//! Chrome binary resolver.
//!
//! Strategy: prefer system Chrome (95% of dev macs have it); on a
//! Chrome-less machine fall back to downloading Google's
//! Chrome-for-Testing into the app's Application Support directory.
//! The download is one-time and cached forever.
//!
//! Detection order:
//!   1. `RLI_CHROME_PATH` env var (escape hatch for unusual installs).
//!   2. /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
//!   3. /Applications/Chromium.app/Contents/MacOS/Chromium
//!   4. ~/Library/Application Support/dev.raeedz.goonware/chrome/<arch>/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
//!   5. None → download CFT from googlechromelabs.github.io
//!
//! Progress events are emitted on `browser://download/progress` so the
//! BrowserPane's offline empty-state can render a download bar instead
//! of a generic spinner.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

const CFT_VERSIONS_URL: &str =
    "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

const PROGRESS_EVENT: &str = "browser://download/progress";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent<'a> {
    stage: &'a str,
    bytes: u64,
    total: u64,
}

/// Errors returned as `String` (matching the project convention of
/// `Result<T, String>` for Tauri-bound returns) but with structured
/// helper conversions so the main code stays clean.
pub type BinaryError = String;

fn err(prefix: &str, e: impl std::fmt::Display) -> String {
    format!("{prefix}: {e}")
}

/// Platform string Google uses in the CFT JSON: "mac-arm64" / "mac-x64".
fn cft_platform() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "mac-arm64"
    } else {
        "mac-x64"
    }
}

/// Where we cache the downloaded Chrome-for-Testing.
fn cache_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("Goonware").join("chrome").join(cft_platform()))
}

fn cft_executable_in(dir: &Path) -> PathBuf {
    // Inside the unzipped folder, the binary lives at:
    //   chrome-mac-{arch}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
    dir.join(format!("chrome-{}", cft_platform()))
        .join("Google Chrome for Testing.app")
        .join("Contents")
        .join("MacOS")
        .join("Google Chrome for Testing")
}

/// Walk known locations, return the first existing Chrome binary, or
/// `None` if nothing is installed yet.
pub fn locate_chrome() -> Option<PathBuf> {
    // Accept all env-var spellings through the RLI → GLI → Goonware
    // rename chain. New code should set GOONWARE_CHROME_PATH; the
    // older names stay so an already-configured shell keeps working.
    for var in ["GOONWARE_CHROME_PATH", "GLI_CHROME_PATH", "RLI_CHROME_PATH"] {
        if let Ok(env_path) = std::env::var(var) {
            let p = PathBuf::from(env_path);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let candidates = [
        PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        PathBuf::from(
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ),
    ];
    for c in candidates {
        if c.is_file() {
            return Some(c);
        }
    }
    if let Some(dir) = cache_dir() {
        let p = cft_executable_in(&dir);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Resolve Chrome — locate or download. On download, fires progress
/// events that the frontend listens to.
pub async fn ensure_chrome<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, BinaryError> {
    if let Some(p) = locate_chrome() {
        let _ = app.emit(
            PROGRESS_EVENT,
            ProgressEvent {
                stage: "ready",
                bytes: 0,
                total: 0,
            },
        );
        return Ok(p);
    }

    let dir = cache_dir().ok_or_else(|| "no home directory".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| err("create cache dir", e))?;

    let url = pick_cft_download_url().await?;
    let zip_path = dir.join("chrome.zip");
    download_with_progress(app, &url, &zip_path).await?;
    extract_zip(app, &zip_path, &dir)?;
    let _ = std::fs::remove_file(&zip_path);

    let exe = cft_executable_in(&dir);
    if !exe.is_file() {
        return Err(format!("expected CFT binary at {}", exe.display()));
    }
    let _ = app.emit(
        PROGRESS_EVENT,
        ProgressEvent {
            stage: "ready",
            bytes: 0,
            total: 0,
        },
    );
    Ok(exe)
}

#[derive(Deserialize)]
struct CftVersions {
    channels: std::collections::HashMap<String, CftChannel>,
}

#[derive(Deserialize)]
struct CftChannel {
    downloads: CftDownloads,
}

#[derive(Deserialize)]
struct CftDownloads {
    chrome: Vec<CftDownloadEntry>,
}

#[derive(Deserialize)]
struct CftDownloadEntry {
    platform: String,
    url: String,
}

async fn pick_cft_download_url() -> Result<String, BinaryError> {
    let body = reqwest::get(CFT_VERSIONS_URL)
        .await
        .map_err(|e| err("fetch CFT manifest", e))?
        .error_for_status()
        .map_err(|e| err("fetch CFT manifest status", e))?
        .text()
        .await
        .map_err(|e| err("fetch CFT manifest body", e))?;
    let parsed: CftVersions =
        serde_json::from_str(&body).map_err(|e| err("parse CFT manifest", e))?;
    let stable = parsed
        .channels
        .get("Stable")
        .ok_or_else(|| "Stable channel missing from CFT manifest".to_string())?;
    let plat = cft_platform();
    let entry = stable
        .downloads
        .chrome
        .iter()
        .find(|e| e.platform == plat)
        .ok_or_else(|| format!("no Chrome-for-Testing build for platform {plat}"))?;
    Ok(entry.url.clone())
}

async fn download_with_progress<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    out: &Path,
) -> Result<(), BinaryError> {
    use futures::StreamExt;
    use std::io::Write;

    let res = reqwest::get(url)
        .await
        .map_err(|e| err("CFT download request", e))?
        .error_for_status()
        .map_err(|e| err("CFT download status", e))?;
    let total = res.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut stream = res.bytes_stream();
    let mut file = std::fs::File::create(out).map_err(|e| err("create download file", e))?;

    let _ = app.emit(
        PROGRESS_EVENT,
        ProgressEvent {
            stage: "download",
            bytes: 0,
            total,
        },
    );

    let mut last_emit = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| err("CFT chunk", e))?;
        file.write_all(&chunk).map_err(|e| err("write CFT chunk", e))?;
        downloaded += chunk.len() as u64;
        // Throttle progress events to ~10/s so we don't flood the
        // frontend's event bus with hundreds of identical re-renders.
        if last_emit.elapsed() > std::time::Duration::from_millis(100) {
            let _ = app.emit(
                PROGRESS_EVENT,
                ProgressEvent {
                    stage: "download",
                    bytes: downloaded,
                    total,
                },
            );
            last_emit = std::time::Instant::now();
        }
    }
    let _ = app.emit(
        PROGRESS_EVENT,
        ProgressEvent {
            stage: "download",
            bytes: downloaded,
            total: downloaded,
        },
    );
    Ok(())
}

fn extract_zip<R: Runtime>(
    app: &AppHandle<R>,
    zip_path: &Path,
    out_dir: &Path,
) -> Result<(), BinaryError> {
    let _ = app.emit(
        PROGRESS_EVENT,
        ProgressEvent {
            stage: "extract",
            bytes: 0,
            total: 0,
        },
    );
    let file = std::fs::File::open(zip_path).map_err(|e| err("open zip", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| err("read zip", e))?;
    let total = archive.len() as u64;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| err("zip entry", e))?;
        let outpath = match entry.enclosed_name() {
            Some(p) => out_dir.join(p),
            None => continue,
        };
        if entry.is_dir() {
            std::fs::create_dir_all(&outpath).map_err(|e| err("mkdir", e))?;
            continue;
        }
        if let Some(parent) = outpath.parent() {
            std::fs::create_dir_all(parent).map_err(|e| err("mkdir parent", e))?;
        }
        let mut out_file = std::fs::File::create(&outpath).map_err(|e| err("create extract file", e))?;
        std::io::copy(&mut entry, &mut out_file).map_err(|e| err("copy zip entry", e))?;
        // Preserve the executable bit so the CFT binary actually runs.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                std::fs::set_permissions(
                    &outpath,
                    std::fs::Permissions::from_mode(mode),
                )
                .map_err(|e| err("set permissions", e))?;
            }
        }
        if i % 10 == 0 {
            let _ = app.emit(
                PROGRESS_EVENT,
                ProgressEvent {
                    stage: "extract",
                    bytes: i as u64,
                    total,
                },
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locate_chrome_honors_env_override() {
        // Use this very test binary as a stand-in for "Chrome" — the
        // resolver only checks that the path is a file, which it is.
        let exe =
            std::env::current_exe().expect("current_exe");
        unsafe {
            std::env::set_var("RLI_CHROME_PATH", &exe);
        }
        let resolved = locate_chrome();
        unsafe {
            std::env::remove_var("RLI_CHROME_PATH");
        }
        assert_eq!(resolved.as_deref(), Some(exe.as_path()));
    }

    #[test]
    fn locate_chrome_returns_none_when_nothing_installed() {
        // Force the env override away and pretend the system / cache
        // candidates aren't installed by checking that the function at
        // least returns a real Option (not panic). We can't reliably
        // assert None on every CI machine because real Chrome may be
        // installed, so the test just exercises the code path.
        unsafe {
            std::env::remove_var("RLI_CHROME_PATH");
        }
        let _ = locate_chrome();
    }

    #[test]
    fn cft_platform_matches_arch() {
        let p = cft_platform();
        assert!(p == "mac-arm64" || p == "mac-x64");
    }
}
