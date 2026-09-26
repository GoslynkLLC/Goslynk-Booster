//! Game profile and daemon config (JSON).

use serde::Deserialize;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProfileError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Msg(String),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameProfile {
    pub schema_version: Option<i32>,
    pub games: Vec<GameEntry>,
    pub relays: Vec<RelayEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub process_names: Vec<String>,
    #[serde(default)]
    pub regions: Vec<RegionEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RegionEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub note: Option<String>,
    /// False for a region the listed relays make slower (a server far from them), so a UI
    /// leaves it unticked until the player asks for it.
    #[serde(rename = "defaultOn", default = "default_true")]
    pub default_on: bool,
    #[serde(default)]
    pub cidrs: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RelayEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub location: String,
    pub endpoint: String,
}

impl GameProfile {
    pub fn load(path: impl AsRef<Path>) -> Result<Self, ProfileError> {
        let raw = fs::read_to_string(path)?;
        Self::from_json(&raw)
    }

    pub fn from_json(raw: &str) -> Result<Self, ProfileError> {
        Ok(serde_json::from_str(raw.trim_start_matches('\u{feff}'))?)
    }

    /// The named game, or the first one if `game_id` is None.
    pub fn game(&self, game_id: Option<&str>) -> Result<&GameEntry, ProfileError> {
        match game_id {
            Some(id) => self
                .games
                .iter()
                .find(|g| g.id == id)
                .ok_or_else(|| ProfileError::Msg(format!("game id '{id}' not in profile"))),
            None => self
                .games
                .first()
                .ok_or_else(|| ProfileError::Msg("profile has no games".into())),
        }
    }

    /// All CIDRs across every region of the named game (or first game if `game_id` is None).
    pub fn game_cidrs(&self, game_id: Option<&str>) -> Result<Vec<String>, ProfileError> {
        self.region_cidrs(game_id, None)
    }

    /// CIDRs of the chosen regions only; `None` means every region.
    pub fn region_cidrs(
        &self,
        game_id: Option<&str>,
        region_ids: Option<&[String]>,
    ) -> Result<Vec<String>, ProfileError> {
        let game = self.game(game_id)?;
        if let Some(ids) = region_ids {
            if let Some(bad) = ids.iter().find(|id| !game.regions.iter().any(|r| &r.id == *id)) {
                return Err(ProfileError::Msg(format!(
                    "region '{bad}' not in game '{}'",
                    game.id
                )));
            }
        }
        let mut out = Vec::new();
        for region in &game.regions {
            if region_ids.is_some_and(|ids| !ids.contains(&region.id)) {
                continue;
            }
            for cidr in &region.cidrs {
                if !out.contains(cidr) {
                    out.push(cidr.clone());
                }
            }
        }
        Ok(out)
    }

    pub fn relay_endpoint(&self, relay_id: Option<&str>) -> Result<SocketAddr, ProfileError> {
        let relay = match relay_id {
            Some(id) => self
                .relays
                .iter()
                .find(|r| r.id == id)
                .ok_or_else(|| ProfileError::Msg(format!("relay id '{id}' not in profile")))?,
            None => self
                .relays
                .first()
                .ok_or_else(|| ProfileError::Msg("profile has no relays".into()))?,
        };
        relay
            .endpoint
            .parse()
            .map_err(|e| ProfileError::Msg(format!("bad relay endpoint '{}': {e}", relay.endpoint)))
    }
}

/// Daemon config — shape close to `gpb-mac.json / gpb-win.json`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonConfig {
    /// Absolute or repo-relative path to a profile JSON.
    pub profile_path: PathBuf,
    pub psk: String,
    #[serde(default)]
    pub default_relay_id: Option<String>,
    /// Override profile relay endpoint (host:port).
    #[serde(default)]
    pub relay_endpoint: Option<String>,
    #[serde(default)]
    pub default_game_id: Option<String>,
    /// Regions of that game to route; omitted means every region.
    #[serde(default)]
    pub region_ids: Option<Vec<String>>,
    /// Path to an 8-byte (or hex/u64 text) client id file. Created with a random id if missing.
    #[serde(default = "default_client_id_path")]
    pub client_id_path: PathBuf,
    #[serde(default = "default_adapter_name")]
    pub adapter_name: String,
    /// Install game CIDRs even without detecting a game process (macOS MVP always needs this).
    #[serde(default = "default_true")]
    pub route_without_game: bool,
}

fn default_client_id_path() -> PathBuf {
    PathBuf::from("gpb-client-id")
}

fn default_adapter_name() -> String {
    "Goslynk Booster".into()
}

fn default_true() -> bool {
    true
}

impl DaemonConfig {
    pub fn load(path: impl AsRef<Path>) -> Result<Self, ProfileError> {
        let raw = fs::read_to_string(path)?;
        let cfg: DaemonConfig = serde_json::from_str(&raw)?;
        if cfg.psk.len() < 16 {
            return Err(ProfileError::Msg(
                "psk must be at least 16 characters".into(),
            ));
        }
        Ok(cfg)
    }

    pub fn resolve_endpoint(&self, profile: &GameProfile) -> Result<SocketAddr, ProfileError> {
        if let Some(ep) = &self.relay_endpoint {
            return ep
                .parse()
                .map_err(|e| ProfileError::Msg(format!("bad relayEndpoint '{ep}': {e}")));
        }
        profile.relay_endpoint(self.default_relay_id.as_deref())
    }
}

/// Load or create a stable 8-byte client id (big-endian u64 stored as 16 hex chars).
pub fn load_or_create_client_id(path: &Path) -> Result<[u8; 8], ProfileError> {
    if path.exists() {
        let s = fs::read_to_string(path)?.trim().to_string();
        if s.len() == 16 && s.chars().all(|c| c.is_ascii_hexdigit()) {
            let bytes = hex_decode_8(&s)?;
            return Ok(bytes);
        }
        if let Ok(n) = s.parse::<u64>() {
            return Ok(n.to_be_bytes());
        }
        return Err(ProfileError::Msg(format!(
            "client id file {path:?} must be 16 hex chars or a decimal u64"
        )));
    }
    let mut id = [0u8; 8];
    getrandom_fill(&mut id);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    fs::write(path, hex_encode(&id))?;
    Ok(id)
}

fn hex_decode_8(s: &str) -> Result<[u8; 8], ProfileError> {
    let mut out = [0u8; 8];
    for i in 0..8 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
            .map_err(|e| ProfileError::Msg(format!("bad hex: {e}")))?;
    }
    Ok(out)
}

fn hex_encode(b: &[u8; 8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn getrandom_fill(buf: &mut [u8]) {
    use rand::RngCore;
    rand::thread_rng().fill_bytes(buf);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_example_profile() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../profiles/pubg-vn.json");
        let p = GameProfile::load(&path).expect("load example");
        assert!(!p.games.is_empty());
        let cidrs = p.game_cidrs(Some("pubg")).unwrap();
        assert!(cidrs.iter().any(|c| c.contains('/')));
        let ep = p.relay_endpoint(None).unwrap();
        assert_eq!(ep.port(), 51820);
    }

    #[test]
    fn every_example_profile_parses_and_routes_something() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../profiles");
        for (file, game) in [
            ("lol-vn.json", "lol"),
            ("tft-vn.json", "tft"),
            ("pubg-vn.json", "pubg"),
            ("valorant-vn.json", "valorant"),
            ("cs2-vn.json", "cs2"),
            ("naraka-vn.json", "naraka"),
            ("deltaforce-vn.json", "deltaforce"),
            ("steam-sg.json", "steam"),
        ] {
            let p = GameProfile::load(dir.join(file)).expect(file);
            let cidrs = p.game_cidrs(Some(game)).unwrap();
            assert!(!cidrs.is_empty(), "{file} routes nothing");
            assert!(p.relay_endpoint(None).is_ok(), "{file} has no relay");
        }
    }

    #[test]
    fn region_filter() {
        let p = GameProfile::from_json(
            r#"{"games":[{"id":"g","name":"G","regions":[
                {"id":"a","name":"A","cidrs":["1.0.0.0/24","2.0.0.0/24"]},
                {"id":"b","name":"B","cidrs":["2.0.0.0/24","3.0.0.0/24"]}]}],
               "relays":[]}"#,
        )
        .unwrap();
        assert_eq!(p.game_cidrs(None).unwrap().len(), 3);
        assert!(p.games[0].regions.iter().all(|r| r.default_on));
        let only_b = p.region_cidrs(Some("g"), Some(&["b".into()])).unwrap();
        assert_eq!(only_b, vec!["2.0.0.0/24", "3.0.0.0/24"]);
        assert!(p.region_cidrs(Some("g"), Some(&["zz".into()])).is_err());
    }
}
