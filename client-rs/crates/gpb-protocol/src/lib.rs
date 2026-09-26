//! GPB tunnel wire protocol v3 — must match
//! `relay/internal/protocol/protocol.go` and
//! `client/src/GamePingBooster.Core/Protocol/GpbProtocol.cs` byte for byte.

use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;
use subtle::ConstantTimeEq;
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

pub const VERSION: u8 = 3;

pub const TYPE_HANDSHAKE_REQ: u8 = 0x1;
pub const TYPE_HANDSHAKE_RESP: u8 = 0x2;
pub const TYPE_DATA: u8 = 0x3;
pub const TYPE_PING: u8 = 0x4;
pub const TYPE_PONG: u8 = 0x5;
pub const TYPE_DISCONNECT: u8 = 0x6;
pub const TYPE_DATA_ENCRYPTED: u8 = 0x7; // reserved, never sent
pub const TYPE_PROBE: u8 = 0x8;
pub const TYPE_PROBE_REPLY: u8 = 0x9;
/// Asks the relay for DataDup; a relay that supports it echoes the Hello, an older one drops it.
pub const TYPE_HELLO: u8 = 0xA;
/// Data plus a sequence number, every packet sent twice; the receiver drops the second copy.
pub const TYPE_DATA_DUP: u8 = 0xB;

pub const AUTH_MODE_PSK: u8 = 0;
pub const AUTH_MODE_TOKEN: u8 = 1;

pub const HANDSHAKE_REQ_PSK_LEN: usize = 58;
pub const HANDSHAKE_RESP_PSK_LEN: usize = 60;
pub const HANDSHAKE_RESP_V2_LEN: usize = 52;
pub const DATA_HEADER_LEN: usize = 9;
pub const DATA_DUP_HEADER_LEN: usize = 13;
pub const PING_LEN: usize = 17;
pub const PROBE_LEN: usize = 17;
pub const DISCONNECT_LEN: usize = 9;
pub const HELLO_LEN: usize = 9;
pub const MAX_PACKET_LEN: usize = 2048;
pub const NONCE_LEN: usize = 8;

pub const STATUS_OK: u8 = 0;
pub const STATUS_POOL_FULL: u8 = 1;
pub const STATUS_SHUTDOWN: u8 = 2;
pub const STATUS_VERSION_MISMATCH: u8 = 3;
pub const STATUS_CREDENTIAL_EXPIRED: u8 = 4;
pub const STATUS_CREDENTIAL_REVOKED: u8 = 5;
pub const STATUS_TIER_TOO_LOW: u8 = 6;

const REQ_OFF_MODE: usize = 1;
const REQ_OFF_NONCE: usize = 2;
const REQ_OFF_TIME: usize = 10;
const REQ_OFF_CLIENT_ID: usize = 18;
const REQ_OFF_AUTH: usize = 26;

const RESP_OFF_NONCE: usize = 20;
const RESP_OFF_AUTH: usize = 28;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("packet too short")]
    ShortPacket,
    #[error("wrong protocol version")]
    BadVersion,
    #[error("wrong message type")]
    BadType,
    #[error("invalid HMAC")]
    BadAuth,
    #[error("nonce echo mismatch")]
    BadNonce,
    #[error("handshake is for a different authentication mode")]
    BadAuthMode,
    #[error("payload is not an IPv4 packet")]
    NotIpv4,
    #[error("buffer too small")]
    BufferTooSmall,
}

pub type ClientId = [u8; 8];
pub type SessionId = [u8; 8];
pub type Nonce = [u8; 8];

#[inline]
pub fn header(msg_type: u8) -> u8 {
    (VERSION << 4) | (msg_type & 0x0f)
}

#[inline]
pub fn parse_header(b: u8) -> (u8, u8) {
    (b >> 4, b & 0x0f)
}

fn sign(psk: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(psk).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

fn hmac_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    bool::from(a.ct_eq(b))
}

/// Builds a PSK HandshakeReq. Returns the packet and the nonce to check against the response echo.
pub fn build_handshake_req(psk: &[u8], client_id: ClientId, unix_secs: u64) -> (Vec<u8>, Nonce) {
    let mut nonce = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut nonce);
    (build_handshake_req_with_nonce(psk, client_id, unix_secs, nonce), nonce)
}

/// Same as [`build_handshake_req`] but with a caller-supplied nonce (tests / deterministic builds).
pub fn build_handshake_req_with_nonce(
    psk: &[u8],
    client_id: ClientId,
    unix_secs: u64,
    nonce: Nonce,
) -> Vec<u8> {
    let mut pkt = vec![0u8; HANDSHAKE_REQ_PSK_LEN];
    pkt[0] = header(TYPE_HANDSHAKE_REQ);
    pkt[REQ_OFF_MODE] = AUTH_MODE_PSK;
    pkt[REQ_OFF_NONCE..REQ_OFF_TIME].copy_from_slice(&nonce);
    pkt[REQ_OFF_TIME..REQ_OFF_CLIENT_ID].copy_from_slice(&unix_secs.to_be_bytes());
    pkt[REQ_OFF_CLIENT_ID..REQ_OFF_AUTH].copy_from_slice(&client_id);
    let mac = sign(psk, &pkt[..REQ_OFF_AUTH]);
    pkt[REQ_OFF_AUTH..].copy_from_slice(&mac);
    pkt
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandshakeResult {
    pub status: u8,
    pub session_id: SessionId,
    pub client_ip: [u8; 4],
    pub relay_ip: [u8; 4],
    pub mtu: u16,
}

fn read_handshake_resp(pkt: &[u8]) -> HandshakeResult {
    let mut session_id = [0u8; 8];
    session_id.copy_from_slice(&pkt[2..10]);
    let mut client_ip = [0u8; 4];
    client_ip.copy_from_slice(&pkt[10..14]);
    let mut relay_ip = [0u8; 4];
    relay_ip.copy_from_slice(&pkt[14..18]);
    HandshakeResult {
        status: pkt[1],
        session_id,
        client_ip,
        relay_ip,
        mtu: u16::from_be_bytes([pkt[18], pkt[19]]),
    }
}

/// Builds a PSK HandshakeResp (used by tests; the relay owns the live path).
pub fn build_handshake_resp(
    psk: &[u8],
    status: u8,
    session_id: SessionId,
    client_ip: [u8; 4],
    relay_ip: [u8; 4],
    mtu: u16,
    nonce: Nonce,
) -> Vec<u8> {
    let mut pkt = vec![0u8; HANDSHAKE_RESP_PSK_LEN];
    pkt[0] = header(TYPE_HANDSHAKE_RESP);
    pkt[1] = status;
    pkt[2..10].copy_from_slice(&session_id);
    pkt[10..14].copy_from_slice(&client_ip);
    pkt[14..18].copy_from_slice(&relay_ip);
    pkt[18..20].copy_from_slice(&mtu.to_be_bytes());
    pkt[RESP_OFF_NONCE..RESP_OFF_AUTH].copy_from_slice(&nonce);
    let mac = sign(psk, &pkt[..RESP_OFF_AUTH]);
    pkt[RESP_OFF_AUTH..].copy_from_slice(&mac);
    pkt
}

/// v2-layout version-mismatch refusal (52 bytes).
pub fn build_version_mismatch_resp(psk: &[u8], client_version: u8) -> Vec<u8> {
    let mut pkt = vec![0u8; HANDSHAKE_RESP_V2_LEN];
    pkt[0] = (client_version << 4) | TYPE_HANDSHAKE_RESP;
    pkt[1] = STATUS_VERSION_MISMATCH;
    let mac = sign(psk, &pkt[..20]);
    pkt[20..].copy_from_slice(&mac);
    pkt
}

/// Parse and authenticate a PSK HandshakeResp (also accepts v2-layout version-mismatch).
pub fn try_parse_handshake_resp(
    psk: &[u8],
    pkt: &[u8],
    sent_nonce: &Nonce,
) -> Result<HandshakeResult, ProtocolError> {
    if pkt.len() == HANDSHAKE_RESP_V2_LEN {
        let (_, ty) = parse_header(pkt[0]);
        if ty != TYPE_HANDSHAKE_RESP {
            return Err(ProtocolError::BadType);
        }
        if pkt[1] != STATUS_VERSION_MISMATCH {
            return Err(ProtocolError::ShortPacket);
        }
        let expected = sign(psk, &pkt[..20]);
        if !hmac_eq(&expected, &pkt[20..]) {
            return Err(ProtocolError::BadAuth);
        }
        return Ok(read_handshake_resp(pkt));
    }

    if pkt.len() != HANDSHAKE_RESP_PSK_LEN {
        return Err(ProtocolError::ShortPacket);
    }
    let (version, ty) = parse_header(pkt[0]);
    if ty != TYPE_HANDSHAKE_RESP {
        return Err(ProtocolError::BadType);
    }
    if version != VERSION && pkt[1] != STATUS_VERSION_MISMATCH {
        return Err(ProtocolError::BadVersion);
    }
    let expected = sign(psk, &pkt[..RESP_OFF_AUTH]);
    if !hmac_eq(&expected, &pkt[RESP_OFF_AUTH..]) {
        return Err(ProtocolError::BadAuth);
    }
    if !hmac_eq(&pkt[RESP_OFF_NONCE..RESP_OFF_AUTH], sent_nonce) {
        return Err(ProtocolError::BadNonce);
    }
    Ok(read_handshake_resp(pkt))
}

/// Writes Data header + IPv4 packet into `dst`. Returns bytes written.
pub fn write_data(dst: &mut [u8], session_id: &SessionId, ip_packet: &[u8]) -> Result<usize, ProtocolError> {
    let need = DATA_HEADER_LEN + ip_packet.len();
    if dst.len() < need {
        return Err(ProtocolError::BufferTooSmall);
    }
    dst[0] = header(TYPE_DATA);
    dst[1..9].copy_from_slice(session_id);
    dst[DATA_HEADER_LEN..need].copy_from_slice(ip_packet);
    Ok(need)
}

/// Splits session id and IPv4 payload from a Data message. Payload aliases `pkt`.
pub fn try_read_data(pkt: &[u8]) -> Result<(SessionId, &[u8]), ProtocolError> {
    if pkt.len() <= DATA_HEADER_LEN {
        return Err(ProtocolError::ShortPacket);
    }
    let mut session_id = [0u8; 8];
    session_id.copy_from_slice(&pkt[1..9]);
    let payload = &pkt[DATA_HEADER_LEN..];
    if payload[0] >> 4 != 4 {
        return Err(ProtocolError::NotIpv4);
    }
    Ok((session_id, payload))
}

/// Writes a DataDup header (Data header plus a big-endian sequence number) and the packet.
pub fn write_data_dup(
    dst: &mut [u8],
    session_id: &SessionId,
    seq: u32,
    ip_packet: &[u8],
) -> Result<usize, ProtocolError> {
    let need = DATA_DUP_HEADER_LEN + ip_packet.len();
    if dst.len() < need {
        return Err(ProtocolError::BufferTooSmall);
    }
    dst[0] = header(TYPE_DATA_DUP);
    dst[1..9].copy_from_slice(session_id);
    dst[9..13].copy_from_slice(&seq.to_be_bytes());
    dst[DATA_DUP_HEADER_LEN..need].copy_from_slice(ip_packet);
    Ok(need)
}

/// Splits session id, sequence number and IPv4 payload from a DataDup message.
pub fn try_read_data_dup(pkt: &[u8]) -> Result<(SessionId, u32, &[u8]), ProtocolError> {
    if pkt.len() <= DATA_DUP_HEADER_LEN {
        return Err(ProtocolError::ShortPacket);
    }
    let mut session_id = [0u8; 8];
    session_id.copy_from_slice(&pkt[1..9]);
    let seq = u32::from_be_bytes(pkt[9..13].try_into().unwrap());
    let payload = &pkt[DATA_DUP_HEADER_LEN..];
    if payload[0] >> 4 != 4 {
        return Err(ProtocolError::NotIpv4);
    }
    Ok((session_id, seq, payload))
}

pub fn build_hello(session_id: &SessionId) -> Vec<u8> {
    let mut pkt = vec![0u8; HELLO_LEN];
    pkt[0] = header(TYPE_HELLO);
    pkt[1..9].copy_from_slice(session_id);
    pkt
}

/// Drops the second copy of a DataDup packet: remembers the highest sequence number and which
/// of the 63 before it arrived. Older than that window counts as seen - too late for a game.
/// Same rules as `DupFilter` in the relay.
#[derive(Default)]
pub struct DupFilter {
    top: u32,
    seen: u64,
    started: bool,
}

impl DupFilter {
    /// Whether `seq` is new; records it.
    pub fn fresh(&mut self, seq: u32) -> bool {
        if !self.started {
            (self.started, self.top, self.seen) = (true, seq, 1);
            return true;
        }
        // Serial-number arithmetic, so the filter survives the counter wrapping.
        let d = seq.wrapping_sub(self.top) as i32;
        if d > 0 {
            self.seen = if d >= 64 { 1 } else { (self.seen << d) | 1 };
            self.top = seq;
            true
        } else if d <= -64 {
            false
        } else {
            let bit = 1u64 << (-d);
            let fresh = self.seen & bit == 0;
            self.seen |= bit;
            fresh
        }
    }
}

fn build_ping_like(msg_type: u8, session_id: &SessionId, stamp: u64) -> Vec<u8> {
    let mut pkt = vec![0u8; PING_LEN];
    pkt[0] = header(msg_type);
    pkt[1..9].copy_from_slice(session_id);
    pkt[9..17].copy_from_slice(&stamp.to_be_bytes());
    pkt
}

pub fn build_ping(session_id: &SessionId, stamp: u64) -> Vec<u8> {
    build_ping_like(TYPE_PING, session_id, stamp)
}

pub fn build_pong(session_id: &SessionId, stamp: u64) -> Vec<u8> {
    build_ping_like(TYPE_PONG, session_id, stamp)
}

pub fn build_probe(session_id: &SessionId, stamp: u64) -> Vec<u8> {
    build_ping_like(TYPE_PROBE, session_id, stamp)
}

pub fn build_probe_reply(session_id: &SessionId, stamp: u64) -> Vec<u8> {
    build_ping_like(TYPE_PROBE_REPLY, session_id, stamp)
}

pub fn try_read_pong(pkt: &[u8]) -> Result<(SessionId, u64), ProtocolError> {
    if pkt.len() != PING_LEN {
        return Err(ProtocolError::ShortPacket);
    }
    let mut session_id = [0u8; 8];
    session_id.copy_from_slice(&pkt[1..9]);
    let stamp = u64::from_be_bytes(pkt[9..17].try_into().unwrap());
    Ok((session_id, stamp))
}

pub fn try_read_probe_reply(pkt: &[u8]) -> Result<(SessionId, u64), ProtocolError> {
    if pkt.len() != PROBE_LEN {
        return Err(ProtocolError::ShortPacket);
    }
    let (version, ty) = parse_header(pkt[0]);
    if version != VERSION || ty != TYPE_PROBE_REPLY {
        return Err(ProtocolError::BadType);
    }
    try_read_pong(pkt)
}

pub fn build_disconnect(session_id: &SessionId) -> Vec<u8> {
    let mut pkt = vec![0u8; DISCONNECT_LEN];
    pkt[0] = header(TYPE_DISCONNECT);
    pkt[1..9].copy_from_slice(session_id);
    pkt
}

/// Encode a `u64` client id as big-endian bytes (matches C# ulong layout).
pub fn client_id_from_u64(id: u64) -> ClientId {
    id.to_be_bytes()
}

pub fn client_id_to_u64(id: &ClientId) -> u64 {
    u64::from_be_bytes(*id)
}

pub fn session_id_from_u64(id: u64) -> SessionId {
    id.to_be_bytes()
}

pub fn ipv4_from_str(s: &str) -> Option<[u8; 4]> {
    let parts: Vec<_> = s.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut out = [0u8; 4];
    for (i, p) in parts.iter().enumerate() {
        out[i] = p.parse().ok()?;
    }
    Some(out)
}

pub fn ipv4_to_string(ip: &[u8; 4]) -> String {
    format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3])
}

#[cfg(test)]
mod vectors;

#[cfg(test)]
mod datadup_tests {
    use super::*;

    #[test]
    fn data_dup_round_trip() {
        let sid = [9, 8, 7, 6, 5, 4, 3, 2];
        let ip = [
            0x45u8, 0, 0, 20, 1, 2, 3, 4, 64, 17, 0, 0, 10, 77, 0, 2, 1, 1, 1, 1,
        ];
        let mut buf = [0u8; MAX_PACKET_LEN];
        let n = write_data_dup(&mut buf, &sid, 0xdead_beef, &ip).unwrap();
        assert_eq!(n, DATA_DUP_HEADER_LEN + ip.len());
        assert_eq!(parse_header(buf[0]), (VERSION, TYPE_DATA_DUP));
        let (got_sid, seq, payload) = try_read_data_dup(&buf[..n]).unwrap();
        assert_eq!((got_sid, seq, payload), (sid, 0xdead_beef, &ip[..]));
        assert_eq!(
            try_read_data_dup(&buf[..DATA_DUP_HEADER_LEN]),
            Err(ProtocolError::ShortPacket)
        );
    }

    /// Same steps as TestDupFilter in the relay, so the two filters agree.
    #[test]
    fn dup_filter_matches_the_relay() {
        let mut f = DupFilter::default();
        let steps = [
            (10, true),
            (10, false),
            (12, true),
            (11, true),
            (11, false),
            (12, false),
            (75, true),
            (12, false),
            (13, true),
            (11, false),
            (200, true),
            (199, true),
            (200, false),
        ];
        for (i, (seq, fresh)) in steps.into_iter().enumerate() {
            assert_eq!(f.fresh(seq), fresh, "step {i}: seq {seq}");
        }
    }

    #[test]
    fn dup_filter_wraps() {
        let mut f = DupFilter::default();
        for seq in [u32::MAX - 1, u32::MAX, 0, 1] {
            assert!(f.fresh(seq), "seq {seq:#x}");
        }
        assert!(!f.fresh(u32::MAX));
    }
}
