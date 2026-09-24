//! macOS utun + routing via `ifconfig` / `route`.

use super::{NetError, RouteTable, TunDevice};
use libc::{c_char, c_void, sockaddr, socklen_t, AF_SYSTEM, AF_SYS_CONTROL, SOCK_DGRAM};
use std::ffi::CStr;
use std::io::{self, ErrorKind, Read, Write};
use std::mem::{size_of, zeroed};
use std::net::Ipv4Addr;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::process::Command;

const UTUN_CONTROL_NAME: &str = "com.apple.net.utun_control";
const SYSPROTO_CONTROL: i32 = 2;
const UTUN_OPT_IFNAME: i32 = 2;
const CTLIOCGINFO: u64 = 0xc0644e03; // _IOWR('N', 3, struct ctl_info)

#[repr(C)]
struct CtlInfo {
    ctl_id: u32,
    ctl_name: [c_char; 96],
}

#[repr(C)]
struct SockaddrCtl {
    sc_len: u8,
    sc_family: u8,
    ss_sysaddr: u16,
    sc_id: u32,
    sc_unit: u32,
    sc_reserved: [u32; 5],
}

/// Open a utun, configure IPv4 point-to-point addresses and MTU.
pub fn open_tun(
    name_hint: &str,
    client_ip: Ipv4Addr,
    peer_ip: Ipv4Addr,
    mtu: u16,
) -> Result<MacUtun, NetError> {
    open_utun(name_hint, client_ip, peer_ip, mtu)
}

/// Open a utun, configure IPv4 point-to-point addresses and MTU.
pub fn open_utun(
    _name_hint: &str,
    client_ip: Ipv4Addr,
    peer_ip: Ipv4Addr,
    mtu: u16,
) -> Result<MacUtun, NetError> {
    let fd = unsafe { libc::socket(AF_SYSTEM, SOCK_DGRAM, SYSPROTO_CONTROL) };
    if fd < 0 {
        return Err(NetError::Io(io::Error::last_os_error()));
    }
    let owned = unsafe { OwnedFd::from_raw_fd(fd) };

    let mut info: CtlInfo = unsafe { zeroed() };
    let name_bytes = UTUN_CONTROL_NAME.as_bytes();
    if name_bytes.len() >= info.ctl_name.len() {
        return Err(NetError::Msg("utun control name too long".into()));
    }
    for (i, b) in name_bytes.iter().enumerate() {
        info.ctl_name[i] = *b as c_char;
    }

    let rc = unsafe {
        libc::ioctl(owned.as_raw_fd(), CTLIOCGINFO, &mut info as *mut _ as *mut c_void)
    };
    if rc < 0 {
        return Err(NetError::Io(io::Error::last_os_error()));
    }

    let mut addr: SockaddrCtl = unsafe { zeroed() };
    addr.sc_len = size_of::<SockaddrCtl>() as u8;
    addr.sc_family = AF_SYSTEM as u8;
    addr.ss_sysaddr = AF_SYS_CONTROL as u16;
    addr.sc_id = info.ctl_id;
    addr.sc_unit = 0; // kernel assigns

    let rc = unsafe {
        libc::connect(
            owned.as_raw_fd(),
            &addr as *const _ as *const sockaddr,
            size_of::<SockaddrCtl>() as socklen_t,
        )
    };
    if rc < 0 {
        return Err(NetError::Io(io::Error::last_os_error()));
    }

    let mut ifname_buf = [0u8; 32];
    let mut ifname_len = ifname_buf.len() as socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            owned.as_raw_fd(),
            SYSPROTO_CONTROL,
            UTUN_OPT_IFNAME,
            ifname_buf.as_mut_ptr() as *mut c_void,
            &mut ifname_len,
        )
    };
    if rc < 0 {
        return Err(NetError::Io(io::Error::last_os_error()));
    }
    let name = CStr::from_bytes_until_nul(&ifname_buf)
        .map_err(|_| NetError::Msg("utun ifname not nul-terminated".into()))?
        .to_string_lossy()
        .into_owned();

    // Point-to-point: ifconfig utunX inet CLIENT PEER mtu MTU up
    run_cmd(
        "ifconfig",
        &[
            &name,
            "inet",
            &client_ip.to_string(),
            &peer_ip.to_string(),
            "mtu",
            &mtu.to_string(),
            "up",
        ],
    )?;

    Ok(MacUtun {
        fd: owned,
        name,
        file: None,
    })
}

pub struct MacUtun {
    fd: OwnedFd,
    name: String,
    /// Lazily wrap as File for Read/Write — set on first use via raw fd clone path.
    file: Option<std::fs::File>,
}

impl MacUtun {
    fn file_mut(&mut self) -> &mut std::fs::File {
        if self.file.is_none() {
            let raw = self.fd.as_raw_fd();
            // Duplicate so OwnedFd and File don't both own the same fd.
            let dup = unsafe { libc::dup(raw) };
            assert!(dup >= 0);
            self.file = Some(unsafe { std::fs::File::from_raw_fd(dup) });
        }
        self.file.as_mut().unwrap()
    }
}

impl TunDevice for MacUtun {
    fn name(&self) -> &str {
        &self.name
    }

    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        // utun prefixes each packet with a 4-byte address family (AF_INET = 2) in network order.
        let mut header = [0u8; 4];
        let mut tmp = vec![0u8; buf.len() + 4];
        let n = self.file_mut().read(&mut tmp)?;
        if n < 4 {
            return Err(io::Error::new(ErrorKind::UnexpectedEof, "utun short read"));
        }
        header.copy_from_slice(&tmp[..4]);
        let af = u32::from_be_bytes(header);
        if af != libc::AF_INET as u32 {
            // Skip non-IPv4 (e.g. IPv6 neighbour noise).
            return Err(io::Error::new(ErrorKind::InvalidData, "non-ipv4 on utun"));
        }
        let payload = n - 4;
        if payload > buf.len() {
            return Err(io::Error::new(ErrorKind::OutOfMemory, "buffer too small"));
        }
        buf[..payload].copy_from_slice(&tmp[4..n]);
        Ok(payload)
    }

    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut out = Vec::with_capacity(buf.len() + 4);
        out.extend_from_slice(&(libc::AF_INET as u32).to_be_bytes());
        out.extend_from_slice(buf);
        self.file_mut().write_all(&out)?;
        Ok(buf.len())
    }
}

/// Parse `route -n get default` for gateway and interface.
pub fn default_gateway() -> Result<(Ipv4Addr, String), NetError> {
    let out = Command::new("route")
        .args(["-n", "get", "default"])
        .output()
        .map_err(NetError::Io)?;
    if !out.status.success() {
        return Err(NetError::Msg(format!(
            "route get default failed: {}",
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut gateway = None;
    let mut iface = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("gateway:") {
            gateway = Some(
                rest.trim()
                    .parse()
                    .map_err(|e| NetError::Msg(format!("bad gateway: {e}")))?,
            );
        }
        if let Some(rest) = line.strip_prefix("interface:") {
            iface = Some(rest.trim().to_string());
        }
    }
    match (gateway, iface) {
        (Some(g), Some(i)) => Ok((g, i)),
        _ => Err(NetError::Msg(
            "could not parse default gateway from `route get default`".into(),
        )),
    }
}

#[derive(Default)]
pub struct MacRouteTable {
    installed_cidrs: Vec<String>,
    pinned_hosts: Vec<Ipv4Addr>,
}

impl MacRouteTable {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn installed_cidrs(&self) -> &[String] {
        &self.installed_cidrs
    }
}

impl RouteTable for MacRouteTable {
    fn pin_host(&mut self, host: Ipv4Addr, via_gateway: Ipv4Addr, iface: &str) -> Result<(), NetError> {
        // route -n add -host RELAY GATEWAY -ifscope IFACE
        run_cmd(
            "route",
            &[
                "-n",
                "add",
                "-host",
                &host.to_string(),
                &via_gateway.to_string(),
                "-ifscope",
                iface,
            ],
        )?;
        self.pinned_hosts.push(host);
        Ok(())
    }

    fn add_cidr(&mut self, cidr: &str, gateway: Ipv4Addr, iface: &str) -> Result<(), NetError> {
        let (net, bits) = parse_cidr(cidr)?;
        run_cmd(
            "route",
            &[
                "-n",
                "add",
                "-net",
                &format!("{net}/{bits}"),
                &gateway.to_string(),
                "-ifscope",
                iface,
            ],
        )?;
        self.installed_cidrs.push(cidr.to_string());
        Ok(())
    }

    fn delete_cidr(&mut self, cidr: &str) -> Result<(), NetError> {
        let (net, bits) = parse_cidr(cidr)?;
        let _ = run_cmd(
            "route",
            &["-n", "delete", "-net", &format!("{net}/{bits}")],
        );
        self.installed_cidrs.retain(|c| c != cidr);
        Ok(())
    }

    fn delete_host(&mut self, host: Ipv4Addr) -> Result<(), NetError> {
        let _ = run_cmd("route", &["-n", "delete", "-host", &host.to_string()]);
        self.pinned_hosts.retain(|h| *h != host);
        Ok(())
    }
}

impl Drop for MacRouteTable {
    fn drop(&mut self) {
        for c in self.installed_cidrs.clone() {
            let _ = self.delete_cidr(&c);
        }
        for h in self.pinned_hosts.clone() {
            let _ = self.delete_host(h);
        }
    }
}

fn parse_cidr(cidr: &str) -> Result<(Ipv4Addr, u8), NetError> {
    let (ip, bits) = cidr
        .split_once('/')
        .ok_or_else(|| NetError::Msg(format!("cidr must be a.b.c.d/nn, got {cidr}")))?;
    let net: Ipv4Addr = ip
        .parse()
        .map_err(|e| NetError::Msg(format!("bad cidr addr: {e}")))?;
    let bits: u8 = bits
        .parse()
        .map_err(|e| NetError::Msg(format!("bad prefix len: {e}")))?;
    Ok((net, bits))
}

fn run_cmd(bin: &str, args: &[&str]) -> Result<(), NetError> {
    let out = Command::new(bin).args(args).output().map_err(NetError::Io)?;
    if !out.status.success() {
        return Err(NetError::Msg(format!(
            "{bin} {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

#[allow(dead_code)]
fn _raw_fd(tun: &MacUtun) -> RawFd {
    tun.fd.as_raw_fd()
}
