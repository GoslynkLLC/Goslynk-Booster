//! How far this machine's clock is from real time, over SNTP.
//!
//! A relay drops, without answering, any handshake stamped more than
//! [`HANDSHAKE_SKEW_SECS`] from its own clock, so a PC a few minutes out sees exactly what a
//! blocked network looks like: a handshake timeout. Measured only after a handshake fails, to
//! turn that timeout into a message naming the real cause.

use std::net::{ToSocketAddrs, UdpSocket};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The relay's accepted drift (relay/internal/protocol: HandshakeSkew).
pub const HANDSHAKE_SKEW_SECS: f64 = 120.0;

const SERVERS: &[&str] = &["time.cloudflare.com:123", "time.google.com:123", "pool.ntp.org:123"];
const NTP_UNIX_OFFSET: f64 = 2_208_988_800.0;

/// Local clock minus real time, in seconds (positive = this machine is ahead). `None` when no
/// time server answered - UDP 123 is blocked on some networks.
pub fn clock_offset_secs(timeout: Duration) -> Option<f64> {
    SERVERS.iter().find_map(|s| query(s, timeout))
}

fn now_unix() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn query(server: &str, timeout: Duration) -> Option<f64> {
    let addr = server.to_socket_addrs().ok()?.find(|a| a.is_ipv4())?;
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.set_read_timeout(Some(timeout)).ok()?;

    let mut req = [0u8; 48];
    req[0] = 0x23; // LI 0, version 4, mode 3 (client)
    let sent = now_unix();
    sock.send_to(&req, addr).ok()?;

    let mut resp = [0u8; 48];
    let (n, from) = sock.recv_from(&mut resp).ok()?;
    let received = now_unix();
    if n < 48 || from != addr || resp[0] & 0x07 != 4 || resp[1] == 0 {
        return None;
    }

    let secs = u32::from_be_bytes(resp[40..44].try_into().ok()?) as f64;
    let frac = u32::from_be_bytes(resp[44..48].try_into().ok()?) as f64 / 4_294_967_296.0;
    let server_unix = secs + frac - NTP_UNIX_OFFSET;
    Some((sent + received) / 2.0 - server_unix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "needs UDP 123 to the internet"]
    fn this_machine_is_close_to_real_time() {
        let off = clock_offset_secs(Duration::from_secs(3)).expect("no time server answered");
        assert!(off.abs() < HANDSHAKE_SKEW_SECS, "clock is {off:+.1} s off");
    }
}
