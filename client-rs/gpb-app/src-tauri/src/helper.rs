//! macOS: utun and route changes need root, so when the app runs as a normal user it starts
//! its own binary as a root helper (`--tunnel-helper <socket>`) through the system password
//! dialog. The two talk JSON lines over a Unix socket; when the app goes away the socket
//! closes and the helper tears the tunnel down and exits.

use crate::tunnel::{self, ConnectResult, StatusSnapshot, TunnelRequest};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const HELPER_FLAG: &str = "--tunnel-helper";

const PROMPT: &str = "Goslynk Booster cần quyền quản trị để tạo card mạng ảo và định tuyến game qua relay.";

/// AppleScript's `quoted form of` keeps the paths out of shell parsing.
const LAUNCH_SCRIPT: &str = "on run argv\n\
    do shell script (quoted form of item 1 of argv) & \" --tunnel-helper \" & \
    (quoted form of item 2 of argv) & \" </dev/null >/dev/null 2>&1 &\" \
    with prompt (item 3 of argv) with administrator privileges\n\
    end run";

#[derive(Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
enum Request {
    Connect(TunnelRequest),
    SetRoutes { cidrs: Vec<String> },
    Status,
    Disconnect,
}

pub fn needs_helper() -> bool {
    unsafe { libc::geteuid() != 0 }
}

pub struct HelperTunnel {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl HelperTunnel {
    pub fn launch(req: &TunnelRequest) -> Result<(Self, ConnectResult), String> {
        let dir = socket_dir()?;
        let result = Self::launch_in(&dir, req);
        let _ = fs::remove_dir_all(&dir);
        result
    }

    fn launch_in(dir: &Path, req: &TunnelRequest) -> Result<(Self, ConnectResult), String> {
        let sock = dir.join("h.sock");
        let listener = UnixListener::bind(&sock).map_err(|e| format!("Helper socket: {e}"))?;
        let exe = std::env::current_exe().map_err(|e| format!("Đường dẫn app: {e}"))?;

        let out = Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(LAUNCH_SCRIPT)
            .arg(&exe)
            .arg(&sock)
            .arg(PROMPT)
            .output()
            .map_err(|e| format!("Không chạy được osascript: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(if err.contains("-128") {
                "Bạn đã hủy nhập mật khẩu nên chưa bật được tăng tốc.".into()
            } else {
                format!("Không xin được quyền quản trị: {}", err.trim())
            });
        }

        let stream = accept_within(&listener, Duration::from_secs(15))?;
        let mut helper = Self {
            reader: BufReader::new(stream.try_clone().map_err(|e| e.to_string())?),
            writer: stream,
        };
        helper.set_timeout(Duration::from_secs(req.timeout_secs + 20));
        let result: Result<ConnectResult, String> = helper
            .call(&Request::Connect(req.clone()))
            .map_err(|e| format!("Helper không phản hồi: {e}"))?;
        helper.set_timeout(Duration::from_secs(5));
        result.map(|r| (helper, r))
    }

    /// `None` once the helper is gone.
    pub fn status(&mut self) -> Option<StatusSnapshot> {
        self.call(&Request::Status).ok()
    }

    pub fn set_cidrs(&mut self, cidrs: &[String]) -> Result<usize, String> {
        self.call::<Result<usize, String>>(&Request::SetRoutes {
            cidrs: cidrs.to_vec(),
        })
        .map_err(|e| format!("Helper không phản hồi: {e}"))?
    }

    pub fn shutdown(mut self) {
        let _: Result<bool, _> = self.call(&Request::Disconnect);
    }

    fn set_timeout(&self, t: Duration) {
        let _ = self.writer.set_read_timeout(Some(t));
    }

    fn call<T: DeserializeOwned>(&mut self, req: &Request) -> Result<T, String> {
        send(&mut self.writer, req).map_err(|e| e.to_string())?;
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) => Err("helper đã thoát".into()),
            Ok(_) => serde_json::from_str(&line).map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        }
    }
}

fn socket_dir() -> Result<PathBuf, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("gsb-{}-{nanos}", std::process::id()));
    fs::create_dir(&dir).map_err(|e| format!("Helper dir: {e}"))?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("Helper dir: {e}"))?;
    Ok(dir)
}

fn accept_within(listener: &UnixListener, limit: Duration) -> Result<UnixStream, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + limit;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).map_err(|e| e.to_string())?;
                return Ok(stream);
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                return Err("Helper không khởi động được.".into())
            }
            Err(e) => return Err(format!("Helper socket: {e}")),
        }
    }
}

fn send<T: Serialize>(w: &mut UnixStream, msg: &T) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(msg)?;
    line.push(b'\n');
    w.write_all(&line)
}

/// The app only launches a helper when it holds none, so any other helper of this same binary
/// has lost its app (older builds could hang on shutdown) and still holds a utun and routes.
/// Killing it closes the utun, and the kernel drops the routes that pointed at it.
/// SIGKILL, because a helper started through the password dialog can inherit SIGTERM as ignored.
fn reap_stale_helpers() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let prefix = format!("{} {HELPER_FLAG} ", exe.display());
    let own = std::process::id();
    let Ok(out) = Command::new("/bin/ps").args(["-axww", "-o", "pid=,command="]).output() else {
        return;
    };
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let Some((pid, cmd)) = line.trim_start().split_once(' ') else {
            continue;
        };
        match pid.parse::<u32>() {
            Ok(pid) if pid != own && cmd.trim_start().starts_with(&prefix) => unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            },
            _ => {}
        }
    }
}

/// Helper side, running as root. Returns the process exit code.
pub fn run(socket: &Path) -> i32 {
    reap_stale_helpers();
    let Ok(mut writer) = UnixStream::connect(socket) else {
        return 2;
    };
    let Ok(read_half) = writer.try_clone() else {
        return 2;
    };
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();

    let req = match reader.read_line(&mut line) {
        Ok(n) if n > 0 => match serde_json::from_str::<Request>(&line) {
            Ok(Request::Connect(req)) => req,
            _ => return 2,
        },
        _ => return 2,
    };

    let mut live = match tunnel::establish(&req) {
        Ok((live, result)) => {
            let _ = send(&mut writer, &Ok::<_, String>(result));
            live
        }
        Err(e) => {
            let _ = send(&mut writer, &Err::<ConnectResult, _>(e));
            return 1;
        }
    };

    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(n) if n > 0 => {}
            _ => break,
        }
        match serde_json::from_str::<Request>(&line) {
            Ok(Request::Status) => {
                if send(&mut writer, &live.status()).is_err() {
                    break;
                }
            }
            Ok(Request::SetRoutes { cidrs }) => {
                if send(&mut writer, &live.set_cidrs(&cidrs)).is_err() {
                    break;
                }
            }
            Ok(Request::Disconnect) => {
                live.shutdown();
                let _ = send(&mut writer, &true);
                return 0;
            }
            _ => break,
        }
    }
    live.shutdown();
    0
}
