//! GPB tunnel daemon (PSK) — macOS (utun) and Windows (Wintun).

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use gpb_net::{default_gateway, open_tun, PlatformRouteTable, RouteTable, TunDevice};
use gpb_profile::{load_or_create_client_id, DaemonConfig, GameProfile};
use gpb_protocol::ipv4_to_string;
use gpb_tunnel::{clock, handshake, start_pumps, TunnelError};
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

#[derive(Parser, Debug)]
#[command(
    name = "gpb-daemon",
    about = "Goslynk Booster tunnel daemon (PSK) — macOS / Windows"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Connect to the relay, open TUN, install routes, pump until Ctrl+C.
    Connect {
        #[cfg_attr(target_os = "windows", arg(long, default_value = "gpb-win.json"))]
        #[cfg_attr(not(target_os = "windows"), arg(long, default_value = "gpb-mac.json"))]
        config: PathBuf,
        /// Keepalive interval in seconds.
        #[arg(long, default_value_t = 15)]
        keepalive: u64,
        /// Handshake timeout in seconds.
        #[arg(long, default_value_t = 8)]
        timeout: u64,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Commands::Connect {
            config,
            keepalive,
            timeout,
        } => cmd_connect(config, keepalive, timeout),
    }
}

fn cmd_connect(config_path: PathBuf, keepalive_secs: u64, timeout_secs: u64) -> Result<()> {
    if !(cfg!(target_os = "macos") || cfg!(target_os = "windows")) {
        bail!("gpb-daemon connect is only implemented on macOS and Windows");
    }

    let cfg = DaemonConfig::load(&config_path)
        .with_context(|| format!("load config {}", config_path.display()))?;
    let profile_path = resolve_path(&config_path, &cfg.profile_path);
    let profile = GameProfile::load(&profile_path)
        .with_context(|| format!("load profile {}", profile_path.display()))?;

    let client_id_path = resolve_path(&config_path, &cfg.client_id_path);
    let client_id = load_or_create_client_id(&client_id_path)?;
    let endpoint = cfg.resolve_endpoint(&profile)?;
    let cidrs =
        profile.region_cidrs(cfg.default_game_id.as_deref(), cfg.region_ids.as_deref())?;
    if cidrs.is_empty() {
        bail!("the chosen game/regions have no CIDRs - nothing would go through the relay");
    }

    println!("relay      {endpoint}");
    println!(
        "client-id  {}",
        client_id.iter().map(|b| format!("{b:02x}")).collect::<String>()
    );
    println!("cidrs      {} prefixes", cidrs.len());

    let (socket, hs, stamp) = match handshake(
        endpoint,
        cfg.psk.as_bytes(),
        client_id,
        Duration::from_secs(timeout_secs),
    ) {
        Ok(v) => v,
        Err(TunnelError::HandshakeTimeout) => {
            match clock::clock_offset_secs(Duration::from_secs(2)) {
                Some(off) if off.abs() > clock::HANDSHAKE_SKEW_SECS / 2.0 => bail!(
                    "handshake timed out: this clock is {off:+.0} s off real time and the relay \
                     accepts +/-{:.0} s - turn on automatic time sync and retry",
                    clock::HANDSHAKE_SKEW_SECS
                ),
                _ => bail!("handshake timed out: check endpoint, PSK and the VPS firewall (UDP)"),
            }
        }
        Err(e) => return Err(e).context("handshake"),
    };

    let client_ip = Ipv4Addr::from(hs.client_ip);
    let relay_ip = Ipv4Addr::from(hs.relay_ip);
    println!(
        "handshake  ok  inner {}  gw {}  mtu {}  rtt {:.1} ms",
        ipv4_to_string(&hs.client_ip),
        ipv4_to_string(&hs.relay_ip),
        hs.mtu,
        stamp.handshake_rtt_us as f64 / 1000.0
    );

    let tun = open_tun(&cfg.adapter_name, client_ip, relay_ip, hs.mtu).with_context(|| {
        if cfg!(target_os = "windows") {
            "open Wintun (need Admin/LocalSystem + wintun.dll beside exe)"
        } else {
            "open utun (need root/sudo)"
        }
    })?;
    let ifname = tun.name().to_string();
    println!("tun        {ifname}");

    let (phys_gw, phys_iface) = default_gateway().context("default gateway")?;
    let relay_host = match endpoint.ip() {
        std::net::IpAddr::V4(v4) => v4,
        std::net::IpAddr::V6(_) => bail!("IPv6 relay endpoints are not supported in this MVP"),
    };

    let mut routes = PlatformRouteTable::default();
    #[cfg(target_os = "windows")]
    {
        routes.tun_ifindex = Some(tun.interface_index());
    }

    routes
        .pin_host(relay_host, phys_gw, &phys_iface)
        .with_context(|| format!("pin relay {relay_host} via {phys_gw} on {phys_iface}"))?;
    println!("pinned     {relay_host}/32 via {phys_gw} ({phys_iface})");

    if cfg.route_without_game {
        for cidr in &cidrs {
            match routes.add_cidr(cidr, relay_ip, &ifname) {
                Ok(()) => println!("route      {cidr} -> {ifname}"),
                Err(e) => eprintln!("warn: route {cidr}: {e}"),
            }
        }
    }

    let session = start_pumps(
        socket,
        hs,
        stamp.handshake_rtt_us,
        tun,
        Duration::from_secs(keepalive_secs),
    )?;

    let running = Arc::new(AtomicBool::new(true));
    let r = Arc::clone(&running);
    ctrlc::set_handler(move || {
        r.store(false, Ordering::SeqCst);
    })
    .context("ctrlc handler")?;

    println!("connected  Ctrl+C to disconnect");
    while running.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_secs(2));
        let s = &session.stats;
        let rtt = s
            .last_rtt_ms()
            .map(|ms| format!("{ms:.1} ms"))
            .unwrap_or_else(|| "-".into());
        println!(
            "stats      up={} down={} ping={} pong={} rtt={rtt}",
            s.packets_sent.load(Ordering::Relaxed),
            s.packets_received.load(Ordering::Relaxed),
            s.pings_sent.load(Ordering::Relaxed),
            s.pongs_received.load(Ordering::Relaxed),
        );
    }

    println!("disconnecting…");
    session.shutdown();
    drop(routes);
    println!("done");
    Ok(())
}

fn resolve_path(config_path: &PathBuf, maybe_relative: &PathBuf) -> PathBuf {
    if maybe_relative.is_absolute() {
        return maybe_relative.clone();
    }
    if let Some(parent) = config_path.parent() {
        let joined = parent.join(maybe_relative);
        if joined.exists() {
            return joined;
        }
    }
    maybe_relative.clone()
}
