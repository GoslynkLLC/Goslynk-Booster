//! UDP tunnel client: handshake, dedicated pump threads, keepalive.

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

pub struct TunnelStats {
    pub packets_sent: AtomicU64,
    pub packets_received: AtomicU64,
    pub pings_sent: AtomicU64,
    pub pongs_received: AtomicU64,
    pub last_rtt_us: AtomicU64, // 0 = none; otherwise microseconds
    pub handshake_rtt_us: AtomicU64,
}

impl TunnelStats {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            packets_sent: AtomicU64::new(0),
            packets_received: AtomicU64::new(0),
            pings_sent: AtomicU64::new(0),
            pongs_received: AtomicU64::new(0),
            last_rtt_us: AtomicU64::new(0),
            handshake_rtt_us: AtomicU64::new(0),
        })
    }

    pub fn last_rtt_ms(&self) -> Option<f64> {
        let us = self.last_rtt_us.load(Ordering::Relaxed);
        if us == 0 {
            None
        } else {
            Some(us as f64 / 1000.0)
        }
    }

    pub fn handshake_rtt_ms(&self) -> Option<f64> {
        let us = self.handshake_rtt_us.load(Ordering::Relaxed);
        if us == 0 {
            None
        } else {
            Some(us as f64 / 1000.0)
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
    let stats = TunnelStats::new();
    stats
        .handshake_rtt_us
        .store(handshake_rtt_us, Ordering::Relaxed);

    socket.set_read_timeout(Some(Duration::from_millis(200)))?;
    // Clone socket for each thread via try_clone.
    let sock_up = socket.try_clone()?;
    let sock_down = socket.try_clone()?;
    let sock_keep = socket.try_clone()?;

    let stop_up = Arc::clone(&stop);
    let stats_up = Arc::clone(&stats);
    let sid_up = session_id;
    // Split tun: we need read and write from two threads. Use a pair of Arc<Mutex<>> or
    // duplicate via raw approach. Simplest MVP: one mutex around the tun.
    let tun = Arc::new(std::sync::Mutex::new(tun));
    let tun_up = Arc::clone(&tun);
    let tun_down = Arc::clone(&tun);

    let uplink = thread::Builder::new()
        .name("gpb-uplink".into())
        .spawn(move || {
            let mut pkt_buf = [0u8; MAX_PACKET_LEN];
            let mut ip_buf = [0u8; MAX_PACKET_LEN - proto::DATA_HEADER_LEN];
            while !stop_up.load(Ordering::Relaxed) {
                let n = {
                    let mut t = tun_up.lock().unwrap();
                    match t.read(&mut ip_buf) {
                        Ok(n) => n,
                        Err(e) if e.kind() == ErrorKind::InvalidData => continue,
                        Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::Interrupted => {
                            continue
                        }
                        Err(e) if e.kind() == ErrorKind::UnexpectedEof => continue,
                        Err(_) if stop_up.load(Ordering::Relaxed) => break,
                        Err(_) => {
                            thread::sleep(Duration::from_millis(1));
                            continue;
                        }
                    }
                };
                if n == 0 {
                    continue;
                }
                // Drop non-unicast noise: IPv4 multicast/broadcast already filtered somewhat.
                if let Ok(total) = write_data(&mut pkt_buf, &sid_up, &ip_buf[..n]) {
                    if sock_up.send(&pkt_buf[..total]).is_ok() {
                        stats_up.packets_sent.fetch_add(1, Ordering::Relaxed);
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
            let clock = Instant::now();
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
                                    let mut t = tun_down.lock().unwrap();
                                    if t.write(ip).is_ok() {
                                        stats_down.packets_received.fetch_add(1, Ordering::Relaxed);
                                    }
                                }
                            }
                            proto::TYPE_PONG => {
                                if let Ok((sid, stamp)) = try_read_pong(&buf[..n]) {
                                    if sid != sid_down {
                                        continue;
                                    }
                                    stats_down.pongs_received.fetch_add(1, Ordering::Relaxed);
                                    let now_us = clock.elapsed().as_micros() as u64;
                                    if now_us >= stamp {
                                        stats_down
                                            .last_rtt_us
                                            .store(now_us - stamp, Ordering::Relaxed);
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
            let clock = Instant::now();
            while !stop_keep.load(Ordering::Relaxed) {
                let stamp = clock.elapsed().as_micros() as u64;
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
