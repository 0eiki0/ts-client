//! Which TeamSpeak client version web users show on the server.
//!
//! The server checks a signature over version + platform, so only versions of
//! official clients work. The list of signed versions comes from tsclientlib
//! (`third_party/ts-versions/Versions.csv`). The admin chooses in `/admin`:
//! - `default`: what tsclientlib sends (`3.?.? [Build: 5680278000]` on Windows),
//! - `fixed`: one version + platform for everybody,
//! - `auto`: the newest version for the user's own system (Android users show
//!   up with Android, iPhones with iOS …).
//! The choice is stored in `settings.json` in the data directory.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use base64::prelude::*;
use serde::{Deserialize, Serialize};
use tracing::warn;

const CSV: &str = include_str!("../third_party/ts-versions/Versions.csv");

#[derive(Clone, Debug)]
pub struct Signed {
	pub version: String,
	pub platform: String,
	signature: Vec<u8>,
	build: u64,
}

/// All usable signed versions, newest first.
pub fn all() -> &'static [Signed] {
	static LIST: OnceLock<Vec<Signed>> = OnceLock::new();
	LIST.get_or_init(|| {
		let mut list: Vec<Signed> = CSV
			.lines()
			.skip(1)
			.filter_map(|l| {
				// version,platform,hash – the version itself has no comma
				let mut it = l.rsplitn(3, ',');
				let hash = it.next()?.trim();
				let platform = it.next()?.trim();
				let version = it.next()?.trim();
				if version.contains("DEBUG") || platform.contains('.') || platform.is_empty() {
					return None;
				}
				let signature = BASE64_STANDARD.decode(hash).ok()?;
				let build = version
					.split("Build: ")
					.nth(1)
					.and_then(|b| b.trim_end_matches(']').trim().parse().ok())
					.unwrap_or(0);
				Some(Signed { version: version.into(), platform: platform.into(), signature, build })
			})
			.collect();
		// newest build first; the "3.?.?" placeholder build number is not a date
		list.sort_by_key(|v| std::cmp::Reverse(if v.version.starts_with("3.?") { 0 } else { v.build }));
		list
	})
}

pub fn find(version: &str, platform: &str) -> Option<&'static Signed> {
	all().iter().find(|v| v.version == version && v.platform == platform)
}

/// Platforms with their versions (newest first), for the admin page.
pub fn by_platform() -> BTreeMap<&'static str, Vec<&'static str>> {
	let mut map: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
	for v in all() {
		map.entry(v.platform.as_str()).or_default().push(v.version.as_str());
	}
	map
}

/// Newest stable (no beta/rc/qa) version of a platform.
pub fn newest_stable(platform: &str) -> Option<&'static Signed> {
	let stable = |v: &&Signed| {
		v.platform == platform && !v.version.starts_with("3.?") && !v.version.contains('-') && !v.version.contains("beta")
	};
	all().iter().find(stable)
}

/// Platform name for a browser's user agent.
fn platform_for(user_agent: &str) -> &'static str {
	if user_agent.contains("Android") {
		"Android"
	} else if user_agent.contains("iPhone") || user_agent.contains("iPad") {
		"iOS"
	} else if user_agent.contains("Mac OS") {
		"macOS"
	} else if user_agent.contains("Windows") {
		"Windows"
	} else if user_agent.contains("Linux") || user_agent.contains("CrOS") {
		"Linux"
	} else {
		"Windows"
	}
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
	#[default]
	Default,
	Fixed,
	Auto,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct VersionSetting {
	#[serde(default)]
	pub mode: Mode,
	#[serde(default)]
	pub version: String,
	#[serde(default)]
	pub platform: String,
}

impl VersionSetting {
	/// The version for a user with this user agent (`None` = tsclientlib default).
	pub fn pick(&self, user_agent: &str) -> Option<&'static Signed> {
		match self.mode {
			Mode::Default => None,
			Mode::Fixed => find(&self.version, &self.platform),
			Mode::Auto => {
				let p = platform_for(user_agent);
				// older macOS clients are listed as "OS X"
				newest_stable(p).or_else(|| (p == "macOS").then(|| newest_stable("OS X")).flatten())
			}
		}
	}
}

impl Signed {
	pub fn to_ts(&self) -> tsclientlib::Version {
		tsclientlib::Version::Custom {
			platform: self.platform.clone(),
			version: self.version.clone(),
			signature: self.signature.clone(),
		}
	}
}

/// Settings the admin can change at runtime (`settings.json`).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Settings {
	#[serde(default)]
	pub client_version: VersionSetting,
}

pub struct SettingsStore {
	path: Option<PathBuf>,
	inner: Mutex<Settings>,
}

impl SettingsStore {
	pub fn load(path: Option<PathBuf>) -> Self {
		let mut s = Settings::default();
		if let Some(p) = &path {
			match std::fs::read_to_string(p) {
				Ok(text) => match serde_json::from_str(&text) {
					Ok(v) => s = v,
					Err(error) => warn!(%error, file = %p.display(), "Einstellungen konnten nicht gelesen werden"),
				},
				Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
				Err(error) => warn!(%error, file = %p.display(), "Einstellungen konnten nicht gelesen werden"),
			}
		}
		Self { path, inner: Mutex::new(s) }
	}

	pub fn get(&self) -> Settings { self.inner.lock().unwrap_or_else(|e| e.into_inner()).clone() }

	pub fn set(&self, s: Settings) {
		*self.inner.lock().unwrap_or_else(|e| e.into_inner()) = s.clone();
		let Some(path) = &self.path else { return };
		let tmp = path.with_extension("json.neu");
		let res = serde_json::to_vec_pretty(&s)
			.map_err(std::io::Error::other)
			.and_then(|b| std::fs::write(&tmp, b))
			.and_then(|()| std::fs::rename(&tmp, path));
		if let Err(error) = res {
			warn!(%error, file = %path.display(), "Einstellungen konnten nicht gespeichert werden");
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn list_is_parsed() {
		assert!(all().len() > 1000);
		let v = find("3.6.0 [Build: 1666781655]", "Windows").expect("listed");
		assert_eq!(v.signature.len(), 64);
		assert!(by_platform()["Windows"].len() > 100);
		assert!(!all().iter().any(|v| v.version.contains("DEBUG")));
	}

	#[test]
	fn auto_follows_the_device() {
		let s = VersionSetting { mode: Mode::Auto, ..Default::default() };
		let win = s.pick("Mozilla/5.0 (Windows NT 10.0) Chrome/130").unwrap();
		assert_eq!(win.platform, "Windows");
		assert_eq!(win.version, "3.6.0 [Build: 1666781655]");
		assert_eq!(s.pick("Mozilla/5.0 (Linux; Android 14) Chrome/130").unwrap().platform, "Android");
		assert_eq!(s.pick("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)").unwrap().platform, "iOS");
		assert!(s.pick("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)").is_some());
		assert!(VersionSetting::default().pick("x").is_none());
	}
}
