//! Windows Wintun adapter + routing via `route.exe` / `netsh`.

use super::{NetError, RouteTable, TunDevice};
use std::io::{self, ErrorKind};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use windows_sys::Win32::System::Threading::WaitForSingleObject;

/// Upper bound on one idle wait in `read`, so the tunnel's stop flag is still observed.
const READ_WAIT_MS: u32 = 100;

/// Whether this process holds an elevated (Administrator) token.
pub fn is_elevated() -> bool {
    unsafe { windows_sys::Win32::UI::Shell::IsUserAnAdmin() != 0 }
}

/// Lets a packet pump preempt the game's own threads when the CPU is saturated.
pub fn prioritize_current_thread() {
    use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_HIGHEST};
    unsafe {
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
    }
}

/// Open a Wintun adapter, assign inner IPs / MTU, start a session.
///
/// Requires elevated privileges. Upstream Wintun docs and the C# client note that
/// `WintunCreateAdapter` often needs **LocalSystem** (a Windows Service); plain
/// Administrator can fail with access denied. Place `wintun.dll` next to the exe
/// (download from https://www.wintun.net/).
pub fn open_tun(
    name_hint: &str,
    client_ip: Ipv4Addr,
    _peer_ip: Ipv4Addr,
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
            created.ok_or_else(|| NetError::Msg(format!("WintunCreateAdapter failed ({last:?})")))?
        }
    };

    let index = adapter
        .get_adapter_index()
        .map_err(|e| NetError::Msg(format!("adapter index: {e}")))?;

    // netsh is addressed by interface index, not by name: the wintun crate passes
    // `name="Goslynk Booster"`, whose quotes Rust escapes as \" and netsh rejects.
    // No gateway either - one would add a default route through the tunnel, while only
    // the game ranges belong there (their routes name the peer as the next hop).
    let idx = index.to_string();
    let address = format!("address={client_ip}");
    let set_address = [
        "interface",
        "ipv4",
        "set",
        "address",
        &idx,
        "source=static",
        &address,
        "mask=255.255.255.0",
        "store=active",
    ];
    // A freshly created adapter can take a moment before netsh sees it.
    let mut last = None;
    for delay_ms in [0u64, 300, 600, 1000, 1500] {
        if delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(delay_ms));
        }
        match run_cmd("netsh", &set_address) {
            Ok(()) => {
                last = None;
                break;
            }
            Err(e) => last = Some(e),
        }
    }
    if let Some(e) = last {
        return Err(NetError::Msg(format!("set adapter address: {e}")));
    }

    // store=active so the setting dies with the adapter.
    let _ = run_cmd(
        "netsh",
        &[
            "interface",
            "ipv4",
            "set",
            "subinterface",
            &idx,
            &format!("mtu={mtu}"),
            "store=active",
        ],
    );

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

    fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
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
                // Wait on the adapter's read event, not a sleep: Sleep(1) lasts a whole timer
                // tick (15.6 ms by default), and every game packet would wait it out.
                match self.session.get_read_wait_event() {
                    Ok(event) => unsafe {
                        WaitForSingleObject(event as _, READ_WAIT_MS);
                    },
                    Err(_) => std::thread::sleep(Duration::from_millis(1)),
                }
                Err(io::Error::new(ErrorKind::WouldBlock, "no packet"))
            }
            Err(e) => Err(io::Error::other(format!("wintun recv: {e}"))),
        }
    }

    fn write(&self, buf: &[u8]) -> io::Result<usize> {
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
        // netsh and route print their errors on stdout.
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let why = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        return Err(NetError::Msg(format!(
            "{bin} {} failed ({}): {why}",
            args.join(" "),
            out.status
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
