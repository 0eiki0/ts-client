//! The web bridge's ServerQuery bot is not part of the desktop client.

/// Never constructed.
#[derive(Clone)]
pub enum BotHandle {}

pub struct WebPresence;

impl WebPresence {
	pub async fn join(bot: &BotHandle, _uid: String) -> Self { match *bot {} }
	pub fn connected(&self) {}
}
