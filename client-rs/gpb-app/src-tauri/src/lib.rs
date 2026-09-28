//! Tauri backend: game profiles + boost / unboost / status (PSK tunnel).
//! Accounts live on the Goslynk API; the webview talks to it directly.
//!
//! Up to `MAX_BOOSTED` games share one tunnel: boosting a game adds its server ranges to the
//! tunnel's routes, stopping it removes them, and the tunnel closes with the last game.

#[cfg(target_os = "macos")]
mod helper;
mod hwid;
mod profiles;
mod tunnel;

use gpb_profile::load_or_create_client_id;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tunnel::{ConnectResult, LiveTunnel, StatusSnapshot, TunnelRequest};

const MAX_BOOSTED: usize = 3;

#[cfg(target_os = "macos")]
pub use helper::{run as run_tunnel_helper, HELPER_FLAG};

/// `{"endpoint": "...", "psk": "..."}` from `src-tauri/relay.local.json` at build time, or `{}`.
const BUILD_RELAY_JSON: &str = include_str!(concat!(env!("OUT_DIR"), "/default_relay.json"));

enum Live {
    InProcess(LiveTunnel),
    #[cfg(target_os = "macos")]
    Helper(helper::HelperTunnel),
}

impl Live {
    fn status(&mut self) -> Option<StatusSnapshot> {
        match self {
            Live::InProcess(t) => Some(t.status()),
            #[cfg(target_os = "macos")]
            Live::Helper(h) => h.status(),
        }
    }

    fn set_cidrs(&mut self, cidrs: &[String]) -> Result<usize, String> {
        match self {
            Live::InProcess(t) => t.set_cidrs(cidrs),
            #[cfg(target_os = "macos")]
            Live::Helper(h) => h.set_cidrs(cidrs),
        }
    }

    fn shutdown(self) {
        match self {
            Live::InProcess(t) => t.shutdown(),
            #[cfg(target_os = "macos")]
            Live::Helper(h) => h.shutdown(),
        }
    }
}

type GameRoutes = BTreeMap<String, Vec<String>>;

struct Boosted {
    live: Live,
    /// Game id -> the ranges it routes; the tunnel carries their union.
    games: GameRoutes,
}

fn union(games: &GameRoutes) -> Vec<String> {
    let all: BTreeSet<&String> = games.values().flatten().collect();
    all.into_iter().cloned().collect()
}

#[derive(Default)]
pub struct AppState {
    boosted: Mutex<Option<Boosted>>,
    /// Serialises boost changes so two quick clicks never race to bring the tunnel up.
    ops: tauri::async_runtime::Mutex<()>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoostArgs {
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

/// Async (like every command that may wait on the tunnel) so it never blocks the UI thread.
/// Hashed machine id sent with redeem codes (see `hwid`).
#[tauri::command]
fn get_hwid() -> Result<String, String> {
    hwid::machine_hash()
}

#[tauri::command]
async fn get_status(state: State<'_, AppState>) -> Result<StatusSnapshot, String> {
    let mut guard = state.boosted.lock().map_err(|e| e.to_string())?;
    let snapshot = guard.as_mut().and_then(|b| {
        b.live.status().map(|mut s| {
            s.games = b.games.keys().cloned().collect();
            s
        })
    });
    Ok(match snapshot {
        Some(s) => s,
        None => {
            *guard = None;
            StatusSnapshot::default()
        }
    })
}

/// Stops every boosted game.
#[tauri::command]
async fn disconnect(state: State<'_, AppState>) -> Result<(), String> {
    let _op = state.ops.lock().await;
    let taken = state.boosted.lock().map_err(|e| e.to_string())?.take();
    shutdown(taken).await
}

/// Starts boosting a game, or re-applies its regions when it is already boosted.
/// Returns the boosted game ids.
#[tauri::command]
async fn boost_game(
    app: AppHandle,
    state: State<'_, AppState>,
    args: BoostArgs,
) -> Result<Vec<String>, String> {
    let _op = state.ops.lock().await;

    let (profile, _) = profiles::load(&app, &args.game_id)?;
    let cidrs = profile
        .region_cidrs(Some(&args.game_id), args.region_ids.as_deref())
        .map_err(|e| e.to_string())?;
    if cidrs.is_empty() {
        return Err(
            "Khu vực đã chọn chưa có dải IP server nào - bật lên cũng không giảm được ping.".into(),
        );
    }

    let current = state
        .boosted
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|b| b.games.clone());
    if let Some(mut games) = current {
        if !games.contains_key(&args.game_id) && games.len() >= MAX_BOOSTED {
            return Err(format!(
                "Tối đa {MAX_BOOSTED} game cùng lúc. Dừng một game ở Home trước."
            ));
        }
        games.insert(args.game_id, cidrs);
        return apply_routes(&app, games).await;
    }

    if args.psk.len() < 16 {
        return Err("PSK tối thiểu 16 ký tự.".into());
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("App data dir: {e}"))?;
    let client_id = load_or_create_client_id(&data_dir.join("client-id"))
        .map_err(|e| format!("Client id: {e}"))?;

    let req = TunnelRequest {
        endpoint: args.endpoint,
        psk: args.psk,
        client_id,
        cidrs: cidrs.clone(),
        timeout_secs: args.timeout_secs.unwrap_or(8),
        // Every keepalive is also the RTT probe the UI shows, so probe once a second.
        keepalive_secs: args.keepalive_secs.unwrap_or(1),
    };

    // Async so the window stays responsive during the handshake and the macOS password dialog.
    let (live, _) = tauri::async_runtime::spawn_blocking(move || bring_up(&req))
        .await
        .map_err(|e| e.to_string())??;

    let games = GameRoutes::from([(args.game_id, cidrs)]);
    let ids = games.keys().cloned().collect();
    *state.boosted.lock().map_err(|e| e.to_string())? = Some(Boosted { live, games });
    Ok(ids)
}

/// Stops boosting one game; the tunnel closes when no game is left. Returns the boosted ids.
#[tauri::command]
async fn unboost_game(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
) -> Result<Vec<String>, String> {
    let _op = state.ops.lock().await;
    let (remaining, last) = {
        let mut guard = state.boosted.lock().map_err(|e| e.to_string())?;
        let mut games = guard.as_ref().map(|b| b.games.clone()).unwrap_or_default();
        games.remove(&game_id);
        let last = if games.is_empty() { guard.take() } else { None };
        (games, last)
    };
    if remaining.is_empty() {
        shutdown(last).await?;
        return Ok(Vec::new());
    }
    apply_routes(&app, remaining).await
}

/// Points the running tunnel at the union of `games`' ranges. Route changes spawn `route`
/// processes (or wait on the macOS helper), so they run off the async threads.
async fn apply_routes(app: &AppHandle, games: GameRoutes) -> Result<Vec<String>, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut guard = state.boosted.lock().map_err(|e| e.to_string())?;
        let boosted = guard.as_mut().ok_or("Tunnel đã dừng, hãy boost lại.")?;
        boosted.live.set_cidrs(&union(&games))?;
        boosted.games = games;
        Ok(boosted.games.keys().cloned().collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn shutdown(boosted: Option<Boosted>) -> Result<(), String> {
    let Some(b) = boosted else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || b.live.shutdown())
        .await
        .map_err(|e| e.to_string())
}

fn bring_up(req: &TunnelRequest) -> Result<(Live, ConnectResult), String> {
    #[cfg(target_os = "macos")]
    if helper::needs_helper() {
        return helper::HelperTunnel::launch(req).map(|(h, r)| (Live::Helper(h), r));
    }
    tunnel::establish(req).map(|(t, r)| (Live::InProcess(t), r))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            boost_game,
            unboost_game,
            disconnect,
            get_status,
            default_relay,
            get_hwid,
            profiles::list_games,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
