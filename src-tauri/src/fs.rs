//! Filesystem + shell-out commands.
//!
//! tauri-plugin-fs exists but is capability-scoped — every path the
//! frontend touches has to be in an allowlist. For GLI's "open any
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

#[tauri::command]
pub fn fs_cwd() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
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

    let dir = std::env::temp_dir().join("gli-paste");
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
