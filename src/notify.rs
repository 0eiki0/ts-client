//! Desktop notifications: the web view's own notifications are not available
//! (WebView2 refuses them, WKWebView on macOS has none), so the page's
//! `Notification` calls are forwarded to the system (Windows toast, macOS
//! notification center, Linux desktop notifications).

/// Replaces `window.Notification` in the page with one that sends the
/// notification to the app (wry's `window.ipc`).
pub const INIT_SCRIPT: &str = r#"
(() => {
  if (!window.ipc || !window.ipc.postMessage) return;
  class AppNotification {
    constructor(title, options) {
      const o = options || {};
      window.ipc.postMessage(JSON.stringify({ t: 'notify', title: String(title || ''), body: String(o.body || '') }));
    }
    static get permission() { return 'granted'; }
    static requestPermission(cb) { if (typeof cb === 'function') cb('granted'); return Promise.resolve('granted'); }
    close() {}
    addEventListener() {}
  }
  Object.defineProperty(window, 'Notification', { value: AppNotification, configurable: true, writable: true });
})();
"#;

/// Identifier under which Windows shows the notifications ("Funkraum").
#[cfg(target_os = "windows")]
const APP_ID: &str = "Funkraum.Desktop";

/// Registers the app for notifications (once per start, cheap).
pub fn init() {
	#[cfg(target_os = "windows")]
	{
		// Unpackaged apps need an AppUserModelID registered for the user,
		// otherwise Windows drops their toasts.
		use winreg::RegKey;
		use winreg::enums::HKEY_CURRENT_USER;
		let res = RegKey::predef(HKEY_CURRENT_USER).create_subkey(format!(r"Software\Classes\AppUserModelId\{APP_ID}")).and_then(|(key, _)| {
			key.set_value("DisplayName", &"Funkraum")?;
			key.set_value("ShowInSettings", &1u32)
		});
		if let Err(error) = res {
			tracing::warn!(%error, "Benachrichtigungen: App-Kennung konnte nicht registriert werden");
		}
	}
	#[cfg(target_os = "macos")]
	{
		let _ = notify_rust::set_application("io.github.0eiki0.funkraum");
	}
}

/// A message from the page (`window.ipc.postMessage`).
pub fn handle_ipc(message: &str) {
	let Ok(v) = serde_json::from_str::<serde_json::Value>(message) else { return };
	if v.get("t").and_then(|t| t.as_str()) != Some("notify") {
		return;
	}
	let clip = |s: &str| s.chars().take(300).collect::<String>();
	let title = clip(v.get("title").and_then(|t| t.as_str()).unwrap_or(""));
	let body = clip(v.get("body").and_then(|t| t.as_str()).unwrap_or(""));
	// Showing can block shortly (D-Bus, Windows runtime): not on the UI thread.
	std::thread::spawn(move || {
		let mut n = notify_rust::Notification::new();
		n.appname("Funkraum").summary(&title).body(&body);
		#[cfg(target_os = "windows")]
		n.app_id(APP_ID);
		if let Err(error) = n.show() {
			tracing::warn!(%error, "Benachrichtigung konnte nicht angezeigt werden");
		}
	});
}
