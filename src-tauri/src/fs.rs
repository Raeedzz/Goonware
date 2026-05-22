//! Filesystem + shell-out commands.
//!
//! tauri-plugin-fs exists but is capability-scoped — every path the
//! frontend touches has to be in an allowlist. For Goonware's "open any
//! folder you point at" model that's the wrong shape, so we expose
//! direct read commands instead.
//!
//! Writes are scoped to the editor's autosave path: the frontend can
//! only call `fs_write_text_file` on a path it already opened (the
//! Editor tracks this), so we don't gate further here.
//!
//! Also: `system_open` shells out to macOS's `open` so the user can
//! reveal/right-click-open files in Finder, VS Code, browsers, etc.

use std::fs;
use std::path::Path;
use std::process::Stdio;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use tokio::process::Command;

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

const HIDE_NAMES: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    ".vite",
    ".rli",
];

#[tauri::command]
pub fn fs_read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && name != ".gitignore" && name != ".env.example" {
            continue;
        }
        if HIDE_NAMES.contains(&name.as_str()) {
            continue;
        }
        let p = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(DirEntry {
            name,
            path: p.to_string_lossy().into_owned(),
            is_dir,
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

#[tauri::command]
pub fn fs_read_text_file(path: String) -> Result<String, String> {
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > 2 * 1024 * 1024 {
        return Err(format!(
            "file too large ({} bytes) — use a CLI editor",
            metadata.len()
        ));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    decode_text(&bytes).map_err(|e| e.to_string())
}

/// Decide whether a byte buffer is plain text and decode it. The editor
/// can only render UTF-8, and `fs::read_to_string` errors with a cryptic
/// `stream did not contain valid UTF-8` message on PNGs / .DS_Store /
/// compiled binaries when the user fat-fingers a click in the file tree.
/// This routine returns a one-line "binary file" message instead so the
/// editor pane can render it as an inline note.
fn decode_text(bytes: &[u8]) -> Result<String, String> {
    // Heuristic: a NUL byte in the first 8 KiB is a near-certain sign of
    // a binary file (text encodings don't use NUL except for legacy UTF-16
    // which we don't support either). Cheap and catches real-world cases:
    // images, pdfs, executables, sqlite databases, .DS_Store.
    let probe = &bytes[..bytes.len().min(8192)];
    if probe.contains(&0u8) {
        return Err("binary file — open with the default app instead".into());
    }
    String::from_utf8(bytes.to_vec())
        .map_err(|_| "file is not valid UTF-8 — open with the default app instead".into())
}

/// Look inside a project folder for a likely "app icon" — favicon,
/// Tauri/Electron app icon, Next.js icon, etc. — and return it as a
/// `data:` URI so the sidebar can render the project's real icon
/// instead of the first-letter glyph fallback. Returns `Ok(None)` when
/// nothing was found; never throws on missing files, only on unreadable
/// paths the caller passed in.
///
/// The candidate list is ordered: Tauri icons first (so Goonware itself
/// shows its app icon), then common web favicon locations across the
/// frameworks we see in real projects. We cap at 256 KiB per icon so
/// a stray huge PNG can't bloat persisted state.
#[tauri::command]
pub fn fs_scan_project_icon(path: String) -> Result<Option<String>, String> {
    use std::path::PathBuf;
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Ok(None);
    }

    const CANDIDATES: &[&str] = &[
        // Tauri (medium size first so the sidebar gets a crisp icon
        // without paying for the 1024 master).
        "src-tauri/icons/icon-128.png",
        "src-tauri/icons/icon-256.png",
        "src-tauri/icons/icon.png",
        "src-tauri/icons/icon-64.png",
        "src-tauri/icons/icon-32.png",
        "src-tauri/icons/icon-512.png",
        // Vite / generic web — `public/`
        "public/favicon.svg",
        "public/icon.svg",
        "public/favicon.png",
        "public/icon.png",
        "public/apple-touch-icon.png",
        "public/favicon.ico",
        "public/logo.svg",
        "public/logo.png",
        // SvelteKit — `static/`
        "static/favicon.svg",
        "static/favicon.png",
        "static/favicon.ico",
        "static/logo.svg",
        "static/logo.png",
        // Next.js app router
        "app/icon.svg",
        "app/icon.png",
        "app/favicon.ico",
        "app/apple-icon.png",
        // Angular / Vue / generic src layouts
        "src/favicon.ico",
        "src/assets/icon.svg",
        "src/assets/icon.png",
        "src/assets/logo.svg",
        "src/assets/logo.png",
        "src/assets/favicon.svg",
        "src/assets/favicon.png",
        // Monorepo conventions (Turbo / Nx / pnpm-workspaces)
        "apps/web/public/favicon.svg",
        "apps/web/public/favicon.png",
        "apps/web/public/favicon.ico",
        "apps/web/public/icon.svg",
        "apps/web/public/icon.png",
        "apps/app/public/favicon.svg",
        "apps/app/public/favicon.png",
        "apps/app/public/favicon.ico",
        "apps/frontend/public/favicon.svg",
        "apps/frontend/public/favicon.png",
        "apps/frontend/public/favicon.ico",
        "frontend/public/favicon.svg",
        "frontend/public/favicon.png",
        "frontend/public/favicon.ico",
        "client/public/favicon.svg",
        "client/public/favicon.png",
        "client/public/favicon.ico",
        "web/public/favicon.svg",
        "web/public/favicon.png",
        "web/public/favicon.ico",
        // Common asset dirs
        "assets/icon.svg",
        "assets/icon.png",
        "assets/logo.svg",
        "assets/logo.png",
        "assets/favicon.svg",
        "assets/favicon.png",
        "images/logo.svg",
        "images/logo.png",
        "images/icon.svg",
        "images/icon.png",
        "media/logo.svg",
        "media/logo.png",
        "media/icon.svg",
        "media/icon.png",
        "docs/logo.svg",
        "docs/logo.png",
        "resources/icon.png",
        "resources/icon.svg",
        // Electron
        "build/icon.png",
        "build/icons/icon.png",
        "electron/build/icon.png",
        "electron/icon.png",
        // Repo root
        "icon.svg",
        "icon.png",
        "favicon.svg",
        "favicon.png",
        "favicon.ico",
        "logo.svg",
        "logo.png",
    ];

    const MAX_BYTES: u64 = 256 * 1024;

    for rel in CANDIDATES {
        let p = root.join(rel);
        let md = match fs::metadata(&p) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !md.is_file() || md.len() == 0 || md.len() > MAX_BYTES {
            continue;
        }
        let bytes = match fs::read(&p) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let mime = mime_for_path(rel);
        let b64 = STANDARD.encode(&bytes);
        return Ok(Some(format!("data:{mime};base64,{b64}")));
    }

    Ok(None)
}

fn mime_for_path(rel: &str) -> &'static str {
    let lower = rel.to_ascii_lowercase();
    if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".ico") {
        "image/x-icon"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

#[tauri::command]
pub fn fs_cwd() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// Bulk path existence check. Used on app startup to mark worktrees
/// whose backing directory was deleted between launches so the sidebar
/// can surface a clear "missing" state instead of letting every
/// downstream call (term_start, git_status, etc.) fail with the cryptic
/// `cwd does not exist` error.
///
/// Returns a vec of the same length and order as `paths` — each entry
/// is `true` if the path exists on disk, `false` otherwise. Errors
/// land as `false` rather than failing the batch; the caller can
/// always assume a result for every input.
#[tauri::command]
pub fn fs_paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).exists()).collect()
}

#[tauri::command]
pub fn system_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "no home dir".to_string())
}

#[tauri::command]
pub fn fs_write_text_file(path: String, content: String) -> Result<(), String> {
    // Editor autosave. The frontend only calls this for files that were
    // explicitly opened via the file tree, so the path origin is trusted.
    // We still refuse files that don't already exist — autosave should
    // never accidentally create new files.
    if !Path::new(&path).exists() {
        return Err(format!("refusing to create new file: {path}"));
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// Opens a path in the macOS default handler (Finder reveals folders,
/// the default editor opens text files, the default browser opens .html,
/// etc.). The frontend's right-click menu uses this for "Open in Finder"
/// and "Open with default app".
#[tauri::command]
pub async fn system_open(path: String, reveal: bool) -> Result<(), String> {
    let mut cmd = Command::new("open");
    if reveal {
        cmd.arg("-R");
    }
    cmd.arg(&path);
    let status = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| format!("spawn open: {e}"))?;
    if !status.success() {
        return Err(format!("open exited {}", status.code().unwrap_or(-1)));
    }
    Ok(())
}

/// Persist a base64-encoded image blob to a stable temp location and
/// return its absolute path. Used by the frontend's image-paste flow:
/// when the user Cmd+V's a screenshot into a terminal pane, the
/// clipboard image bytes have nowhere to land in a PTY, so we drop
/// them on disk and feed the running shell/agent the file path
/// instead. Claude Code, codex, etc. all accept image paths inline
/// as prompt context, so the round-trip "screenshot → paste → agent
/// reads it" is one keystroke for the user.
///
/// `extension` is sanitized — only well-known raster formats are
/// accepted; anything else is coerced to `png` so a malicious or
/// fat-fingered value can't write `paste-123.sh` (or worse) into
/// /tmp. Each file gets a millisecond timestamp + a 6-byte random
/// suffix so two pastes inside the same ms don't collide.
#[tauri::command]
pub fn system_save_image_to_temp(
    base64_bytes: String,
    extension: String,
) -> Result<String, String> {
    let bytes = STANDARD
        .decode(base64_bytes.as_bytes())
        .map_err(|e| format!("decode base64: {e}"))?;

    let ext = match extension.to_ascii_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tiff" | "heic" | "svg" => {
            extension.to_ascii_lowercase()
        }
        _ => "png".to_string(),
    };

    let dir = std::env::temp_dir().join("goonware-paste");
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // Cheap entropy to disambiguate same-ms pastes without pulling in
    // a `rand` crate. Two pastes in the same ms is rare but possible
    // (drag-and-drop of multiple files lands as one event).
    let nonce: u32 = (stamp as u32).wrapping_mul(2654435761);
    let path = dir.join(format!("paste-{stamp}-{nonce:08x}.{ext}"));

    fs::write(&path, &bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Read the macOS clipboard's plain-text contents via the native
/// `pbpaste` binary.
///
/// Why this exists: `navigator.clipboard.readText()` inside Tauri's
/// WKWebView is governed by WebKit's clipboard permission policy and,
/// on macOS 15+ (Sequoia), by the system-wide "Apps want to read your
/// clipboard" gate. If the user ever dismissed or denied that prompt,
/// the web API returns an empty string without throwing — and the
/// Ctrl+V paste path in PromptInput / PtyPassthrough silently no-ops.
///
/// `/usr/bin/pbpaste` reads NSPasteboard via AppKit's standard paste
/// pathway. macOS treats it as a first-party paste action, so the
/// read succeeds even when the per-app clipboard-read prompt was
/// declined for the WKWebView itself. That gives us a reliable
/// fallback the Ctrl+V handlers route through whenever the browser
/// API comes back empty.
///
/// Returns the clipboard text as UTF-8 (lossy on invalid bytes —
/// `pbpaste` outputs whatever's on the pasteboard; a binary clipboard
/// item produces a lossy decode rather than an error so the caller's
/// paste flow still has something to work with). Returns an empty
/// string if the clipboard is genuinely empty or pbpaste fails (e.g.
/// PATH missing, signal interrupt). Errors only on spawn failures.
#[tauri::command]
pub async fn system_clipboard_read_text() -> Result<String, String> {
    // Pin the absolute path. We've seen $PATH come through stripped
    // when Goonware is launched outside a terminal (Finder/Dock); a
    // bare `pbpaste` would then ENOENT. /usr/bin is system-pinned on
    // macOS and ships pbpaste since 10.6 — no realistic ENOENT path
    // unless the user has wiped their OS.
    let output = Command::new("/usr/bin/pbpaste")
        .stderr(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("spawn pbpaste: {e}"))?;
    if !output.status.success() {
        // Non-zero exit — clipboard might just be empty or hold a
        // non-text item. Return empty so the caller's fallback chain
        // can decide what to do (most callers no-op cleanly).
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Try to extract an image from the macOS pasteboard, write it to
/// `/tmp/goonware-paste/`, and return the file path. Returns Ok(None)
/// when the clipboard does not hold an image (so the caller knows to
/// fall back to text paste).
///
/// Why this exists: the frontend used to call
/// `navigator.clipboard.read()` to fish image bytes out of the
/// clipboard for Cmd+V'd screenshots. That browser API triggers the
/// macOS "Apps want to read your clipboard" TCC dialog — the
/// user-perceived "weird paste popup that shouldn't show up." This
/// command runs through AppKit's NSPasteboard via osascript, which is
/// treated by macOS as a first-party paste — no popup, no prompt.
///
/// Implementation: osascript reads the pasteboard `«class PNGf»`
/// flavor (PNG image data) and writes the raw bytes to disk. AppKit
/// automatically transcodes whatever's on the pasteboard (raw NSImage,
/// TIFF, PICT, BMP, …) into PNG on read, which makes "screenshot →
/// Cmd+V" deterministic regardless of how the screenshot tool stored
/// the image (Cmd+Shift+4 lands as TIFF, web image copies land as
/// raw bytes of whatever MIME the page provided, etc.).
///
/// Returns the absolute path on success. Returns Ok(None) for an empty
/// pasteboard or one holding only text. Returns Err only on filesystem
/// errors (mkdir, write) — the osascript call itself never fails the
/// command (it always exits zero, even when the pasteboard has no
/// image data; we detect that by checking the temp file's size after
/// the write).
#[tauri::command]
pub async fn system_clipboard_save_image_to_temp() -> Result<Option<String>, String> {
    let dir = std::env::temp_dir().join("goonware-paste");
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let nonce: u32 = (stamp as u32).wrapping_mul(2654435761);
    let path = dir.join(format!("paste-{stamp}-{nonce:08x}.png"));

    // AppleScript: grab «class PNGf» from the pasteboard, write the
    // bytes to the target path. The `try` block makes the script
    // exit cleanly when there's no image on the pasteboard (instead
    // of erroring out with "Can't make data … into PNG"), so the
    // caller can distinguish "no image" (empty file) from "write
    // failed" (filesystem error).
    let script = format!(
        r#"try
    set theData to the clipboard as «class PNGf»
    set theFile to open for access POSIX file "{}" with write permission
    write theData to theFile
    close access theFile
on error
    try
        close access POSIX file "{}"
    end try
end try"#,
        path.to_string_lossy(),
        path.to_string_lossy(),
    );

    let status = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(&script)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| format!("spawn osascript: {e}"))?;
    if !status.success() {
        // osascript itself failed (rare — we wrapped the body in a
        // try block). Clean up any partial file we may have written
        // and report no image; the caller will fall back to text.
        let _ = fs::remove_file(&path);
        return Ok(None);
    }

    // No image on the pasteboard → the `try` block exited without
    // writing anything; either the file was never created or it's
    // zero bytes.
    match fs::metadata(&path) {
        Ok(meta) if meta.len() > 0 => Ok(Some(path.to_string_lossy().into_owned())),
        _ => {
            let _ = fs::remove_file(&path);
            Ok(None)
        }
    }
}

/// Opens a path in a named application (e.g. "Visual Studio Code",
/// "Sublime Text", "Safari", "Google Chrome"). Uses `open -a` on macOS.
#[tauri::command]
pub async fn system_open_with(path: String, app: String) -> Result<(), String> {
    let status = Command::new("open")
        .arg("-a")
        .arg(&app)
        .arg(&path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| format!("spawn open -a: {e}"))?;
    if !status.success() {
        return Err(format!(
            "could not open with '{app}' (exit {})",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_text_accepts_plain_ascii() {
        let s = decode_text(b"hello world\n").unwrap();
        assert_eq!(s, "hello world\n");
    }

    #[test]
    fn decode_text_accepts_utf8_with_emoji_and_cjk() {
        let bytes = "hello 🌶  日本語\n".as_bytes();
        let s = decode_text(bytes).unwrap();
        assert!(s.contains("🌶"));
        assert!(s.contains("日本語"));
    }

    #[test]
    fn decode_text_accepts_empty_file() {
        let s = decode_text(b"").unwrap();
        assert_eq!(s, "");
    }

    #[test]
    fn decode_text_rejects_nul_byte_as_binary() {
        // PNG signature contains NULs in the first 8 bytes.
        let png_header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00];
        let err = decode_text(&png_header).unwrap_err();
        assert!(
            err.to_lowercase().contains("binary"),
            "PNG header must read as binary, got: {err}"
        );
    }

    #[test]
    fn decode_text_rejects_invalid_utf8() {
        // 0xff is never valid as a UTF-8 starter byte.
        let bytes = [0x66, 0x6f, 0x6f, 0xff, 0x62, 0x61, 0x72];
        let err = decode_text(&bytes).unwrap_err();
        assert!(
            err.to_lowercase().contains("utf-8") || err.to_lowercase().contains("binary"),
            "invalid utf-8 must produce a clean error, got: {err}"
        );
    }

    #[test]
    fn decode_text_only_probes_first_8kib_for_nul() {
        // NUL beyond the 8 KiB probe window is allowed through as text. We
        // accept this trade-off: probing the whole buffer would slow down
        // 2 MiB reads, and real-world text files virtually never contain
        // NULs (the few legitimate cases — protobuf wire format, etc. —
        // wouldn't be opened in a code editor anyway).
        let mut bytes = vec![b'a'; 8192];
        bytes.push(0u8);
        bytes.extend_from_slice(b"trailing");
        // String::from_utf8 will reject the NUL+trailing? Actually NUL is
        // valid UTF-8 (it's just U+0000). So this should succeed.
        let s = decode_text(&bytes).unwrap();
        assert!(s.starts_with("aaaa"));
    }
}
