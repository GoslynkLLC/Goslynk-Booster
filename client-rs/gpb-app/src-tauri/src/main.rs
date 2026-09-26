// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "macos")]
    {
        let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
        if args.len() == 3 && args[1] == gpb_app_lib::HELPER_FLAG {
            std::process::exit(gpb_app_lib::run_tunnel_helper(std::path::Path::new(&args[2])));
        }
    }
    gpb_app_lib::run()
}
