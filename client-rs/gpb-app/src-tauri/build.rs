use std::{env, fs, path::Path};

fn main() {
    embed_default_relay();

    let mut attrs = tauri_build::Attributes::new();
    // Release only: a dev build that demands elevation cannot be launched by `tauri dev`
    // from a normal terminal (os error 740).
    if env::var("PROFILE").as_deref() == Ok("release") {
        attrs = attrs.windows_attributes(
            tauri_build::WindowsAttributes::new()
                .app_manifest(include_str!("windows-app-manifest.xml")),
        );
    }
    tauri_build::try_build(attrs).expect("tauri build");
}

/// `relay.local.json` is gitignored: it carries the PSK, and the repository is public.
fn embed_default_relay() {
    let src = Path::new("relay.local.json");
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("default_relay.json");
    let json = match fs::read_to_string(src) {
        Ok(raw) => {
            println!("cargo:rerun-if-changed=relay.local.json");
            let raw = raw.trim_start_matches('\u{feff}');
            let v: serde_json::Value =
                serde_json::from_str(raw).expect("relay.local.json is not valid JSON");
            v.to_string()
        }
        Err(_) => "{}".to_string(),
    };
    fs::write(out, json).unwrap();
}
