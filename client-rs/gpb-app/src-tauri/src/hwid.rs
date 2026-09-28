//! A stable per-machine id for redeem codes: SHA-256 of the OS machine id, so the raw id never
//! leaves the computer. It survives reinstalling the app but not reinstalling the OS, and anyone
//! who controls the machine can change it; the server treats it as a hint, not a proof.

use sha2::{Digest, Sha256};

const SALT: &str = "goslynk-booster-hwid-v1:";

pub fn machine_hash() -> Result<String, String> {
    let id = machine_id()?;
    let id = id.trim().to_ascii_lowercase();
    if id.is_empty() {
        return Err("mã máy trống".into());
    }
    let digest = Sha256::digest(format!("{SALT}{id}").as_bytes());
    Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(windows)]
fn machine_id() -> Result<String, String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    // The 64-bit view, so a 32-bit build would read the same value.
    winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(
            r"SOFTWARE\Microsoft\Cryptography",
            KEY_READ | KEY_WOW64_64KEY,
        )
        .and_then(|k| k.get_value::<String, _>("MachineGuid"))
        .map_err(|e| format!("không đọc được MachineGuid: {e}"))
}

#[cfg(target_os = "macos")]
fn machine_id() -> Result<String, String> {
    let out = std::process::Command::new("/usr/sbin/ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .map_err(|e| format!("không chạy được ioreg: {e}"))?;
    parse_platform_uuid(&String::from_utf8_lossy(&out.stdout))
        .ok_or_else(|| "không tìm thấy IOPlatformUUID".into())
}

#[cfg(any(target_os = "macos", test))]
fn parse_platform_uuid(ioreg: &str) -> Option<String> {
    let line = ioreg.lines().find(|l| l.contains("\"IOPlatformUUID\""))?;
    let value = line.split('=').nth(1)?.trim().trim_matches('"');
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn machine_id() -> Result<String, String> {
    std::fs::read_to_string("/etc/machine-id")
        .map_err(|e| format!("không đọc được /etc/machine-id: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ioreg_output() {
        let out = r#"+-o J314sAP  <class IOPlatformExpertDevice, id 0x100000223>
    {
      "IOPlatformSerialNumber" = "XYZ"
      "IOPlatformUUID" = "3F2A7B1C-0D4E-4F5A-9B6C-7D8E9F0A1B2C"
    }"#;
        assert_eq!(
            parse_platform_uuid(out).as_deref(),
            Some("3F2A7B1C-0D4E-4F5A-9B6C-7D8E9F0A1B2C")
        );
        assert_eq!(parse_platform_uuid("nothing here"), None);
    }

    #[test]
    fn hash_is_64_hex_and_stable() {
        let a = machine_hash().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert_eq!(a, machine_hash().unwrap());
    }
}
