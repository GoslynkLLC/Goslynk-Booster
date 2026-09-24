//! Local account store (MVP). Not the commercial licence server — email/password
//! hashed with SHA-256 + salt, kept under the OS app-data directory.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicUser {
    pub username: String,
    pub display_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct AccountRecord {
    username: String,
    display_name: String,
    salt_hex: String,
    password_hash_hex: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct AccountFile {
    accounts: Vec<AccountRecord>,
}

fn accounts_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("accounts.json"))
}

fn load(app: &AppHandle) -> Result<AccountFile, String> {
    let path = accounts_path(app)?;
    if !path.exists() {
        return Ok(AccountFile::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("parse accounts: {e}"))
}

fn save(app: &AppHandle, file: &AccountFile) -> Result<(), String> {
    let path = accounts_path(app)?;
    let raw = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

fn hash_password(salt: &[u8], password: &str) -> String {
    let mut h = Sha256::new();
    h.update(salt);
    h.update(password.as_bytes());
    hex::encode(h.finalize())
}

fn random_salt() -> [u8; 16] {
    use rand::RngCore;
    let mut s = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut s);
    s
}

fn normalize_username(u: &str) -> String {
    u.trim().to_lowercase()
}

#[tauri::command]
pub fn register(
    app: AppHandle,
    username: String,
    password: String,
    display_name: String,
) -> Result<PublicUser, String> {
    let user = normalize_username(&username);
    if user.len() < 3 {
        return Err("Tên đăng nhập tối thiểu 3 ký tự.".into());
    }
    if password.len() < 6 {
        return Err("Mật khẩu tối thiểu 6 ký tự.".into());
    }
    let display = {
        let d = display_name.trim();
        if d.is_empty() {
            username.trim().to_string()
        } else {
            d.to_string()
        }
    };

    let mut file = load(&app)?;
    if file.accounts.iter().any(|a| a.username == user) {
        return Err("Tên đăng nhập đã tồn tại.".into());
    }

    let salt = random_salt();
    let record = AccountRecord {
        username: user.clone(),
        display_name: display.clone(),
        salt_hex: hex::encode(salt),
        password_hash_hex: hash_password(&salt, &password),
    };
    file.accounts.push(record);
    save(&app, &file)?;

    Ok(PublicUser {
        username: user,
        display_name: display,
    })
}

#[tauri::command]
pub fn login(app: AppHandle, username: String, password: String) -> Result<PublicUser, String> {
    let user = normalize_username(&username);
    let file = load(&app)?;
    let Some(acc) = file.accounts.iter().find(|a| a.username == user) else {
        return Err("Sai tên đăng nhập hoặc mật khẩu.".into());
    };
    let salt = hex::decode(&acc.salt_hex).map_err(|_| "Tài khoản hỏng (salt).".to_string())?;
    let expect = hash_password(&salt, &password);
    if expect != acc.password_hash_hex {
        return Err("Sai tên đăng nhập hoặc mật khẩu.".into());
    }
    Ok(PublicUser {
        username: acc.username.clone(),
        display_name: acc.display_name.clone(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInfo {
    pub id: String,
    pub name: String,
    pub name_vi: String,
    pub profile_path: String,
    pub is_default: bool,
}

#[tauri::command]
pub fn list_games() -> Vec<GameInfo> {
    // Paths relative to client-rs/ when running `tauri dev` from gpb-app/
    vec![
        GameInfo {
            id: "lol".into(),
            name: "League of Legends".into(),
            name_vi: "Liên Minh Huyền Thoại".into(),
            profile_path: "../../profiles/lol-vn.example.json".into(),
            is_default: true,
        },
        GameInfo {
            id: "pubg".into(),
            name: "PUBG".into(),
            name_vi: "PUBG".into(),
            profile_path: "../../profiles/pubg-vn.example.json".into(),
            is_default: false,
        },
        GameInfo {
            id: "valorant".into(),
            name: "VALORANT".into(),
            name_vi: "VALORANT".into(),
            profile_path: "../../profiles/valorant-vn.example.json".into(),
            is_default: false,
        },
        GameInfo {
            id: "cs2".into(),
            name: "Counter-Strike 2".into(),
            name_vi: "CS2".into(),
            profile_path: "../../profiles/cs2-vn.example.json".into(),
            is_default: false,
        },
    ]
}
