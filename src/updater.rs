//! Automatic updates from the GitHub release "latest".
//!
//! Every build knows the commit it was built from (`FUNKRAUM_BUILD`, set by the
//! build workflow). The release "latest" is created for one commit and holds the
//! files for all systems. If its commit differs from ours and the file for this
//! system is there, it is downloaded, checked against its `.sha256` file and
//! replaces the program; the new version runs from the next start.
//!
//! Local builds (no `FUNKRAUM_BUILD`) never update. `--no-update` or the
//! environment variable `FUNKRAUM_NO_UPDATE=1` switch updates off.

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};

const API: &str = "https://api.github.com/repos/0eiki0/ts-client/releases/tags/latest";
pub const RELEASES_PAGE: &str = "https://github.com/0eiki0/ts-client/releases/latest";
const BUILD: &str = env!("FUNKRAUM_BUILD");
/// The release file for this system.
const ASSET: Option<&str> = if cfg!(target_os = "windows") {
	Some("Funkraum-Windows.exe")
} else if cfg!(target_os = "macos") {
	Some("Funkraum-macOS.zip")
} else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
	Some("Funkraum-Linux-x86_64")
} else {
	None
};
const MAX_SIZE: u64 = 400 * 1024 * 1024;

pub enum Outcome {
	/// Nothing new (or updates are off).
	Current,
	/// The new version is installed and used from the next start.
	Installed,
	/// A new version exists but could not be installed; the text says why.
	Failed(String),
}

pub fn enabled() -> bool {
	!BUILD.is_empty()
		&& ASSET.is_some()
		&& !std::env::args().any(|a| a == "--no-update")
		&& std::env::var("FUNKRAUM_NO_UPDATE").map(|v| v.is_empty() || v == "0").unwrap_or(true)
}

pub fn build() -> &'static str { if BUILD.is_empty() { "lokal" } else { &BUILD[..BUILD.len().min(7)] } }

fn client() -> Result<reqwest::blocking::Client> {
	Ok(reqwest::blocking::Client::builder()
		.user_agent(concat!("funkraum-updater/", env!("CARGO_PKG_VERSION")))
		.timeout(Duration::from_secs(300))
		.build()?)
}

#[derive(serde::Deserialize)]
struct Release {
	target_commitish: String,
	assets: Vec<Asset>,
}

#[derive(serde::Deserialize)]
struct Asset {
	name: String,
	size: u64,
	browser_download_url: String,
}

/// Checks once and installs a new version if there is one.
pub fn check_and_install(data_dir: &Path) -> Outcome {
	match try_update(data_dir) {
		Ok(true) => Outcome::Installed,
		Ok(false) => Outcome::Current,
		Err(e) => {
			tracing::warn!(error = %format!("{e:#}"), "Update fehlgeschlagen");
			Outcome::Failed(format!("{e:#}"))
		}
	}
}

fn try_update(data_dir: &Path) -> Result<bool> {
	let Some(asset_name) = ASSET else { return Ok(false) };
	let http = client()?;
	// The release is recreated on every build and missing for a moment; network
	// problems are also no reason to bother the user: try again later.
	let api = std::env::var("FUNKRAUM_UPDATE_API").unwrap_or_else(|_| API.to_string());
	let rel: Release = match http
		.get(&api)
		.header("Accept", "application/vnd.github+json")
		.send()
		.and_then(|r| r.error_for_status())
		.and_then(|r| r.json())
	{
		Ok(r) => r,
		Err(error) => {
			tracing::debug!(%error, "Update-Prüfung nicht möglich");
			return Ok(false);
		}
	};
	if rel.target_commitish.is_empty() || rel.target_commitish == BUILD {
		return Ok(false);
	}
	// While the new build is still running, the files are not there yet.
	let Some(asset) = rel.assets.iter().find(|a| a.name == asset_name) else { return Ok(false) };
	let Some(sum) = rel.assets.iter().find(|a| a.name == format!("{asset_name}.sha256")) else { return Ok(false) };
	if asset.size > MAX_SIZE {
		bail!("Update-Datei zu groß ({} Bytes)", asset.size);
	}
	tracing::info!(neu = %rel.target_commitish, aktuell = BUILD, "Neue Version gefunden, lade herunter");

	let expected = http.get(&sum.browser_download_url).send()?.error_for_status()?.text()?;
	let expected = expected.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
	if expected.len() != 64 {
		bail!("Prüfsumme der Update-Datei ist ungültig");
	}
	let dir = data_dir.join("update");
	let _ = std::fs::remove_dir_all(&dir);
	std::fs::create_dir_all(&dir)?;
	let file = dir.join(asset_name);
	let mut body = Vec::with_capacity(asset.size as usize);
	http.get(&asset.browser_download_url).send()?.error_for_status()?.take(MAX_SIZE).read_to_end(&mut body)?;
	let actual: String = Sha256::digest(&body).iter().map(|b| format!("{b:02x}")).collect();
	if actual != expected {
		bail!("Prüfsumme stimmt nicht (Download beschädigt?)");
	}
	std::fs::write(&file, &body)?;
	install(&file, &dir)?;
	let _ = std::fs::remove_dir_all(&dir);
	tracing::info!(version = %rel.target_commitish, "Update installiert, gilt ab dem nächsten Start");
	Ok(true)
}

#[cfg(not(target_os = "macos"))]
fn install(file: &Path, _dir: &Path) -> Result<()> {
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755))?;
	}
	self_replace::self_replace(file).context("Programmdatei kann nicht ersetzt werden (keine Schreibrechte?)")
}

/// macOS: the whole app bundle is replaced (its signature covers all files).
#[cfg(target_os = "macos")]
fn install(file: &Path, dir: &Path) -> Result<()> {
	use std::path::PathBuf;
	let exe = std::env::current_exe()?.canonicalize()?;
	let bundle: PathBuf = exe
		.ancestors()
		.find(|p| p.extension().is_some_and(|e| e == "app"))
		.context("Programm läuft nicht aus einer .app – bitte manuell aktualisieren")?
		.to_path_buf();
	let unpacked = dir.join("unpacked");
	let mut zip = zip::ZipArchive::new(std::fs::File::open(file)?)?;
	zip.extract(&unpacked)?;
	let new_app = std::fs::read_dir(&unpacked)?
		.flatten()
		.map(|e| e.path())
		.find(|p| p.extension().is_some_and(|e| e == "app"))
		.context("Keine .app im Update")?;
	let old = bundle.with_extension("app.old");
	let _ = std::fs::remove_dir_all(&old);
	std::fs::rename(&bundle, &old).context("App kann nicht ersetzt werden (keine Schreibrechte im Programme-Ordner?)")?;
	if let Err(e) = std::fs::rename(&new_app, &bundle) {
		let _ = std::fs::rename(&old, &bundle);
		return Err(e).context("Neue App konnte nicht an ihren Platz gelegt werden");
	}
	let _ = std::fs::remove_dir_all(&old);
	Ok(())
}
