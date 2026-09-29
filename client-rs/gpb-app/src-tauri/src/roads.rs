//! Which relay a game goes through, and by which roads: the fastest exit meant for the game, then
//! the direct road to it and each entry in front of it, timed with Probes. The two best roads carry
//! the session - one DataDup copy each - when the second is close enough to the first to matter.

use gpb_protocol::{build_disconnect, ClientId, HandshakeResult};
use gpb_tunnel::{choose_roads, handshake, probe_rtt, NonceStamp, TunnelError};
use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::thread;
use std::time::Duration;

pub const DIRECT: &str = "direct";

/// Probes per road. The relay answers at most 20 a second per session, so the direct road plus
/// `MAX_ENTRIES` entries must stay under that.
const PROBES: usize = 4;
const MAX_ENTRIES: usize = 3;
const PROBE_TIMEOUT: Duration = Duration::from_millis(400);

/// A relay as the app hands it over: `games` empty means it serves every game.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayChoice {
    pub id: String,
    pub endpoint: String,
    #[serde(default)]
    pub games: Vec<String>,
    #[serde(default)]
    pub entries: Vec<String>,
}

/// One exit the tunnel may use, already narrowed to the game being boosted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayRoute {
    pub id: String,
    pub endpoint: String,
    #[serde(default)]
    pub entries: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
    /// `direct`, or the entry's endpoint.
    pub via: String,
    pub rtt_ms: Option<f64>,
}

/// The exits a game may use: those dedicated to it, or else the ones that serve every game. The
/// exit nearest the player is not necessarily the one nearest the game server.
pub fn for_game(relays: &[RelayChoice], game_id: &str) -> Vec<RelayRoute> {
    let dedicated: Vec<&RelayChoice> = relays
        .iter()
        .filter(|r| r.games.iter().any(|g| g == game_id))
        .collect();
    let pool = if dedicated.is_empty() {
        relays.iter().filter(|r| r.games.is_empty()).collect()
    } else {
        dedicated
    };
    pool.into_iter()
        .filter(|r| !r.endpoint.trim().is_empty())
        .map(|r| RelayRoute {
            id: r.id.clone(),
            endpoint: r.endpoint.trim().to_string(),
            entries: r.entries.clone(),
        })
        .collect()
}

pub struct Connected {
    pub relay_id: String,
    pub relay_host: Ipv4Addr,
    pub hs: HandshakeResult,
    pub handshake_rtt_us: u64,
    pub main: UdpSocket,
    pub main_via: String,
    pub alt: Option<(UdpSocket, String)>,
    pub paths: Vec<PathInfo>,
}

fn parse_v4(endpoint: &str) -> Option<SocketAddr> {
    endpoint.parse::<SocketAddr>().ok().filter(SocketAddr::is_ipv4)
}

type Handshaken = (UdpSocket, HandshakeResult, NonceStamp);

/// Handshakes with every exit at once and keeps the one that answered fastest; the others are told
/// to let their session go.
fn fastest_exit(
    relays: &[RelayRoute],
    psk: &[u8],
    client_id: ClientId,
    timeout: Duration,
) -> Result<(usize, Handshaken), TunnelError> {
    let results: Vec<(usize, Result<Handshaken, TunnelError>)> = thread::scope(|scope| {
        let jobs: Vec<_> = relays
            .iter()
            .enumerate()
            .filter_map(|(i, r)| parse_v4(&r.endpoint).map(|ep| (i, ep)))
            .map(|(i, ep)| (i, scope.spawn(move || handshake(ep, psk, client_id, timeout))))
            .collect();
        jobs.into_iter()
            .map(|(i, job)| {
                let res = job
                    .join()
                    .unwrap_or_else(|_| Err(TunnelError::Msg("handshake thread panicked".into())));
                (i, res)
            })
            .collect()
    });

    let best = results
        .iter()
        .filter_map(|(i, r)| r.as_ref().ok().map(|(_, _, st)| (*i, st.handshake_rtt_us)))
        .min_by_key(|(_, rtt)| *rtt)
        .map(|(i, _)| i);
    let mut first_err = None;
    let mut chosen = None;
    for (i, res) in results {
        match res {
            Ok(ok) if Some(i) == best => chosen = Some((i, ok)),
            Ok((sock, hs, _)) => {
                let _ = sock.send(&build_disconnect(&hs.session_id));
            }
            Err(e) => {
                first_err.get_or_insert(e);
            }
        }
    }
    chosen.ok_or_else(|| {
        first_err.unwrap_or_else(|| TunnelError::Msg("Không có endpoint relay IPv4 hợp lệ.".into()))
    })
}

fn open_entry(endpoint: &str) -> Option<UdpSocket> {
    let addr = parse_v4(endpoint)?;
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect(addr).ok()?;
    Some(sock)
}

pub fn connect(
    relays: &[RelayRoute],
    psk: &[u8],
    client_id: ClientId,
    timeout: Duration,
) -> Result<Connected, TunnelError> {
    let (idx, (direct, hs, stamp)) = fastest_exit(relays, psk, client_id, timeout)?;
    let relay = &relays[idx];
    let relay_host = match parse_v4(&relay.endpoint).map(|a| a.ip()) {
        Some(std::net::IpAddr::V4(v4)) => v4,
        _ => return Err(TunnelError::Msg("Chưa hỗ trợ relay IPv6".into())),
    };
    let sid = hs.session_id;

    let mut roads: Vec<(UdpSocket, String)> = vec![(direct, DIRECT.to_string())];
    for entry in relay.entries.iter().take(MAX_ENTRIES) {
        if let Some(sock) = open_entry(entry) {
            roads.push((sock, entry.clone()));
        }
    }
    let handshake_ms = stamp.handshake_rtt_us as f64 / 1000.0;
    let rtts: Vec<Option<f64>> = roads
        .iter()
        .enumerate()
        .map(|(i, (sock, _))| {
            let probed = probe_rtt(sock, &sid, PROBES, PROBE_TIMEOUT).map(|d| d.as_secs_f64() * 1000.0);
            // The direct road just carried the handshake, so it works even if every Probe was lost.
            if i == 0 {
                probed.or(Some(handshake_ms))
            } else {
                probed
            }
        })
        .collect();
    let paths = roads
        .iter()
        .zip(&rtts)
        .map(|((_, via), rtt)| PathInfo { via: via.clone(), rtt_ms: *rtt })
        .collect();

    let (main_idx, alt_idx) = choose_roads(&rtts).unwrap_or((0, None));
    let mut slots: Vec<Option<(UdpSocket, String)>> = roads.into_iter().map(Some).collect();
    let (main, main_via) = slots[main_idx].take().expect("main road exists");
    let alt = alt_idx.and_then(|i| slots[i].take());

    Ok(Connected {
        relay_id: relay.id.clone(),
        relay_host,
        hs,
        handshake_rtt_us: stamp.handshake_rtt_us,
        main,
        main_via,
        alt,
        paths,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn choice(id: &str, games: &[&str]) -> RelayChoice {
        RelayChoice {
            id: id.into(),
            endpoint: format!("192.0.2.{}:51820", id.len()),
            games: games.iter().map(|g| g.to_string()).collect(),
            entries: Vec::new(),
        }
    }

    #[test]
    fn a_game_uses_its_dedicated_exits_before_the_shared_ones() {
        let relays = [choice("sg-1", &[]), choice("vn-1", &["lol", "tft"])];
        let ids = |game: &str| -> Vec<String> {
            for_game(&relays, game).into_iter().map(|r| r.id).collect()
        };
        assert_eq!(ids("lol"), ["vn-1"]);
        assert_eq!(ids("tft"), ["vn-1"]);
        assert_eq!(ids("roblox"), ["sg-1"]);
    }

    #[test]
    fn no_shared_exit_means_nothing_for_other_games() {
        let relays = [choice("vn-1", &["lol"])];
        assert!(for_game(&relays, "roblox").is_empty());
    }

    #[test]
    fn blank_endpoints_are_skipped() {
        let mut blank = choice("sg-1", &[]);
        blank.endpoint = "  ".into();
        assert!(for_game(&[blank], "lol").is_empty());
    }
}
