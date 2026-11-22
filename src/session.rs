//! One browser session = one TeamSpeak connection.
//!
//! Each session runs on its own thread with a single-threaded tokio runtime, so the
//! TeamSpeak connection never has to cross threads.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use audiopus::coder::Encoder;
use futures::prelude::*;
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;
use tracing::{debug, info, warn};

use tsclientlib::data::{Channel, Client, Connection as State};
use tsclientlib::events::{Event, PropertyId, PropertyValue};
use tsclientlib::prelude::*;
use tsclientlib::{
	ChannelId, ClientId, Connection, DisconnectOptions, Identity, MessageHandle, MessageTarget,
	StreamItem,
};
use tsproto_packets::packets::{AudioData, CodecType, OutAudio};

use crate::Config;
use crate::protocol::*;

/// 20 ms of 48 kHz mono audio.
pub const FRAME_SAMPLES: usize = 960;
pub const MAX_OPUS_FRAME_SIZE: usize = 1275;
/// Highest identity security level the bridge computes for servers other than
/// the configured one (level 30 already takes minutes).
const MAX_FOREIGN_SECURITY_LEVEL: u8 = 28;
/// Bitrate of the Opus stream to the browser (mono, mixed).
const OUTPUT_OPUS_BITRATE: i32 = 64000;
const TOKEN_WHAT: &str = "Berechtigungsschlüssel einlösen";
/// How long the bridge waits for the answer to a management command.
const ADMIN_TIMEOUT: Duration = Duration::from_secs(20);
/// Queued management commands per session (the permission editor sends one per change).
const ADMIN_QUEUE_MAX: usize = 200;

/// Management commands the web interface may send (`ClientCmd::Admin`). These are
/// the commands the official client uses for the same dialogs; the TeamSpeak
/// server checks the permissions of the user for each of them.
pub const ADMIN_COMMANDS: &[&str] = &[
	// server
	"servergetvariables",
	"serveredit",
	"servertemppasswordlist",
	"servertemppasswordadd",
	"servertemppassworddel",
	// channels
	"channeledit",
	"channelmove",
	"channelpermlist",
	"channeladdperm",
	"channeldelperm",
	// server groups
	"servergrouplist",
	"servergroupadd",
	"servergroupcopy",
	"servergrouprename",
	"servergroupdel",
	"servergrouppermlist",
	"servergroupaddperm",
	"servergroupdelperm",
	"servergroupclientlist",
	"servergroupaddclient",
	"servergroupdelclient",
	"servergroupsbyclientid",
	// channel groups
	"channelgrouplist",
	"channelgroupadd",
	"channelgroupcopy",
	"channelgrouprename",
	"channelgroupdel",
	"channelgrouppermlist",
	"channelgroupaddperm",
	"channelgroupdelperm",
	"channelgroupclientlist",
	"setclientchannelgroup",
	// client permissions
	"clientpermlist",
	"clientaddperm",
	"clientdelperm",
	"channelclientpermlist",
	"channelclientaddperm",
	"channelclientdelperm",
	"clientedit",
	"clientgetdbidfromuid",
	"permissionlist",
	// bans, privilege keys, complaints
	"banlist",
	"banadd",
	"banclient",
	"bandel",
	"privilegekeylist",
	"privilegekeyadd",
	"privilegekeydelete",
	"complainlist",
	"complaindel",
];
/// Options (without value) allowed for management commands.
const ADMIN_FLAGS: &[&str] = &["-names", "-permsid", "-continueonerror"];

/// A management command waiting to be sent or for its answer.
struct AdminRequest {
	id: u32,
	cmd: String,
	packet: tsproto_packets::packets::OutCommand,
}

/// Build the TeamSpeak command for `ClientCmd::Admin`, checking names and values.
fn admin_packet(
	cmd: &str, parts: &[std::collections::BTreeMap<String, serde_json::Value>], flags: &[String],
) -> Result<tsproto_packets::packets::OutCommand> {
	use tsproto_packets::packets::{Direction, Flags, OutCommand, PacketType};
	if !ADMIN_COMMANDS.contains(&cmd) {
		bail!("Unbekannter Verwaltungsbefehl „{cmd}“");
	}
	if parts.len() > 500 {
		bail!("Zu viele Einträge in einem Befehl");
	}
	let mut packet = OutCommand::new(Direction::C2S, Flags::empty(), PacketType::Command, cmd);
	for (i, part) in parts.iter().enumerate() {
		if i > 0 {
			packet.start_new_part();
		}
		for (key, value) in part {
			if key.is_empty()
				|| key.len() > 64
				|| key == "return_code"
				|| !key.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
			{
				bail!("Ungültiger Parameter „{key}“");
			}
			let value = match value {
				serde_json::Value::String(s) => s.clone(),
				serde_json::Value::Bool(b) => if *b { "1" } else { "0" }.to_string(),
				serde_json::Value::Number(n) => n.to_string(),
				serde_json::Value::Null => continue,
				_ => bail!("Ungültiger Wert für „{key}“"),
			};
			if value.len() > 8192 {
				bail!("Wert für „{key}“ ist zu lang");
			}
			packet.write_arg(key, &value);
		}
	}
	for flag in flags {
		if !ADMIN_FLAGS.contains(&flag.as_str()) {
			bail!("Ungültige Option „{flag}“");
		}
		packet.write_bin_arg(flag, &[]);
	}
	Ok(packet)
}

/// German text for the errors the management dialogs run into most.
fn admin_error_text(code: u32, server_msg: Option<&str>) -> String {
	let text = match code {
		0x0a08 => "Dafür fehlen dir die Rechte",
		0x0a09 => "Deine Gruppen-Bearbeitungsstärke (i_group_modify_power) reicht für diese Gruppe nicht",
		0x0a0a => "Deine Rechte-Bearbeitungsstärke (i_permission_modify_power) reicht für dieses Recht nicht",
		0x0a07 => "Die Gruppe ist nicht leer",
		0x0a02 => "Ungültige Gruppe",
		0x0a00 | 0x0a01 => "Ungültiges Recht",
		0x0303 => "Der Kanalname ist schon vergeben",
		0x0300 => "Ungültiger Kanal",
		0x0200 => "Ungültiger Client",
		0x0202 => "Unbekannte Datenbank-ID",
		0x0602 | 0x0603 | 0x0601 | 0x0605 => "Ungültige Eingabe",
		0x020c => "Zu viele Befehle auf einmal (Flood-Schutz des Servers) – kurz warten",
		0x0100 => "Der Server kennt diesen Befehl nicht",
		0x0505 => "Der Name ist schon vergeben",
		_ => "",
	};
	match (text.is_empty(), server_msg.filter(|m| !m.is_empty())) {
		(false, _) => text.to_string(),
		(true, Some(m)) => format!("Der Server meldet: {m} (Fehler {code})"),
		(true, None) => format!("Fehler {code}"),
	}
}

pub enum ToSession {
	Cmd(ClientCmd),
	Audio(Vec<i16>),
	/// One Opus packet (20 ms) encoded by the browser.
	Opus(Vec<u8>),
	AudioEnd,
	/// Disconnect (admin interface, ban); the text is shown to the user.
	#[allow(dead_code)]
	Kick(String),
}

pub enum FromSession {
	Text(String),
	Binary(Vec<u8>),
}

type Out = mpsc::Sender<FromSession>;

async fn send(out: &Out, msg: ServerMsg) { let _ = out.send(FromSession::Text(msg.to_json())).await; }

fn send_now(out: &Out, msg: ServerMsg) {
	// Used in places where awaiting would be awkward. Drops the message if the
	// browser is too slow (the channel is large, so this only happens on dead sockets).
	let _ = out.try_send(FromSession::Text(msg.to_json()));
}

/// Spawn the thread for a session.
pub fn spawn(
	cfg: Arc<Config>, bot: Option<crate::query::BotHandle>, hub: crate::admin::SessionHandle,
	rx: mpsc::Receiver<ToSession>, out: Out,
) {
	std::thread::Builder::new()
		.name("ts-session".into())
		.spawn(move || {
			let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
				Ok(rt) => rt,
				Err(error) => {
					warn!(%error, "Failed to create runtime");
					return;
				}
			};
			let local = tokio::task::LocalSet::new();
			local.block_on(&rt, run(cfg, bot, hub, rx, out));
		})
		.expect("failed to spawn session thread");
}

async fn run(
	cfg: Arc<Config>, bot: Option<crate::query::BotHandle>, hub: crate::admin::SessionHandle,
	mut rx: mpsc::Receiver<ToSession>, out: Out,
) {
	loop {
		// Wait for a connect command.
		let cmd = loop {
			match rx.recv().await {
				None => return,
				Some(ToSession::Cmd(ClientCmd::Ping)) => send(&out, ServerMsg::Pong).await,
				Some(ToSession::Cmd(c @ ClientCmd::Connect { .. })) => break c,
				Some(ToSession::Kick(reason)) => {
					send(&out, ServerMsg::Status { state: "disconnected", reason: Some(reason) }).await;
				}
				Some(_) => {}
			}
		};
		let res = connection(&cfg, bot.as_ref(), &hub, cmd, &mut rx, &out).await;
		hub.update(|i| {
			i.state = "browser";
			i.client_id = None;
			i.channel = None;
			i.connected_since = None;
			i.ping_ms = None;
		});
		match res {
			Ok(Ended::BrowserGone) => return,
			Ok(Ended::Disconnected(reason)) => {
				send(&out, ServerMsg::Status { state: "disconnected", reason }).await;
			}
			Err(error) => {
				info!(%error, "Connection ended with error");
				send(&out, ServerMsg::Status {
					state: "disconnected",
					reason: Some(error.to_string()),
				})
				.await;
			}
		}
	}
}

enum Ended {
	BrowserGone,
	Disconnected(Option<String>),
}

enum Action {
	Event(Option<std::result::Result<StreamItem, tsclientlib::Error>>),
	Input(Option<ToSession>),
	Tick,
}

struct Session<'a> {
	out: &'a Out,
	audio: tsclientlib::audio::AudioHandler<ClientId>,
	encoder: Encoder,
	/// Encodes the mixed output for the browser (None = send PCM).
	out_encoder: Option<Encoder>,
	opus_buf: Vec<u8>,
	/// Volume per client set by the browser.
	volumes: HashMap<ClientId, f32>,
	talking: Vec<u16>,
	own_talking: bool,
	own_id: Option<ClientId>,
	state_dirty: bool,
	last_state: Instant,
	connected: bool,
	connected_at: Instant,
	/// The initial channel list was received.
	synced: bool,
	/// Descriptions of commands we sent, to report errors in a readable way.
	pending: HashMap<MessageHandle, String>,
	output_muted: bool,
	audio_seq: u16,
	hub: crate::admin::SessionHandle,
	uid: String,
	/// Current nickname (for the ban list).
	nickname: String,
	/// Management commands, sent one after another so the answers do not mix.
	admin_queue: std::collections::VecDeque<AdminRequest>,
	/// The management command waiting for its answer.
	admin_active: Option<(MessageHandle, u32, String, Instant)>,
}

async fn connection(
	cfg: &Config, bot: Option<&crate::query::BotHandle>, hub: &crate::admin::SessionHandle, cmd: ClientCmd,
	rx: &mut mpsc::Receiver<ToSession>, out: &Out,
) -> Result<Ended> {
	let ClientCmd::Connect {
		address,
		nickname,
		server_password,
		channel,
		channel_password,
		identity,
		opus,
	} = cmd
	else {
		bail!("Expected connect command");
	};

	let address = match (&cfg.ts_server, address.filter(|a| !a.trim().is_empty())) {
		(_, Some(a)) if cfg.allow_any_server => a.trim().to_string(),
		(server, _) => server.clone(),
	};
	let nickname = nickname.trim();
	if nickname.chars().any(char::is_control) {
		bail!("Der Nickname darf keine Steuerzeichen (z. B. Zeilenumbrüche) enthalten.");
	}
	if nickname.is_empty() || nickname.chars().count() < 3 || nickname.chars().count() > 30 {
		bail!("Der Nickname muss zwischen 3 und 30 Zeichen lang sein.");
	}

	let identity = match identity.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
		Some(s) => match Identity::new_from_str(s) {
			Ok(i) => i,
			Err(error) => bail!("Ungültige Identität: {error}"),
		},
		None => {
			send(out, ServerMsg::Info { message: "Erzeuge neue Identität…".into() }).await;
			tokio::task::spawn_blocking(Identity::create).await?
		}
	};
	let uid = identity.key().to_pub().get_uid();
	// Banned on the bridge (real IP or unique id)?
	if let Some(text) = hub.check(Some(&uid), Some(nickname)) {
		info!(ip = %hub.ip, %uid, ?nickname, "Gebannter Webnutzer abgewiesen");
		return Ok(Ended::Disconnected(Some(text)));
	}
	hub.update(|i| {
		i.state = "connecting";
		i.nickname = Some(nickname.to_string());
		i.uid = Some(uid.clone());
		i.server = Some(address.clone());
	});
	let hwid = hardware_id(&uid);
	let uid_for_bot = uid.clone();
	let uid_for_hub = uid.clone();
	send(out, ServerMsg::Identity {
		identity: format!("{}V{}", identity.counter(), identity.key().to_ts()),
		uid,
	})
	.await;

	send(out, ServerMsg::Status { state: "connecting", reason: None }).await;
	info!(?address, ?nickname, ip = %hub.ip, "Connecting");

	// Resolve the address ourselves (SRV record -> TSDNS -> A/AAAA, like the official client).
	let resolved = crate::resolve::resolve(&address).await;
	if resolved.is_empty() {
		bail!("Die Adresse „{address}“ konnte nicht aufgelöst werden (DNS).");
	}
	let tried = resolved.iter().map(|a| a.to_string()).collect::<Vec<_>>().join(", ");
	info!(?address, addresses = %tried, "Resolved");

	let identity_str = format!("{}V{}", identity.counter(), identity.key().to_ts());
	let server_password = server_password.filter(|p| !p.is_empty());
	let channel = channel.filter(|c| !c.is_empty());
	let channel_password = channel_password.filter(|p| !p.is_empty());
	// Shown client version (admin interface); only on our own server.
	let client_version = hub.client_version();
	if let Some(v) = client_version {
		debug!(version = %v.version, platform = %v.platform, "Client-Version");
	}
	let make_options = |addr: std::net::SocketAddr| -> Result<tsclientlib::ConnectOptions> {
		let mut options = Connection::build(addr)
			.name(nickname.to_string())
			.identity(Identity::new_from_str(&identity_str)?)
			.hardware_id(hwid.clone())
			// Always on: crate::capture reads ban reasons from the command log.
			// What is printed is still decided by -v.
			.log_commands(true)
			.log_packets(cfg.verbose >= 3);
		if let Some(v) = client_version {
			options = options.version(v.to_ts());
		}
		if let Some(p) = &server_password {
			options = options.password(p.clone());
		}
		if let Some(c) = &channel {
			options = options.channel(c.clone());
		}
		if let Some(p) = &channel_password {
			options = options.channel_password(p.clone());
		}
		Ok(options)
	};

	crate::capture::reset();
	// Let the ServerQuery bot hand out the web group (only on our own server) –
	// for known users before they join. Dropping the guard when this function
	// returns takes the group away again.
	let presence = match bot {
		Some(bot) if address == cfg.ts_server => Some(crate::query::WebPresence::join(bot, uid_for_bot).await),
		_ => None,
	};
	// Try the addresses one after another until one answers.
	let mut con = None;
	for addr in &resolved {
		send(out, ServerMsg::Info { message: format!("Verbinde mit {addr}…") }).await;
		info!(%addr, "Trying");
		let mut c = make_options(*addr)?.connect()?;
		let res = loop {
			match c.events().next().await {
				Some(Ok(StreamItem::BookEvents(_))) => break Ok(()),
				Some(Ok(StreamItem::IdentityLevelIncreasing(level))) => {
					// On foreign servers (--allow-any-server) do not let a server make the
					// bridge compute for hours: each level doubles the work.
					if level > MAX_FOREIGN_SECURITY_LEVEL && address != cfg.ts_server {
						return Ok(Ended::Disconnected(Some(format!(
							"Der Server verlangt Sicherheitslevel {level}. Die Brücke berechnet für fremde \
							 Server höchstens Level {MAX_FOREIGN_SECURITY_LEVEL}. Importiere eine Identität \
							 mit ausreichendem Level."
						))));
					}
					send(out, ServerMsg::Info {
						message: format!(
							"Der Server verlangt Sicherheitslevel {level} – Identität wird verbessert, das kann dauern…"
						),
					})
					.await;
				}
				Some(Ok(_)) => {}
				Some(Err(e)) => break Err((describe_error(&e), e.to_string())),
				None => break Err(("Verbindung wurde geschlossen".to_string(), String::new())),
			}
		};
		match res {
			Ok(()) => {
				con = Some(c);
				break;
			}
			Err((msg, error)) => {
				if !msg.contains("not acked") {
					// Wrong password, banned, ... – another address will not help.
					return Ok(Ended::Disconnected(Some(msg)));
				}
				warn!(%addr, %error, "No answer, trying next address");
			}
		}
	}
	if let (Some(p), Some(_)) = (&presence, &con) {
		p.connected();
	}
	let Some(mut con) = con else {
		return Ok(Ended::Disconnected(Some(format!(
			"Der TeamSpeak-Server antwortet nicht auf {tried} (UDP). Läuft der Server dort, \
			 ist der Port richtig und lässt die Firewall die Brücke durch?"
		))));
	};

	let mut encoder = Encoder::new(
		audiopus::SampleRate::Hz48000,
		audiopus::Channels::Mono,
		audiopus::Application::Voip,
	)?;
	let _ = encoder.set_bitrate(audiopus::Bitrate::BitsPerSecond(64000));
	// Audio to the browser: Opus if it can decode it (mixed voice + music bots).
	let out_encoder = if opus {
		let mut e = Encoder::new(
			audiopus::SampleRate::Hz48000,
			audiopus::Channels::Mono,
			audiopus::Application::Audio,
		)?;
		let _ = e.set_bitrate(audiopus::Bitrate::BitsPerSecond(OUTPUT_OPUS_BITRATE));
		Some(e)
	} else {
		None
	};

	let mut s = Session {
		out,
		audio: tsclientlib::audio::AudioHandler::new(),
		encoder,
		out_encoder,
		opus_buf: vec![0; MAX_OPUS_FRAME_SIZE],
		volumes: HashMap::new(),
		talking: Vec::new(),
		own_talking: false,
		own_id: None,
		state_dirty: false,
		last_state: Instant::now(),
		connected: true,
		connected_at: Instant::now(),
		synced: false,
		pending: HashMap::new(),
		output_muted: false,
		audio_seq: 0,
		hub: hub.clone(),
		uid: uid_for_hub,
		nickname: nickname.to_string(),
		admin_queue: Default::default(),
		admin_active: None,
	};
	hub.update(|i| {
		i.state = "connected";
		i.connected_since = Some(crate::bans::now());
	});
	hub.joined(nickname, &s.uid, &address);

	let mut tick = tokio::time::interval(Duration::from_millis(20));
	tick.set_missed_tick_behavior(MissedTickBehavior::Burst);
	let mut stats_tick = Instant::now();

	loop {
		let action = {
			let mut events = con.events();
			tokio::select! {
				e = events.next() => Action::Event(e),
				m = rx.recv() => Action::Input(m),
				_ = tick.tick() => Action::Tick,
			}
		};

		match action {
			Action::Event(None) => return Ok(Ended::Disconnected(s.own_leave_reason())),
			Action::Event(Some(Err(error))) => {
				if let Some(msg) = s.own_leave_reason() {
					return Ok(Ended::Disconnected(Some(msg)));
				}
				let mut msg = describe_error(&error);
				if !s.connected && msg.contains("not acked") {
					msg = format!(
						"Der TeamSpeak-Server antwortet nicht auf {tried} (UDP). Läuft der Server dort, \
						 ist der Port richtig und lässt die Firewall die Brücke durch? Details: {msg}"
					);
				}
				return Ok(Ended::Disconnected(Some(msg)));
			}
			Action::Event(Some(Ok(item))) => s.handle_item(&mut con, item).await?,
			Action::Input(None) => {
				let _ = con.disconnect(DisconnectOptions::new());
				drain(&mut con).await;
				return Ok(Ended::BrowserGone);
			}
			Action::Input(Some(ToSession::Cmd(ClientCmd::Disconnect { message }))) => {
				let mut opts = DisconnectOptions::new();
				if let Some(m) = message {
					opts = opts.message(m);
				}
				let _ = con.disconnect(opts);
				drain(&mut con).await;
				return Ok(Ended::Disconnected(Some("Verbindung getrennt".into())));
			}
			Action::Input(Some(ToSession::Kick(reason))) => {
				let _ = con.disconnect(DisconnectOptions::new().message("Von der Brücke getrennt"));
				drain(&mut con).await;
				return Ok(Ended::Disconnected(Some(reason)));
			}
			Action::Input(Some(ToSession::Cmd(ClientCmd::Connect { .. }))) => {
				send(out, ServerMsg::Error { message: "Bereits verbunden".into() }).await;
			}
			Action::Input(Some(ToSession::Cmd(cmd))) => {
				if let Err(error) = s.handle_cmd(&mut con, cmd).await {
					send(out, ServerMsg::Error { message: error.to_string() }).await;
				}
			}
			Action::Input(Some(ToSession::Audio(samples))) => s.send_audio(&mut con, &samples),
			Action::Input(Some(ToSession::Opus(packet))) => s.send_opus(&mut con, &packet),
			Action::Input(Some(ToSession::AudioEnd)) => s.end_audio(&mut con),
			Action::Tick => {
				s.audio_tick().await;
				s.admin_check_timeout(&mut con).await;
				if s.connected && !s.synced && s.connected_at.elapsed() > Duration::from_secs(5) {
					s.on_synced(&mut con).await;
				}
				if s.synced
					&& (s.state_dirty && s.last_state.elapsed() >= Duration::from_millis(100)
						|| stats_tick.elapsed() >= Duration::from_secs(5))
				{
					stats_tick = Instant::now();
					s.send_state(&con).await;
				}
			}
		}
	}
}

/// Wait (shortly) until the disconnect went through.
async fn drain(con: &mut Connection) {
	let _ = tokio::time::timeout(
		Duration::from_secs(2),
		con.events().for_each(|_| future::ready(())),
	)
	.await;
}

pub(crate) fn describe_error(error: &tsclientlib::Error) -> String {
	// The server refused the connection: add the text it sent along (ban reason, …).
	if let tsclientlib::Error::ConnectTs(code) = error {
		let code = *code;
		let server = crate::capture::take_error(code as u32);
		let extra = server.as_ref().and_then(|e| e.extra.clone());
		if code == tsclientlib::TsError::ConnectFailedBanned {
			let mut text = "Du bist auf diesem Server gebannt.".to_string();
			if let Some(extra) = extra {
				text.push('\n');
				text.push_str(&crate::capture::describe_ban(&extra));
			}
			return text;
		}
		if code == tsclientlib::TsError::ServerInvalidPassword {
			return "Falsches Serverpasswort.".into();
		}
		if let Some(server) = server {
			let mut text = format!("Der Server hat die Verbindung abgelehnt: {} ({code:?})", server.msg);
			if let Some(extra) = extra {
				text.push_str(&format!("\n{extra}"));
			}
			return text;
		}
	}
	let s = error.to_string();
	let lower = s.to_lowercase();
	if lower.contains("password") {
		format!("Falsches Serverpasswort ({s})")
	} else if lower.contains("banned") || lower.contains("ban") {
		format!("Du bist gebannt ({s})")
	} else if lower.contains("timeout") || lower.contains("timed out") {
		format!("Zeitüberschreitung – Server nicht erreichbar ({s})")
	} else {
		s
	}
}

/// Readable text for a kick or ban, e.g. "gebannt von Admin – Grund: Spam, Dauer: 1 Std.".
fn describe_leave(info: &crate::capture::LeaveInfo, own: bool) -> String {
	let what = match (info.reason_id, own) {
		(6, true) => "Du wurdest vom Server gebannt",
		(6, false) => "gebannt",
		(4, true) => "Du wurdest aus dem Kanal gekickt",
		(4, false) => "aus dem Kanal gekickt",
		(_, true) => "Du wurdest vom Server gekickt",
		(_, false) => "vom Server gekickt",
	};
	let mut text = what.to_string();
	if let Some(by) = &info.invoker {
		text.push_str(&format!(" von {by}"));
	}
	let mut details = Vec::new();
	if let Some(msg) = &info.message {
		details.push(format!("Grund: {msg}"));
	}
	if info.reason_id == 6 {
		match info.ban_time {
			Some(0) => details.push("Dauer: permanent".into()),
			Some(t) => details.push(format!("Dauer: {}", crate::capture::format_duration(t))),
			None => {}
		}
	}
	if !details.is_empty() {
		text.push_str(if own { ".\n" } else { " – " });
		text.push_str(&details.join(if own { "\n" } else { ", " }));
	}
	text
}

/// Whether the server accepts voice from us right now (same rules as tsclientlib:
/// not muted, not away, enough talk power in the current channel).
pub(crate) fn can_send_audio(con: &Connection) -> bool {
	let Ok(state) = con.get_state() else { return false };
	let Some(me) = state.clients.get(&state.own_client) else { return false };
	if me.input_muted
		|| !me.input_hardware_enabled
		|| me.output_muted
		|| !me.output_hardware_enabled
		|| me.away_message.is_some()
	{
		return false;
	}
	match state.channels.get(&me.channel).and_then(|c| c.needed_talk_power) {
		Some(needed) => me.talk_power_granted || me.talk_power >= needed,
		None => true,
	}
}

/// A hardware id that belongs to the identity instead of the one that is built
/// into tsclientlib (and therefore shared by every bot built with it).
pub(crate) fn hardware_id(uid: &str) -> String {
	use sha2::{Digest, Sha256};
	let hash = Sha256::digest(format!("ts3-webbridge hwid {uid}").as_bytes());
	let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
	format!("{},{}", &hex[..32], &hex[32..])
}

fn reason_text(reason: Option<tsclientlib::Reason>) -> Option<&'static str> {
	use tsclientlib::Reason::*;
	match reason? {
		None => Option::None,
		KickChannel => Some("aus dem Kanal gekickt"),
		KickServer => Some("vom Server gekickt"),
		KickServerBan => Some("gebannt"),
		LostConnection => Some("Verbindung verloren"),
		Serverstop | ClientdisconnectServerShutdown => Some("Server wurde gestoppt"),
		_ => Option::None,
	}
}

impl Session<'_> {
	/// Why we were removed from the server, if we were kicked or banned.
	fn own_leave_reason(&self) -> Option<String> {
		let own = self.own_id?;
		let info = crate::capture::take_leave(own.0)?;
		if info.reason_id == 6 {
			// keep the user out of the bridge, too (real IP + unique id)
			self.hub.banned(&self.uid, &self.nickname, &info);
		} else if info.reason_id == 5 {
			self.hub.log("kicked", Some(&self.nickname), Some(&self.uid), describe_leave(&info, false));
		}
		(info.reason_id != 4).then(|| describe_leave(&info, true))
	}

	async fn handle_item(&mut self, con: &mut Connection, item: StreamItem) -> Result<()> {
		match item {
			StreamItem::BookEvents(events) => {
				self.state_dirty = true;
				if !self.connected {
					self.connected = true;
					self.connected_at = Instant::now();
				}
				let state = con.get_state()?;
				self.own_id = Some(state.own_client);
				if self.synced {
					for e in &events {
						self.handle_event(state, e).await;
					}
				}
			}
			StreamItem::Audio(packet) => {
				let from = ClientId(match packet.data().data() {
					AudioData::S2C { from, .. } => *from,
					AudioData::S2CWhisper { from, .. } => *from,
					_ => return Ok(()),
				});
				if self.output_muted {
					return Ok(());
				}
				match self.audio.handle_packet(from, packet) {
					Ok(Some(id)) => {
						let vol = self.volumes.get(&id).copied().unwrap_or(1.0);
						if let Some(q) = self.audio.get_mut_queues().get_mut(&id) {
							q.volume = vol;
						}
					}
					Ok(None) => {}
					Err(error) => debug!(%error, "Failed to handle audio packet"),
				}
			}
			StreamItem::DisconnectedTemporarily(reason) => {
				self.connected = false;
				self.synced = false;
				self.audio.reset();
				send(self.out, ServerMsg::Status {
					state: "reconnecting",
					reason: Some(format!("{reason:?}")),
				})
				.await;
			}
			StreamItem::MessageResult(handle, res)
				if self.admin_active.as_ref().is_some_and(|(h, ..)| *h == handle) =>
			{
				self.admin_finished(con, res).await;
			}
			StreamItem::MessageResult(handle, res) => {
				let what = self.pending.remove(&handle);
				if res.is_ok() && what.as_deref() == Some(TOKEN_WHAT) {
					send(self.out, ServerMsg::Info { message: "Berechtigungsschlüssel eingelöst".into() }).await;
				}
				if let Err(e) = res {
					let what = what.unwrap_or_else(|| "Befehl".into());
					send(self.out, ServerMsg::Error { message: format!("{what} fehlgeschlagen: {e}") })
						.await;
				}
			}
			StreamItem::AudioChange(tsclientlib::AudioEvent::CanSendAudio(can)) => {
				send(self.out, ServerMsg::CanTalk { can }).await;
			}
			StreamItem::IdentityLevelIncreasing(level) => {
				send(self.out, ServerMsg::Info {
					message: format!(
						"Der Server verlangt Sicherheitslevel {level} – Identität wird verbessert, das kann dauern…"
					),
				})
				.await;
			}
			StreamItem::IdentityLevelIncreased => {
				if let Some(id) = con.get_options().get_identity() {
					send(self.out, ServerMsg::Identity {
						identity: format!("{}V{}", id.counter(), id.key().to_ts()),
						uid: id.key().to_pub().get_uid(),
					})
					.await;
				}
			}
			StreamItem::MessageEvent(tsclientlib::InMessage::ChannelListFinished(_)) => {
				self.on_synced(con).await;
			}
			StreamItem::NetworkStatsUpdated => {}
			_ => {}
		}
		Ok(())
	}

	async fn handle_event(&mut self, state: &State, e: &Event) {
		let own = state.own_client;
		let invoker_name = e.get_invoker().map(|i| i.name.clone());
		let by = invoker_name.as_ref().map(|n| format!(" von {n}")).unwrap_or_default();
		let chan_name = |id: ChannelId| {
			state.channels.get(&id).map(|c| c.name.clone()).unwrap_or_else(|| format!("#{}", id.0))
		};
		match e {
			Event::Message { target, invoker, message } => {
				let (target, partner) = match target {
					MessageTarget::Server => ("server", None),
					MessageTarget::Channel => ("channel", None),
					MessageTarget::Client(id) => {
						// Messages we sent ourselves come back with our id as invoker.
						let partner = if invoker.id == own { *id } else { invoker.id };
						("private", Some(partner.0))
					}
					MessageTarget::Poke(_) => {
						send(self.out, ServerMsg::Poke {
							from_id: invoker.id.0,
							from_name: invoker.name.clone(),
							text: message.clone(),
						})
						.await;
						return;
					}
				};
				send(self.out, ServerMsg::Chat {
					target,
					from_id: invoker.id.0,
					from_name: invoker.name.clone(),
					from_uid: invoker.uid.as_ref().map(|u| u.as_ref().to_string()),
					partner,
					text: message.clone(),
				})
				.await;
			}
			Event::PropertyAdded { id: PropertyId::Client(cid), extra, .. } => {
				if extra.reason == Some(tsclientlib::Reason::Subscription) {
					return;
				}
				if let Some(c) = state.clients.get(cid) {
					if *cid != own {
						send(self.out, ServerMsg::Log {
							kind: "join",
							text: format!("{} hat den Server betreten ({})", c.name, chan_name(c.channel)),
						})
						.await;
					}
				}
			}
			Event::PropertyRemoved { id: PropertyId::Client(cid), old, extra, .. } => {
				self.audio.get_mut_queues().remove(cid);
				if extra.reason == Some(tsclientlib::Reason::Subscription) {
					return;
				}
				if let PropertyValue::Client(c) = old {
					let why = match crate::capture::take_leave(cid.0) {
						Some(info) => format!(" ({})", describe_leave(&info, false)),
						None => reason_text(extra.reason)
							.map(|r| format!(" ({r}{by})"))
							.unwrap_or_default(),
					};
					send(self.out, ServerMsg::Log {
						kind: "leave",
						text: format!("{} hat den Server verlassen{why}", c.name),
					})
					.await;
				}
			}
			Event::PropertyChanged { id: PropertyId::ClientChannel(cid), old, extra, .. } => {
				if let (Some(c), PropertyValue::ChannelId(from)) = (state.clients.get(cid), old) {
					let kicked = matches!(extra.reason, Some(tsclientlib::Reason::KickChannel));
					let text = if kicked {
						format!("{} wurde aus {} gekickt{by}", c.name, chan_name(*from))
					} else if invoker_name.is_some()
						&& e.get_invoker().map(|i| i.id) != Some(*cid)
					{
						format!("{} wurde nach {} verschoben{by}", c.name, chan_name(c.channel))
					} else {
						format!("{}: {} → {}", c.name, chan_name(*from), chan_name(c.channel))
					};
					send(self.out, ServerMsg::Log { kind: if kicked { "kick" } else { "move" }, text })
						.await;
				}
			}
			Event::PropertyChanged { id: PropertyId::ClientName(cid), old, .. } => {
				if let (Some(c), PropertyValue::String(from)) = (state.clients.get(cid), old) {
					send(self.out, ServerMsg::Log {
						kind: "info",
						text: format!("{from} heißt jetzt {}", c.name),
					})
					.await;
				}
			}
			Event::PropertyAdded { id: PropertyId::Channel(ch), .. } => {
				send(self.out, ServerMsg::Log {
					kind: "channel",
					text: format!("Kanal „{}“ wurde erstellt{by}", chan_name(*ch)),
				})
				.await;
			}
			Event::PropertyRemoved { id: PropertyId::Channel(_), old: PropertyValue::Channel(c), .. } => {
				send(self.out, ServerMsg::Log {
					kind: "channel",
					text: format!("Kanal „{}“ wurde gelöscht{by}", c.name),
				})
				.await;
			}
			_ => {}
		}
	}

	async fn on_synced(&mut self, con: &mut Connection) {
		if self.synced {
			return;
		}
		self.synced = true;
		send(self.out, ServerMsg::Status { state: "connected", reason: None }).await;
		// See every client in every channel.
		if let Ok(state) = con.get_state() {
			let cmd = state.server.set_subscribed(true);
			let _ = cmd.send(con);
		}
		self.send_state(con).await;
		send(self.out, ServerMsg::CanTalk { can: con.can_send_audio() }).await;
	}

	fn track(&mut self, con: &mut Connection, cmd: tsproto_packets::packets::OutCommand, what: &str) -> Result<()> {
		let handle = cmd.send_with_result(con)?;
		self.pending.insert(handle, what.to_string());
		Ok(())
	}

	/// Queue a management command and send it when the previous one is answered.
	async fn admin_enqueue(&mut self, con: &mut Connection, req: AdminRequest) {
		if self.admin_queue.len() >= ADMIN_QUEUE_MAX {
			send(self.out, ServerMsg::AdminResult {
				id: req.id,
				ok: false,
				error: Some("Zu viele Befehle auf einmal".into()),
				code: None,
				data: Vec::new(),
			})
			.await;
			return;
		}
		self.admin_queue.push_back(req);
		self.admin_pump(con).await;
	}

	async fn admin_pump(&mut self, con: &mut Connection) {
		while self.admin_active.is_none() {
			let Some(req) = self.admin_queue.pop_front() else { return };
			crate::capture::collect(true);
			match req.packet.send_with_result(con) {
				Ok(handle) => self.admin_active = Some((handle, req.id, req.cmd, Instant::now())),
				Err(error) => {
					crate::capture::collect(false);
					send(self.out, ServerMsg::AdminResult {
						id: req.id,
						ok: false,
						error: Some(format!("Senden fehlgeschlagen: {error}")),
						code: None,
						data: Vec::new(),
					})
					.await;
				}
			}
		}
	}

	async fn admin_finished(
		&mut self, con: &mut Connection, res: std::result::Result<(), tsclientlib::CommandError>,
	) {
		let Some((_, id, cmd, _)) = self.admin_active.take() else { return };
		let mut data: Vec<AdminData> = crate::capture::take_notifies()
			.into_iter()
			.map(|(name, items)| AdminData { name, items })
			.collect();
		crate::capture::collect(false);
		if cmd == "servergetvariables" {
			if let Ok(state) = con.get_state() {
				data.push(server_variables(state));
			}
		}
		let msg = match res {
			Ok(()) => ServerMsg::AdminResult { id, ok: true, error: None, code: None, data },
			Err(e) => {
				let code = e.error as u32;
				// "empty result set": an empty list, not an error
				if code == 0x0501 || code == 0x0a03 {
					ServerMsg::AdminResult { id, ok: true, error: None, code: None, data }
				} else {
					let server = crate::capture::take_error(code);
					let mut text = admin_error_text(code, server.as_ref().map(|s| s.msg.as_str()));
					let missing = server
						.as_ref()
						.and_then(|s| s.failed_permid)
						.map(|p| p.to_string())
						.or_else(|| e.missing_permission.map(|p| format!("{p:?}")));
					if let Some(p) = missing {
						text.push_str(&format!(" (fehlendes Recht: {p})"));
					}
					ServerMsg::AdminResult { id, ok: false, error: Some(text), code: Some(code), data }
				}
			}
		};
		send(self.out, msg).await;
		self.admin_pump(con).await;
	}

	async fn admin_check_timeout(&mut self, con: &mut Connection) {
		let Some((_, id, _, since)) = &self.admin_active else { return };
		if since.elapsed() < ADMIN_TIMEOUT {
			return;
		}
		let id = *id;
		self.admin_active = None;
		crate::capture::collect(false);
		send(self.out, ServerMsg::AdminResult {
			id,
			ok: false,
			error: Some("Der Server hat nicht geantwortet".into()),
			code: None,
			data: Vec::new(),
		})
		.await;
		self.admin_pump(con).await;
	}

	async fn handle_cmd(&mut self, con: &mut Connection, cmd: ClientCmd) -> Result<()> {
		if !self.connected && !matches!(cmd, ClientCmd::Volume { .. } | ClientCmd::Ping) {
			bail!("Nicht verbunden");
		}
		match cmd {
			ClientCmd::Ping => send(self.out, ServerMsg::Pong).await,
			ClientCmd::Join { channel, password } => {
				let state = con.get_state()?;
				let me = own(state)?;
				let mut c = me.client_move(ChannelId(channel));
				if let Some(p) = password.as_deref().filter(|p| !p.is_empty()) {
					c = c.set_password(p);
				}
				let cmd = c.to_packet();
				self.track(con, cmd, "Kanalwechsel")?;
			}
			ClientCmd::MoveClient { client, channel, password } => {
				let state = con.get_state()?;
				let target = get_client(state, client)?;
				let mut c = target.client_move(ChannelId(channel));
				if let Some(p) = password.as_deref().filter(|p| !p.is_empty()) {
					c = c.set_password(p);
				}
				let cmd = c.to_packet();
				self.track(con, cmd, "Verschieben")?;
			}
			ClientCmd::Message { target, client, text } => {
				let text = text.trim();
				if text.is_empty() {
					return Ok(());
				}
				let target = match (target.as_str(), client) {
					("server", _) => MessageTarget::Server,
					("channel", _) => MessageTarget::Channel,
					("client", Some(id)) => MessageTarget::Client(ClientId(id)),
					_ => bail!("Ungültiges Nachrichtenziel"),
				};
				let cmd = con.get_state()?.send_message(target, text);
				self.track(con, cmd, "Nachricht senden")?;
			}
			ClientCmd::Poke { client, text } => {
				let cmd = con.get_state()?.send_message(MessageTarget::Poke(ClientId(client)), &text);
				self.track(con, cmd, "Anstupsen")?;
			}
			ClientCmd::SetMute { input, output } => {
				let state = con.get_state()?;
				let mut u = state.client_update();
				if let Some(i) = input {
					u = u.set_input_muted(i);
				}
				if let Some(o) = output {
					u = u.set_output_muted(o);
					self.output_muted = o;
					if o {
						self.audio.reset();
					}
				}
				let cmd = u.to_packet();
				self.track(con, cmd, "Stummschalten")?;
			}
			ClientCmd::SetAway { away, message } => {
				let state = con.get_state()?;
				let msg = message.unwrap_or_default();
				let u = if away { state.client_update().set_away(Some(&msg)) } else { state.client_update().set_away(None) };
				let cmd = u.to_packet();
				self.track(con, cmd, "Abwesenheitsstatus")?;
			}
			ClientCmd::SetName { name } => {
				let name = name.trim();
				if name.chars().count() < 3 || name.chars().count() > 30 {
					bail!("Der Nickname muss zwischen 3 und 30 Zeichen lang sein.");
				}
				let cmd = con.get_state()?.client_update().set_name(name).to_packet();
				self.track(con, cmd, "Umbenennen")?;
			}
			ClientCmd::SetDescription { client, description } => {
				let state = con.get_state()?;
				let cmd = get_client(state, client)?.edit().set_description(&description).to_packet();
				self.track(con, cmd, "Beschreibung setzen")?;
			}
			ClientCmd::SetCommander { commander } => {
				let cmd = con.get_state()?.client_update().set_is_channel_commander(commander).to_packet();
				self.track(con, cmd, "Channel Commander")?;
			}
			ClientCmd::Volume { client, volume } => {
				let v = volume.clamp(0.0, 4.0);
				self.volumes.insert(ClientId(client), v);
				if let Some(q) = self.audio.get_mut_queues().get_mut(&ClientId(client)) {
					q.volume = v;
				}
			}
			ClientCmd::CreateChannel {
				name,
				parent,
				password,
				topic,
				description,
				kind,
				max_clients,
			} => {
				let name = name.trim();
				if name.is_empty() {
					bail!("Kanalname fehlt");
				}
				let mut opts = tsclientlib::data::ChannelOptions::new(name);
				if let Some(p) = parent.filter(|p| *p != 0) {
					opts = opts.parent_id(ChannelId(p));
				}
				if let Some(p) = password.as_deref().filter(|p| !p.is_empty()) {
					opts = opts.password(p);
				}
				if let Some(t) = topic.as_deref().filter(|p| !p.is_empty()) {
					opts = opts.topic(t);
				}
				if let Some(d) = description.as_deref().filter(|p| !p.is_empty()) {
					opts = opts.description(d);
				}
				if let Some(m) = max_clients.filter(|m| *m > 0) {
					opts = opts.max_clients(tsclientlib::MaxClients::Limited(m));
				}
				opts = opts.channel_type(match kind.as_deref() {
					Some("permanent") => tsclientlib::ChannelType::Permanent,
					Some("semi_permanent") => tsclientlib::ChannelType::SemiPermanent,
					_ => tsclientlib::ChannelType::Temporary,
				});
				let cmd = con.get_state()?.server.add_channel(opts);
				self.track(con, cmd, "Kanal erstellen")?;
			}
			ClientCmd::DeleteChannel { channel, force } => {
				get_channel(con.get_state()?, channel)?;
				let cmd = tsclientlib::messages::c2s::OutChannelDeleteMessage::new(&mut std::iter::once(
					tsclientlib::messages::c2s::OutChannelDeletePart { channel_id: ChannelId(channel), force },
				));
				self.track(con, cmd, "Kanal löschen")?;
			}
			ClientCmd::Kick { client, from, reason } => {
				let state = con.get_state()?;
				let r = if from == "server" {
					tsclientlib::Reason::KickServer
				} else {
					tsclientlib::Reason::KickChannel
				};
				let mut k = get_client(state, client)?.kick(r);
				if let Some(m) = reason.as_deref().filter(|m| !m.is_empty()) {
					k = k.set_reason_message(m);
				}
				let cmd = k.to_packet();
				self.track(con, cmd, "Kicken")?;
			}
			ClientCmd::SubscribeChannel { channel, subscribe } => {
				let cmd = get_channel(con.get_state()?, channel)?.set_subscribed(subscribe);
				self.track(con, cmd, "Kanal abonnieren")?;
			}
			ClientCmd::ChannelDescription { channel } => {
				let cmd = get_channel(con.get_state()?, channel)?.description().to_packet();
				self.track(con, cmd, "Kanalbeschreibung laden")?;
			}
			ClientCmd::Admin { id, cmd, parts, flags } => match admin_packet(&cmd, &parts, &flags) {
				Ok(packet) => self.admin_enqueue(con, AdminRequest { id, cmd, packet }).await,
				Err(error) => {
					send(self.out, ServerMsg::AdminResult {
						id,
						ok: false,
						error: Some(error.to_string()),
						code: None,
						data: Vec::new(),
					})
					.await;
				}
			},
			ClientCmd::UseToken { token } => {
				let token = token.trim();
				if token.is_empty() {
					return Ok(());
				}
				let cmd = tsclientlib::messages::c2s::OutPrivilegeKeyUseMessage::new(&mut std::iter::once(
					tsclientlib::messages::c2s::OutPrivilegeKeyUsePart { token: token.into() },
				));
				self.track(con, cmd, TOKEN_WHAT)?;
			}
			ClientCmd::Connect { .. } | ClientCmd::Disconnect { .. } => {}
		}
		Ok(())
	}

	fn send_audio(&mut self, con: &mut Connection, samples: &[i16]) {
		if !self.connected || samples.len() != FRAME_SAMPLES {
			return;
		}
		let input: Vec<f32> = samples.iter().map(|s| *s as f32 / 32768.0).collect();
		match self.encoder.encode_float(&input, &mut self.opus_buf[..]) {
			Ok(len) => {
				let data = self.opus_buf[..len].to_vec();
				self.send_packet(con, &data);
			}
			Err(error) => warn!(%error, "Opus encoding failed"),
		}
	}

	/// The browser already encoded the audio: pass the packet on unchanged.
	fn send_opus(&mut self, con: &mut Connection, packet: &[u8]) {
		if !self.connected || packet.is_empty() {
			return;
		}
		self.send_packet(con, packet);
	}

	fn send_packet(&mut self, con: &mut Connection, data: &[u8]) {
		// Muted, away or no talk power: the server would drop it anyway
		// (and tsclientlib warns "Sending audio while muted").
		if !can_send_audio(con) {
			return;
		}
		self.audio_seq = self.audio_seq.wrapping_add(1);
		let packet =
			OutAudio::new(&AudioData::C2S { id: self.audio_seq, codec: channel_codec(con), data });
		if let Err(error) = con.send_audio(packet) {
			debug!(%error, "Failed to send audio");
		}
		self.own_talking = true;
	}

	fn end_audio(&mut self, con: &mut Connection) {
		if !self.connected || !self.own_talking {
			return;
		}
		self.own_talking = false;
		if !can_send_audio(con) {
			return;
		}
		self.audio_seq = self.audio_seq.wrapping_add(1);
		let packet =
			OutAudio::new(&AudioData::C2S { id: self.audio_seq, codec: channel_codec(con), data: &[] });
		let _ = con.send_audio(packet);
	}

	async fn audio_tick(&mut self) {
		let mut talking = Vec::new();
		if !self.audio.get_queues().is_empty() {
			let mut buf = vec![0f32; FRAME_SAMPLES * 2];
			self.audio.fill_buffer_with_proc(&mut buf, |id, data| {
				if !data.is_empty() {
					talking.push(id.0);
				}
			});
			if !talking.is_empty() && !self.output_muted && self.out_encoder.is_some() {
				let mono: Vec<f32> =
					buf.chunks_exact(2).map(|f| ((f[0] + f[1]) * 0.5).clamp(-1.0, 1.0)).collect();
				let encoder = self.out_encoder.as_mut().unwrap();
				match encoder.encode_float(&mono, &mut self.opus_buf[..]) {
					Ok(len) => {
						let _ = self.out.try_send(FromSession::Binary(self.opus_buf[..len].to_vec()));
					}
					Err(error) => debug!(%error, "Opus encoding for the browser failed"),
				}
			} else if !talking.is_empty() && !self.output_muted {
				let mut bytes = Vec::with_capacity(FRAME_SAMPLES * 2);
				for frame in buf.chunks_exact(2) {
					let v = ((frame[0] + frame[1]) * 0.5).clamp(-1.0, 1.0);
					let s = (v * 32767.0) as i16;
					bytes.extend_from_slice(&s.to_le_bytes());
				}
				// Never block the audio clock on a slow browser; drop the frame instead.
				let _ = self.out.try_send(FromSession::Binary(bytes));
			}
		}
		talking.sort_unstable();
		if talking != self.talking {
			self.talking = talking.clone();
			send_now(self.out, ServerMsg::Talking { ids: talking });
		}
	}

	async fn send_state(&mut self, con: &Connection) {
		self.state_dirty = false;
		self.last_state = Instant::now();
		let Ok(state) = con.get_state() else { return };
		let (ping, loss) = match con.get_network_stats() {
			Ok(s) => (Some(s.rtt.as_secs_f64() * 1000.0), Some(s.get_packetloss())),
			Err(_) => (None, None),
		};
		if let Some(me) = state.clients.get(&state.own_client) {
			self.nickname = me.name.clone();
			let channel = state.channels.get(&me.channel).map(|c| c.name.clone());
			self.hub.update(|i| {
				i.nickname = Some(me.name.clone());
				i.client_id = Some(state.own_client.0);
				i.channel = channel;
				i.ping_ms = ping;
			});
		}
		let msg = build_state(state, ping, loss);
		send(self.out, msg).await;
	}
}

fn own(state: &State) -> Result<&Client> {
	state.clients.get(&state.own_client).ok_or_else(|| anyhow::anyhow!("Eigener Client unbekannt"))
}

fn get_client(state: &State, id: u16) -> Result<&Client> {
	state.clients.get(&ClientId(id)).ok_or_else(|| anyhow::anyhow!("Client nicht gefunden"))
}

fn get_channel(state: &State, id: u64) -> Result<&Channel> {
	state.channels.get(&ChannelId(id)).ok_or_else(|| anyhow::anyhow!("Kanal nicht gefunden"))
}

pub(crate) fn channel_codec(con: &Connection) -> CodecType {
	let Ok(state) = con.get_state() else { return CodecType::OpusVoice };
	let codec = state
		.clients
		.get(&state.own_client)
		.and_then(|c| state.channels.get(&c.channel))
		.map(|c| c.codec);
	match codec {
		Some(tsclientlib::Codec::OpusMusic) => CodecType::OpusMusic,
		_ => CodecType::OpusVoice,
	}
}

/// The server settings the bridge knows from `initserver` and `notifyserveredited`,
/// with the names `serveredit` uses. `notifyserverupdated` (also in the answer)
/// adds the rest.
fn server_variables(state: &State) -> AdminData {
	let s = &state.server;
	let mut m = std::collections::HashMap::new();
	let mut put = |k: &str, v: String| {
		m.insert(format!("virtualserver_{k}"), v);
	};
	put("name", s.name.clone());
	put("nickname", s.nickname.clone().unwrap_or_default());
	put("name_phonetic", s.phonetic_name.clone());
	put("welcomemessage", s.welcome_message.clone());
	put("maxclients", s.max_clients.to_string());
	put("hostmessage", s.hostmessage.clone());
	put("hostmessage_mode", (s.hostmessage_mode as u8).to_string());
	put("hostbanner_url", s.hostbanner_url.clone());
	put("hostbanner_gfx_url", s.hostbanner_gfx_url.clone());
	put("hostbanner_gfx_interval", s.hostbanner_gfx_interval.whole_seconds().to_string());
	put("hostbanner_mode", (s.hostbanner_mode as u8).to_string());
	put("hostbutton_tooltip", s.hostbutton_tooltip.clone());
	put("hostbutton_url", s.hostbutton_url.clone());
	put("hostbutton_gfx_url", s.hostbutton_gfx_url.clone());
	put("codec_encryption_mode", (s.codec_encryption_mode as u8).to_string());
	put("default_server_group", s.default_server_group.0.to_string());
	put("default_channel_group", s.default_channel_group.0.to_string());
	put("priority_speaker_dimm_modificator", s.priority_speaker_dimm_modificator.to_string());
	put("channel_temp_delete_delay_default", s.temp_channel_default_delete_delay.whole_seconds().to_string());
	put("icon_id", s.icon.0.to_string());
	if let Some(o) = &s.optional_data {
		put("flag_password", if o.has_password { "1" } else { "0" }.into());
		put("default_channel_admin_group", o.default_channel_admin_group.0.to_string());
		put("reserved_slots", o.reserved_slots.to_string());
		put("needed_identity_security_level", o.needed_identity_security_level.to_string());
		put("antiflood_points_tick_reduce", o.antiflood_points_tick_reduce.to_string());
		put("antiflood_points_needed_command_block", o.antiflood_points_to_command_block.to_string());
		put("antiflood_points_needed_ip_block", o.antiflood_points_to_ip_block.to_string());
		put("complain_autoban_count", o.complain_autoban_count.to_string());
		put("complain_autoban_time", o.complain_autoban_time.whole_seconds().to_string());
		put("complain_remove_time", o.complain_remove_time.whole_seconds().to_string());
		put(
			"min_clients_in_channel_before_forced_silence",
			o.min_clients_in_channel_before_forced_silence.to_string(),
		);
		put("max_download_total_bandwidth", o.max_download_bandwidth_total.to_string());
		put("max_upload_total_bandwidth", o.max_upload_bandwidth_total.to_string());
		put("download_quota", o.download_quota.to_string());
		put("upload_quota", o.upload_quota.to_string());
		put("weblist_enabled", if o.weblist_enabled { "1" } else { "0" }.into());
		for (k, v) in [
			("log_client", o.log_client),
			("log_query", o.log_query),
			("log_channel", o.log_channel),
			("log_permissions", o.log_permissions),
			("log_server", o.log_server),
			("log_filetransfer", o.log_filetransfer),
		] {
			put(k, if v { "1" } else { "0" }.into());
		}
	}
	AdminData { name: "bridge_server".into(), items: vec![m] }
}

fn build_state(state: &State, ping_ms: Option<f64>, packet_loss: Option<f32>) -> ServerMsg {
	let s = &state.server;
	let server = ServerDto {
		uid: s.public_key.get_uid(),
		name: s.name.clone(),
		welcome_message: s.welcome_message.clone(),
		host_message: s.hostmessage.clone(),
		platform: s.platform.clone(),
		version: s.version.clone(),
		max_clients: s.max_clients,
		hostbanner_url: s.hostbanner_url.clone(),
		hostbanner_gfx_url: s.hostbanner_gfx_url.clone(),
		hostbutton_url: s.hostbutton_url.clone(),
		hostbutton_tooltip: s.hostbutton_tooltip.clone(),
		hostbutton_gfx_url: s.hostbutton_gfx_url.clone(),
		nickname: s.nickname.clone().unwrap_or_default(),
		phonetic_name: s.phonetic_name.clone(),
		hostmessage_mode: s.hostmessage_mode as u8,
		hostbanner_mode: s.hostbanner_mode as u8,
		hostbanner_gfx_interval: s.hostbanner_gfx_interval.whole_seconds(),
		codec_encryption_mode: s.codec_encryption_mode as u8,
		default_server_group: s.default_server_group.0,
		default_channel_group: s.default_channel_group.0,
		priority_speaker_dimm: s.priority_speaker_dimm_modificator,
		temp_delete_delay: s.temp_channel_default_delete_delay.whole_seconds(),
	};

	let channels = state
		.channels
		.values()
		.map(|c| ChannelDto {
			id: c.id.0,
			parent: c.parent.0,
			order: c.order.0,
			name: c.name.clone(),
			topic: c.topic.clone().unwrap_or_default(),
			has_password: c.has_password.unwrap_or(false),
			max_clients: match c.max_clients {
				Some(tsclientlib::MaxClients::Limited(n)) => n as i32,
				_ => -1,
			},
			is_default: c.is_default.unwrap_or(false),
			kind: match c.channel_type {
				tsclientlib::ChannelType::Permanent => "permanent",
				tsclientlib::ChannelType::SemiPermanent => "semi_permanent",
				tsclientlib::ChannelType::Temporary => "temporary",
			},
			needed_talk_power: c.needed_talk_power.unwrap_or(0),
			codec: format!("{:?}", c.codec),
			codec_quality: c.codec_quality.unwrap_or(0),
			subscribed: c.subscribed,
			description: c.optional_data.as_ref().map(|d| d.description.clone()),
			is_unencrypted: c.is_unencrypted.unwrap_or(false),
			max_family_clients: match c.max_family_clients {
				Some(tsclientlib::MaxClients::Limited(n)) => n as i32,
				Some(tsclientlib::MaxClients::Inherited) => -2,
				_ => -1,
			},
			codec_latency_factor: c.codec_latency_factor.unwrap_or(1),
			delete_delay: c.delete_delay.map(|d| d.whole_seconds()).unwrap_or(0),
			phonetic_name: c.phonetic_name.clone().unwrap_or_default(),
		})
		.collect();

	let clients = state
		.clients
		.values()
		.map(|c| {
			let mut groups: Vec<_> = c
				.server_groups
				.iter()
				.filter_map(|g| state.server_groups.get(g))
				.map(|g| (g.sort_id, g.name.clone()))
				.collect();
			groups.sort();
			let conn = c.connection_data.as_ref();
			ClientDto {
				id: c.id.0,
				channel: c.channel.0,
				name: c.name.clone(),
				uid: c.uid.as_ref().map(|u| u.as_ref().to_string()),
				database_id: c.database_id.0,
				input_muted: c.input_muted,
				output_muted: c.output_muted,
				output_only_muted: c.output_only_muted,
				input_hardware_enabled: c.input_hardware_enabled,
				output_hardware_enabled: c.output_hardware_enabled,
				away: c.away_message.clone(),
				talk_power: c.talk_power,
				talk_power_granted: c.talk_power_granted,
				talk_request: c.talk_power_request.as_ref().map(|r| r.message.clone()),
				is_priority_speaker: c.is_priority_speaker,
				is_channel_commander: c.is_channel_commander,
				is_recording: c.is_recording,
				is_query: !matches!(c.client_type, tsclientlib::ClientType::Normal),
				country: c.country_code.clone(),
				description: c.description.clone(),
				server_groups: groups.into_iter().map(|(_, n)| n).collect(),
				channel_group: state.channel_groups.get(&c.channel_group).map(|g| g.name.clone()),
				version: c.optional_data.as_ref().map(|d| d.version.clone()),
				platform: c.optional_data.as_ref().map(|d| d.platform.clone()),
				ping_ms: conn.and_then(|d| d.ping).map(|p| p.whole_milliseconds() as i64),
				connected_secs: conn.and_then(|d| d.connected_time).map(|p| p.whole_seconds()),
				idle_secs: conn.map(|d| d.idle_time.whole_seconds()),
			}
		})
		.collect();

	ServerMsg::State {
		own_id: state.own_client.0,
		server,
		channels,
		clients,
		ping_ms,
		packet_loss,
	}
}

#[cfg(test)]
mod tests {
	use std::collections::BTreeMap;

	use serde_json::json;

	use super::admin_packet;

	fn part(v: serde_json::Value) -> BTreeMap<String, serde_json::Value> { serde_json::from_value(v).unwrap() }

	fn text(cmd: &str, parts: &[BTreeMap<String, serde_json::Value>], flags: &[&str]) -> String {
		let flags: Vec<String> = flags.iter().map(|f| f.to_string()).collect();
		let p = admin_packet(cmd, parts, &flags).unwrap().into_packet();
		String::from_utf8(p.content().to_vec()).unwrap()
	}

	#[test]
	fn builds_escaped_commands() {
		assert_eq!(
			text("servergrouprename", &[part(json!({"sgid": 6, "name": "Server Admin|x"}))], &[]),
			r"servergrouprename name=Server\sAdmin\px sgid=6"
		);
		assert_eq!(
			text("servergroupaddperm", &[part(json!({"sgid": 6, "permid": 12, "permvalue": -1, "permskip": true}))], &[]),
			"servergroupaddperm permid=12 permskip=1 permvalue=-1 sgid=6"
		);
		assert_eq!(text("servergroupclientlist", &[part(json!({"sgid": 7}))], &["-names"]), "servergroupclientlist sgid=7 -names");
		assert_eq!(
			text("servergroupdelperm", &[part(json!({"sgid": 7, "permid": 1})), part(json!({"permid": 2}))], &[]),
			"servergroupdelperm permid=1 sgid=7|permid=2"
		);
	}

	#[test]
	fn rejects_unknown_commands_and_arguments() {
		let none: Vec<String> = Vec::new();
		assert!(admin_packet("clientinit", &[], &none).is_err());
		assert!(admin_packet("serverstop", &[], &none).is_err());
		assert!(admin_packet("serveredit", &[part(json!({"return_code": "1"}))], &none).is_err());
		assert!(admin_packet("serveredit", &[part(json!({"a b": "1"}))], &none).is_err());
		assert!(admin_packet("serveredit", &[part(json!({"x": {"y": 1}}))], &none).is_err());
		assert!(admin_packet("banlist", &[], &["-all".to_string()]).is_err());
	}
}
