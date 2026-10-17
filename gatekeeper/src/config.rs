//! The gatekeeper's settings, read from environment variables. The two addresses are private
//! network details, so they come from Bitwarden Secrets Manager at startup (`bws run`) and are
//! never written in the repo.

use std::collections::HashSet;
use std::env;
use std::net::IpAddr;
use std::path::PathBuf;

pub struct Config {
    /// The address to listen on: this computer's Tailscale address.
    pub listen_host: IpAddr,
    pub listen_port: u16,
    /// The only client addresses let in: the iPhone's Tailscale address.
    pub allowed_addresses: HashSet<IpAddr>,
    /// The socket file ttyd listens on.
    pub ttyd_socket: PathBuf,
    /// How many connections can be open at once.
    pub max_connections: usize,
}

const DEFAULT_PORT: u16 = 7681;
const DEFAULT_MAX_CONNECTIONS: usize = 20;

impl Config {
    /// Reads every setting, or explains the first one that is missing or invalid.
    pub fn from_env() -> Result<Self, String> {
        let listen_host = required("LISTEN_HOST")?
            .parse()
            .map_err(|_| "LISTEN_HOST must be an IP address.".to_string())?;
        let allowed_addresses = address_list(&required("ALLOWED_ADDRESSES")?)
            .ok_or("ALLOWED_ADDRESSES must be a comma-separated list of IP addresses.")?;
        let ttyd_socket = PathBuf::from(required("TTYD_SOCKET")?);
        // Port 0 asks the system for any free port, which the tests use.
        let listen_port = optional("LISTEN_PORT", DEFAULT_PORT, |_: &u16| true)
            .ok_or("LISTEN_PORT must be a port number.")?;
        let max_connections =
            optional("MAX_CONNECTIONS", DEFAULT_MAX_CONNECTIONS, |max: &usize| {
                *max > 0
            })
            .ok_or("MAX_CONNECTIONS must be a whole number greater than 0.")?;
        Ok(Self {
            listen_host,
            listen_port,
            allowed_addresses,
            ttyd_socket,
            max_connections,
        })
    }
}

fn required(name: &str) -> Result<String, String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "Missing {name}. Start the gatekeeper through `bws run` so it receives its secrets."
            )
        })
}

/// The setting's value if it is set and valid, the default if it is not set, `None` if it is invalid.
fn optional<T: std::str::FromStr>(name: &str, default: T, valid: impl Fn(&T) -> bool) -> Option<T> {
    match env::var(name) {
        Err(_) => Some(default),
        Ok(text) => text.trim().parse().ok().filter(valid),
    }
}

/// Parses "a, b ,c": entries are trimmed and empty ones skipped. `None` if any entry is not an IP
/// address, or if nothing is left.
fn address_list(text: &str) -> Option<HashSet<IpAddr>> {
    let addresses = text
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.parse().ok())
        .collect::<Option<HashSet<IpAddr>>>()?;
    (!addresses.is_empty()).then_some(addresses)
}
