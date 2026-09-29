//! UDP tunnel client: handshake, dedicated pump threads, keepalive.

pub mod clock;

use gpb_net::TunDevice;
use gpb_protocol::{
    self as proto, build_disconnect, build_handshake_req, build_hello, build_multipath,
    build_ping, try_parse_handshake_resp, try_read_data, try_read_data_dup, try_read_pong,
    write_data, write_data_dup, ClientId, DupFilter, HandshakeResult, SessionId, MAX_PACKET_LEN,
};
use std::io::ErrorKind;
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
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
    /// Set once the relay echoed our Hello: both directions now send every packet twice.
    pub redundant: AtomicBool,
    /// Distinct DataDup packets received, and second copies dropped. Their difference is how
    /// many packets arrived only because of the other copy.
    pub dup_packets: AtomicU64,
    pub dup_copies: AtomicU64,
    /// A second road (an entry) was given to the tunnel.
    pub has_alt: AtomicBool,
    /// Set once the relay echoed Multipath: each DataDup copy now takes a different road.
    pub multipath: AtomicBool,
    /// Last round trip measured down the second road, microseconds.
    pub alt_rtt_us: AtomicU64,
    /// Downlink packets whose first copy came in over the second road.
    pub alt_first: AtomicU64,
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

    pub fn alt_rtt_ms(&self) -> Option<f64> {
        us_to_ms(self.alt_rtt_us.load(Ordering::Relaxed))
    }

    /// Downlink packets that one copy lost and the other delivered.
    pub fn rescued_packets(&self) -> u64 {
        self.dup_packets
            .load(Ordering::Relaxed)
            .saturating_sub(self.dup_copies.load(Ordering::Relaxed))
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

/// Median round trip of `count` Probes sent down `sock` (connected to the relay or to an entry in
/// front of it) for session `sid`, or `None` when nothing came back. A Probe moves nothing on the
/// relay, so this is safe on a road the session is not using. Call it before the pumps start:
/// they read the same socket.
pub fn probe_rtt(
    sock: &UdpSocket,
    sid: &SessionId,
    count: usize,
    timeout: Duration,
) -> Option<Duration> {
    let mut samples = Vec::with_capacity(count);
    let mut buf = [0u8; 64];
    let epoch = Instant::now();
    sock.set_read_timeout(Some(Duration::from_millis(50))).ok()?;
    for _ in 0..count {
        let stamp = epoch.elapsed().as_micros() as u64;
        if sock.send(&proto::build_probe(sid, stamp)).is_err() {
            continue;
        }
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let Ok(n) = sock.recv(&mut buf) else { continue };
            match proto::try_read_probe_reply(&buf[..n]) {
                Ok((got_sid, got)) if got_sid == *sid && got == stamp => {
                    samples.push(epoch.elapsed().saturating_sub(Duration::from_micros(stamp)));
                    break;
                }
                _ => {}
            }
        }
    }
    samples.sort();
    samples.get(samples.len() / 2).copied()
}

/// Picks the roads a session runs on from their measured round trips, in ms (`None` = no answer):
/// the fastest as the main road, and the next fastest as the second one when it is no more than
/// max(15 ms, 50 %) behind - a second road far slower than the first only ever delivers late copies.
pub fn choose_roads(rtts: &[Option<f64>]) -> Option<(usize, Option<usize>)> {
    let mut ranked: Vec<(usize, f64)> = rtts
        .iter()
        .enumerate()
        .filter_map(|(i, r)| r.map(|ms| (i, ms)))
        .collect();
    ranked.sort_by(|a, b| a.1.total_cmp(&b.1));
    let (main, main_ms) = *ranked.first()?;
    let second = ranked
        .get(1)
        .filter(|(_, ms)| *ms <= main_ms + (main_ms * 0.5).max(15.0))
        .map(|(i, _)| *i);
    Some((main, second))
}

/// After a successful handshake, start pumps between `tun` and the UDP socket.
pub fn start_pumps<T: TunDevice + 'static>(
    socket: UdpSocket,
    handshake: HandshakeResult,
    handshake_rtt_us: u64,
    tun: T,
    keepalive: Duration,
) -> Result<TunnelSession, TunnelError> {
    start_pumps_multipath(socket, None, handshake, handshake_rtt_us, tun, keepalive)
}

/// Like [`start_pumps`], with an optional second road to the same relay (`alt`, a socket connected
/// to an entry in front of it). Once the relay agrees to Multipath each DataDup copy goes down a
/// different road; until then `alt` stays silent, because a Ping or Data from a second address
/// would move a single-path session over to it.
pub fn start_pumps_multipath<T: TunDevice + 'static>(
    socket: UdpSocket,
    alt: Option<UdpSocket>,
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
    stats.has_alt.store(alt.is_some(), Ordering::Relaxed);
    // Ping stamps are written by the keepalive thread and read back by the downlink threads,
    // so all of them must count from the same instant.
    let epoch = Instant::now();

    socket.set_read_timeout(Some(Duration::from_millis(200)))?;
    if let Some(a) = &alt {
        a.set_read_timeout(Some(Duration::from_millis(200)))?;
    }
    let alt_up = alt.as_ref().map(UdpSocket::try_clone).transpose()?;
    let alt_keep = alt.as_ref().map(UdpSocket::try_clone).transpose()?;

    let tun = Arc::new(tun);
    let seen = Arc::new(Mutex::new(DupFilter::default()));
    let mut handles = Vec::with_capacity(4);

    let uplink = Uplink {
        sock: socket.try_clone()?,
        alt: alt_up,
        tun: Arc::clone(&tun),
        stop: Arc::clone(&stop),
        stats: Arc::clone(&stats),
        session_id,
    };
    handles.push(spawn("gpb-uplink", move || uplink.run())?);

    let down = Downlink {
        sock: socket.try_clone()?,
        is_alt: false,
        tun: Arc::clone(&tun),
        stop: Arc::clone(&stop),
        stats: Arc::clone(&stats),
        seen: Arc::clone(&seen),
        session_id,
        epoch,
    };
    handles.push(spawn("gpb-downlink", move || down.run())?);

    if let Some(alt_sock) = alt {
        let down_alt = Downlink {
            sock: alt_sock,
            is_alt: true,
            tun: Arc::clone(&tun),
            stop: Arc::clone(&stop),
            stats: Arc::clone(&stats),
            seen,
            session_id,
            epoch,
        };
        handles.push(spawn("gpb-downlink-alt", move || down_alt.run())?);
    }

    let keep = Keepalive {
        sock: socket.try_clone()?,
        alt: alt_keep,
        stop: Arc::clone(&stop),
        stats: Arc::clone(&stats),
        session_id,
        epoch,
        interval: keepalive,
    };
    handles.push(spawn("gpb-keepalive", move || keep.run())?);

    Ok(TunnelSession {
        socket,
        session_id,
        stop,
        handles,
        stats,
        handshake,
    })
}

fn spawn(name: &str, f: impl FnOnce() + Send + 'static) -> Result<JoinHandle<()>, TunnelError> {
    thread::Builder::new()
        .name(name.into())
        .spawn(f)
        .map_err(|e| TunnelError::Msg(e.to_string()))
}

struct Uplink<T> {
    sock: UdpSocket,
    alt: Option<UdpSocket>,
    tun: Arc<T>,
    stop: Arc<AtomicBool>,
    stats: Arc<TunnelStats>,
    session_id: SessionId,
}

impl<T: TunDevice> Uplink<T> {
    fn run(self) {
        gpb_net::prioritize_current_thread();
        let mut pkt_buf = [0u8; MAX_PACKET_LEN];
        let mut ip_buf = [0u8; MAX_PACKET_LEN - proto::DATA_DUP_HEADER_LEN];
        let mut seq = 0u32;
        while !self.stop.load(Ordering::Relaxed) {
            let n = match self.tun.read(&mut ip_buf) {
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
                Err(_) if self.stop.load(Ordering::Relaxed) => break,
                Err(_) => {
                    thread::sleep(Duration::from_millis(1));
                    continue;
                }
            };
            if n == 0 {
                continue;
            }
            let redundant = self.stats.redundant.load(Ordering::Relaxed);
            let encoded = if redundant {
                seq = seq.wrapping_add(1);
                write_data_dup(&mut pkt_buf, &self.session_id, seq, &ip_buf[..n])
            } else {
                write_data(&mut pkt_buf, &self.session_id, &ip_buf[..n])
            };
            let Ok(total) = encoded else { continue };
            let pkt = &pkt_buf[..total];
            let first = self.sock.send(pkt).is_ok();
            // One copy per road when there are two; back to back on the one road otherwise, where
            // the second copy still covers the random single drops of a busy route.
            let second = redundant
                && match (&self.alt, self.stats.multipath.load(Ordering::Relaxed)) {
                    (Some(alt), true) => alt.send(pkt).is_ok(),
                    _ => self.sock.send(pkt).is_ok(),
                };
            if first || second {
                self.stats.packets_sent.fetch_add(1, Ordering::Relaxed);
                self.stats.bytes_sent.fetch_add(n as u64, Ordering::Relaxed);
            }
        }
    }
}

struct Downlink<T> {
    sock: UdpSocket,
    is_alt: bool,
    tun: Arc<T>,
    stop: Arc<AtomicBool>,
    stats: Arc<TunnelStats>,
    seen: Arc<Mutex<DupFilter>>,
    session_id: SessionId,
    epoch: Instant,
}

impl<T: TunDevice> Downlink<T> {
    fn run(self) {
        gpb_net::prioritize_current_thread();
        let mut buf = [0u8; MAX_PACKET_LEN];
        while !self.stop.load(Ordering::Relaxed) {
            match self.sock.recv(&mut buf) {
                Ok(n) if n > 0 => self.handle(&buf[..n]),
                Ok(_) => {}
                Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut => {}
                Err(_) if self.stop.load(Ordering::Relaxed) => break,
                Err(_) => {}
            }
        }
    }

    fn deliver(&self, ip: &[u8]) {
        if self.tun.write(ip).is_ok() {
            self.stats.packets_received.fetch_add(1, Ordering::Relaxed);
            self.stats
                .bytes_received
                .fetch_add(ip.len() as u64, Ordering::Relaxed);
        }
    }

    fn handle(&self, pkt: &[u8]) {
        let (ver, ty) = proto::parse_header(pkt[0]);
        if ver != proto::VERSION {
            return;
        }
        let stats = &self.stats;
        match ty {
            proto::TYPE_DATA => {
                if let Ok((sid, ip)) = try_read_data(pkt) {
                    if sid == self.session_id {
                        self.deliver(ip);
                    }
                }
            }
            proto::TYPE_DATA_DUP => {
                let Ok((sid, seq, ip)) = try_read_data_dup(pkt) else {
                    return;
                };
                if sid != self.session_id {
                    return;
                }
                let fresh = self.seen.lock().map(|mut f| f.fresh(seq)).unwrap_or(true);
                if !fresh {
                    stats.dup_copies.fetch_add(1, Ordering::Relaxed);
                    return;
                }
                stats.dup_packets.fetch_add(1, Ordering::Relaxed);
                if self.is_alt {
                    stats.alt_first.fetch_add(1, Ordering::Relaxed);
                }
                self.deliver(ip);
            }
            proto::TYPE_HELLO => {
                if pkt.len() == proto::HELLO_LEN && pkt[1..9] == self.session_id {
                    stats.redundant.store(true, Ordering::Relaxed);
                }
            }
            proto::TYPE_MULTIPATH => {
                if pkt.len() == proto::MULTIPATH_LEN && pkt[1..9] == self.session_id {
                    stats.multipath.store(true, Ordering::Relaxed);
                }
            }
            proto::TYPE_PONG => {
                let Ok((sid, stamp)) = try_read_pong(pkt) else {
                    return;
                };
                if sid != self.session_id {
                    return;
                }
                let now_us = self.epoch.elapsed().as_micros() as u64;
                if self.is_alt {
                    if now_us >= stamp {
                        stats
                            .alt_rtt_us
                            .store((now_us - stamp).max(1), Ordering::Relaxed);
                    }
                    return;
                }
                stats.pongs_received.fetch_add(1, Ordering::Relaxed);
                if now_us >= stamp {
                    stats.record_rtt(now_us - stamp);
                }
            }
            _ => {}
        }
    }
}

struct Keepalive {
    sock: UdpSocket,
    alt: Option<UdpSocket>,
    stop: Arc<AtomicBool>,
    stats: Arc<TunnelStats>,
    session_id: SessionId,
    epoch: Instant,
    interval: Duration,
}

impl Keepalive {
    fn run(self) {
        let sid = &self.session_id;
        while !self.stop.load(Ordering::Relaxed) {
            let stamp = self.epoch.elapsed().as_micros() as u64;
            let ping = build_ping(sid, stamp);
            if self.sock.send(&ping).is_ok() {
                self.stats.pings_sent.fetch_add(1, Ordering::Relaxed);
            }
            let redundant = self.stats.redundant.load(Ordering::Relaxed);
            let multipath = self.stats.multipath.load(Ordering::Relaxed);
            // Each repeated until the relay echoes it; an older relay never does, and the tunnel
            // carries on as it is.
            if !redundant {
                let _ = self.sock.send(&build_hello(sid));
            } else if let Some(alt) = &self.alt {
                if multipath {
                    // Keeps the second road registered with the relay and times it.
                    let _ = alt.send(&ping);
                } else {
                    let _ = self.sock.send(&build_multipath(sid));
                }
            }
            // Sleep in small slices so shutdown is responsive.
            let mut left = self.interval;
            while left > Duration::ZERO && !self.stop.load(Ordering::Relaxed) {
                let slice = left.min(Duration::from_millis(100));
                thread::sleep(slice);
                left = left.saturating_sub(slice);
            }
        }
    }
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

    struct FakeTun {
        inbound: Mutex<std::sync::mpsc::Receiver<Vec<u8>>>,
        written: Mutex<Vec<Vec<u8>>>,
    }

    impl TunDevice for FakeTun {
        fn name(&self) -> &str {
            "fake"
        }
        fn read(&self, buf: &mut [u8]) -> std::io::Result<usize> {
            let rx = self.inbound.lock().unwrap();
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(p) => {
                    buf[..p.len()].copy_from_slice(&p);
                    Ok(p.len())
                }
                Err(_) => Err(ErrorKind::WouldBlock.into()),
            }
        }
        fn write(&self, buf: &[u8]) -> std::io::Result<usize> {
            self.written.lock().unwrap().push(buf.to_vec());
            Ok(buf.len())
        }
    }

    fn ipv4_packet() -> Vec<u8> {
        let mut p = vec![0u8; 28];
        p[0] = 0x45;
        p[3] = 28;
        p[9] = 17;
        p[12..16].copy_from_slice(&[10, 77, 0, 2]);
        p[16..20].copy_from_slice(&[1, 1, 1, 1]);
        p
    }

    /// Next packet of `ty` on `sock`, skipping everything else; also returns who sent it.
    fn recv_type(sock: &UdpSocket, ty: u8) -> (Vec<u8>, SocketAddr) {
        let mut buf = [0u8; MAX_PACKET_LEN];
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok((n, from)) = sock.recv_from(&mut buf) {
                if proto::parse_header(buf[0]).1 == ty {
                    return (buf[..n].to_vec(), from);
                }
            }
        }
        panic!("no packet of type {ty:#x} arrived");
    }

    fn wait_until(what: &str, cond: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !cond() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn multipath_sends_one_copy_per_road_and_keeps_the_first_copy_down() {
        let relay = UdpSocket::bind("127.0.0.1:0").unwrap();
        let entry = UdpSocket::bind("127.0.0.1:0").unwrap();
        relay.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
        entry.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
        let client = UdpSocket::bind("127.0.0.1:0").unwrap();
        client.connect(relay.local_addr().unwrap()).unwrap();
        let alt = UdpSocket::bind("127.0.0.1:0").unwrap();
        alt.connect(entry.local_addr().unwrap()).unwrap();

        let sid: SessionId = [7; 8];
        let handshake = HandshakeResult {
            status: proto::STATUS_OK,
            session_id: sid,
            client_ip: [10, 77, 0, 2],
            relay_ip: [10, 77, 0, 1],
            mtu: 1400,
        };
        let (tx, rx) = std::sync::mpsc::channel();
        let tun = Arc::new(FakeTun {
            inbound: Mutex::new(rx),
            written: Mutex::new(Vec::new()),
        });
        let session = start_pumps_multipath(
            client,
            Some(alt),
            handshake,
            1,
            SharedTun(Arc::clone(&tun)),
            Duration::from_millis(50),
        )
        .unwrap();

        let (_, client_addr) = recv_type(&relay, proto::TYPE_HELLO);
        relay.send_to(&build_hello(&sid), client_addr).unwrap();
        recv_type(&relay, proto::TYPE_MULTIPATH);
        relay.send_to(&build_multipath(&sid), client_addr).unwrap();
        wait_until("multipath", || session.stats.multipath.load(Ordering::Relaxed));
        let (_, alt_addr) = recv_type(&entry, proto::TYPE_PING);

        tx.send(ipv4_packet()).unwrap();
        let (a, _) = recv_type(&relay, proto::TYPE_DATA_DUP);
        let (b, _) = recv_type(&entry, proto::TYPE_DATA_DUP);
        assert_eq!(a, b, "the two roads carried different packets");

        let mut out = [0u8; MAX_PACKET_LEN];
        let n = write_data_dup(&mut out, &sid, 5, &ipv4_packet()).unwrap();
        entry.send_to(&out[..n], alt_addr).unwrap();
        relay.send_to(&out[..n], client_addr).unwrap();
        wait_until("both copies", || {
            session.stats.dup_packets.load(Ordering::Relaxed)
                + session.stats.dup_copies.load(Ordering::Relaxed)
                >= 2
        });
        assert_eq!(tun.written.lock().unwrap().len(), 1, "the second copy reached the TUN");
        session.shutdown();
    }

    struct SharedTun(Arc<FakeTun>);

    impl TunDevice for SharedTun {
        fn name(&self) -> &str {
            self.0.name()
        }
        fn read(&self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.0.read(buf)
        }
        fn write(&self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.write(buf)
        }
    }

    #[test]
    fn roads_are_the_fastest_and_a_close_second() {
        assert_eq!(choose_roads(&[]), None);
        assert_eq!(choose_roads(&[None, None]), None);
        assert_eq!(choose_roads(&[Some(8.0)]), Some((0, None)));
        assert_eq!(choose_roads(&[Some(8.0), Some(20.0)]), Some((0, Some(1))));
        assert_eq!(choose_roads(&[Some(8.0), Some(30.0)]), Some((0, None)));
        assert_eq!(choose_roads(&[Some(60.0), None, Some(40.0)]), Some((2, Some(0))));
        assert_eq!(choose_roads(&[Some(100.0), Some(40.0), Some(90.0)]), Some((1, None)));
    }

    #[test]
    fn probe_rtt_times_the_replies_and_ignores_strangers() {
        let relay = UdpSocket::bind("127.0.0.1:0").unwrap();
        let client = UdpSocket::bind("127.0.0.1:0").unwrap();
        client.connect(relay.local_addr().unwrap()).unwrap();
        let sid: SessionId = [3; 8];
        let echo = thread::spawn(move || {
            let mut buf = [0u8; 64];
            for _ in 0..3 {
                let (n, from) = relay.recv_from(&mut buf).unwrap();
                let (s, stamp) = try_read_pong(&buf[..n]).unwrap();
                relay.send_to(&proto::build_probe_reply(&[9; 8], stamp), from).unwrap();
                relay.send_to(&proto::build_probe_reply(&s, stamp), from).unwrap();
            }
        });
        let rtt = probe_rtt(&client, &sid, 3, Duration::from_millis(500));
        echo.join().unwrap();
        assert!(rtt.is_some_and(|d| d < Duration::from_millis(500)));
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
