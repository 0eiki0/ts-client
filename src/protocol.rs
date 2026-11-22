//! JSON messages exchanged between the browser and the bridge over the WebSocket.
//!
//! Binary WebSocket frames carry audio:
//! * browser -> bridge: 960 little-endian i16 samples (20 ms, 48 kHz, mono).
//!   An empty binary frame marks the end of a transmission.
//! * bridge -> browser: 960 little-endian i16 samples (20 ms, 48 kHz, mono), already mixed.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientCmd {
	Connect {
		#[serde(default)]
		address: Option<String>,
		nickname: String,
		#[serde(default)]
		server_password: Option<String>,
		#[serde(default)]
		channel: Option<String>,
		#[serde(default)]
		channel_password: Option<String>,
		/// Identity in TeamSpeak format (`<counter>V<key>`) or base64 key.
		#[serde(default)]
		identity: Option<String>,
		/// The browser can decode Opus: send the mixed audio as Opus packets
		/// instead of raw PCM (about 8 kB/s instead of 96 kB/s).
		#[serde(default)]
		opus: bool,
	},
	Disconnect {
		#[serde(default)]
		message: Option<String>,
	},
	/// Move ourselves into a channel.
	Join {
		channel: u64,
		#[serde(default)]
		password: Option<String>,
	},
	/// Move another client (needs permissions).
	MoveClient {
		client: u16,
		channel: u64,
		#[serde(default)]
		password: Option<String>,
	},
	Message {
		/// "server", "channel" or "client"
		target: String,
		#[serde(default)]
		client: Option<u16>,
		text: String,
	},
	Poke {
		client: u16,
		text: String,
	},
	SetMute {
		#[serde(default)]
		input: Option<bool>,
		#[serde(default)]
		output: Option<bool>,
	},
	SetAway {
		away: bool,
		#[serde(default)]
		message: Option<String>,
	},
	SetName {
		name: String,
	},
	SetDescription {
		client: u16,
		description: String,
	},
	SetCommander {
		commander: bool,
	},
	/// Per-client playback volume (0.0 - 2.0), applied by the bridge before mixing.
	Volume {
		client: u16,
		volume: f32,
	},
	CreateChannel {
		name: String,
		#[serde(default)]
		parent: Option<u64>,
		#[serde(default)]
		password: Option<String>,
		#[serde(default)]
		topic: Option<String>,
		#[serde(default)]
		description: Option<String>,
		/// "temporary", "semi_permanent" or "permanent"
		#[serde(default)]
		kind: Option<String>,
		#[serde(default)]
		max_clients: Option<u16>,
	},
	DeleteChannel {
		channel: u64,
		#[serde(default)]
		force: bool,
	},
	Kick {
		client: u16,
		/// "channel" or "server"
		from: String,
		#[serde(default)]
		reason: Option<String>,
	},
	SubscribeChannel {
		channel: u64,
		subscribe: bool,
	},
	/// Request the description of a channel.
	ChannelDescription {
		channel: u64,
	},
	/// Use a privilege key (e.g. the ServerAdmin token).
	UseToken {
		token: String,
	},
	/// A management command of the TeamSpeak client protocol (server and channel
	/// settings, groups, permissions, bans, privilege keys …). The server checks
	/// the permissions of the user exactly like for the official client; the
	/// bridge only allows the commands in `session::ADMIN_COMMANDS`.
	Admin {
		/// Chosen by the browser, comes back in `admin_result`.
		id: u32,
		cmd: String,
		/// The command arguments; more than one entry makes a list (`a=1|a=2`).
		#[serde(default)]
		parts: Vec<std::collections::BTreeMap<String, serde_json::Value>>,
		/// Options without value, e.g. `-names`.
		#[serde(default)]
		flags: Vec<String>,
	},
	Ping,
}

#[derive(Debug, Serialize)]
pub struct ChannelDto {
	pub id: u64,
	pub parent: u64,
	pub order: u64,
	pub name: String,
	pub topic: String,
	pub has_password: bool,
	/// -1 = unlimited / inherited
	pub max_clients: i32,
	pub is_default: bool,
	pub kind: &'static str,
	pub needed_talk_power: i32,
	pub codec: String,
	pub codec_quality: u8,
	pub subscribed: bool,
	pub description: Option<String>,
	pub is_unencrypted: bool,
	/// -1 = unlimited, -2 = inherited
	pub max_family_clients: i32,
	pub codec_latency_factor: i32,
	/// Seconds a temporary channel is kept after the last user left.
	pub delete_delay: i64,
	pub phonetic_name: String,
}

#[derive(Debug, Serialize)]
pub struct ClientDto {
	pub id: u16,
	pub channel: u64,
	pub name: String,
	pub uid: Option<String>,
	pub database_id: u64,
	pub input_muted: bool,
	pub output_muted: bool,
	pub output_only_muted: bool,
	pub input_hardware_enabled: bool,
	pub output_hardware_enabled: bool,
	pub away: Option<String>,
	pub talk_power: i32,
	pub talk_power_granted: bool,
	pub talk_request: Option<String>,
	pub is_priority_speaker: bool,
	pub is_channel_commander: bool,
	pub is_recording: bool,
	pub is_query: bool,
	pub country: String,
	pub description: String,
	pub server_groups: Vec<String>,
	pub channel_group: Option<String>,
	pub version: Option<String>,
	pub platform: Option<String>,
	pub ping_ms: Option<i64>,
	pub connected_secs: Option<i64>,
	pub idle_secs: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ServerDto {
	/// Unique id of the virtual server (from its public key).
	pub uid: String,
	pub name: String,
	pub welcome_message: String,
	pub host_message: String,
	pub platform: String,
	pub version: String,
	pub max_clients: u16,
	pub hostbanner_url: String,
	pub hostbanner_gfx_url: String,
	pub hostbutton_url: String,
	pub hostbutton_tooltip: String,
	pub hostbutton_gfx_url: String,
	pub nickname: String,
	pub phonetic_name: String,
	/// 0 = none, 1 = log, 2 = modal, 3 = modal + quit
	pub hostmessage_mode: u8,
	/// 0 = no adjust, 1 = adjust ignoring aspect, 2 = adjust keeping aspect
	pub hostbanner_mode: u8,
	pub hostbanner_gfx_interval: i64,
	/// 0 = per channel, 1 = forced off, 2 = forced on
	pub codec_encryption_mode: u8,
	pub default_server_group: u64,
	pub default_channel_group: u64,
	pub priority_speaker_dimm: f32,
	pub temp_delete_delay: i64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMsg {
	/// connecting | connected | reconnecting | disconnected
	Status {
		state: &'static str,
		#[serde(skip_serializing_if = "Option::is_none")]
		reason: Option<String>,
	},
	Identity {
		identity: String,
		uid: String,
	},
	State {
		own_id: u16,
		server: ServerDto,
		channels: Vec<ChannelDto>,
		clients: Vec<ClientDto>,
		ping_ms: Option<f64>,
		packet_loss: Option<f32>,
	},
	Chat {
		/// server | channel | private
		target: &'static str,
		from_id: u16,
		from_name: String,
		from_uid: Option<String>,
		/// For private messages: the other side of the conversation.
		partner: Option<u16>,
		text: String,
	},
	Poke {
		from_id: u16,
		from_name: String,
		text: String,
	},
	Log {
		/// join | leave | move | kick | info | channel
		kind: &'static str,
		text: String,
	},
	Talking {
		ids: Vec<u16>,
	},
	CanTalk {
		can: bool,
	},
	Error {
		message: String,
	},
	Info {
		message: String,
	},
	/// Answer to `ClientCmd::Admin`.
	AdminResult {
		id: u32,
		ok: bool,
		#[serde(skip_serializing_if = "Option::is_none")]
		error: Option<String>,
		/// TeamSpeak error number (e.g. 2568 = insufficient permissions).
		#[serde(skip_serializing_if = "Option::is_none")]
		code: Option<u32>,
		/// The notifications the server sent in answer, e.g. a permission list.
		data: Vec<AdminData>,
	},
	Pong,
}

#[derive(Debug, Serialize)]
pub struct AdminData {
	pub name: String,
	pub items: Vec<std::collections::HashMap<String, String>>,
}

impl ServerMsg {
	pub fn to_json(&self) -> String { serde_json::to_string(self).unwrap_or_else(|_| "{}".into()) }
}
