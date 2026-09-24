//! Tauri backend: auth (local) + connect / disconnect / status (PSK tunnel).

mod auth;

use gpb_net::{default_gateway, open_tun, PlatformRouteTable, RouteTable, TunDevice};
use gpb_profile::{load_or_create_client_id, GameProfile};
use gpb_protocol::ipv4_to_string;
use gpb_tunnel::{handshake, start_pumps, TunnelSession};
use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

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
    pub profile_path: String,
    pub game_id: Option<String>,
    pub client_id_path: Option<String>,
    pub adapter_name: Option<String>,
    pub route_without_game: Option<bool>,
    pub timeout_secs: Option<u64>,
    pub keepalive_secs: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub inner_ip: String,
    pub gateway_ip: String,
    pub mtu: u16,
    pub handshake_rtt_ms: f64,
    pub tun_name: String,
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
fn connect(state: State<'_, AppState>, args: ConnectArgs) -> Result<ConnectResult, String> {
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

    let profile =
        GameProfile::load(&args.profile_path).map_err(|e| format!("Không đọc được profile: {e}"))?;
    let cidrs = profile
        .game_cidrs(args.game_id.as_deref())
        .map_err(|e| e.to_string())?;

    let client_id_path = PathBuf::from(
        args.client_id_path
            .unwrap_or_else(|| "gpb-client-id".into()),
    );
    let client_id =
        load_or_create_client_id(&client_id_path).map_err(|e| format!("Client id: {e}"))?;

    let timeout = Duration::from_secs(args.timeout_secs.unwrap_or(8));
    let keepalive = Duration::from_secs(args.keepalive_secs.unwrap_or(15));
    let adapter_name = args
        .adapter_name
        .unwrap_or_else(|| "Game Ping Booster".into());
    let route_without_game = args.route_without_game.unwrap_or(true);

    let (socket, hs, stamp) = handshake(endpoint, args.psk.as_bytes(), client_id, timeout)
        .map_err(|e| format!("Handshake thất bại: {e}"))?;

    let client_ip = Ipv4Addr::from(hs.client_ip);
    let relay_ip = Ipv4Addr::from(hs.relay_ip);

    let tun = open_tun(&adapter_name, client_ip, relay_ip, hs.mtu).map_err(|e| {
        format!(
            "Không mở được TUN: {e}. macOS: chạy bằng sudo. Windows: Admin/LocalSystem + wintun.dll."
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

    if route_without_game {
        for cidr in &cidrs {
            let _ = routes.add_cidr(cidr, relay_ip, &tun_name);
        }
    }

    let result = ConnectResult {
        inner_ip: ipv4_to_string(&hs.client_ip),
        gateway_ip: ipv4_to_string(&hs.relay_ip),
        mtu: hs.mtu,
        handshake_rtt_ms: stamp.handshake_rtt_us as f64 / 1000.0,
        tun_name: tun_name.clone(),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            connect,
            disconnect,
            get_status,
            auth::login,
            auth::register,
            auth::list_games,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
