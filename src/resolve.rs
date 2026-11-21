//! Resolve a TeamSpeak address like the official client does.
//!
//! tsclientlib has its own resolver, but it drops SRV records with weight 0
//! (the most common case, e.g. `_ts3._udp.example.com. SRV 0 0 9987 ts.example.com.`),
//! and then falls back to the A/AAAA records of the bare domain, which usually
//! point to a web server. So we look up the SRV record ourselves first.

use std::net::SocketAddr;
use std::time::Duration;

use futures::prelude::*;
use hickory_resolver::TokioResolver;
use hickory_resolver::config::{CLOUDFLARE, ResolverConfig, ResolverOpts};
use hickory_resolver::net::runtime::TokioRuntimeProvider;
use hickory_resolver::proto::rr::RData;
use tracing::{debug, info, warn};

const DEFAULT_PORT: u16 = 9987;

/// Split `host[:port]` (also `[v6]:port`). Returns None for plain IP addresses.
fn split_host_port(address: &str) -> (String, Option<u16>) {
	let a = address.trim();
	if let Some(rest) = a.strip_prefix('[') {
		if let Some((host, tail)) = rest.split_once(']') {
			let port = tail.strip_prefix(':').and_then(|p| p.parse().ok());
			return (host.to_string(), port);
		}
	}
	match a.rsplit_once(':') {
		// Exactly one colon: host:port
		Some((host, port)) if !host.contains(':') => (host.to_string(), port.parse().ok()),
		_ => (a.to_string(), None),
	}
}

fn create_resolver() -> Option<TokioResolver> {
	let (config, options) = match hickory_resolver::system_conf::read_system_conf() {
		Ok(c) => c,
		Err(error) => {
			warn!(%error, "System-DNS-Konfiguration nicht lesbar, nutze Cloudflare");
			(ResolverConfig::udp_and_tcp(&CLOUDFLARE), ResolverOpts::default())
		}
	};
	let mut builder = TokioResolver::builder_with_config(config, TokioRuntimeProvider::default());
	*builder.options_mut() = options;
	builder.build().ok()
}

/// Look up `_ts3._udp.<host>` and return the targets ordered by priority (ascending)
/// and weight (descending).
async fn srv_targets(host: &str) -> Vec<(String, u16)> {
	let Some(resolver) = create_resolver() else { return Vec::new() };
	let name = format!("_ts3._udp.{}.", host.trim_end_matches('.'));
	let lookup = match tokio::time::timeout(Duration::from_secs(5), resolver.srv_lookup(name.clone())).await
	{
		Ok(Ok(l)) => l,
		Ok(Err(error)) => {
			debug!(%name, %error, "Kein SRV-Eintrag");
			return Vec::new();
		}
		Err(_) => {
			warn!(%name, "SRV-Abfrage: Zeitüberschreitung");
			return Vec::new();
		}
	};
	let mut srvs: Vec<_> = lookup
		.answers()
		.iter()
		.filter_map(|r| match &r.data {
			RData::SRV(srv) => Some((srv.priority, srv.weight, srv.target.to_ascii(), srv.port)),
			_ => None,
		})
		.collect();
	srvs.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
	srvs.into_iter()
		.map(|(_, _, target, port)| (target.trim_end_matches('.').to_string(), port))
		.collect()
}

async fn lookup(host: &str, port: u16) -> Vec<SocketAddr> {
	match tokio::net::lookup_host((host, port)).await {
		Ok(addrs) => addrs.collect(),
		Err(error) => {
			debug!(%host, %error, "Auflösung fehlgeschlagen");
			Vec::new()
		}
	}
}

/// IPv4 first: many servers have broken or unreachable IPv6, and the official
/// client also prefers IPv4.
fn order(mut addrs: Vec<SocketAddr>) -> Vec<SocketAddr> {
	addrs.sort_by_key(|a| a.is_ipv6());
	addrs.dedup();
	addrs
}

/// Resolve a server address to the list of socket addresses to try, in order.
pub async fn resolve(address: &str) -> Vec<SocketAddr> {
	if let Ok(addr) = address.trim().parse::<SocketAddr>() {
		return vec![addr];
	}
	let (host, port) = split_host_port(address);
	if let Ok(ip) = host.parse::<std::net::IpAddr>() {
		return vec![SocketAddr::new(ip, port.unwrap_or(DEFAULT_PORT))];
	}

	// 1. SRV record (only without an explicit port, like the official client).
	if port.is_none() && host.contains('.') {
		for (target, srv_port) in srv_targets(&host).await {
			let addrs = lookup(&target, srv_port).await;
			if !addrs.is_empty() {
				info!(%host, %target, port = srv_port, "SRV-Eintrag gefunden");
				return order(addrs);
			}
		}
	}

	// 2. tsclientlib: TSDNS, server nicknames and plain A/AAAA records.
	let addrs: Vec<SocketAddr> = tokio::time::timeout(
		Duration::from_secs(12),
		tsclientlib::resolver::resolve(address.to_string())
			.filter_map(|r| future::ready(r.ok()))
			.collect::<Vec<_>>(),
	)
	.await
	.unwrap_or_default();
	order(addrs)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn split() {
		assert_eq!(split_host_port("ts.example.com"), ("ts.example.com".into(), None));
		assert_eq!(split_host_port("ts.example.com:1234"), ("ts.example.com".into(), Some(1234)));
		assert_eq!(split_host_port("[::1]:9987"), ("::1".into(), Some(9987)));
		assert_eq!(split_host_port("::1"), ("::1".into(), None));
	}

	#[tokio::test]
	async fn ip_passthrough() {
		assert_eq!(resolve("127.0.0.1:1234").await, vec!["127.0.0.1:1234".parse().unwrap()]);
		assert_eq!(resolve("127.0.0.1").await, vec!["127.0.0.1:9987".parse().unwrap()]);
	}
}
