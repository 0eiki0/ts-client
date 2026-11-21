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

enum UserEvent {
	Input(String),
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
	tracing::info!(version = env!("CARGO_PKG_VERSION"), data = %data.display(), "Funkraum startet");

	let cfg = Arc::new(Config { ts_server: String::new(), allow_any_server: true, verbose: 0 });
	let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().context("tokio")?;
	let url = match rt.block_on(tokio::net::TcpListener::bind(("127.0.0.1", PORT))) {
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
		.build(&event_loop)
		.context("Fenster")?;

	notify::init();
	let mut context = WebContext::new(Some(data.join("webview")));
	let builder = WebViewBuilder::new_with_web_context(&mut context)
		.with_url(url)
		.with_autoplay(true)
		.with_initialization_script(notify::INIT_SCRIPT)
		.with_ipc_handler(|req| notify::handle_ipc(req.body()))
		.with_permission_handler(|kind| match kind {
			PermissionKind::Microphone => PermissionResponse::Allow,
			_ => PermissionResponse::Default,
		});

	#[cfg(not(any(target_os = "linux", target_os = "dragonfly", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd")))]
	let webview = builder.build(&window).context("Web-Ansicht")?;
	#[cfg(any(target_os = "linux", target_os = "dragonfly", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd"))]
	let webview = {
		use tao::platform::unix::WindowExtUnix;
		use wry::WebViewBuilderExtUnix;
		let vbox = window.default_vbox().context("GTK-Container")?;
		builder.build_gtk(vbox).context("Web-Ansicht")?
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
