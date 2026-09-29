//! Game profiles compiled into the binary, so an installed app never depends on the
//! working directory. A file at `<app data>/profiles/<game id>.json` overrides the
//! built-in copy, which is how ranges get updated without rebuilding.

use gpb_profile::GameProfile;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const WINDOWS: &str = "windows";
const MACOS: &str = "macos";
const BOTH: &[&str] = &[WINDOWS, MACOS];

/// The OS this build runs on, named as in `BuiltinGame::platforms`.
const CURRENT_PLATFORM: &str = if cfg!(target_os = "macos") {
    MACOS
} else {
    WINDOWS
};

struct BuiltinGame {
    id: &'static str,
    name_vi: &'static str,
    is_default: bool,
    /// Where the game runs and can be boosted.
    platforms: &'static [&'static str],
    json: &'static str,
}

/// Listed in the order the game grid shows them.
const BUILTIN: &[BuiltinGame] = &[
    BuiltinGame {
        id: "pubg",
        name_vi: "PUBG",
        is_default: false,
        platforms: &[WINDOWS],
        json: include_str!("../../../../profiles/pubg-vn.json"),
    },
    BuiltinGame {
        id: "cs2",
        name_vi: "CS2",
        is_default: false,
        platforms: BOTH,
        json: include_str!("../../../../profiles/cs2-vn.json"),
    },
    BuiltinGame {
        id: "valorant",
        name_vi: "VALORANT",
        is_default: false,
        platforms: &[WINDOWS],
        json: include_str!("../../../../profiles/valorant-vn.json"),
    },
    BuiltinGame {
        id: "tft",
        name_vi: "Đấu Trường Chân Lý",
        is_default: false,
        platforms: &[WINDOWS],
        json: include_str!("../../../../profiles/tft-vn.json"),
    },
    BuiltinGame {
        id: "lol",
        name_vi: "Liên Minh Huyền Thoại",
        is_default: true,
        platforms: BOTH,
        json: include_str!("../../../../profiles/lol-vn.json"),
    },
    BuiltinGame {
        id: "deltaforce",
        name_vi: "Delta Force",
        is_default: false,
        platforms: &[WINDOWS],
        json: include_str!("../../../../profiles/deltaforce-vn.json"),
    },
    BuiltinGame {
        id: "wot",
        name_vi: "World of Tanks",
        is_default: false,
        platforms: &[WINDOWS],
        json: include_str!("../../../../profiles/wot-asia.json"),
    },
    BuiltinGame {
        id: "naraka",
        name_vi: "Naraka: Bladepoint",
        is_default: false,
        platforms: &[WINDOWS],
        json: include_str!("../../../../profiles/naraka-vn.json"),
    },
    BuiltinGame {
        id: "steam",
        name_vi: "Steam",
        is_default: false,
        platforms: BOTH,
        json: include_str!("../../../../profiles/steam-sg.json"),
    },
    BuiltinGame {
        id: "roblox",
        name_vi: "Roblox",
        is_default: false,
        platforms: &[MACOS],
        json: include_str!("../../../../profiles/roblox-sg.json"),
    },
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionInfo {
    pub id: String,
    pub name: String,
    pub note: Option<String>,
    pub default_on: bool,
    pub cidr_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInfo {
    pub id: String,
    pub name: String,
    pub name_vi: String,
    pub is_default: bool,
    pub custom_profile: bool,
    pub process_names: Vec<String>,
    pub regions: Vec<RegionInfo>,
    pub platforms: &'static [&'static str],
    /// Whether this machine's OS is one of `platforms`.
    pub supported: bool,
}

pub fn override_path(app: &AppHandle, game_id: &str) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join("profiles").join(format!("{game_id}.json")))
}

/// The profile for `game_id`, and whether it came from the override file.
pub fn load(app: &AppHandle, game_id: &str) -> Result<(GameProfile, bool), String> {
    let builtin = BUILTIN
        .iter()
        .find(|g| g.id == game_id)
        .ok_or_else(|| format!("Không có game '{game_id}'."))?;
    if let Some(path) = override_path(app, game_id).filter(|p| p.is_file()) {
        let raw = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let profile = GameProfile::from_json(&raw)
            .map_err(|e| format!("Profile {} lỗi: {e}", path.display()))?;
        return Ok((profile, true));
    }
    let profile = GameProfile::from_json(builtin.json)
        .map_err(|e| format!("Profile có sẵn của '{game_id}' lỗi: {e}"))?;
    Ok((profile, false))
}

fn platform_label(platform: &str) -> &'static str {
    if platform == MACOS {
        "macOS"
    } else {
        "Windows"
    }
}

/// Refuses a game that does not run on this OS, whatever the UI let through.
pub fn ensure_supported(game_id: &str) -> Result<(), String> {
    let builtin = BUILTIN
        .iter()
        .find(|g| g.id == game_id)
        .ok_or_else(|| format!("Không có game '{game_id}'."))?;
    if builtin.platforms.contains(&CURRENT_PLATFORM) {
        Ok(())
    } else {
        Err(format!(
            "{} chưa boost được trên {}.",
            builtin.name_vi,
            platform_label(CURRENT_PLATFORM)
        ))
    }
}

/// First relay endpoint any built-in profile names.
pub fn builtin_relay_endpoint() -> Option<String> {
    BUILTIN.iter().find_map(|g| {
        GameProfile::from_json(g.json)
            .ok()?
            .relays
            .first()
            .map(|r| r.endpoint.clone())
    })
}

#[tauri::command]
pub fn list_games(app: AppHandle) -> Result<Vec<GameInfo>, String> {
    let mut out = Vec::with_capacity(BUILTIN.len());
    for b in BUILTIN {
        let (profile, custom) = load(&app, b.id)?;
        let game = profile.game(Some(b.id)).map_err(|e| e.to_string())?;
        out.push(GameInfo {
            id: b.id.into(),
            name: game.name.clone(),
            name_vi: b.name_vi.into(),
            is_default: b.is_default,
            custom_profile: custom,
            process_names: game.process_names.clone(),
            regions: game
                .regions
                .iter()
                .map(|r| RegionInfo {
                    id: r.id.clone(),
                    name: r.name.clone(),
                    note: r.note.clone(),
                    default_on: r.default_on,
                    cidr_count: r.cidrs.len(),
                })
                .collect(),
            platforms: b.platforms,
            supported: b.platforms.contains(&CURRENT_PLATFORM),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_profiles_parse() {
        for b in BUILTIN {
            let p = GameProfile::from_json(b.json).expect(b.id);
            assert!(p.game(Some(b.id)).is_ok(), "{} missing its own game", b.id);
        }
        assert_eq!(BUILTIN.iter().filter(|b| b.is_default).count(), 1);
        assert!(BUILTIN.iter().all(|b| !b.platforms.is_empty()));
        assert!(
            BUILTIN.iter().any(|b| b.is_default && b.platforms == BOTH),
            "the default game must run everywhere"
        );
        assert!(builtin_relay_endpoint().is_some());
    }

    #[test]
    fn unsupported_games_are_refused() {
        for b in BUILTIN {
            let supported = b.platforms.contains(&CURRENT_PLATFORM);
            assert_eq!(ensure_supported(b.id).is_ok(), supported, "{}", b.id);
        }
        assert!(ensure_supported("nope").is_err());
    }
}
