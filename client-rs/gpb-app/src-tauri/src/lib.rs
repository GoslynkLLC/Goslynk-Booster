//! Tauri backend: auth (local) + connect / disconnect / status (PSK tunnel).

mod auth;
mod profiles;

use gpb_net::{default_gateway, open_tun, PlatformRouteTable, RouteTable, TunDevice};
use gpb_profile::load_or_create_client_id;
use gpb_protocol::ipv4_to_string;
use gpb_tunnel::{clock, handshake, start_pumps, TunnelError, TunnelSession};
use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

/// `{"endpoint": "...", "psk": "..."}` from `src-tauri/relay.local.json` at build time, or `{}`.
const BUILD_RELAY_JSON: &str = include_str!(concat!(env!("OUT_DIR"), "/default_relay.json"));

const ADAPTER_NAME: &str = "Goslynk Booster";

struct LiveTunnel {
    session: TunnelSession,
    _routes: PlatformRouteTable,
}

pub struct AppState {
    live: Mutex<Option<LiveTunnel>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            live: Mutex::new(None),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectArgs {
    pub psk: String,
    pub endpoint: String,
    pub game_id: String,
    /// Regions of the game to route; `None` means every region.
    pub region_ids: Option<Vec<String>>,
    pub timeout_secs: Option<u64>,
    pub keepalive_secs: Option<u64>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayDefaults {
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub psk: String,
}

#[tauri::command]
fn default_relay() -> RelayDefaults {
    let mut d: RelayDefaults = serde_json::from_str(BUILD_RELAY_JSON).unwrap_or_default();
    if d.endpoint.trim().is_empty() {
        d.endpoint = profiles::builtin_relay_endpoint().unwrap_or_default();
    }
    d
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub inner_ip: String,
    pub gateway_ip: String,
    pub mtu: u16,
    pub handshake_rtt_ms: f64,
    pub tun_name: String,
    pub routes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    pub connected: bool,
    pub packets_sent: u64,
    pub packets_received: u64,
    pub pings_sent: u64,
    pub pongs_received: u64,
    pub last_rtt_ms: Option<f64>,
    pub handshake_rtt_ms: Option<f64>,
    pub inner_ip: Option<String>,
    pub mtu: Option<u16>,
}

#[tauri::command]
fn get_status(state: State<'_, AppState>) -> StatusSnapshot {
    let guard = state.live.lock().unwrap();
    match guard.as_ref() {
        None => StatusSnapshot {
            connected: false,
            packets_sent: 0,
            packets_received: 0,
            pings_sent: 0,
            pongs_received: 0,
            last_rtt_ms: None,
            handshake_rtt_ms: None,
            inner_ip: None,
            mtu: None,
        },
        Some(live) => {
            let s = &live.session.stats;
            StatusSnapshot {
                connected: true,
                packets_sent: s.packets_sent.load(std::sync::atomic::Ordering::Relaxed),
                packets_received: s.packets_received.load(std::sync::atomic::Ordering::Relaxed),
                pings_sent: s.pings_sent.load(std::sync::atomic::Ordering::Relaxed),
                pongs_received: s.pongs_received.load(std::sync::atomic::Ordering::Relaxed),
                last_rtt_ms: s.last_rtt_ms(),
                handshake_rtt_ms: s.handshake_rtt_ms(),
                inner_ip: Some(ipv4_to_string(&live.session.handshake.client_ip)),
                mtu: Some(live.session.handshake.mtu),
            }
        }
    }
}

#[tauri::command]
fn disconnect(state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.live.lock().map_err(|e| e.to_string())?;
    if let Some(live) = guard.take() {
        live.session.shutdown();
    }
    Ok(())
}

#[tauri::command]
fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    args: ConnectArgs,
) -> Result<ConnectResult, String> {
    {
        let guard = state.live.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("Đã kết nối. Hãy ngắt trước.".into());
        }
    }

    if args.psk.len() < 16 {
        return Err("PSK tối thiểu 16 ký tự.".into());
    }

    let endpoint: SocketAddr = args
        .endpoint
        .parse()
        .map_err(|e| format!("Endpoint không hợp lệ '{}': {e}", args.endpoint))?;

    let (profile, _) = profiles::load(&app, &args.game_id)?;
    let cidrs = profile
        .region_cidrs(Some(&args.game_id), args.region_ids.as_deref())
        .map_err(|e| e.to_string())?;
    if cidrs.is_empty() {
        return Err(
            "Khu vực đã chọn chưa có dải IP server nào - bật lên cũng không giảm được ping.".into(),
        );
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("App data dir: {e}"))?;
    let client_id = load_or_create_client_id(&data_dir.join("client-id"))
        .map_err(|e| format!("Client id: {e}"))?;

    let timeout = Duration::from_secs(args.timeout_secs.unwrap_or(8));
    let keepalive = Duration::from_secs(args.keepalive_secs.unwrap_or(15));

    let (socket, hs, stamp) = handshake(endpoint, args.psk.as_bytes(), client_id, timeout)
        .map_err(explain_handshake_error)?;

    let client_ip = Ipv4Addr::from(hs.client_ip);
    let relay_ip = Ipv4Addr::from(hs.relay_ip);

    let tun = open_tun(ADAPTER_NAME, client_ip, relay_ip, hs.mtu).map_err(|e| {
        format!(
            "Không mở được TUN: {e}. macOS: chạy bằng sudo. Windows: chạy bằng quyền Administrator."
        )
    })?;
    let tun_name = tun.name().to_string();

    let (phys_gw, phys_iface) =
        default_gateway().map_err(|e| format!("Default gateway: {e}"))?;
    let relay_host = match endpoint.ip() {
        std::net::IpAddr::V4(v4) => v4,
        std::net::IpAddr::V6(_) => return Err("Chưa hỗ trợ relay IPv6".into()),
    };

    let mut routes = PlatformRouteTable::default();
    #[cfg(target_os = "windows")]
    {
        routes.tun_ifindex = Some(tun.interface_index());
    }

    routes
        .pin_host(relay_host, phys_gw, &phys_iface)
        .map_err(|e| format!("Gắn route relay: {e}"))?;

    let mut routed = 0usize;
    for cidr in &cidrs {
        if routes.add_cidr(cidr, relay_ip, &tun_name).is_ok() {
            routed += 1;
        }
    }
    if routed == 0 {
        return Err("Không thêm được route nào qua tunnel.".into());
    }

    let result = ConnectResult {
        inner_ip: ipv4_to_string(&hs.client_ip),
        gateway_ip: ipv4_to_string(&hs.relay_ip),
        mtu: hs.mtu,
        handshake_rtt_ms: stamp.handshake_rtt_us as f64 / 1000.0,
        tun_name: tun_name.clone(),
        routes: routed,
    };

    let session = start_pumps(socket, hs, stamp.handshake_rtt_us, tun, keepalive)
        .map_err(|e| format!("Start pumps: {e}"))?;

    let mut guard = state.live.lock().map_err(|e| e.to_string())?;
    *guard = Some(LiveTunnel {
        session,
        _routes: routes,
    });

    Ok(result)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            connect,
            disconnect,
            get_status,
            default_relay,
            auth::login,
            auth::register,
            profiles::list_games,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
