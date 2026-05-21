//! Localhost HTTP daemon — drop-in replacement for gstack's
//! `127.0.0.1:4000` service. Routes:
//!
//! ```text
//! GET  /health                  → { ok, version }
//! GET  /status                  → { url, title, ready }
//! GET  /screenshot              → image/png bytes
//! GET  /console/recent          → { entries: [...] }
//! POST /navigate                → { url } → 204
//! POST /click                   → { x, y } → 204
//! POST /type                    → { text } → 204
//! POST /key                     → { key } → 204
//! POST /back                    → 204
//! POST /forward                 → 204
//! POST /reload                  → 204
//! ```
//!
//! Bind preference: 4000, falling back through 4001..4099 if taken.
//! Chosen port is written to `~/Library/Application Support/dev.raeedz.goonware/browser-port`
//! so other tools (a `claude` running in a Goonware terminal pane, hand-
//! rolled scripts, etc.) can discover it programmatically.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;

use super::chrome::{ChromeSession, LogEntry, Status};
use super::BrowserState;

const PORT_FIRST: u16 = 4000;
// Widened from 4099 to give 200 ports of headroom for dev sessions
// that accumulate stale processes from repeated `tauri dev` restarts
// before falling back to an OS-assigned port.
const PORT_LAST: u16 = 4199;

struct DaemonCtx<R: Runtime> {
    app: AppHandle<R>,
    state: BrowserState,
}

// Manual Clone — derive(Clone) on a generic adds an unwanted `R: Clone`
// bound. AppHandle<R> is Clone for every Runtime, BrowserState is Clone,
// so the impl is trivial; we just don't want R itself constrained.
impl<R: Runtime> Clone for DaemonCtx<R> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            state: self.state.clone(),
        }
    }
}

/// Bind the daemon to 127.0.0.1:4000 (or 4001..4099 if 4000 is taken).
/// Spawned as a background tokio task — returns once the listener is
/// bound so the caller can move on with app boot.
pub async fn start<R: Runtime>(app: AppHandle<R>) -> Result<u16, String> {
    let state: BrowserState = app.state::<BrowserState>().inner().clone();
    let ctx = DaemonCtx {
        app: app.clone(),
        state: state.clone(),
    };

    // Best-effort cleanup of the legacy port-file location, in case an
    // earlier build wrote one there. Stale files in the old dir aren't
    // read by anyone anymore but keeping them around invites confusion.
    if let Some(legacy) = dirs::data_dir() {
        let _ = std::fs::remove_file(legacy.join("RLI").join("browser-port"));
    }

    let (listener, port) = bind_with_retry().await?;
    // Publish the bound port to BrowserState BEFORE writing the file
    // — that's the in-memory source of truth that `term.rs` reads to
    // inject `GOONWARE_BROWSER_URL` into PTY children. The port file is
    // for the React frontend, which can't reach managed state
    // directly.
    state
        .bound_port
        .store(port, std::sync::atomic::Ordering::Relaxed);
    write_port_file(&app, port);

    // Tell the frontend the daemon is up. Without this event, React's
    // health-check polling runs on a 2s interval and a 10s timeout,
    // so a slow boot can briefly land in the DaemonOffline UI even
    // though everything is fine. The BrowserPane listens for this
    // event and fires an immediate health probe on receipt, so the
    // moment the daemon binds the UI flips to ready.
    if let Err(e) = app.emit("rli://browser-daemon-ready", port) {
        eprintln!("[browser daemon] failed to emit ready event: {e}");
    }

    let router = Router::new()
        .route("/health", get(health))
        .route("/status", get(status))
        .route("/screenshot", get(screenshot))
        .route("/console/recent", get(console_recent))
        .route("/navigate", post(navigate))
        .route("/click", post(click))
        .route("/type", post(type_text))
        .route("/key", post(key))
        .route("/back", post(back))
        .route("/forward", post(forward))
        .route("/reload", post(reload))
        .layer(CorsLayer::permissive())
        .with_state(ctx);

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("[browser daemon] axum::serve exited: {e}");
        }
    });

    Ok(port)
}

async fn bind_with_retry() -> Result<(TcpListener, u16), String> {
    let mut last_err: Option<std::io::Error> = None;
    for port in PORT_FIRST..=PORT_LAST {
        let addr: std::net::SocketAddr = ([127, 0, 0, 1], port).into();
        match TcpListener::bind(addr).await {
            Ok(l) => return Ok((l, port)),
            Err(e) => {
                last_err = Some(e);
                continue;
            }
        }
    }
    // Fallback: bind to an OS-assigned ephemeral port (`:0`). This
    // virtually always succeeds — the only way it doesn't is the
    // whole machine being out of file descriptors / ephemeral ports,
    // which means much bigger problems than the browser daemon.
    // The port is unpredictable but harmless: BrowserState publishes
    // it, and term.rs reads from BrowserState before injecting the
    // env var into PTYs, so agents always get the right URL.
    let fallback_addr: std::net::SocketAddr = ([127, 0, 0, 1], 0).into();
    match TcpListener::bind(fallback_addr).await {
        Ok(l) => {
            let port = l
                .local_addr()
                .map(|a| a.port())
                .map_err(|e| format!("could not read OS-assigned port: {e}"))?;
            eprintln!(
                "[browser daemon] preferred range {PORT_FIRST}..={PORT_LAST} \
                 was fully taken; bound OS-assigned port {port} instead"
            );
            Ok((l, port))
        }
        Err(e) => Err(format!(
            "browser daemon could not bind any port — preferred range \
             {PORT_FIRST}..={PORT_LAST} exhausted, OS-assigned fallback \
             also failed: {} (last preferred-range error: {})",
            e,
            last_err
                .map(|e| e.to_string())
                .unwrap_or_else(|| "n/a".to_string()),
        )),
    }
}

fn write_port_file<R: Runtime>(app: &AppHandle<R>, port: u16) {
    // CRITICAL: we MUST write into the same directory Tauri's frontend
    // resolves via `appDataDir()` — that's the bundle-id-scoped
    // `~/Library/Application Support/dev.raeedz.goonware/` on macOS. The
    // previous `dirs::data_dir().join("RLI")` resolved to a sibling
    // directory the frontend never read, so any non-default port the
    // daemon ended up on (4001+, e.g. after a port collision) was
    // invisible — the frontend kept trying :4000 and timed out.
    //
    // Every step now logs on failure. The previous all-silent version
    // meant a missing/unwritable port file looked identical to a happy
    // path from the user's perspective; React fell back to :4000,
    // every fetch timed out, and there was no signal anywhere as to
    // why. The `browser_bound_port` Tauri command in mod.rs is the
    // primary discovery channel now, but the file is still useful for
    // out-of-process tools (curl, agent scripts) so we want it written
    // and we want to know when it isn't.
    let dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!(
                "[browser daemon] could not resolve app_data_dir for port file: {e}"
            );
            return;
        }
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!(
            "[browser daemon] could not create {} for port file: {e}",
            dir.display()
        );
        return;
    }
    let path = dir.join("browser-port");
    if let Err(e) = std::fs::write(&path, port.to_string()) {
        eprintln!(
            "[browser daemon] could not write port file {}: {e}",
            path.display()
        );
    }
}

/* ------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------ */

/// Acquire (or lazily spawn) the Chrome session, then run `f` against
/// it. Lazy spawn keeps `cargo run` snappy — Chrome doesn't fork until
/// the first request that actually needs a page.
async fn with_session<R, F, Fut, T>(
    ctx: &DaemonCtx<R>,
    f: F,
) -> Result<T, String>
where
    R: Runtime,
    F: FnOnce(Arc<ChromeSession>) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let session_arc = {
        let mut g = ctx.state.session.write().await;
        if g.is_none() {
            let session = ChromeSession::launch(&ctx.app).await?;
            *g = Some(Arc::new(session));
        }
        // Cheap Arc::clone — handler runs without holding the lock.
        g.as_ref().expect("session set above").clone()
    };
    f(session_arc).await
}

/// Map `Result<T, String>` → axum response with a sensible status code.
fn err_500(e: String) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, e).into_response()
}

/* ------------------------------------------------------------------
   Route handlers
   ------------------------------------------------------------------ */

#[derive(Serialize)]
struct Health {
    ok: bool,
    version: &'static str,
}

async fn health<R: Runtime>(State(_ctx): State<DaemonCtx<R>>) -> Json<Health> {
    Json(Health {
        ok: true,
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn status<R: Runtime>(State(ctx): State<DaemonCtx<R>>) -> Response {
    // Don't lazy-spawn Chrome on /status — return a "not ready" stub
    // if the user's just opened the pane and hasn't navigated yet.
    let g = ctx.state.session.read().await;
    if let Some(s) = g.as_ref() {
        Json(s.status().await).into_response()
    } else {
        Json(Status::default()).into_response()
    }
}

async fn screenshot<R: Runtime>(State(ctx): State<DaemonCtx<R>>) -> Response {
    match with_session(&ctx, |s| async move { s.screenshot().await }).await {
        Ok(bytes) => {
            let mut res = bytes.into_response();
            res.headers_mut()
                .insert(axum::http::header::CONTENT_TYPE, "image/png".parse().unwrap());
            res
        }
        Err(e) => err_500(e),
    }
}

#[derive(Deserialize)]
struct RecentQuery {
    n: Option<usize>,
}

async fn console_recent<R: Runtime>(
    State(ctx): State<DaemonCtx<R>>,
    Query(q): Query<RecentQuery>,
) -> Json<ConsoleResponse> {
    let n = q.n.unwrap_or(200);
    let g = ctx.state.session.read().await;
    let entries = match g.as_ref() {
        Some(s) => s.recent_console(n).await,
        None => vec![],
    };
    Json(ConsoleResponse { entries })
}

#[derive(Serialize)]
struct ConsoleResponse {
    entries: Vec<LogEntry>,
}

#[derive(Deserialize)]
struct NavigateBody {
    url: String,
}

async fn navigate<R: Runtime>(
    State(ctx): State<DaemonCtx<R>>,
    Json(body): Json<NavigateBody>,
) -> Response {
    let url = body.url;
    match with_session(&ctx, |s| async move { s.navigate(&url).await }).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err_500(e),
    }
}

#[derive(Deserialize)]
struct ClickBody {
    x: f64,
    y: f64,
}

async fn click<R: Runtime>(
    State(ctx): State<DaemonCtx<R>>,
    Json(body): Json<ClickBody>,
) -> Response {
    let ClickBody { x, y } = body;
    match with_session(&ctx, |s| async move { s.click(x, y).await }).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err_500(e),
    }
}

#[derive(Deserialize)]
struct TypeBody {
    text: String,
}

async fn type_text<R: Runtime>(
    State(ctx): State<DaemonCtx<R>>,
    Json(body): Json<TypeBody>,
) -> Response {
    let text = body.text;
    match with_session(&ctx, |s| async move { s.type_text(&text).await }).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err_500(e),
    }
}

#[derive(Deserialize)]
struct KeyBody {
    key: String,
}

async fn key<R: Runtime>(
    State(ctx): State<DaemonCtx<R>>,
    Json(body): Json<KeyBody>,
) -> Response {
    let k = body.key;
    match with_session(&ctx, |s| async move { s.key(&k).await }).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err_500(e),
    }
}

async fn back<R: Runtime>(State(ctx): State<DaemonCtx<R>>) -> Response {
    match with_session(&ctx, |s| async move { s.back().await }).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err_500(e),
    }
}

async fn forward<R: Runtime>(State(ctx): State<DaemonCtx<R>>) -> Response {
    match with_session(&ctx, |s| async move { s.forward().await }).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err_500(e),
    }
}

async fn reload<R: Runtime>(State(ctx): State<DaemonCtx<R>>) -> Response {
    match with_session(&ctx, |s| async move { s.reload().await }).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err_500(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bind_with_retry_walks_off_busy_port() {
        // Hold port 4000 yourself so bind_with_retry skips it.
        let blocker_addr: std::net::SocketAddr = ([127, 0, 0, 1], 4000).into();
        let _blocker = match TcpListener::bind(blocker_addr).await {
            Ok(l) => l,
            // Port already taken in CI for other reasons — skip.
            Err(_) => return,
        };
        let (got, port) = bind_with_retry().await.expect("retry");
        drop(got);
        assert!(port > 4000 && port <= 4099, "got port {port}");
    }
}
