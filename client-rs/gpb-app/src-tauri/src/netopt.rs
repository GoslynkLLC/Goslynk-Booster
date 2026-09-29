//! Network tuning for every user, boosting or not.
//!
//! `apply` is permanent and safe to repeat: Google DNS on the physical adapters (IPv6 too where
//! the adapter has it), a flushed DNS cache, and on Windows the TCP and multimedia settings that
//! cut input latency. It needs Administrator/root: Windows runs it in-process, since the app is
//! elevated; macOS runs this binary as `--optimize-network` through the password dialog.
//!
//! `BoostTuning` lives as long as a tunnel and puts back what it changed when dropped.

use std::process::{Command, Output};

#[cfg(target_os = "macos")]
pub const OPTIMIZE_FLAG: &str = "--optimize-network";

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const DNS: [&str; 4] = [
    "8.8.8.8",
    "8.8.4.4",
    "2001:4860:4860::8888",
    "2001:4860:4860::8844",
];

/// On Windows `bin` is a path under System32, see `gpb_net::system_tool`.
fn run(bin: &str, args: &[&str]) -> Result<Output, String> {
    #[cfg(windows)]
    let mut cmd = Command::new(gpb_net::system_tool(bin));
    #[cfg(not(windows))]
    let mut cmd = Command::new(bin);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: from a GUI process every console tool would flash a window.
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| format!("{bin}: {e}"))?;
    if out.status.success() {
        Ok(out)
    } else {
        Err(format!(
            "{bin}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Applies the permanent tuning. Returns how many adapters (macOS: network services) got Google DNS.
pub fn apply() -> Result<usize, String> {
    #[cfg(windows)]
    return windows::apply();
    #[cfg(target_os = "macos")]
    return macos::apply();
    #[cfg(not(any(windows, target_os = "macos")))]
    Err("Chưa hỗ trợ tối ưu mạng trên hệ điều hành này.".into())
}

/// `--optimize-network` entry point, running as root under the macOS password dialog.
#[cfg(target_os = "macos")]
pub fn run_cli() -> i32 {
    match macos::apply_as_root() {
        Ok(n) => {
            println!("services={n}");
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// Tuning that only makes sense while a game is boosted: Windows switches to the High
/// performance power plan, macOS stops delaying TCP ACKs. Dropping it restores the old value.
#[derive(Default)]
pub struct BoostTuning {
    restore: Option<String>,
}

impl BoostTuning {
    pub fn start() -> Self {
        #[cfg(windows)]
        return Self {
            restore: windows::high_performance(),
        };
        #[cfg(target_os = "macos")]
        return Self {
            restore: macos::no_delayed_ack(),
        };
        #[cfg(not(any(windows, target_os = "macos")))]
        Self::default()
    }
}

impl Drop for BoostTuning {
    fn drop(&mut self) {
        let Some(previous) = self.restore.take() else {
            return;
        };
        #[cfg(windows)]
        let _ = run("powercfg.exe", &["/setactive", &previous]);
        #[cfg(target_os = "macos")]
        let _ = run(
            "/usr/sbin/sysctl",
            &["-w", &format!("net.inet.tcp.delayed_ack={previous}")],
        );
        #[cfg(not(any(windows, target_os = "macos")))]
        let _ = previous;
    }
}

#[cfg(windows)]
mod windows {
    use super::run;

    const HIGH_PERFORMANCE: &str = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c";

    /// Virtual adapters (Wintun, Hyper-V, VPNs) are skipped by `-Physical`. Setting IPv4 alone
    /// first keeps Google DNS on adapters where IPv6 is unbound and the combined call fails.
    /// This runs elevated, so modules and tools come from System32 only: the default module path
    /// searches the user's Documents first, and a module planted there would run as Administrator.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$sys = [Environment]::SystemDirectory
$env:PSModulePath = "$sys\WindowsPowerShell\v1.0\Modules"
$netsh = "$sys\netsh.exe"
$v4 = '8.8.8.8','8.8.4.4'
$v6 = '2001:4860:4860::8888','2001:4860:4860::8844'
$n = 0
foreach ($a in (Get-NetAdapter -Physical | Where-Object Status -eq 'Up')) {
  Set-DnsClientServerAddress -InterfaceIndex $a.ifIndex -ServerAddresses $v4
  if (Get-NetIPInterface -InterfaceIndex $a.ifIndex -AddressFamily IPv6) {
    Set-DnsClientServerAddress -InterfaceIndex $a.ifIndex -ServerAddresses ($v4 + $v6)
  }
  $k = "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\$($a.InterfaceGuid)"
  if (Test-Path $k) {
    Set-ItemProperty $k TcpAckFrequency 1 -Type DWord
    Set-ItemProperty $k TCPNoDelay 1 -Type DWord
    Set-ItemProperty $k TcpDelAckTicks 0 -Type DWord
  }
  $n++
}
Clear-DnsClientCache
$mm = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile'
Set-ItemProperty $mm NetworkThrottlingIndex 0xffffffff -Type DWord
Set-ItemProperty $mm SystemResponsiveness 10 -Type DWord
$g = "$mm\Tasks\Games"
if (-not (Test-Path $g)) { New-Item $g -Force | Out-Null }
Set-ItemProperty $g 'GPU Priority' 8 -Type DWord
Set-ItemProperty $g 'Priority' 6 -Type DWord
Set-ItemProperty $g 'Scheduling Category' 'High' -Type String
Set-ItemProperty $g 'SFIO Priority' 'High' -Type String
& $netsh int tcp set global autotuninglevel=normal | Out-Null
& $netsh int tcp set global rss=enabled | Out-Null
"adapters=$n"
"#;

    pub fn apply() -> Result<usize, String> {
        use base64::Engine;
        let utf16: Vec<u8> = SCRIPT.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
        let out = run(
            r"WindowsPowerShell\v1.0\powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                &encoded,
            ],
        )?;
        let text = String::from_utf8_lossy(&out.stdout);
        let n = text
            .lines()
            .find_map(|l| l.trim().strip_prefix("adapters="))
            .and_then(|n| n.parse().ok())
            .ok_or("Không đọc được kết quả tối ưu mạng.")?;
        if n == 0 {
            return Err("Không tìm thấy card mạng nào đang kết nối.".into());
        }
        Ok(n)
    }

    /// Returns the plan to go back to, or `None` when nothing changed. Machines with Modern
    /// Standby ship without High performance, so the switch can fail and is then left alone.
    pub fn high_performance() -> Option<String> {
        let out = run("powercfg.exe", &["/getactivescheme"]).ok()?;
        let current = guid_in(&String::from_utf8_lossy(&out.stdout))?;
        if current.eq_ignore_ascii_case(HIGH_PERFORMANCE) {
            return None;
        }
        run("powercfg.exe", &["/setactive", HIGH_PERFORMANCE]).ok()?;
        Some(current)
    }

    /// The text around the GUID is localised, so only the GUID itself is looked for.
    fn guid_in(text: &str) -> Option<String> {
        text.split(|c: char| !(c.is_ascii_hexdigit() || c == '-'))
            .find(|w| w.len() == 36 && w.matches('-').count() == 4)
            .map(str::to_owned)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{run, DNS, OPTIMIZE_FLAG};

    const PROMPT: &str = "Goslynk Booster cần quyền quản trị để đặt DNS Google (8.8.8.8, 8.8.4.4) và tối ưu mạng cho máy.";

    const LAUNCH_SCRIPT: &str = "on run argv\n\
        do shell script (quoted form of item 1 of argv) & \" \" & (quoted form of item 2 of argv) \
        with prompt (item 3 of argv) with administrator privileges\n\
        end run";

    pub fn apply() -> Result<usize, String> {
        if unsafe { libc::geteuid() } == 0 {
            return apply_as_root();
        }
        let exe = std::env::current_exe().map_err(|e| format!("Đường dẫn app: {e}"))?;
        let exe = exe.to_string_lossy();
        let out = std::process::Command::new("/usr/bin/osascript")
            .args(["-e", LAUNCH_SCRIPT, &exe, OPTIMIZE_FLAG, PROMPT])
            .output()
            .map_err(|e| format!("Không chạy được osascript: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(if err.contains("-128") {
                "Bạn đã hủy nhập mật khẩu nên chưa tối ưu mạng.".into()
            } else {
                format!("Không tối ưu được mạng: {}", err.trim())
            });
        }
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .strip_prefix("services=")
            .and_then(|n| n.parse().ok())
            .ok_or_else(|| "Không đọc được kết quả tối ưu mạng.".into())
    }

    pub fn apply_as_root() -> Result<usize, String> {
        let out = run("/usr/sbin/networksetup", &["-listallnetworkservices"])?;
        let list = String::from_utf8_lossy(&out.stdout);
        // The first line is a legend; disabled services start with '*'.
        let n = list
            .lines()
            .skip(1)
            .filter(|svc| !svc.is_empty() && !svc.starts_with('*'))
            .filter(|svc| {
                let mut args = vec!["-setdnsservers", svc];
                args.extend(DNS);
                run("/usr/sbin/networksetup", &args).is_ok()
            })
            .count();
        let _ = run("/usr/bin/dscacheutil", &["-flushcache"]);
        let _ = run("/usr/bin/killall", &["-HUP", "mDNSResponder"]);
        if n == 0 {
            return Err("Không đặt được DNS cho dịch vụ mạng nào.".into());
        }
        Ok(n)
    }

    /// Needs root, so it only works inside the tunnel helper. Returns the value to restore.
    pub fn no_delayed_ack() -> Option<String> {
        let out = run("/usr/sbin/sysctl", &["-n", "net.inet.tcp.delayed_ack"]).ok()?;
        let current = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        if current == "0" || current.is_empty() {
            return None;
        }
        run("/usr/sbin/sysctl", &["-w", "net.inet.tcp.delayed_ack=0"]).ok()?;
        Some(current)
    }
}
