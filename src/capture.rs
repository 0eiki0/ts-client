//! Picks up details from TeamSpeak commands that tsclientlib throws away.
//!
//! tsclientlib only reports the error *code* when the server refuses a connection
//! (e.g. `ConnectFailedBanned`) and drops the text the server sends along with it
//! (`extra_msg`, which contains the ban reason and duration). The same is true for
//! the reason message and ban time of kicks and bans.
//!
//! tsproto can log every command it sends or receives as a tracing event. This
//! module installs a tracing layer that listens to those events and remembers the
//! interesting parts. Every browser session runs on its own thread (see
//! `session::spawn`), so the data is kept in thread-locals and cannot mix between
//! sessions.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::fmt;

use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

/// Target of the command log events in tsproto.
pub const TARGET: &str = "tsproto::log";

/// An `error` answer of the server with a non-zero id.
#[derive(Clone, Debug)]
pub struct ServerError {
	pub id: u32,
	pub msg: String,
	pub extra: Option<String>,
	/// The permission that was missing (`failed_permid`).
	pub failed_permid: Option<u32>,
}

/// Why a client left the server (`notifyclientleftview`).
#[derive(Clone, Debug)]
pub struct LeaveInfo {
	pub reason_id: u8,
	pub message: Option<String>,
	pub invoker: Option<String>,
	/// Ban duration in seconds, `0` means permanent.
	pub ban_time: Option<u64>,
}

/// Notifications that answer the management commands of the web interface
/// (group, permission, ban and token lists, server variables). tsclientlib
/// either drops them or cannot parse every variant, so they are read here.
pub const ADMIN_NOTIFIES: &[&str] = &[
	"notifyservergrouplist",
	"notifychannelgrouplist",
	"notifyservergrouppermlist",
	"notifychannelgrouppermlist",
	"notifychannelpermlist",
	"notifyclientpermlist",
	"notifychannelclientpermlist",
	"notifypermissionlist",
	"notifyservergroupclientlist",
	"notifychannelgroupclientlist",
	"notifyservergroupsbyclientid",
	"notifybanlist",
	"notifytokenlist",
	"notifytokenadd",
	"notifycomplainlist",
	"notifyservertemppasswordlist",
	"notifyserverupdated",
	"notifyclientdbidfromuid",
];

/// One captured notification: its name and its list entries.
pub type Notify = (String, Vec<HashMap<String, String>>);

/// Upper bound for buffered entries (a full permission list has about 300).
const MAX_NOTIFY_ITEMS: usize = 20_000;

thread_local! {
	static COLLECT: Cell<bool> = const { Cell::new(false) };
	static NOTIFIES: RefCell<Vec<Notify>> = const { RefCell::new(Vec::new()) };
	static LAST_ERROR: RefCell<Option<ServerError>> = const { RefCell::new(None) };
	static LEAVES: RefCell<HashMap<u16, LeaveInfo>> = RefCell::new(HashMap::new());
}

/// Forget everything that was captured on this thread.
pub fn reset() {
	LAST_ERROR.with(|e| e.borrow_mut().take());
	LEAVES.with(|l| l.borrow_mut().clear());
	collect(false);
}

/// Start (and clear) or stop buffering the notifications in [`ADMIN_NOTIFIES`].
pub fn collect(on: bool) {
	COLLECT.with(|c| c.set(on));
	NOTIFIES.with(|n| n.borrow_mut().clear());
}

/// The notifications buffered since [`collect`] was switched on.
pub fn take_notifies() -> Vec<Notify> { NOTIFIES.with(|n| std::mem::take(&mut *n.borrow_mut())) }

/// The last error the server sent on this thread, if it has the given id.
pub fn take_error(id: u32) -> Option<ServerError> {
	LAST_ERROR.with(|e| {
		let mut e = e.borrow_mut();
		if e.as_ref().is_some_and(|e| e.id == id) { e.take() } else { None }
	})
}

/// Why the client with this id left (only kept for kicks and bans).
pub fn take_leave(client_id: u16) -> Option<LeaveInfo> {
	LEAVES.with(|l| l.borrow_mut().remove(&client_id))
}

pub struct CaptureLayer;

impl<S: Subscriber> Layer<S> for CaptureLayer {
	fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
		if event.metadata().target() != TARGET {
			return;
		}
		let mut visitor = ContentVisitor(None);
		event.record(&mut visitor);
		if let Some(content) = visitor.0 {
			handle_command(&content);
		}
	}
}

struct ContentVisitor(Option<String>);

impl Visit for ContentVisitor {
	fn record_str(&mut self, field: &Field, value: &str) {
		if field.name() == "content" {
			self.0 = Some(value.to_string());
		}
	}

	fn record_debug(&mut self, _field: &Field, _value: &dyn fmt::Debug) {}
}

fn handle_command(content: &str) {
	let (name, parts) = parse_command(content);
	match name {
		"error" => {
			let Some(first) = parts.first() else { return };
			let id = first.get("id").and_then(|i| i.parse::<u32>().ok()).unwrap_or(0);
			if id == 0 {
				return;
			}
			let err = ServerError {
				id,
				msg: first.get("msg").cloned().unwrap_or_default(),
				extra: first.get("extra_msg").filter(|m| !m.is_empty()).cloned(),
				failed_permid: first.get("failed_permid").and_then(|p| p.parse().ok()).filter(|p| *p != 0),
			};
			LAST_ERROR.with(|e| *e.borrow_mut() = Some(err));
		}
		"notifyclientleftview" => {
			for part in parts {
				let reason_id = part.get("reasonid").and_then(|r| r.parse::<u8>().ok()).unwrap_or(0);
				// 4 = kicked from channel, 5 = kicked from server, 6 = banned
				if !(4..=6).contains(&reason_id) {
					continue;
				}
				let Some(clid) = part.get("clid").and_then(|c| c.parse::<u16>().ok()) else {
					continue;
				};
				let info = LeaveInfo {
					reason_id,
					message: part.get("reasonmsg").filter(|m| !m.is_empty()).cloned(),
					invoker: part.get("invokername").filter(|m| !m.is_empty()).cloned(),
					ban_time: part.get("bantime").and_then(|b| b.parse().ok()),
				};
				LEAVES.with(|l| {
					let mut l = l.borrow_mut();
					// Do not grow without bounds on busy servers.
					if l.len() > 256 {
						l.clear();
					}
					l.insert(clid, info);
				});
			}
		}
		name if ADMIN_NOTIFIES.contains(&name) && COLLECT.with(Cell::get) => {
			NOTIFIES.with(|n| {
				let mut n = n.borrow_mut();
				let count: usize = n.iter().map(|(_, items)| items.len()).sum();
				if count + parts.len() <= MAX_NOTIFY_ITEMS {
					n.push((name.to_string(), parts));
				}
			});
		}
		_ => {}
	}
}

/// Split a TeamSpeak command into its name and its (list) parts.
///
/// In a list (`a=1 b=2|a=3`) the arguments of the first part are shared with all
/// following parts unless they override them.
fn parse_command(content: &str) -> (&str, Vec<HashMap<String, String>>) {
	let content = content.trim();
	let (name, rest) = match content.split_once(' ') {
		Some((n, r)) if !n.contains('=') => (n, r),
		None if !content.contains('=') => (content, ""),
		_ => ("", content),
	};
	let mut parts = Vec::new();
	let mut shared: HashMap<String, String> = HashMap::new();
	for (i, part) in rest.split('|').enumerate() {
		let mut map = if i == 0 { HashMap::new() } else { shared.clone() };
		for arg in part.split(' ').filter(|a| !a.is_empty()) {
			let (k, v) = arg.split_once('=').unwrap_or((arg, ""));
			map.insert(k.to_string(), unescape(v));
		}
		if i == 0 {
			shared = map.clone();
		}
		parts.push(map);
	}
	(name, parts)
}

pub fn unescape(s: &str) -> String {
	let mut out = String::with_capacity(s.len());
	let mut chars = s.chars();
	while let Some(c) = chars.next() {
		if c != '\\' {
			out.push(c);
			continue;
		}
		match chars.next() {
			Some('s') => out.push(' '),
			Some('p') => out.push('|'),
			Some('/') => out.push('/'),
			Some('\\') => out.push('\\'),
			Some('n') => out.push('\n'),
			Some('r') => out.push('\r'),
			Some('t') => out.push('\t'),
			Some('a') => out.push('\x07'),
			Some('b') => out.push('\x08'),
			Some('f') => out.push('\x0c'),
			Some('v') => out.push('\x0b'),
			Some(o) => out.push(o),
			None => {}
		}
	}
	out
}

/// Format a duration in seconds in German.
pub fn format_duration(secs: u64) -> String {
	let (d, h, m, s) = (secs / 86400, secs / 3600 % 24, secs / 60 % 60, secs % 60);
	let mut parts = Vec::new();
	if d > 0 {
		parts.push(format!("{d} {}", if d == 1 { "Tag" } else { "Tage" }));
	}
	if h > 0 {
		parts.push(format!("{h} Std."));
	}
	if m > 0 && d == 0 {
		parts.push(format!("{m} Min."));
	}
	if parts.is_empty() {
		parts.push(format!("{s} Sek."));
	}
	parts.join(" ")
}

/// Turn the `extra_msg` of a ban (e.g. `You are banned permanently. Reason: "Spam"`)
/// into German lines (`Grund: …`, `Dauer: …`).
pub fn describe_ban(extra: &str) -> String {
	let mut lines = Vec::new();
	let reason = extra
		.find("Reason:")
		.map(|i| extra[i + "Reason:".len()..].trim().trim_matches('"').trim().to_string())
		.filter(|r| !r.is_empty());
	lines.push(format!("Grund: {}", reason.as_deref().unwrap_or("(kein Grund angegeben)")));

	let lower = extra.to_lowercase();
	if lower.contains("permanent") {
		lines.push("Dauer: permanent".to_string());
	} else if let Some(secs) = seconds_in(&lower) {
		lines.push(format!("Verbleibende Dauer: {}", format_duration(secs)));
	}
	lines.push(format!("Meldung des Servers: {extra}"));
	lines.join("\n")
}

/// Find a number followed by "second(s)" in the text.
fn seconds_in(text: &str) -> Option<u64> {
	let words: Vec<&str> = text.split_whitespace().collect();
	words.windows(2).find_map(|w| {
		if w[1].starts_with("second") { w[0].parse().ok() } else { None }
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_ban_error() {
		let (name, parts) = parse_command(
			r#"error id=3329 msg=connection\sfailed,\syou\sare\sbanned extra_msg=You\sare\sbanned\spermanently.\sReason:\s"Soundboard""#,
		);
		assert_eq!(name, "error");
		assert_eq!(parts[0]["id"], "3329");
		assert_eq!(parts[0]["extra_msg"], r#"You are banned permanently. Reason: "Soundboard""#);
		let text = describe_ban(&parts[0]["extra_msg"]);
		assert!(text.contains("Grund: Soundboard"));
		assert!(text.contains("Dauer: permanent"));
	}

	#[test]
	fn parses_temporary_ban() {
		let text = describe_ban(r#"You may retry in 3600 seconds. Reason: "Spam""#);
		assert!(text.contains("Grund: Spam"));
		assert!(text.contains("1 Std."));
	}

	#[test]
	fn parses_list() {
		let (name, parts) =
			parse_command(r"notifyclientleftview cfid=1 ctid=0 reasonid=6 reasonmsg=weg\sda bantime=0 clid=5|clid=7");
		assert_eq!(name, "notifyclientleftview");
		assert_eq!(parts.len(), 2);
		assert_eq!(parts[1]["clid"], "7");
		assert_eq!(parts[1]["reasonmsg"], "weg da");
	}
}

#[cfg(test)]
mod notify_tests {
	#[test]
	fn collects_admin_lists_only_when_asked() {
		super::handle_command("notifyservergrouplist sgid=6 name=Server\\sAdmin type=1");
		assert!(super::take_notifies().is_empty());
		super::collect(true);
		super::handle_command("notifyservergrouppermlist sgid=6 permid=1 permvalue=1|permid=2 permvalue=75");
		super::handle_command("notifyclientmoved clid=1 ctid=2");
		let n = super::take_notifies();
		assert_eq!(n.len(), 1);
		assert_eq!(n[0].0, "notifyservergrouppermlist");
		assert_eq!(n[0].1[1]["sgid"], "6");
		assert_eq!(n[0].1[1]["permvalue"], "75");
		super::collect(false);
	}
}

#[cfg(test)]
mod layer_tests {
	use tracing_subscriber::prelude::*;

	#[test]
	fn captures_while_log_level_hides_it() {
		let subscriber = tracing_subscriber::registry()
			.with(
				tracing_subscriber::fmt::layer()
					.with_filter(tracing_subscriber::EnvFilter::new("info,tsproto=warn")),
			)
			.with(super::CaptureLayer.with_filter(tracing_subscriber::filter::filter_fn(|m| {
				m.target() == super::TARGET
			})));
		tracing::subscriber::with_default(subscriber, || {
			let _span = tracing::debug_span!(target: "tsproto::log", "packet").entered();
			tracing::debug!(
				target: "tsproto::log",
				content = r#"error id=3329 msg=x extra_msg=You\sare\sbanned\spermanently.\sReason:\s"Soundboard""#,
				"Command"
			);
		});
		let e = super::take_error(3329).expect("captured");
		assert_eq!(e.extra.as_deref(), Some(r#"You are banned permanently. Reason: "Soundboard""#));
	}
}
