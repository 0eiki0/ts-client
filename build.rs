//! Static musl builds (the release binaries): `libopus_sys` (Opus for the
//! Discord bridge) asks the linker for `-lm`. Rust links musl binaries with the
//! system `cc`, which then finds glibc's `libm.a` – that does not fit musl and
//! the link fails. musl has its math functions in `libc.a` already, so an empty
//! `libm.a` that is found first is all that is needed.

use std::path::PathBuf;

fn main() {
	println!("cargo:rerun-if-changed=build.rs");
	// Commit of this build (set by the build workflow), used by the updater.
	println!("cargo:rerun-if-env-changed=FUNKRAUM_BUILD");
	println!("cargo:rustc-env=FUNKRAUM_BUILD={}", std::env::var("FUNKRAUM_BUILD").unwrap_or_default());
	if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("musl") {
		return;
	}
	let dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("musl-libm");
	std::fs::create_dir_all(&dir).expect("create musl-libm dir");
	// An empty ar archive is just its magic header.
	std::fs::write(dir.join("libm.a"), b"!<arch>\n").expect("write empty libm.a");
	println!("cargo:rustc-link-search=native={}", dir.display());
}
