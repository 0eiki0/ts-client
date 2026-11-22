//! funkraum: TeamSpeak client for Windows, macOS and Linux.
//!
//! The program contains Funkraum Web (the web bridge): a local web server on 127.0.0.1
//! connects to the TeamSpeak server (tsclientlib) and serves its user interface,
//! which is shown in an app window (system web view). Global push-to-talk reads
//! the keyboard and mouse also while the window is in the background.

#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod admin;
mod bans;
mod capture;
mod hotkeys;
mod notify;
mod protocol;
mod query;
mod resolve;
mod session;
mod updater;
mod versions;
mod web;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use wry::{PermissionKind, PermissionResponse, WebContext, WebViewBuilder};

/// Settings the session code of the bridge reads.
pub struct Config {
	/// The bridge's "own" server; the desktop client has none.
	pub ts_server: String,
	pub allow_any_server: bool,
	pub verbose: u8,
}

/// Fixed port: the web view keeps its data (identities, settings) per address.
const PORT: u16 = 47213;

/// Window icon (same as the web interface's icon.svg), 128×128 RGBA.
const ICON_RGBA: &[u8] = include_bytes!("../packaging/icon-128.rgba");

enum UserEvent {
	Input(String),
	/// A message from the page (`window.ipc.postMessage`).
	Ipc(String),
	/// New state of the update (shown in the window).
	Update(serde_json::Value),
}

/// Update state for the page (`window.funkraum.update(…)` in desktop.js).
fn update_state(state: &str, extra: serde_json::Value) -> serde_json::Value {
	let mut v = serde_json::json!({
		"state": state,
		"build": updater::build(),
		"version": env!("CARGO_PKG_VERSION"),
		"enabled": updater::enabled(),
	});
	if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
		for (k, x) in e {
			o.insert(k.clone(), x.clone());
		}
	}
	v
}

fn data_dir() -> PathBuf {
	dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join("funkraum")
}

fn init_logging(dir: &std::path::Path) {
	use tracing_subscriber::prelude::*;
	let verbose = std::env::args().any(|a| a == "-v" || a == "--verbose");
	let filter = if verbose { "debug,tsproto=info,tsclientlib=info,hyper=info" } else { "info,tsproto=warn,tsclientlib=warn" };
	let env_filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(filter));
	let file = std::fs::File::create(dir.join("funkraum.log")).ok();
	let fmt = tracing_subscriber::fmt::layer().with_ansi(false);
	let registry = tracing_subscriber::registry().with(capture::CaptureLayer.with_filter(tracing_subscriber::filter::filter_fn(|m| {
		m.target() == capture::TARGET
	})));
	match file {
		Some(f) => registry.with(fmt.with_writer(std::sync::Mutex::new(f)).with_filter(env_filter)).init(),
		None => registry.with(fmt.with_filter(env_filter)).init(),
	}
}

fn main() -> Result<()> {
	let data = data_dir();
	let _ = std::fs::create_dir_all(&data);
	init_logging(&data);
	tracing::info!(version = env!("CARGO_PKG_VERSION"), build = updater::build(), data = %data.display(), "Funkraum startet");

	// `funkraum --update`: check once, install, exit (also used for testing).
	if std::env::args().any(|a| a == "--update") {
		if !updater::enabled() {
			println!("Updates sind für diesen Build ausgeschaltet (lokal gebaut oder --no-update).");
			return Ok(());
		}
		match updater::check().and_then(|p| p.map(|p| updater::install(&p, &data).map(|_| p)).transpose()) {
			Ok(None) => println!("Funkraum ist aktuell (Build {}).", updater::build()),
			Ok(Some(p)) => println!("Neue Version {} installiert – sie startet beim nächsten Öffnen.", p.short()),
			Err(e) => {
				println!("Update fehlgeschlagen: {e:#}");
				std::process::exit(1);
			}
		}
		return Ok(());
	}

	let cfg = Arc::new(Config { ts_server: String::new(), allow_any_server: true, verbose: 0 });
	let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().context("tokio")?;
	// After "restart" the old process may still hold the port for a moment.
	let bound = rt.block_on(async {
		let mut last = None;
		for _ in 0..30 {
			match tokio::net::TcpListener::bind(("127.0.0.1", PORT)).await {
				Ok(l) => return Ok(l),
				Err(e) => last = Some(e),
			}
			tokio::time::sleep(Duration::from_millis(100)).await;
		}
		Err(last.unwrap())
	});
	let url = match bound {
		Ok(listener) => {
			let addr = listener.local_addr()?;
			let app = web::router(cfg, addr);
			rt.spawn(async move {
				if let Err(e) = axum::serve(listener, app).await {
					tracing::error!(error = %e, "Lokaler Server beendet");
				}
			});
			format!("http://{addr}/")
		}
		Err(e) => {
			// Probably the app is already open: show its interface again.
			tracing::warn!(error = %e, "Port {PORT} belegt – läuft Funkraum schon?");
			format!("http://127.0.0.1:{PORT}/")
		}
	};

	let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
	let window = WindowBuilder::new()
		.with_title("Funkraum")
		.with_inner_size(LogicalSize::new(1180.0, 780.0))
		.with_min_inner_size(LogicalSize::new(360.0, 480.0))
		.with_window_icon(tao::window::Icon::from_rgba(ICON_RGBA.to_vec(), 128, 128).ok())
		.build(&event_loop)
		.context("Fenster")?;

	notify::init();
	let mut context = WebContext::new(Some(data.join("webview")));
	let builder = WebViewBuilder::new_with_web_context(&mut context)
		.with_url(url)
		.with_autoplay(true)
		.with_initialization_script(notify::INIT_SCRIPT)
		.with_ipc_handler({
			let proxy = event_loop.create_proxy();
			move |req| {
				let _ = proxy.send_event(UserEvent::Ipc(req.body().clone()));
			}
		})
		.with_permission_handler(|kind| match kind {
			// Screen sharing: the system still shows its own picker (window or screen).
			PermissionKind::Microphone | PermissionKind::DisplayCapture => PermissionResponse::Allow,
			_ => PermissionResponse::Default,
		});

	#[cfg(not(any(target_os = "linux", target_os = "dragonfly", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd")))]
	let webview = builder.build(&window).context("Web-Ansicht")?;
	#[cfg(any(target_os = "linux", target_os = "dragonfly", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd"))]
	let webview = {
		use tao::platform::unix::WindowExtUnix;
		use wry::WebViewBuilderExtUnix;
		let vbox = window.default_vbox().context("GTK-Container")?;
		let webview = builder.build_gtk(vbox).context("Web-Ansicht")?;
		// WebKitGTK only offers microphone and screen capture (getUserMedia,
		// getDisplayMedia via the desktop portal) with media streams switched on.
		{
			use webkit2gtk::{SettingsExt, WebViewExt};
			use wry::WebViewExtUnix;
			if let Some(settings) = WebViewExt::settings(&webview.webview()) {
				settings.set_enable_media_stream(true);
				settings.set_enable_webrtc(true);
			}
		}
		webview
	};

	// Global push-to-talk
	let proxy = event_loop.create_proxy();
	std::thread::Builder::new().name("hotkeys".into()).spawn(move || {
		hotkeys::run(|ev| {
			if let Ok(json) = serde_json::to_string(&ev) {
				let _ = proxy.send_event(UserEvent::Input(json));
			}
		})
	})?;

	// Updates: look shortly after the start, then every 6 hours. Installing
	// only happens after the user agreed (bar in the window, desktop.js).
	let pending: Arc<std::sync::Mutex<Option<updater::Pending>>> = Default::default();
	if updater::enabled() {
		let proxy = event_loop.create_proxy();
		let pending = pending.clone();
		std::thread::Builder::new().name("updater".into()).spawn(move || {
			std::thread::sleep(Duration::from_secs(15));
			loop {
				match updater::check() {
					Ok(Some(p)) => {
						let commit = p.short().to_string();
						*pending.lock().unwrap() = Some(p);
						let _ = proxy.send_event(UserEvent::Update(update_state("available", serde_json::json!({ "new": commit }))));
					}
					Ok(None) => {}
					Err(error) => tracing::debug!(error = %format!("{error:#}"), "Update-Prüfung nicht möglich"),
				}
				std::thread::sleep(Duration::from_secs(6 * 3600));
			}
		})?;
	}
	let proxy = event_loop.create_proxy();
	let mut last_update = update_state("idle", serde_json::json!({}));

	let mut webview = Some(webview);
	let mut focused = true;
	event_loop.run(move |event, _, control_flow| {
		*control_flow = ControlFlow::Wait;
		match event {
			Event::WindowEvent { event: WindowEvent::Focused(f), .. } => focused = f,
			Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
				window.set_visible(false);
				// Closing the web view ends the WebSocket; the session then leaves
				// the TeamSpeak server properly.
				webview.take();
				std::thread::sleep(Duration::from_millis(600));
				*control_flow = ControlFlow::Exit;
			}
			Event::UserEvent(UserEvent::Update(state)) => {
				if let Some(w) = &webview {
					let _ = w.evaluate_script(&format!("window.funkraum && window.funkraum.update({state})"));
				}
				last_update = state;
			}
			Event::UserEvent(UserEvent::Ipc(msg)) => {
				let kind = serde_json::from_str::<serde_json::Value>(&msg)
					.ok()
					.and_then(|v| v.get("t").and_then(|t| t.as_str()).map(str::to_string))
					.unwrap_or_default();
				match kind.as_str() {
					"notify" => notify::handle_ipc(&msg),
					// The page (re)loaded: tell it the current update state.
					"hello" => {
						if let Some(w) = &webview {
							let _ = w.evaluate_script(&format!("window.funkraum && window.funkraum.update({last_update})"));
						}
					}
					"update-check" => {
						let (proxy, pending) = (proxy.clone(), pending.clone());
						let _ = proxy.send_event(UserEvent::Update(update_state("checking", serde_json::json!({}))));
						std::thread::spawn(move || {
							let state = if !updater::enabled() {
								update_state("disabled", serde_json::json!({}))
							} else {
								match updater::check() {
									Ok(Some(p)) => {
										let commit = p.short().to_string();
										*pending.lock().unwrap() = Some(p);
										update_state("available", serde_json::json!({ "new": commit }))
									}
									Ok(None) => update_state("current", serde_json::json!({})),
									Err(e) => update_state("check-failed", serde_json::json!({ "reason": format!("{e:#}") })),
								}
							};
							let _ = proxy.send_event(UserEvent::Update(state));
						});
					}
					"update-install" => {
						let p = pending.lock().unwrap().clone();
						if let Some(p) = p {
							let (proxy, dir) = (proxy.clone(), data.clone());
							let _ = proxy.send_event(UserEvent::Update(update_state("installing", serde_json::json!({ "new": p.short() }))));
							std::thread::spawn(move || {
								let state = match updater::install(&p, &dir) {
									Ok(()) => update_state("installed", serde_json::json!({ "new": p.short() })),
									Err(e) => {
										tracing::warn!(error = %format!("{e:#}"), "Update fehlgeschlagen");
										update_state("failed", serde_json::json!({ "reason": format!("{e:#}"), "new": p.short() }))
									}
								};
								let _ = proxy.send_event(UserEvent::Update(state));
							});
						}
					}
					"open-releases" => updater::open_releases(),
					// Links from the page (screen sharing in the browser): only web addresses.
					"open-url" => {
						if let Some(url) = serde_json::from_str::<serde_json::Value>(&msg)
							.ok()
							.and_then(|v| v.get("url").and_then(|u| u.as_str()).map(str::to_string))
						{
							updater::open_url(&url);
						}
					}
					"restart" => {
						if let Err(error) = updater::restart() {
							tracing::warn!(%error, "Neustart fehlgeschlagen");
						} else {
							window.set_visible(false);
							webview.take();
							std::thread::sleep(Duration::from_millis(400));
							*control_flow = ControlFlow::Exit;
						}
					}
					_ => {}
				}
			}
			Event::UserEvent(UserEvent::Input(json)) => {
				if !focused {
					if let Some(w) = &webview {
						let _ = w.evaluate_script(&format!("window.tsGlobalInput && window.tsGlobalInput({json})"));
					}
				}
			}
			_ => {}
		}
	});
}
