//! Local web server for the app window (only on 127.0.0.1): the user interface
//! of the web bridge and the WebSocket to the TeamSpeak session.
//!
//! Other programs and websites in a normal browser can also reach 127.0.0.1, so
//! only requests for our own address (Host) and from our own page (Origin) are
//! accepted.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures::prelude::*;
use tokio::sync::{Semaphore, mpsc};
use tracing::warn;

use crate::Config;
use crate::session::{self, FromSession, ToSession};

const INDEX_HTML: &str = include_str!("../web/index.html");
const APP_JS: &str = include_str!("../web/app.js");
const MANAGE_JS: &str = include_str!("../web/manage.js");
const STYLE_CSS: &str = include_str!("../web/style.css");
const WORKLET_JS: &str = include_str!("../web/audio-worklet.js");
const ICON_SVG: &str = include_str!("../web/icon.svg");
const HELP_HTML: &str = include_str!("../web/help.html");
const HELP_JS: &str = include_str!("../web/help.js");
const RNNOISE_WASM: &[u8] = include_bytes!("../web/rnnoise.wasm");
const RNNOISE_V2_WASM: &[u8] = include_bytes!("../web/rnnoise-v2.wasm");

const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; \
	img-src 'self' data: blob:; connect-src 'self' ws: wss:; media-src 'self' blob:; \
	object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

pub struct AppState {
	pub cfg: Arc<Config>,
	pub origin: String,
	pub host: String,
	identity_jobs: Semaphore,
}

fn asset(content_type: &'static str, body: &'static [u8]) -> Response {
	(
		[
			(header::CONTENT_TYPE, content_type),
			(header::CACHE_CONTROL, "no-cache"),
			(header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
			(header::CONTENT_SECURITY_POLICY, CSP),
			(header::REFERRER_POLICY, "no-referrer"),
		],
		body,
	)
		.into_response()
}

/// Only our window may use the server.
async fn guard(State(state): State<Arc<AppState>>, req: Request, next: Next) -> Response {
	let headers = req.headers();
	let host_ok = headers.get(header::HOST).and_then(|h| h.to_str().ok()) == Some(state.host.as_str());
	let origin_ok = match headers.get(header::ORIGIN).and_then(|h| h.to_str().ok()) {
		None => req.method() == axum::http::Method::GET && req.uri().path() != "/ws",
		Some(o) => o == state.origin,
	};
	if !host_ok || !origin_ok {
		return StatusCode::FORBIDDEN.into_response();
	}
	next.run(req).await
}

pub fn router(cfg: Arc<Config>, addr: SocketAddr) -> Router {
	let host = addr.to_string();
	let state = Arc::new(AppState { cfg, origin: format!("http://{host}"), host, identity_jobs: Semaphore::new(2) });
	Router::new()
		.route("/", get(|| async { asset("text/html; charset=utf-8", INDEX_HTML.as_bytes()) }))
		.route("/app.js", get(|| async { asset("text/javascript; charset=utf-8", APP_JS.as_bytes()) }))
		.route("/manage.js", get(|| async { asset("text/javascript; charset=utf-8", MANAGE_JS.as_bytes()) }))
		.route("/style.css", get(|| async { asset("text/css; charset=utf-8", STYLE_CSS.as_bytes()) }))
		.route("/audio-worklet.js", get(|| async { asset("text/javascript; charset=utf-8", WORKLET_JS.as_bytes()) }))
		.route("/icon.svg", get(|| async { asset("image/svg+xml", ICON_SVG.as_bytes()) }))
		.route("/rnnoise.wasm", get(|| async { asset("application/wasm", RNNOISE_WASM) }))
		.route("/rnnoise-v2.wasm", get(|| async { asset("application/wasm", RNNOISE_V2_WASM) }))
		.route("/help.html", get(|| async { asset("text/html; charset=utf-8", HELP_HTML.as_bytes()) }))
		.route("/help.js", get(|| async { asset("text/javascript; charset=utf-8", HELP_JS.as_bytes()) }))
		.route("/api/config", get(api_config))
		.route("/api/identity", post(api_identity))
		.route("/api/identity/new", post(api_identity_new))
		.route("/ws", get(ws_handler))
		.layer(middleware::from_fn_with_state(state.clone(), guard))
		.with_state(state)
}

async fn api_config() -> impl IntoResponse {
	axum::Json(serde_json::json!({
		"title": "Funkraum",
		"server": "",
		"allow_any_server": true,
		"needs_access_password": false,
		"default_channel": null,
		"default_address": null,
		"sync": false,
		"history": false,
		"desktop": true,
		"version": env!("CARGO_PKG_VERSION"),
	}))
}

fn identity_json(id: &tsclientlib::Identity) -> Response {
	axum::Json(serde_json::json!({
		"identity": format!("{}V{}", id.counter(), id.key().to_ts()),
		"uid": id.key().to_pub().get_uid(),
		"level": id.level(),
	}))
	.into_response()
}

/// Checks an identity to import (TeamSpeak 3 client export or bare key).
async fn api_identity(State(state): State<Arc<AppState>>, body: String) -> Response {
	let bad = |msg: String| (StatusCode::BAD_REQUEST, axum::Json(serde_json::json!({ "error": msg }))).into_response();
	if body.len() > 16 * 1024 {
		return bad("Die Eingabe ist zu groß.".into());
	}
	let Some(key) = extract_identity(&body) else {
		return bad("Keine Identität gefunden.".into());
	};
	let Ok(_job) = state.identity_jobs.acquire().await else {
		return bad("Bitte später erneut versuchen.".into());
	};
	match tokio::task::spawn_blocking(move || tsclientlib::Identity::new_from_str(&key)).await {
		Ok(Ok(id)) => identity_json(&id),
		Ok(Err(error)) => bad(format!(
			"Das ist keine gültige TeamSpeak-Identität ({error}). Exportiere sie im TeamSpeak-3-Client unter \
			 Extras → Identitäten → Exportieren und füge den Inhalt der Datei ein."
		)),
		Err(error) => bad(error.to_string()),
	}
}

async fn api_identity_new(State(state): State<Arc<AppState>>) -> Response {
	let Ok(_job) = state.identity_jobs.acquire().await else {
		return (StatusCode::SERVICE_UNAVAILABLE, "Bitte später erneut versuchen.").into_response();
	};
	match tokio::task::spawn_blocking(tsclientlib::Identity::create).await {
		Ok(id) => identity_json(&id),
		Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
	}
}

fn extract_identity(input: &str) -> Option<String> {
	let clean = |s: &str| s.trim().trim_matches('"').trim().to_string();
	let from_ini = input.lines().find_map(|l| {
		let (k, v) = l.trim().split_once('=')?;
		(k.trim().eq_ignore_ascii_case("identity")).then(|| clean(v))
	});
	let key = from_ini.unwrap_or_else(|| clean(input));
	let key: String = key.chars().filter(|c| !c.is_whitespace()).collect();
	(!key.is_empty()).then_some(key)
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>, _h: HeaderMap) -> Response {
	ws.max_message_size(64 * 1024).on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
	let (mut sink, mut stream) = socket.split();
	let (to_session, session_rx) = mpsc::channel::<ToSession>(256);
	let (session_tx, mut from_session) = mpsc::channel::<FromSession>(512);
	session::spawn(state.cfg.clone(), None, crate::admin::SessionHandle::local(), session_rx, session_tx);

	let writer = tokio::spawn(async move {
		while let Some(msg) = from_session.recv().await {
			let m = match msg {
				FromSession::Text(t) => Message::Text(t.into()),
				FromSession::Binary(b) => Message::Binary(b.into()),
			};
			if sink.send(m).await.is_err() {
				break;
			}
		}
		let _ = sink.close().await;
	});

	while let Some(Ok(msg)) = stream.next().await {
		let item = match msg {
			Message::Text(t) => match serde_json::from_str(&t) {
				Ok(cmd) => ToSession::Cmd(cmd),
				Err(error) => {
					warn!(%error, "Ungültige Nachricht von der Oberfläche");
					continue;
				}
			},
			Message::Binary(b) => {
				// empty = end of transmission, 1920 bytes = 20 ms PCM, otherwise one Opus packet
				if b.is_empty() {
					ToSession::AudioEnd
				} else if b.len() == session::FRAME_SAMPLES * 2 {
					ToSession::Audio(b.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect())
				} else if b.len() <= session::MAX_OPUS_FRAME_SIZE {
					ToSession::Opus(b.to_vec())
				} else {
					continue;
				}
			}
			Message::Close(_) => break,
			_ => continue,
		};
		match item {
			ToSession::Audio(_) | ToSession::Opus(_) => {
				let _ = to_session.try_send(item);
			}
			_ => {
				if to_session.send(item).await.is_err() {
					break;
				}
			}
		}
	}
	drop(to_session);
	let _ = writer.await;
}
