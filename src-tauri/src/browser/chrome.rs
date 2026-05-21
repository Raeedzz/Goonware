//! Headless Chrome lifecycle + Chrome DevTools Protocol bridge.
//!
//! Spawns the Chrome binary returned by `binary::ensure_chrome`, parses
//! the WebSocket URL Chrome prints to stderr, then attaches
//! chromiumoxide as a CDP client. From there we expose:
//!
//!   - navigate, click, type, key, back, forward, reload
//!   - screenshot (PNG bytes of the current viewport)
//!   - status (current url + title)
//!   - console buffer (last 200 messages)
//!
//! The Chrome process dies when the `ChromeSession` is dropped (kill on
//! Drop). User-data-dir is unique per launch so a hard crash never
//! leaves the next run unable to start.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::cdp::browser_protocol::input::{
    DispatchKeyEventParams, DispatchKeyEventType, DispatchMouseEventParams,
    DispatchMouseEventType, InsertTextParams, MouseButton,
};
use chromiumoxide::cdp::browser_protocol::page::{
    CaptureScreenshotFormat, CaptureScreenshotParams, NavigateParams,
};
use chromiumoxide::cdp::js_protocol::runtime::EventConsoleApiCalled;
use chromiumoxide::Page;
use futures::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tokio::sync::Mutex;

use super::binary::ensure_chrome;

/// Maximum console messages buffered per page.
const CONSOLE_BUFFER_CAP: usize = 200;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub ts: u64,
    pub level: String,
    pub text: String,
}

/// Active Chrome process + CDP client. Cheap to clone references via
/// `Arc<Mutex<…>>` so handlers can grab the page without holding the
/// outer Tokio RwLock for the whole request.
pub struct ChromeSession {
    /// Kept alive so we can SIGTERM on Drop. Wrapped because
    /// chromiumoxide's `Browser` owns a websocket connection too.
    _process: ChromeProcess,
    browser: Browser,
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    page: Option<Page>,
    console: VecDeque<LogEntry>,
    last_url: Option<String>,
    last_title: Option<String>,
    /// Flipped on after the first `navigate` call's `wait_for_navigation`
    /// future resolves (or its 8s timeout fires). `Status::ready` keys
    /// off this rather than `page.is_some()` so the frontend's
    /// screenshot polling doesn't fire against the `about:blank` page
    /// that `ensure_page` minted before the user's URL load finished.
    nav_completed: bool,
}

/// Owns the spawned Chrome child. Killing happens on drop. We keep
/// the user-data-dir around (no auto-remove) so cookies survive across
/// pane open/close — but it's per-PID so a crashed run doesn't poison
/// the next one.
struct ChromeProcess {
    child: tokio::process::Child,
    /// Held only so the directory path stays alive for the lifetime of
    /// the session — Drop deliberately does NOT remove it (cookies).
    _user_data_dir: PathBuf,
}

impl Drop for ChromeProcess {
    fn drop(&mut self) {
        // Best-effort: ask Chrome to close, kill if it lingers. Don't
        // panic from Drop — that could double-fault during process exit.
        let _ = self.child.start_kill();
        // We deliberately do NOT remove `user_data_dir` here — the
        // user may have logged into something inside the headless
        // session and we don't want to nuke their cookies on app exit.
    }
}

impl ChromeSession {
    /// Spawn Chrome (downloading CFT first if necessary) and connect via
    /// CDP. Returns once the websocket handshake completes — the page
    /// itself is created lazily on the first `navigate` call.
    pub async fn launch<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let chrome_path = ensure_chrome(app).await?;

        // Per-PID user-data-dir keeps a crashed previous session from
        // colliding with this one. Inside ~/Library/Application Support/Goonware/.
        let pid = std::process::id();
        let data_root = dirs::data_dir()
            .ok_or_else(|| "no home directory".to_string())?
            .join("Goonware")
            .join("chrome-profiles");
        std::fs::create_dir_all(&data_root)
            .map_err(|e| format!("create profile root: {e}"))?;
        let user_data_dir = data_root.join(format!("p-{pid}"));

        // Be explicit about headless mode. chromiumoxide's
        // BrowserConfig defaults to legacy `--headless`, and the
        // ambient `.args(["--headless=new", …])` we used to layer on
        // top meant the spawned Chrome got *both* flags. Chrome handles
        // duplicates with last-wins, but the redundancy is asking for
        // trouble — and on some macOS Chrome builds, the combination
        // briefly flashes a real window on first launch before the
        // headless backend kicks in. Calling `.new_headless_mode()`
        // makes chromiumoxide emit `--headless=new` once and only once,
        // so the user never sees a real Chrome window.
        let config = BrowserConfig::builder()
            .chrome_executable(chrome_path)
            .user_data_dir(&user_data_dir)
            .new_headless_mode()
            .args([
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-features=Translate",
                "--window-size=1280,800",
            ])
            .build()
            .map_err(|e| format!("BrowserConfig: {e}"))?;

        let (browser, mut handler) = Browser::launch(config)
            .await
            .map_err(|e| format!("Chrome launch: {e}"))?;

        // chromiumoxide requires a background task to drive the
        // event-loop handler. Detach it; it dies when `browser` drops.
        tokio::spawn(async move {
            while let Some(_event) = handler.next().await {
                // We don't use any of the bus-level events at this
                // layer — page-scoped events get their own listener.
            }
        });

        // Capture the child handle from chromiumoxide's process
        // ownership so we control kill-on-drop ourselves. We can't
        // get tokio::process::Child out of chromiumoxide directly,
        // so we just rely on the Browser's own teardown via Drop and
        // skip the explicit child handle. (chromiumoxide kills the
        // process when Browser is dropped.)
        let _ = pid; // silence unused on platforms that don't need it
        let process = ChromeProcess {
            child: tokio::process::Command::new("/usr/bin/true")
                .spawn()
                .map_err(|e| format!("placeholder spawn: {e}"))?,
            _user_data_dir: user_data_dir,
        };
        // The placeholder Child is for symmetry / Drop ordering only;
        // the real Chrome child is owned by `browser` (chromiumoxide).
        // start_kill on the placeholder is a no-op on a finished /usr/bin/true.

        let inner = Arc::new(Mutex::new(Inner {
            page: None,
            console: VecDeque::with_capacity(CONSOLE_BUFFER_CAP + 1),
            last_url: None,
            last_title: None,
            nav_completed: false,
        }));

        Ok(Self {
            _process: process,
            browser,
            inner,
        })
    }

    /// Returns the active page, creating one if none has been
    /// navigated yet. Subscribed to console events on first creation.
    async fn ensure_page(&self) -> Result<Page, String> {
        {
            let inner = self.inner.lock().await;
            if let Some(p) = inner.page.as_ref() {
                return Ok(p.clone());
            }
        }
        let page = self
            .browser
            .new_page("about:blank")
            .await
            .map_err(|e| format!("new_page: {e}"))?;

        // Subscribe to console events for this page. Background task
        // pumps each event into the ring buffer.
        let inner = self.inner.clone();
        let mut events = page
            .event_listener::<EventConsoleApiCalled>()
            .await
            .map_err(|e| format!("event_listener: {e}"))?;
        tokio::spawn(async move {
            while let Some(ev) = events.next().await {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let level = format!("{:?}", ev.r#type).to_lowercase();
                let text = ev
                    .args
                    .iter()
                    .map(|a| {
                        a.value
                            .as_ref()
                            .map(|v| v.to_string())
                            .or_else(|| a.description.clone())
                            .unwrap_or_default()
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                let mut g = inner.lock().await;
                g.console.push_back(LogEntry { ts: now, level, text });
                while g.console.len() > CONSOLE_BUFFER_CAP {
                    g.console.pop_front();
                }
            }
        });

        let mut g = self.inner.lock().await;
        g.page = Some(page.clone());
        Ok(page)
    }

    pub async fn navigate(&self, url: &str) -> Result<(), String> {
        let page = self.ensure_page().await?;
        page.execute(NavigateParams::new(url.to_string()))
            .await
            .map_err(|e| format!("navigate: {e}"))?;
        // Best-effort: wait briefly for the load event so screenshots
        // captured immediately after see the new content.
        let _ = tokio::time::timeout(
            Duration::from_secs(8),
            page.wait_for_navigation(),
        )
        .await;
        let url_now = page.url().await.ok().flatten();
        let title_now = page.get_title().await.ok().flatten();
        let mut g = self.inner.lock().await;
        g.last_url = url_now;
        g.last_title = title_now;
        // First successful navigate flips ready=true for the frontend.
        // Subsequent navigates keep it true (the page is still a real
        // page; the URL just changed). We never flip back to false
        // without a full session restart via `browser_restart`.
        g.nav_completed = true;
        Ok(())
    }

    pub async fn back(&self) -> Result<(), String> {
        let page = self.ensure_page().await?;
        page.evaluate("history.back()")
            .await
            .map_err(|e| format!("back: {e}"))?;
        Ok(())
    }

    pub async fn forward(&self) -> Result<(), String> {
        let page = self.ensure_page().await?;
        page.evaluate("history.forward()")
            .await
            .map_err(|e| format!("forward: {e}"))?;
        Ok(())
    }

    pub async fn reload(&self) -> Result<(), String> {
        let page = self.ensure_page().await?;
        page.reload().await.map_err(|e| format!("reload: {e}"))?;
        Ok(())
    }

    pub async fn click(&self, x: f64, y: f64) -> Result<(), String> {
        let page = self.ensure_page().await?;
        // Press + release. Single click; no double-click yet.
        let down = DispatchMouseEventParams::builder()
            .r#type(DispatchMouseEventType::MousePressed)
            .x(x)
            .y(y)
            .button(MouseButton::Left)
            .click_count(1)
            .build()
            .map_err(|e| format!("click down build: {e}"))?;
        let up = DispatchMouseEventParams::builder()
            .r#type(DispatchMouseEventType::MouseReleased)
            .x(x)
            .y(y)
            .button(MouseButton::Left)
            .click_count(1)
            .build()
            .map_err(|e| format!("click up build: {e}"))?;
        page.execute(down).await.map_err(|e| format!("click down: {e}"))?;
        page.execute(up).await.map_err(|e| format!("click up: {e}"))?;
        Ok(())
    }

    pub async fn type_text(&self, text: &str) -> Result<(), String> {
        let page = self.ensure_page().await?;
        page.execute(InsertTextParams::new(text.to_string()))
            .await
            .map_err(|e| format!("type: {e}"))?;
        Ok(())
    }

    pub async fn key(&self, key: &str) -> Result<(), String> {
        let page = self.ensure_page().await?;
        let down = DispatchKeyEventParams::builder()
            .r#type(DispatchKeyEventType::KeyDown)
            .key(key.to_string())
            .build()
            .map_err(|e| format!("key down build: {e}"))?;
        let up = DispatchKeyEventParams::builder()
            .r#type(DispatchKeyEventType::KeyUp)
            .key(key.to_string())
            .build()
            .map_err(|e| format!("key up build: {e}"))?;
        page.execute(down).await.map_err(|e| format!("key down: {e}"))?;
        page.execute(up).await.map_err(|e| format!("key up: {e}"))?;
        Ok(())
    }

    pub async fn screenshot(&self) -> Result<Vec<u8>, String> {
        let page = self.ensure_page().await?;
        let params = CaptureScreenshotParams::builder()
            .format(CaptureScreenshotFormat::Png)
            .build();
        let result = page
            .execute(params)
            .await
            .map_err(|e| format!("screenshot: {e}"))?;
        // chromiumoxide returns a base64-encoded PNG via the CDP wire.
        use base64::{engine::general_purpose, Engine as _};
        general_purpose::STANDARD
            .decode(&result.data)
            .map_err(|e| format!("screenshot decode: {e}"))
    }

    pub async fn status(&self) -> Status {
        let g = self.inner.lock().await;
        // ready means "a real URL has been loaded", not just "a page
        // object exists" — see Inner::nav_completed for why.
        Status {
            url: g.last_url.clone(),
            title: g.last_title.clone(),
            ready: g.nav_completed,
        }
    }

    pub async fn recent_console(&self, limit: usize) -> Vec<LogEntry> {
        let g = self.inner.lock().await;
        let count = limit.min(g.console.len());
        let start = g.console.len() - count;
        g.console.iter().skip(start).cloned().collect()
    }
}

#[derive(Serialize, Default, Clone)]
pub struct Status {
    pub url: Option<String>,
    pub title: Option<String>,
    pub ready: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_serializes_with_camel_case() {
        let s = Status {
            url: Some("https://example.com".into()),
            title: Some("Example".into()),
            ready: true,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["url"], "https://example.com");
        assert_eq!(v["title"], "Example");
        assert_eq!(v["ready"], true);
    }

    #[test]
    fn console_buffer_caps_at_200() {
        let mut buf: VecDeque<LogEntry> = VecDeque::new();
        for i in 0..250 {
            buf.push_back(LogEntry {
                ts: i,
                level: "log".into(),
                text: format!("msg {i}"),
            });
            while buf.len() > CONSOLE_BUFFER_CAP {
                buf.pop_front();
            }
        }
        assert_eq!(buf.len(), CONSOLE_BUFFER_CAP);
        // Newest entry kept, oldest evicted.
        assert_eq!(buf.front().unwrap().ts, 50);
        assert_eq!(buf.back().unwrap().ts, 249);
    }

    #[test]
    fn log_entry_serializes_to_camel_case() {
        let e = LogEntry {
            ts: 1700000000000,
            level: "error".into(),
            text: "boom".into(),
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["ts"], 1700000000000u64);
        assert_eq!(v["level"], "error");
        assert_eq!(v["text"], "boom");
    }
}
