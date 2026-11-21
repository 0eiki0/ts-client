//! Stand-in for the session registry of the web bridge: the desktop client has
//! exactly one local user, so there is nothing to register, ban or log.

use std::net::IpAddr;

#[derive(Default)]
pub struct SessionInfo {
	pub state: &'static str,
	pub nickname: Option<String>,
	pub uid: Option<String>,
	pub server: Option<String>,
	pub channel: Option<String>,
	pub client_id: Option<u16>,
	pub connected_since: Option<u64>,
	pub ping_ms: Option<f64>,
}

#[derive(Clone)]
pub struct SessionHandle {
	pub ip: IpAddr,
}

impl SessionHandle {
	pub fn local() -> Self { SessionHandle { ip: IpAddr::from([127, 0, 0, 1]) } }
	pub fn update(&self, f: impl FnOnce(&mut SessionInfo)) { f(&mut SessionInfo::default()) }
	pub fn check(&self, _uid: Option<&str>, _nickname: Option<&str>) -> Option<String> { None }
	pub fn log(&self, _kind: &'static str, _nickname: Option<&str>, _uid: Option<&str>, _text: String) {}
	/// A signed TeamSpeak 3 client version of this operating system, so servers see a
	/// normal client of the platform.
	pub fn client_version(&self) -> Option<&'static crate::versions::Signed> {
		let platform = if cfg!(target_os = "windows") {
			"Windows"
		} else if cfg!(target_os = "macos") {
			"macOS"
		} else {
			"Linux"
		};
		crate::versions::newest_stable(platform)
	}
	pub fn joined(&self, _nickname: &str, _uid: &str, _address: &str) {}
	pub fn banned(&self, _uid: &str, _nickname: &str, _info: &crate::capture::LeaveInfo) {}
}
