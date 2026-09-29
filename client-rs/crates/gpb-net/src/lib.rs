//! TUN device and route table abstractions.
//!
//! Implemented on **macOS** (utun) and **Windows** (Wintun). Linux client TUN is not in this MVP.

use std::io;
use std::net::Ipv4Addr;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum NetError {
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Msg(String),
    #[error("TUN/routing is not implemented on this OS (need macOS or Windows)")]
    UnsupportedOs,
}

/// A virtual TUN that carries raw IPv4 packets (no ethernet header).
///
/// One thread reads while another writes, so both take `&self`. `read` must return
/// `WouldBlock` within a fraction of a second when idle so the reader can see a stop request.
pub trait TunDevice: Send + Sync {
    fn name(&self) -> &str;
    fn read(&self, buf: &mut [u8]) -> io::Result<usize>;
    fn write(&self, buf: &[u8]) -> io::Result<usize>;
}

/// Install / remove host routes that steer game CIDRs into the tunnel.
pub trait RouteTable {
    /// Pin a /32 (or host) route for the relay via the physical gateway so tunnel traffic
    /// to the relay does not recurse into the virtual adapter.
    fn pin_host(&mut self, host: Ipv4Addr, via_gateway: Ipv4Addr, iface: &str) -> Result<(), NetError>;

    fn add_cidr(&mut self, cidr: &str, gateway: Ipv4Addr, iface: &str) -> Result<(), NetError>;

    fn delete_cidr(&mut self, cidr: &str) -> Result<(), NetError>;

    fn delete_host(&mut self, host: Ipv4Addr) -> Result<(), NetError>;
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "macos")]
pub use macos::{
    default_gateway, open_tun, open_utun, prioritize_current_thread, MacRouteTable, MacRouteTable as PlatformRouteTable,
    MacUtun,
};

#[cfg(target_os = "windows")]
pub use windows::{
    default_gateway, is_elevated, open_tun, prioritize_current_thread, system_tool, WinRouteTable,
    WinRouteTable as PlatformRouteTable, WinTun,
};

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn prioritize_current_thread() {}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn open_tun(
    _name_hint: &str,
    _client_ip: Ipv4Addr,
    _peer_ip: Ipv4Addr,
    _mtu: u16,
) -> Result<StubTun, NetError> {
    Err(NetError::UnsupportedOs)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn default_gateway() -> Result<(Ipv4Addr, String), NetError> {
    Err(NetError::UnsupportedOs)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub struct StubTun;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl TunDevice for StubTun {
    fn name(&self) -> &str {
        "unsupported"
    }
    fn read(&self, _buf: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "unsupported OS"))
    }
    fn write(&self, _buf: &[u8]) -> io::Result<usize> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "unsupported OS"))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[derive(Default)]
pub struct PlatformRouteTable;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl RouteTable for PlatformRouteTable {
    fn pin_host(&mut self, _: Ipv4Addr, _: Ipv4Addr, _: &str) -> Result<(), NetError> {
        Err(NetError::UnsupportedOs)
    }
    fn add_cidr(&mut self, _: &str, _: Ipv4Addr, _: &str) -> Result<(), NetError> {
        Err(NetError::UnsupportedOs)
    }
    fn delete_cidr(&mut self, _: &str) -> Result<(), NetError> {
        Err(NetError::UnsupportedOs)
    }
    fn delete_host(&mut self, _: Ipv4Addr) -> Result<(), NetError> {
        Err(NetError::UnsupportedOs)
    }
}
