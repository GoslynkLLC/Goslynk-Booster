//! Windows Wintun adapter + routing via `route.exe` / `netsh`.

use super::{NetError, RouteTable, TunDevice};
use std::io::{self, ErrorKind};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

/// Open a Wintun adapter, assign inner IPs / MTU, start a session.
///
/// Requires elevated privileges. Upstream Wintun docs and the C# client note that
/// `WintunCreateAdapter` often needs **LocalSystem** (a Windows Service); plain
/// Administrator can fail with access denied. Place `wintun.dll` next to the exe
/// (download from https://www.wintun.net/).
pub fn open_tun(
    name_hint: &str,
    client_ip: Ipv4Addr,
    peer_ip: Ipv4Addr,
    mtu: u16,
) -> Result<WinTun, NetError> {
    let dll = find_wintun_dll()?;
    let wintun = unsafe {
        wintun::load_from_path(&dll).map_err(|e| NetError::Msg(format!("load wintun.dll: {e}")))?
    };

    let adapter = match wintun::Adapter::open(&wintun, name_hint) {
        Ok(a) => a,
        Err(_) => {
            // Retry briefly: a previous adapter may still be tearing down (same as C# client).
            let mut last = None;
            let mut created = None;
            for delay_ms in [0u64, 250, 500, 750, 1000, 1000] {
                if delay_ms > 0 {
                    std::thread::sleep(Duration::from_millis(delay_ms));
                }
                match wintun::Adapter::create(&wintun, name_hint, "GoslynkBooster", None) {
                    Ok(a) => {
                        created = Some(a);
                        break;
                    }
                    Err(e) => last = Some(e),
                }
            }
            created.ok_or_else(|| {
                NetError::Msg(format!(
                    "WintunCreateAdapter failed ({last:?}). Need LocalSystem/Admin and wintun.dll beside the exe."
                ))
            })?
        }
    };

    use std::net::IpAddr;
    adapter
        .set_network_addresses_tuple(
            IpAddr::V4(client_ip),
            IpAddr::V4(Ipv4Addr::new(255, 255, 255, 0)),
            Some(IpAddr::V4(peer_ip)),
        )
        .map_err(|e| NetError::Msg(format!("set adapter addresses: {e}")))?;

    // MTU via netsh (store=active so it dies with the adapter).
    let _ = run_cmd(
        "netsh",
        &[
            "interface",
            "ipv4",
            "set",
            "subinterface",
            name_hint,
            &format!("mtu={mtu}"),
            "store=active",
        ],
    );

    let index = adapter
        .get_adapter_index()
        .map_err(|e| NetError::Msg(format!("adapter index: {e}")))?;

    let session = Arc::new(
        adapter
            .start_session(wintun::MAX_RING_CAPACITY)
            .map_err(|e| NetError::Msg(format!("start session: {e}")))?,
    );

    Ok(WinTun {
        name: name_hint.to_string(),
        index,
        session,
    })
}

pub struct WinTun {
    name: String,
    index: u32,
    session: Arc<wintun::Session>,
}

impl WinTun {
    pub fn interface_index(&self) -> u32 {
        self.index
    }
}

impl TunDevice for WinTun {
    fn name(&self) -> &str {
        &self.name
    }

    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        // Non-blocking poll so the tunnel stop flag can be observed.
        match self.session.try_receive() {
            Ok(Some(packet)) => {
                let bytes = packet.bytes();
                if bytes.is_empty() {
                    return Ok(0);
                }
                if (bytes[0] >> 4) != 4 {
                    return Err(io::Error::new(ErrorKind::InvalidData, "non-ipv4"));
                }
                if bytes.len() > buf.len() {
                    return Err(io::Error::new(ErrorKind::OutOfMemory, "buffer too small"));
                }
                buf[..bytes.len()].copy_from_slice(bytes);
                Ok(bytes.len())
            }
            Ok(None) => {
                // Brief wait so we do not spin the CPU.
                std::thread::sleep(Duration::from_millis(1));
                Err(io::Error::new(ErrorKind::WouldBlock, "no packet"))
            }
            Err(e) => Err(io::Error::other(format!("wintun recv: {e}"))),
        }
    }

    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.len() > u16::MAX as usize {
            return Err(io::Error::new(ErrorKind::InvalidInput, "packet too large"));
        }
        let mut packet = self
            .session
            .allocate_send_packet(buf.len() as u16)
            .map_err(|e| io::Error::other(format!("allocate send: {e}")))?;
        packet.bytes_mut().copy_from_slice(buf);
        self.session.send_packet(packet);
        Ok(buf.len())
    }
}

impl Drop for WinTun {
    fn drop(&mut self) {
        let _ = self.session.shutdown();
    }
}

/// Default IPv4 gateway and outgoing interface name from `route print`.
pub fn default_gateway() -> Result<(Ipv4Addr, String), NetError> {
    let out = Command::new("route")
        .args(["print", "0.0.0.0"])
        .output()
        .map_err(NetError::Io)?;
    if !out.status.success() {
        return Err(NetError::Msg(format!(
            "route print failed: {}",
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // Lines like:  0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.10     25
    for line in text.lines() {
        let cols: Vec<_> = line.split_whitespace().collect();
        if cols.len() >= 5 && cols[0] == "0.0.0.0" && cols[1] == "0.0.0.0" {
            let gw: Ipv4Addr = cols[2]
                .parse()
                .map_err(|e| NetError::Msg(format!("bad gateway: {e}")))?;
            // Interface column is often the local address on that NIC; use it as a label.
            return Ok((gw, cols[3].to_string()));
        }
    }
    Err(NetError::Msg(
        "could not parse default gateway from `route print`".into(),
    ))
}

#[derive(Default)]
pub struct WinRouteTable {
    installed_cidrs: Vec<(String, u32)>, // cidr, ifindex used
    pinned_hosts: Vec<Ipv4Addr>,
    /// Interface index of the Wintun adapter (set by daemon after open).
    pub tun_ifindex: Option<u32>,
    /// Physical interface index for pinned relay route (optional; 0 = omit IF).
    pub phys_ifindex: Option<u32>,
}

impl WinRouteTable {
    pub fn new() -> Self {
        Self::default()
    }
}

impl RouteTable for WinRouteTable {
    fn pin_host(&mut self, host: Ipv4Addr, via_gateway: Ipv4Addr, _iface: &str) -> Result<(), NetError> {
        // route add HOST mask 255.255.255.255 GATEWAY
        let mut args = vec![
            "add".into(),
            host.to_string(),
            "mask".into(),
            "255.255.255.255".into(),
            via_gateway.to_string(),
            "metric".into(),
            "1".into(),
        ];
        if let Some(idx) = self.phys_ifindex {
            args.push("if".into());
            args.push(idx.to_string());
        }
        run_cmd_owned("route", &args)?;
        self.pinned_hosts.push(host);
        Ok(())
    }

    fn add_cidr(&mut self, cidr: &str, gateway: Ipv4Addr, _iface: &str) -> Result<(), NetError> {
        let (net, mask) = cidr_to_net_mask(cidr)?;
        let ifindex = self.tun_ifindex.ok_or_else(|| {
            NetError::Msg("tun_ifindex not set on WinRouteTable before add_cidr".into())
        })?;
        run_cmd(
            "route",
            &[
                "add",
                &net.to_string(),
                "mask",
                &mask.to_string(),
                &gateway.to_string(),
                "metric",
                "5",
                "if",
                &ifindex.to_string(),
            ],
        )?;
        self.installed_cidrs.push((cidr.to_string(), ifindex));
        Ok(())
    }

    fn delete_cidr(&mut self, cidr: &str) -> Result<(), NetError> {
        let (net, mask) = cidr_to_net_mask(cidr)?;
        let _ = run_cmd(
            "route",
            &["delete", &net.to_string(), "mask", &mask.to_string()],
        );
        self.installed_cidrs.retain(|(c, _)| c != cidr);
        Ok(())
    }

    fn delete_host(&mut self, host: Ipv4Addr) -> Result<(), NetError> {
        let _ = run_cmd("route", &["delete", &host.to_string()]);
        self.pinned_hosts.retain(|h| *h != host);
        Ok(())
    }
}

impl Drop for WinRouteTable {
    fn drop(&mut self) {
        for (c, _) in self.installed_cidrs.clone() {
            let _ = self.delete_cidr(&c);
        }
        for h in self.pinned_hosts.clone() {
            let _ = self.delete_host(h);
        }
    }
}

fn find_wintun_dll() -> Result<PathBuf, NetError> {
    if let Ok(p) = std::env::var("GPB_WINTUN_DLL") {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Ok(path);
        }
        return Err(NetError::Msg(format!(
            "GPB_WINTUN_DLL={path:?} not found"
        )));
    }
    // Beside the exe first: that is where the installer puts it, and this process runs
    // elevated, so a DLL picked up from an arbitrary working directory comes last.
    let candidates = [
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("wintun.dll")))
            .unwrap_or_else(|| PathBuf::from("wintun.dll")),
        PathBuf::from("wintun/wintun.dll"),
        PathBuf::from("gpb-app/src-tauri/wintun/wintun.dll"),
        PathBuf::from("wintun.dll"),
    ];
    for c in candidates {
        if c.is_file() {
            return Ok(c);
        }
    }
    Err(NetError::Msg(
        "wintun.dll not found. Run gpb-app/scripts/fetch-wintun.ps1, or download the amd64 \
         build from https://www.wintun.net/ and place it next to the exe (or set GPB_WINTUN_DLL)."
            .into(),
    ))
}

fn cidr_to_net_mask(cidr: &str) -> Result<(Ipv4Addr, Ipv4Addr), NetError> {
    let (ip, bits) = cidr
        .split_once('/')
        .ok_or_else(|| NetError::Msg(format!("cidr must be a.b.c.d/nn, got {cidr}")))?;
    let net: Ipv4Addr = ip
        .parse()
        .map_err(|e| NetError::Msg(format!("bad cidr addr: {e}")))?;
    let bits: u32 = bits
        .parse()
        .map_err(|e| NetError::Msg(format!("bad prefix len: {e}")))?;
    if bits > 32 {
        return Err(NetError::Msg("prefix > 32".into()));
    }
    let mask_u = if bits == 0 {
        0u32
    } else {
        u32::MAX << (32 - bits)
    };
    Ok((net, Ipv4Addr::from(mask_u)))
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

fn run_cmd_owned(bin: &str, args: &[String]) -> Result<(), NetError> {
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_cmd(bin, &refs)
}

#[allow(dead_code)]
fn _path_exists(p: &Path) -> bool {
    p.exists()
}
