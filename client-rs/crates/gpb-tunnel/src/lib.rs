//! UDP tunnel client: handshake, dedicated pump threads, keepalive.

pub mod clock;

use gpb_net::TunDevice;
use gpb_protocol::{
    self as proto, build_disconnect, build_handshake_req, build_ping, try_parse_handshake_resp,
    try_read_data, try_read_pong, write_data, ClientId, HandshakeResult, SessionId, MAX_PACKET_LEN,
};
use std::io::ErrorKind;
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TunnelError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("protocol: {0}")]
    Protocol(#[from] proto::ProtocolError),
    #[error("handshake timed out")]
    HandshakeTimeout,
    #[error("handshake refused with status {0}")]
    HandshakeRefused(u8),
    #[error("{0}")]
    Msg(String),
}

/// Counters shared with the UI. RTT fields are microseconds, 0 meaning "no sample yet".
/// Only the downlink thread writes the RTT fields, so plain load/store is enough.
#[derive(Default)]
pub struct TunnelStats {
    pub packets_sent: AtomicU64,
    pub packets_received: AtomicU64,
    /// IP bytes carried through the tunnel (tunnel headers excluded).
    pub bytes_sent: AtomicU64,
    pub bytes_received: AtomicU64,
    pub pings_sent: AtomicU64,
    pub pongs_received: AtomicU64,
    pub last_rtt_us: AtomicU64,
    pub min_rtt_us: AtomicU64,
    /// Exponential average, weight 1/8 (as TCP's SRTT).
    pub avg_rtt_us: AtomicU64,
    /// Mean deviation between consecutive samples, weight 1/16 (RFC 3550 interarrival jitter).
    pub jitter_us: AtomicU64,
    pub handshake_rtt_us: AtomicU64,
}

fn us_to_ms(us: u64) -> Option<f64> {
    (us != 0).then(|| us as f64 / 1000.0)
}

impl TunnelStats {
    pub fn last_rtt_ms(&self) -> Option<f64> {
        us_to_ms(self.last_rtt_us.load(Ordering::Relaxed))
    }

    pub fn min_rtt_ms(&self) -> Option<f64> {
        us_to_ms(self.min_rtt_us.load(Ordering::Relaxed))
    }

    pub fn avg_rtt_ms(&self) -> Option<f64> {
        us_to_ms(self.avg_rtt_us.load(Ordering::Relaxed))
    }

    pub fn jitter_ms(&self) -> Option<f64> {
        let have_samples = self.pongs_received.load(Ordering::Relaxed) > 1;
        have_samples.then(|| self.jitter_us.load(Ordering::Relaxed) as f64 / 1000.0)
    }

    pub fn handshake_rtt_ms(&self) -> Option<f64> {
        us_to_ms(self.handshake_rtt_us.load(Ordering::Relaxed))
    }

    /// Share of pings with no pong, as a percentage. The newest ping may still be in
    /// flight, so it is not counted as lost.
    pub fn loss_pct(&self) -> Option<f64> {
        let sent = self.pings_sent.load(Ordering::Relaxed).saturating_sub(1);
        if sent == 0 {
            return None;
        }
        let got = self.pongs_received.load(Ordering::Relaxed).min(sent);
        Some((sent - got) as f64 * 100.0 / sent as f64)
    }

    fn record_rtt(&self, rtt_us: u64) {
        let rtt_us = rtt_us.max(1);
        let prev = self.last_rtt_us.swap(rtt_us, Ordering::Relaxed);
        let min = self.min_rtt_us.load(Ordering::Relaxed);
        if min == 0 || rtt_us < min {
            self.min_rtt_us.store(rtt_us, Ordering::Relaxed);
        }
        let avg = self.avg_rtt_us.load(Ordering::Relaxed);
        let avg = if avg == 0 { rtt_us } else { (avg * 7 + rtt_us) / 8 };
        self.avg_rtt_us.store(avg, Ordering::Relaxed);
        if prev != 0 {
            let d = rtt_us.abs_diff(prev) as i64;
            let j = self.jitter_us.load(Ordering::Relaxed) as i64;
            self.jitter_us
                .store((j + (d - j) / 16).max(0) as u64, Ordering::Relaxed);
        }
    }
}

/// Running tunnel: owns the socket and pump threads. Drop or [`TunnelSession::shutdown`] to stop.
pub struct TunnelSession {
    socket: UdpSocket,
    session_id: SessionId,
    stop: Arc<AtomicBool>,
    handles: Vec<JoinHandle<()>>,
    pub stats: Arc<TunnelStats>,
    pub handshake: HandshakeResult,
}

impl TunnelSession {
    pub fn session_id(&self) -> SessionId {
        self.session_id
    }

    pub fn shutdown(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self
            .socket
            .send(&build_disconnect(&self.session_id));
        // Unblock recv
        let _ = self.socket.set_read_timeout(Some(Duration::from_millis(50)));
        for h in self.handles.drain(..) {
            let _ = h.join();
        }
    }
}

impl Drop for TunnelSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.socket.send(&build_disconnect(&self.session_id));
    }
}

/// Handshake with the relay. Does not open a TUN.
pub fn handshake(
    endpoint: SocketAddr,
    psk: &[u8],
    client_id: ClientId,
    timeout: Duration,
) -> Result<(UdpSocket, HandshakeResult, NonceStamp), TunnelError> {
    let socket = UdpSocket::bind("0.0.0.0:0")?;
    socket.connect(endpoint)?;
    socket.set_read_timeout(Some(timeout))?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| TunnelError::Msg(e.to_string()))?
        .as_secs();

    let t0 = Instant::now();
    let mut nonce;
    let mut buf = [0u8; 512];
    let deadline = Instant::now() + timeout;
    // Send first request; on timeout resend with a fresh nonce.
    {
        let (req, n) = build_handshake_req(psk, client_id, now);
        nonce = n;
        socket.send(&req)?;
    }

    loop {
        if Instant::now() > deadline {
            return Err(TunnelError::HandshakeTimeout);
        }
        match socket.recv(&mut buf) {
            Ok(n) => {
                match try_parse_handshake_resp(psk, &buf[..n], &nonce) {
                    Ok(result) => {
                        if result.status != proto::STATUS_OK {
                            return Err(TunnelError::HandshakeRefused(result.status));
                        }
                        let hs_us = t0.elapsed().as_micros() as u64;
                        return Ok((
                            socket,
                            result,
                            NonceStamp {
                                handshake_rtt_us: hs_us,
                            },
                        ));
                    }
                    Err(proto::ProtocolError::BadAuth)
                    | Err(proto::ProtocolError::BadNonce)
                    | Err(proto::ProtocolError::ShortPacket)
                    | Err(proto::ProtocolError::BadType)
                    | Err(proto::ProtocolError::BadVersion) => continue,
                    Err(e) => return Err(e.into()),
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut => {
                let (req, n) = build_handshake_req(psk, client_id, now);
                nonce = n;
                let _ = socket.send(&req);
                continue;
            }
            Err(e) => return Err(e.into()),
        }
    }
}

pub struct NonceStamp {
    pub handshake_rtt_us: u64,
}

/// After a successful handshake, start pumps between `tun` and the UDP socket.
pub fn start_pumps<T: TunDevice + 'static>(
    socket: UdpSocket,
    handshake: HandshakeResult,
    handshake_rtt_us: u64,
    tun: T,
    keepalive: Duration,
) -> Result<TunnelSession, TunnelError> {
    let session_id = handshake.session_id;
    let stop = Arc::new(AtomicBool::new(false));
    let stats = Arc::new(TunnelStats::default());
    stats
        .handshake_rtt_us
        .store(handshake_rtt_us, Ordering::Relaxed);
    // Ping stamps are written by the keepalive thread and read back by the downlink thread,
    // so both must count from the same instant.
    let epoch = Instant::now();

    socket.set_read_timeout(Some(Duration::from_millis(200)))?;
    let sock_up = socket.try_clone()?;
    let sock_down = socket.try_clone()?;
    let sock_keep = socket.try_clone()?;

    let stop_up = Arc::clone(&stop);
    let stats_up = Arc::clone(&stats);
    let sid_up = session_id;
    let tun = Arc::new(tun);
    let tun_up = Arc::clone(&tun);
    let tun_down = Arc::clone(&tun);

    let uplink = thread::Builder::new()
        .name("gpb-uplink".into())
        .spawn(move || {
            let mut pkt_buf = [0u8; MAX_PACKET_LEN];
            let mut ip_buf = [0u8; MAX_PACKET_LEN - proto::DATA_HEADER_LEN];
            while !stop_up.load(Ordering::Relaxed) {
                let n = match tun_up.read(&mut ip_buf) {
                    Ok(n) => n,
                    Err(e)
                        if matches!(
                            e.kind(),
                            ErrorKind::InvalidData
                                | ErrorKind::WouldBlock
                                | ErrorKind::Interrupted
                                | ErrorKind::UnexpectedEof
                        ) =>
                    {
                        continue
                    }
                    Err(_) if stop_up.load(Ordering::Relaxed) => break,
                    Err(_) => {
                        thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                };
                if n == 0 {
                    continue;
                }
                if let Ok(total) = write_data(&mut pkt_buf, &sid_up, &ip_buf[..n]) {
                    if sock_up.send(&pkt_buf[..total]).is_ok() {
                        stats_up.packets_sent.fetch_add(1, Ordering::Relaxed);
                        stats_up.bytes_sent.fetch_add(n as u64, Ordering::Relaxed);
                    }
                }
            }
        })
        .map_err(|e| TunnelError::Msg(e.to_string()))?;

    let stop_down = Arc::clone(&stop);
    let stats_down = Arc::clone(&stats);
    let sid_down = session_id;
    let downlink = thread::Builder::new()
        .name("gpb-downlink".into())
        .spawn(move || {
            let mut buf = [0u8; MAX_PACKET_LEN];
            while !stop_down.load(Ordering::Relaxed) {
                match sock_down.recv(&mut buf) {
                    Ok(n) if n > 0 => {
                        let (ver, ty) = proto::parse_header(buf[0]);
                        if ver != proto::VERSION {
                            continue;
                        }
                        match ty {
                            proto::TYPE_DATA => {
                                if let Ok((sid, ip)) = try_read_data(&buf[..n]) {
                                    if sid != sid_down {
                                        continue;
                                    }
                                    if tun_down.write(ip).is_ok() {
                                        stats_down.packets_received.fetch_add(1, Ordering::Relaxed);
                                        stats_down
                                            .bytes_received
                                            .fetch_add(ip.len() as u64, Ordering::Relaxed);
                                    }
                                }
                            }
                            proto::TYPE_PONG => {
                                if let Ok((sid, stamp)) = try_read_pong(&buf[..n]) {
                                    if sid != sid_down {
                                        continue;
                                    }
                                    stats_down.pongs_received.fetch_add(1, Ordering::Relaxed);
                                    let now_us = epoch.elapsed().as_micros() as u64;
                                    if now_us >= stamp {
                                        stats_down.record_rtt(now_us - stamp);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    Ok(_) => {}
                    Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut => {}
                    Err(_) if stop_down.load(Ordering::Relaxed) => break,
                    Err(_) => {}
                }
            }
        })
        .map_err(|e| TunnelError::Msg(e.to_string()))?;

    let stop_keep = Arc::clone(&stop);
    let stats_keep = Arc::clone(&stats);
    let sid_keep = session_id;
    let keepalive_handle = thread::Builder::new()
        .name("gpb-keepalive".into())
        .spawn(move || {
            while !stop_keep.load(Ordering::Relaxed) {
                let stamp = epoch.elapsed().as_micros() as u64;
                let pkt = build_ping(&sid_keep, stamp);
                if sock_keep.send(&pkt).is_ok() {
                    stats_keep.pings_sent.fetch_add(1, Ordering::Relaxed);
                }
                // Sleep in small slices so shutdown is responsive.
                let mut left = keepalive;
                while left > Duration::ZERO && !stop_keep.load(Ordering::Relaxed) {
                    let slice = left.min(Duration::from_millis(100));
                    thread::sleep(slice);
                    left = left.saturating_sub(slice);
                }
            }
        })
        .map_err(|e| TunnelError::Msg(e.to_string()))?;

    Ok(TunnelSession {
        socket,
        session_id,
        stop,
        handles: vec![uplink, downlink, keepalive_handle],
        stats,
        handshake,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rtt_stats_follow_samples() {
        let s = TunnelStats::default();
        assert_eq!(s.last_rtt_ms(), None);
        for (i, us) in [40_000u64, 44_000, 38_000].into_iter().enumerate() {
            s.pongs_received.store(i as u64 + 1, Ordering::Relaxed);
            s.record_rtt(us);
        }
        assert_eq!(s.last_rtt_ms(), Some(38.0));
        assert_eq!(s.min_rtt_ms(), Some(38.0));
        // 40000 -> (7*40000+44000)/8 = 40500 -> (7*40500+38000)/8 = 40187
        assert_eq!(s.avg_rtt_us.load(Ordering::Relaxed), 40_187);
        // |44000-40000|/16 = 250 -> 250 + (6000-250)/16 = 609
        assert_eq!(s.jitter_us.load(Ordering::Relaxed), 609);
    }

    #[test]
    fn loss_ignores_the_ping_in_flight() {
        let s = TunnelStats::default();
        s.pings_sent.store(1, Ordering::Relaxed);
        assert_eq!(s.loss_pct(), None);
        s.pings_sent.store(11, Ordering::Relaxed);
        s.pongs_received.store(10, Ordering::Relaxed);
        assert_eq!(s.loss_pct(), Some(0.0));
        s.pongs_received.store(9, Ordering::Relaxed);
        assert_eq!(s.loss_pct(), Some(10.0));
    }
}
