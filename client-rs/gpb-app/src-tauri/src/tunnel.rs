//! Handshake + TUN + routes + pumps. Runs in the app process when it already has the
//! privileges, otherwise inside the root helper (see `helper.rs`).

use gpb_net::{default_gateway, open_tun, PlatformRouteTable, RouteTable, TunDevice};
use gpb_protocol::{ipv4_to_string, ClientId};
use gpb_tunnel::{clock, handshake, start_pumps, TunnelError, TunnelSession};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::Ordering;
use std::time::Duration;

const ADAPTER_NAME: &str = "Goslynk Booster";

/// Everything needed to bring the tunnel up, already resolved by the app.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelRequest {
    pub endpoint: String,
    pub psk: String,
    pub client_id: ClientId,
    pub cidrs: Vec<String>,
    pub timeout_secs: u64,
    pub keepalive_secs: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub inner_ip: String,
    pub gateway_ip: String,
    pub mtu: u16,
    pub handshake_rtt_ms: f64,
    pub tun_name: String,
    pub routes: usize,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    pub connected: bool,
    pub packets_sent: u64,
    pub packets_received: u64,
    pub bytes_sent: u64,
    pub bytes_received: u64,
    pub pings_sent: u64,
    pub pongs_received: u64,
    pub last_rtt_ms: Option<f64>,
    pub avg_rtt_ms: Option<f64>,
    pub min_rtt_ms: Option<f64>,
    pub jitter_ms: Option<f64>,
    pub loss_pct: Option<f64>,
    pub handshake_rtt_ms: Option<f64>,
    pub inner_ip: Option<String>,
    pub mtu: Option<u16>,
    /// Games whose routes go through the tunnel; filled in by the app, not the helper.
    #[serde(default)]
    pub games: Vec<String>,
}

pub struct LiveTunnel {
    session: TunnelSession,
    routes: PlatformRouteTable,
    cidrs: BTreeSet<String>,
    relay_ip: Ipv4Addr,
    tun_name: String,
}

impl LiveTunnel {
    /// Routes exactly `cidrs` through the tunnel, keeping the ones already installed so the
    /// games that stay boosted never lose their path. Returns how many routes are installed.
    pub fn set_cidrs(&mut self, cidrs: &[String]) -> Result<usize, String> {
        let want: BTreeSet<String> = cidrs.iter().cloned().collect();
        let gone: Vec<String> = self.cidrs.difference(&want).cloned().collect();
        for cidr in gone {
            let _ = self.routes.delete_cidr(&cidr);
            self.cidrs.remove(&cidr);
        }
        let mut failed = 0;
        for cidr in want.difference(&self.cidrs.clone()) {
            match self.routes.add_cidr(cidr, self.relay_ip, &self.tun_name) {
                Ok(()) => {
                    self.cidrs.insert(cidr.clone());
                }
                Err(_) => failed += 1,
            }
        }
        if failed > 0 && self.cidrs.is_empty() {
            return Err("Không thêm được route nào qua tunnel.".into());
        }
        Ok(self.cidrs.len())
    }

    pub fn status(&self) -> StatusSnapshot {
        let s = &self.session.stats;
        StatusSnapshot {
            connected: true,
            packets_sent: s.packets_sent.load(Ordering::Relaxed),
            packets_received: s.packets_received.load(Ordering::Relaxed),
            bytes_sent: s.bytes_sent.load(Ordering::Relaxed),
            bytes_received: s.bytes_received.load(Ordering::Relaxed),
            pings_sent: s.pings_sent.load(Ordering::Relaxed),
            pongs_received: s.pongs_received.load(Ordering::Relaxed),
            last_rtt_ms: s.last_rtt_ms(),
            avg_rtt_ms: s.avg_rtt_ms(),
            min_rtt_ms: s.min_rtt_ms(),
            jitter_ms: s.jitter_ms(),
            loss_pct: s.loss_pct(),
            handshake_rtt_ms: s.handshake_rtt_ms(),
            inner_ip: Some(ipv4_to_string(&self.session.handshake.client_ip)),
            mtu: Some(self.session.handshake.mtu),
            games: Vec::new(),
        }
    }

    pub fn shutdown(self) {
        self.session.shutdown();
        drop(self.routes);
    }
}

pub fn establish(req: &TunnelRequest) -> Result<(LiveTunnel, ConnectResult), String> {
    let endpoint: SocketAddr = req
        .endpoint
        .parse()
        .map_err(|e| format!("Endpoint không hợp lệ '{}': {e}", req.endpoint))?;
    let relay_host = match endpoint.ip() {
        std::net::IpAddr::V4(v4) => v4,
        std::net::IpAddr::V6(_) => return Err("Chưa hỗ trợ relay IPv6".into()),
    };

    let (socket, hs, stamp) = handshake(
        endpoint,
        req.psk.as_bytes(),
        req.client_id,
        Duration::from_secs(req.timeout_secs),
    )
    .map_err(explain_handshake_error)?;

    let client_ip = Ipv4Addr::from(hs.client_ip);
    let relay_ip = Ipv4Addr::from(hs.relay_ip);

    let tun = open_tun(ADAPTER_NAME, client_ip, relay_ip, hs.mtu).map_err(|e| {
        if cfg!(target_os = "windows") {
            format!("Không mở được TUN: {e}. Hãy mở app bằng quyền Administrator.")
        } else {
            format!("Không mở được TUN: {e}.")
        }
    })?;
    let tun_name = tun.name().to_string();

    let (phys_gw, phys_iface) = default_gateway().map_err(|e| format!("Default gateway: {e}"))?;

    let mut routes = PlatformRouteTable::default();
    #[cfg(target_os = "windows")]
    {
        routes.tun_ifindex = Some(tun.interface_index());
    }

    routes
        .pin_host(relay_host, phys_gw, &phys_iface)
        .map_err(|e| format!("Gắn route relay: {e}"))?;

    let cidrs: BTreeSet<String> = req
        .cidrs
        .iter()
        .filter(|cidr| routes.add_cidr(cidr, relay_ip, &tun_name).is_ok())
        .cloned()
        .collect();
    if cidrs.is_empty() {
        return Err("Không thêm được route nào qua tunnel.".into());
    }

    let result = ConnectResult {
        inner_ip: ipv4_to_string(&hs.client_ip),
        gateway_ip: ipv4_to_string(&hs.relay_ip),
        mtu: hs.mtu,
        handshake_rtt_ms: stamp.handshake_rtt_us as f64 / 1000.0,
        tun_name: tun_name.clone(),
        routes: cidrs.len(),
    };

    let session = start_pumps(
        socket,
        hs,
        stamp.handshake_rtt_us,
        tun,
        Duration::from_secs(req.keepalive_secs),
    )
    .map_err(|e| format!("Start pumps: {e}"))?;

    Ok((
        LiveTunnel {
            session,
            routes,
            cidrs,
            relay_ip,
            tun_name: result.tun_name.clone(),
        },
        result,
    ))
}

fn explain_handshake_error(e: TunnelError) -> String {
    if !matches!(e, TunnelError::HandshakeTimeout) {
        return format!("Handshake thất bại: {e}");
    }
    match clock::clock_offset_secs(Duration::from_secs(2)) {
        Some(off) if off.abs() > clock::HANDSHAKE_SKEW_SECS / 2.0 => format!(
            "Đồng hồ máy đang {} {:.0} giây nên relay từ chối kết nối. \
             Bật \"Đặt giờ tự động\" (Set time automatically) rồi thử lại.",
            if off > 0.0 { "nhanh" } else { "chậm" },
            off.abs()
        ),
        _ => "Relay không phản hồi. Kiểm tra endpoint, PSK, và cổng UDP trên firewall của VPS."
            .into(),
    }
}
