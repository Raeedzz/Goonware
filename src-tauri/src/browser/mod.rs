//! In-house headless-browser daemon — a drop-in replacement for the
//! gstack daemon that gstack ships, exposing the same HTTP contract on
//! `http://127.0.0.1:4000` plus a few new POST routes for interactive
//! input forwarding.
//!
//! See `/Users/raeedz/.claude/plans/zippy-riding-micali.md` for the
//! design + rationale.

#![cfg(target_os = "macos")]

pub mod binary;
pub mod chrome;
pub mod daemon;

use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};
use tokio::sync::RwLock;

use chrome::ChromeSession;

/// Lives in Tauri's managed-state. Holds the lazy-initialized Chrome
/// session — `None` until the first /navigate or /screenshot HTTP call.
/// The inner `Arc<ChromeSession>` lets handlers clone a cheap reference
/// out of the lock so the write-lock isn't held for the whole request.
///
/// Also publishes the daemon's bound port (0 = not yet bound) so the
/// rest of the app — specifically `term.rs` injecting `GOONWARE_BROWSER_URL`
/// into PTY child env — can read the actual URL instead of guessing
/// at the default 4000.
#[derive(Default, Clone)]
pub struct BrowserState {
    pub session: Arc<RwLock<Option<Arc<ChromeSession>>>>,
    pub bound_port: Arc<AtomicU16>,
}

impl BrowserState {
    /// Read the daemon's bound port. Returns `None` until the daemon
    /// has successfully bound a listener.
    pub fn port(&self) -> Option<u16> {
        let p = self.bound_port.load(Ordering::Relaxed);
        if p == 0 { None } else { Some(p) }
    }
}

/// Frontend-facing port lookup. The React side calls this through
/// `invoke()` to discover the daemon's actual bound port — it's the
/// single source of truth, faster and more reliable than reading the
/// port file (which can be missing or stale during the boot race).
/// Returns `None` until the daemon has bound; callers should retry
/// or fall back to the port file.
#[tauri::command]
pub fn browser_bound_port(state: tauri::State<'_, BrowserState>) -> Option<u16> {
    state.port()
}

/// Drop the current Chrome session so the next request lazy-spawns a
/// fresh one. Used by the BrowserPane's "restart browser" button to
/// recover from a stuck or crashed Chrome process without restarting
/// the whole app. The daemon stays running.
///
/// Returns `true` if a session was dropped, `false` if none was
/// active. Both are non-error cases — `false` just means the next
/// request was already going to lazy-spawn.
#[tauri::command]
pub async fn browser_restart(state: tauri::State<'_, BrowserState>) -> Result<bool, String> {
    let mut guard = state.session.write().await;
    let had_session = guard.is_some();
    // Drop the existing session — chromiumoxide's Browser kill-on-drop
    // tears down the child Chrome process. The Arc may have other
    // outstanding clones if a request is mid-flight; those finish
    // against the old session and then the Arc's refcount hits zero.
    *guard = None;
    Ok(had_session)
}
