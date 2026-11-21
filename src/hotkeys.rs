//! Global push-to-talk: reads the keyboard and mouse state of the whole system
//! (also while the window is in the background) and reports changes as events in
//! the format of the web page (`KeyboardEvent.code`, `MouseEvent.button`).
//!
//! - Windows: keys and mouse buttons including the side buttons
//! - macOS: keys and the middle mouse button; needs the permission
//!   "Bedienungshilfen" (Accessibility) for the app
//! - Linux: X11 (Wayland only sees keys pressed in X11 applications)

use std::collections::HashSet;
use std::time::Duration;

use device_query::{DeviceQuery, DeviceState, Keycode};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct InputEvent {
	/// keydown | keyup | mousedown | mouseup
	#[serde(rename = "type")]
	pub kind: &'static str,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub code: Option<&'static str>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub button: Option<u8>,
	pub ctrl: bool,
	pub alt: bool,
	pub shift: bool,
	pub meta: bool,
}

/// `KeyboardEvent.code` of a key.
pub fn dom_code(k: &Keycode) -> Option<&'static str> {
	use Keycode::*;
	Some(match k {
		Key0 => "Digit0",
		Key1 => "Digit1",
		Key2 => "Digit2",
		Key3 => "Digit3",
		Key4 => "Digit4",
		Key5 => "Digit5",
		Key6 => "Digit6",
		Key7 => "Digit7",
		Key8 => "Digit8",
		Key9 => "Digit9",
		A => "KeyA",
		B => "KeyB",
		C => "KeyC",
		D => "KeyD",
		E => "KeyE",
		F => "KeyF",
		G => "KeyG",
		H => "KeyH",
		I => "KeyI",
		J => "KeyJ",
		K => "KeyK",
		L => "KeyL",
		M => "KeyM",
		N => "KeyN",
		O => "KeyO",
		P => "KeyP",
		Q => "KeyQ",
		R => "KeyR",
		S => "KeyS",
		T => "KeyT",
		U => "KeyU",
		V => "KeyV",
		W => "KeyW",
		X => "KeyX",
		Y => "KeyY",
		Z => "KeyZ",
		F1 => "F1",
		F2 => "F2",
		F3 => "F3",
		F4 => "F4",
		F5 => "F5",
		F6 => "F6",
		F7 => "F7",
		F8 => "F8",
		F9 => "F9",
		F10 => "F10",
		F11 => "F11",
		F12 => "F12",
		F13 => "F13",
		F14 => "F14",
		F15 => "F15",
		F16 => "F16",
		F17 => "F17",
		F18 => "F18",
		F19 => "F19",
		F20 => "F20",
		Escape => "Escape",
		Space => "Space",
		LControl => "ControlLeft",
		RControl => "ControlRight",
		LShift => "ShiftLeft",
		RShift => "ShiftRight",
		LAlt | LOption => "AltLeft",
		RAlt | ROption => "AltRight",
		Command | LMeta => "MetaLeft",
		RCommand | RMeta => "MetaRight",
		Enter => "Enter",
		Up => "ArrowUp",
		Down => "ArrowDown",
		Left => "ArrowLeft",
		Right => "ArrowRight",
		Backspace => "Backspace",
		CapsLock => "CapsLock",
		Tab => "Tab",
		Home => "Home",
		End => "End",
		PageUp => "PageUp",
		PageDown => "PageDown",
		Insert => "Insert",
		Delete => "Delete",
		Numpad0 => "Numpad0",
		Numpad1 => "Numpad1",
		Numpad2 => "Numpad2",
		Numpad3 => "Numpad3",
		Numpad4 => "Numpad4",
		Numpad5 => "Numpad5",
		Numpad6 => "Numpad6",
		Numpad7 => "Numpad7",
		Numpad8 => "Numpad8",
		Numpad9 => "Numpad9",
		NumpadSubtract => "NumpadSubtract",
		NumpadAdd => "NumpadAdd",
		NumpadDivide => "NumpadDivide",
		NumpadMultiply => "NumpadMultiply",
		NumpadEquals => "NumpadEqual",
		NumpadEnter => "NumpadEnter",
		NumpadDecimal => "NumpadDecimal",
		Grave => "Backquote",
		Minus => "Minus",
		Equal => "Equal",
		LeftBracket => "BracketLeft",
		RightBracket => "BracketRight",
		BackSlash => "Backslash",
		Semicolon => "Semicolon",
		Apostrophe => "Quote",
		Comma => "Comma",
		Dot => "Period",
		Slash => "Slash",
		#[allow(unreachable_patterns)]
		_ => return None,
	})
}

/// Mouse buttons in `MouseEvent.button` numbering (1 middle, 3 back, 4 forward)
/// from device_query's list (1 left, 2 right, 3 middle, 4/5 extra).
fn dom_buttons(pressed: &[bool]) -> HashSet<u8> {
	let mut set = HashSet::new();
	if pressed.get(3).copied().unwrap_or(false) {
		set.insert(1);
	}
	// On Linux/X11 buttons 4 and 5 are the scroll wheel, not side buttons.
	if cfg!(target_os = "windows") {
		if pressed.get(4).copied().unwrap_or(false) {
			set.insert(3);
		}
		if pressed.get(5).copied().unwrap_or(false) {
			set.insert(4);
		}
	}
	set
}

/// Polls the input state and calls `emit` for every change. Runs forever.
pub fn run(mut emit: impl FnMut(InputEvent)) {
	let Some(state) = checked_state() else {
		tracing::warn!("Globale Tastenkürzel nicht verfügbar (keine Berechtigung oder kein X11)");
		return;
	};
	let mut keys: HashSet<Keycode> = HashSet::new();
	let mut buttons: HashSet<u8> = HashSet::new();
	loop {
		std::thread::sleep(Duration::from_millis(15));
		let now: HashSet<Keycode> = state.get_keys().into_iter().collect();
		let mouse = dom_buttons(&state.get_mouse().button_pressed);
		if now == keys && mouse == buttons {
			continue;
		}
		let has = |set: &HashSet<Keycode>, a: Keycode, b: Keycode| set.contains(&a) || set.contains(&b);
		let mods = |set: &HashSet<Keycode>| {
			(
				has(set, Keycode::LControl, Keycode::RControl),
				has(set, Keycode::LAlt, Keycode::RAlt) || has(set, Keycode::LOption, Keycode::ROption),
				has(set, Keycode::LShift, Keycode::RShift),
				has(set, Keycode::LMeta, Keycode::RMeta) || has(set, Keycode::Command, Keycode::RCommand),
			)
		};
		let (ctrl, alt, shift, meta) = mods(&now);
		let ev = |kind, code, button| InputEvent { kind, code, button, ctrl, alt, shift, meta };
		for k in keys.difference(&now) {
			if let Some(c) = dom_code(k) {
				emit(ev("keyup", Some(c), None));
			}
		}
		for k in now.difference(&keys) {
			if let Some(c) = dom_code(k) {
				emit(ev("keydown", Some(c), None));
			}
		}
		for b in buttons.difference(&mouse) {
			emit(ev("mouseup", None, Some(*b)));
		}
		for b in mouse.difference(&buttons) {
			emit(ev("mousedown", None, Some(*b)));
		}
		keys = now;
		buttons = mouse;
	}
}

#[cfg(target_os = "macos")]
fn checked_state() -> Option<DeviceState> {
	// Asks for the accessibility permission if it is missing.
	DeviceState::checked_new()
}

#[cfg(not(target_os = "macos"))]
fn checked_state() -> Option<DeviceState> {
	std::panic::catch_unwind(DeviceState::new).ok()
}

#[cfg(test)]
mod tests {
	#[test]
	fn codes() {
		assert_eq!(super::dom_code(&device_query::Keycode::V), Some("KeyV"));
		assert_eq!(super::dom_code(&device_query::Keycode::LControl), Some("ControlLeft"));
		let ev = super::InputEvent { kind: "keydown", code: Some("KeyV"), button: None, ctrl: false, alt: false, shift: false, meta: false };
		assert_eq!(serde_json::to_string(&ev).unwrap(), r#"{"type":"keydown","code":"KeyV","ctrl":false,"alt":false,"shift":false,"meta":false}"#);
	}
}
