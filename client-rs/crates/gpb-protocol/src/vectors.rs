//! Golden-packet tests against `testdata/protocol-vectors.json` (shared with Go and C#).

use super::*;
use hmac::Mac;
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

#[derive(Deserialize)]
struct VectorFile {
    psk: String,
    version: u8,
    #[serde(rename = "handshakeReq")]
    handshake_req: HandshakeReqVec,
    #[serde(rename = "handshakeResp")]
    handshake_resp: HandshakeRespVec,
    #[serde(rename = "versionMismatchResp")]
    version_mismatch_resp: VersionMismatchVec,
    data: DataVec,
    ping: PingVec,
    pong: PingVec,
    probe: PingVec,
    #[serde(rename = "probeReply")]
    probe_reply: PingVec,
    disconnect: DisconnectVec,
}

#[derive(Deserialize)]
struct HandshakeReqVec {
    #[serde(rename = "clientIdHex")]
    client_id_hex: String,
    #[serde(rename = "unixTimeSeconds")]
    unix_time_seconds: u64,
    #[serde(rename = "nonceHex")]
    nonce_hex: String,
    #[serde(rename = "packetHex")]
    packet_hex: String,
}

#[derive(Deserialize)]
struct HandshakeRespVec {
    status: u8,
    #[serde(rename = "nonceHex")]
    nonce_hex: String,
    #[serde(rename = "sessionIdHex")]
    session_id_hex: String,
    #[serde(rename = "clientIp")]
    client_ip: String,
    #[serde(rename = "relayIp")]
    relay_ip: String,
    mtu: u16,
    #[serde(rename = "packetHex")]
    packet_hex: String,
}

#[derive(Deserialize)]
struct VersionMismatchVec {
    #[serde(rename = "clientVersion")]
    client_version: u8,
    #[serde(rename = "packetHex")]
    packet_hex: String,
}

#[derive(Deserialize)]
struct DataVec {
    #[serde(rename = "sessionIdHex")]
    session_id_hex: String,
    #[serde(rename = "innerHex")]
    inner_hex: String,
    #[serde(rename = "packetHex")]
    packet_hex: String,
}

#[derive(Deserialize)]
struct PingVec {
    #[serde(rename = "sessionIdHex")]
    session_id_hex: String,
    stamp: u64,
    #[serde(rename = "packetHex")]
    packet_hex: String,
}

#[derive(Deserialize)]
struct DisconnectVec {
    #[serde(rename = "sessionIdHex")]
    session_id_hex: String,
    #[serde(rename = "packetHex")]
    packet_hex: String,
}

fn vectors_path() -> PathBuf {
    // client-rs/crates/gpb-protocol -> repo root
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../testdata/protocol-vectors.json")
}

fn load() -> VectorFile {
    let raw = fs::read_to_string(vectors_path()).expect("read protocol-vectors.json");
    serde_json::from_str(&raw).expect("parse protocol-vectors.json")
}

fn hex(s: &str) -> Vec<u8> {
    hex::decode(s).expect("hex")
}

fn sid_from(hex_str: &str) -> SessionId {
    let b = hex(hex_str);
    assert_eq!(b.len(), 8);
    let mut sid = [0u8; 8];
    sid.copy_from_slice(&b);
    sid
}

#[test]
fn protocol_vectors() {
    let v = load();
    assert_eq!(v.version, VERSION, "vectors version must match this crate");

    let psk = v.psk.as_bytes();
    let client_id = {
        let b = hex(&v.handshake_req.client_id_hex);
        let mut id = [0u8; 8];
        id.copy_from_slice(&b);
        id
    };
    let session_id = sid_from(&v.handshake_resp.session_id_hex);

    // HandshakeReq — nonce is random so we verify HMAC layout, not byte-identity of a rebuild.
    let req_pkt = hex(&v.handshake_req.packet_hex);
    assert_eq!(req_pkt.len(), HANDSHAKE_REQ_PSK_LEN);
    assert_eq!(req_pkt[1], AUTH_MODE_PSK);
    assert_eq!(hex::encode(&req_pkt[2..10]), v.handshake_req.nonce_hex);
    let expected_mac = {
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(psk).unwrap();
        mac.update(&req_pkt[..26]);
        mac.finalize().into_bytes()
    };
    assert_eq!(
        &req_pkt[26..],
        expected_mac.as_slice(),
        "golden HandshakeReq HMAC"
    );
    assert_eq!(&req_pkt[18..26], &client_id);
    let ts = u64::from_be_bytes(req_pkt[10..18].try_into().unwrap());
    assert_eq!(ts, v.handshake_req.unix_time_seconds);

    // Rebuild with the committed nonce must match byte for byte.
    let mut nonce = [0u8; 8];
    nonce.copy_from_slice(&hex(&v.handshake_req.nonce_hex));
    let rebuilt_req = build_handshake_req_with_nonce(
        psk,
        client_id,
        v.handshake_req.unix_time_seconds,
        nonce,
    );
    assert_eq!(
        rebuilt_req, req_pkt,
        "HandshakeReq with fixed nonce must match golden packet"
    );

    // HandshakeResp
    let resp_pkt = hex(&v.handshake_resp.packet_hex);
    let mut resp_nonce = [0u8; 8];
    resp_nonce.copy_from_slice(&hex(&v.handshake_resp.nonce_hex));
    let client_ip = ipv4_from_str(&v.handshake_resp.client_ip).unwrap();
    let relay_ip = ipv4_from_str(&v.handshake_resp.relay_ip).unwrap();
    let rebuilt = build_handshake_resp(
        psk,
        v.handshake_resp.status,
        session_id,
        client_ip,
        relay_ip,
        v.handshake_resp.mtu,
        resp_nonce,
    );
    assert_eq!(rebuilt, resp_pkt, "HandshakeResp changed");

    let parsed = try_parse_handshake_resp(psk, &resp_pkt, &resp_nonce).expect("parse resp");
    assert_eq!(parsed.session_id, session_id);
    assert_eq!(parsed.client_ip, client_ip);
    assert_eq!(parsed.relay_ip, relay_ip);
    assert_eq!(parsed.mtu, v.handshake_resp.mtu);
    assert_eq!(parsed.status, STATUS_OK);

    // Version mismatch
    let mismatch = build_version_mismatch_resp(psk, v.version_mismatch_resp.client_version);
    assert_eq!(mismatch, hex(&v.version_mismatch_resp.packet_hex));

    // Data
    let inner = hex(&v.data.inner_hex);
    let sid = sid_from(&v.data.session_id_hex);
    let mut buf = [0u8; MAX_PACKET_LEN];
    let n = write_data(&mut buf, &sid, &inner).unwrap();
    assert_eq!(&buf[..n], hex(&v.data.packet_hex));
    let data_pkt = hex(&v.data.packet_hex);
    let (dec_sid, dec_inner) = try_read_data(&data_pkt).unwrap();
    assert_eq!(dec_sid, sid);
    assert_eq!(dec_inner, inner.as_slice());

    // Ping / Pong / Probe
    let ping_sid = sid_from(&v.ping.session_id_hex);
    assert_eq!(build_ping(&ping_sid, v.ping.stamp), hex(&v.ping.packet_hex));
    assert_eq!(
        build_pong(&sid_from(&v.pong.session_id_hex), v.pong.stamp),
        hex(&v.pong.packet_hex)
    );
    assert_eq!(
        build_probe(&sid_from(&v.probe.session_id_hex), v.probe.stamp),
        hex(&v.probe.packet_hex)
    );
    assert_eq!(
        build_probe_reply(&sid_from(&v.probe_reply.session_id_hex), v.probe_reply.stamp),
        hex(&v.probe_reply.packet_hex)
    );

    // Disconnect
    let d_sid = sid_from(&v.disconnect.session_id_hex);
    assert_eq!(build_disconnect(&d_sid), hex(&v.disconnect.packet_hex));
}
