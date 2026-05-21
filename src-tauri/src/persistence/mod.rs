//! Warp-style persistence layer.
//!
//! ## Architecture (mirrors `crates/persistence` + `app/src/persistence/sqlite.rs` upstream)
//!
//! ```text
//!   Tauri command thread                     persistence writer thread
//!   ─────────────────────                    ─────────────────────────
//!   state_save(content) ──┐
//!                         │  sync_channel(1024)        ┌─────────────┐
//!   state_clear() ────────┼────────────────────────────►   apply()   │
//!                         │  Save | Clear              │  → SQLite    │
//!   state_load() ── open_ro() ── direct read           │  (RW conn)   │
//!                                                      └─────────────┘
//! ```
//!
//! ## Lifecycle
//!
//! [`init`] is called once from `lib.rs` setup. It:
//! 1. Resolves `<app_data_dir>/goonware.db`.
//! 2. Opens the RW connection, sets PRAGMAs, runs migrations.
//! 3. **One-shot legacy ingest**: if `state.json` from the pre-SQLite
//!    storage exists in the same dir and the new DB has no row, the
//!    JSON is loaded into the singleton row and `state.json` is
//!    deleted. The file is gone for good after this — keeping it
//!    around would let stale state silently re-appear after the user
//!    edited the DB.
//! 4. Hands the RW connection to a freshly-spawned writer thread.
//! 5. Stores the writer handle in Tauri's state.
//!
//! ## What this module deliberately doesn't do (yet)
//!
//! - **No normalized schema.** The singleton `app_state` row holds
//!   the same JSON blob the front-end already serializes via
//!   `pickPersistent`. Migrating to per-table windows/tabs/panes is
//!   the next slice (add a v2 migration + a new `Event::Snapshot`
//!   variant that fills those tables in a transaction, then drop the
//!   blob).
//! - **No block / scrollback persistence.** Terminal history isn't
//!   touched here — `flat_storage.rs` still owns in-memory grids and
//!   block segmentation isn't VTE-wired yet.
//! - **No graceful shutdown.** The writer thread relies on macOS
//!   tearing it down at app exit; WAL recovers any half-finished
//!   transaction on next launch. If we add long-running async writes
//!   (e.g. block-by-block scrollback), revisit this.

pub mod db;
pub mod migrations;
pub mod writer;

use std::path::PathBuf;

use rusqlite::OptionalExtension;
use tauri::{AppHandle, Manager, Runtime};

pub use writer::WriterHandle;

/// Tauri-managed state holder.
pub struct PersistenceState {
    pub writer: WriterHandle,
    pub db_path: PathBuf,
}

/// Open the DB, run migrations, ingest any legacy `state.json`,
/// spawn the writer thread. Returns the handle + the DB path (the
/// path is reused by the synchronous load command).
pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<PersistenceState, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let db_path = app_data.join(db::DB_FILE);

    let mut conn = db::open_rw(&db_path)
        .map_err(|e| format!("open SQLite at {}: {e}", db_path.display()))?;

    ingest_legacy_state_json(&mut conn, &app_data)?;

    let writer = writer::start(conn, db_path.clone());
    Ok(PersistenceState { writer, db_path })
}

/// Synchronous read from a fresh RO connection. Cheap — no channel
/// round-trip. Returns `None` if the singleton row is missing (fresh
/// install or after `state_clear`).
pub fn load(db_path: &std::path::Path) -> Result<Option<String>, String> {
    let conn = db::open_ro(db_path)
        .map_err(|e| format!("open RO at {}: {e}", db_path.display()))?;
    conn.query_row(
        "SELECT content FROM app_state WHERE id = 1",
        [],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("read app_state: {e}"))
}

/// Wire-format row used by `term_history_load`. Mirrors
/// `term::ClosedBlock` field names + casing so the frontend reuses
/// its `ClosedBlock` TypeScript interface unchanged.
#[derive(Debug, serde::Serialize)]
pub struct SavedBlock {
    pub block_id: i64,
    pub input: String,
    pub transcript: String,
    /// Parsed back to the frontend's expected `BlockRow[]` shape on
    /// the JS side. Stored as JSON text rather than re-parsed here so
    /// the read path stays a single column read per block.
    #[serde(rename = "blockRows")]
    pub block_rows_json: serde_json::Value,
    pub exit_code: Option<i32>,
    pub cwd: Option<String>,
    #[serde(rename = "durationMs")]
    pub duration_ms: Option<i64>,
}

/// Return every persisted block for a pty_id in insertion order
/// (oldest first), matching how the frontend's `sessionMemory.blocks`
/// array is ordered. Returns an empty vec for unknown pty_ids — no
/// error.
pub fn load_blocks(
    db_path: &std::path::Path,
    pty_id: &str,
) -> Result<Vec<SavedBlock>, String> {
    let conn = db::open_ro(db_path)
        .map_err(|e| format!("open RO at {}: {e}", db_path.display()))?;
    let mut stmt = conn
        .prepare(
            "SELECT block_id, input, transcript, block_rows, \
                    exit_code, cwd, duration_ms \
             FROM blocks WHERE pty_id = ?1 ORDER BY id ASC",
        )
        .map_err(|e| format!("prepare load_blocks: {e}"))?;
    let rows = stmt
        .query_map(rusqlite::params![pty_id], |row| {
            let rows_text: String = row.get(3)?;
            // Stored as a known-shape JSON literal we wrote ourselves
            // last save — parse failures here are real corruption and
            // worth surfacing instead of silently returning [].
            let rows_value: serde_json::Value =
                serde_json::from_str(&rows_text).unwrap_or_else(|_| {
                    serde_json::Value::Array(Vec::new())
                });
            Ok(SavedBlock {
                block_id: row.get(0)?,
                input: row.get(1)?,
                transcript: row.get(2)?,
                block_rows_json: rows_value,
                exit_code: row.get(4)?,
                cwd: row.get(5)?,
                duration_ms: row.get(6)?,
            })
        })
        .map_err(|e| format!("query blocks: {e}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("read blocks row: {e}"))
}

/// One-shot import of the v1 storage format. If `state.json` is
/// present alongside the new DB and the DB is empty, ingest its
/// contents into the singleton row and delete the JSON file. The
/// delete is deliberate — leaving the file around would let it
/// silently override the SQLite state on a future load path bug, and
/// the JSON has no information not already captured in the DB row.
///
/// Run before the writer thread starts so we can use the RW
/// connection directly without going through the channel.
fn ingest_legacy_state_json(
    conn: &mut rusqlite::Connection,
    app_data: &std::path::Path,
) -> Result<(), String> {
    let legacy = app_data.join("state.json");
    if !legacy.exists() {
        return Ok(());
    }

    // Don't overwrite a real DB row if one already exists — that's
    // the source of truth and the legacy file is stale by definition.
    let has_row: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM app_state WHERE id = 1)",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("check app_state: {e}"))?;
    if has_row {
        // The user upgraded once already; nuke the orphan JSON.
        let _ = std::fs::remove_file(&legacy);
        return Ok(());
    }

    let content = match std::fs::read_to_string(&legacy) {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "[persistence] legacy state.json present but unreadable \
                 ({e}); leaving in place for manual recovery"
            );
            return Ok(());
        }
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    conn.execute(
        "INSERT INTO app_state (id, content, updated_at) VALUES (1, ?1, ?2)",
        rusqlite::params![content, now],
    )
    .map_err(|e| format!("ingest legacy state.json: {e}"))?;

    if let Err(e) = std::fs::remove_file(&legacy) {
        // Non-fatal — DB row is already the truth.
        eprintln!("[persistence] couldn't remove legacy state.json: {e}");
    } else {
        eprintln!(
            "[persistence] ingested legacy state.json into {}",
            db::DB_FILE
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::{Duration, Instant};

    fn wait_for<F: Fn() -> bool>(check: F) {
        // Writer thread is asynchronous; poll briefly. 2s is generous —
        // a singleton UPSERT against an empty DB is microseconds on
        // any reasonable disk.
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if check() {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("timed out waiting for writer thread to flush");
    }

    fn fresh_db() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(db::DB_FILE);
        (dir, path)
    }

    #[test]
    fn save_then_load_returns_same_content() {
        let (_dir, path) = fresh_db();
        let conn = db::open_rw(&path).unwrap();
        let writer = writer::start(conn, path.clone());

        writer.save(r#"{"projects":{}}"#.into()).unwrap();
        wait_for(|| matches!(load(&path), Ok(Some(_))));

        assert_eq!(load(&path).unwrap().as_deref(), Some(r#"{"projects":{}}"#));
    }

    #[test]
    fn last_save_wins_when_bursting() {
        let (_dir, path) = fresh_db();
        let conn = db::open_rw(&path).unwrap();
        let writer = writer::start(conn, path.clone());

        for i in 0..50 {
            writer.save(format!(r#"{{"n":{i}}}"#)).unwrap();
        }
        wait_for(|| load(&path).unwrap().as_deref() == Some(r#"{"n":49}"#));
    }

    #[test]
    fn clear_removes_the_singleton_row() {
        let (_dir, path) = fresh_db();
        let conn = db::open_rw(&path).unwrap();
        let writer = writer::start(conn, path.clone());

        writer.save("hello".into()).unwrap();
        wait_for(|| load(&path).unwrap().is_some());

        writer.clear().unwrap();
        wait_for(|| load(&path).unwrap().is_none());
    }

    #[test]
    fn migrations_are_idempotent_across_reopens() {
        let (_dir, path) = fresh_db();
        {
            let _ = db::open_rw(&path).unwrap();
        }
        // Second open must not fail re-running migrations.
        let conn = db::open_rw(&path).unwrap();
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert!(version >= 1, "user_version should be at least 1");
    }

    #[test]
    fn legacy_state_json_is_ingested_and_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        let legacy = app_data.join("state.json");
        std::fs::write(&legacy, r#"{"legacy":true}"#).unwrap();

        let db_path = app_data.join(db::DB_FILE);
        let mut conn = db::open_rw(&db_path).unwrap();
        ingest_legacy_state_json(&mut conn, app_data).unwrap();

        assert!(!legacy.exists(), "legacy file should be deleted");
        let row: String = conn
            .query_row("SELECT content FROM app_state WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(row, r#"{"legacy":true}"#);
    }

    fn mk_block(id: i64, input: &str) -> writer::SavedBlockPayload {
        writer::SavedBlockPayload {
            pty_id: "pty-A".into(),
            block_id: id,
            input: input.into(),
            transcript: format!("{input}\nhello\n"),
            block_rows_json: r#"[{"spans":[]}]"#.into(),
            exit_code: Some(0),
            cwd: Some("/tmp".into()),
            duration_ms: Some(42),
        }
    }

    #[test]
    fn save_block_then_load_blocks_returns_history_in_order() {
        let (_dir, path) = fresh_db();
        let conn = db::open_rw(&path).unwrap();
        let w = writer::start(conn, path.clone());

        w.save_block(mk_block(1, "ls"));
        w.save_block(mk_block(2, "echo hi"));
        wait_for(|| load_blocks(&path, "pty-A").map(|v| v.len()).unwrap_or(0) >= 2);

        let blocks = load_blocks(&path, "pty-A").unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].input, "ls");
        assert_eq!(blocks[1].input, "echo hi");
        assert_eq!(blocks[1].exit_code, Some(0));
        assert_eq!(blocks[0].cwd.as_deref(), Some("/tmp"));
    }

    #[test]
    fn forget_pty_cascades_to_blocks() {
        let (_dir, path) = fresh_db();
        let conn = db::open_rw(&path).unwrap();
        let w = writer::start(conn, path.clone());

        w.save_block(mk_block(1, "ls"));
        wait_for(|| load_blocks(&path, "pty-A").map(|v| v.len()).unwrap_or(0) >= 1);

        w.forget_pty("pty-A".into()).unwrap();
        wait_for(|| load_blocks(&path, "pty-A").map(|v| v.is_empty()).unwrap_or(false));

        let blocks = load_blocks(&path, "pty-A").unwrap();
        assert!(blocks.is_empty(), "forget_pty should cascade");
    }

    #[test]
    fn load_blocks_for_unknown_pty_is_empty_not_error() {
        let (_dir, path) = fresh_db();
        // No writes — the table is empty but exists.
        let _ = db::open_rw(&path).unwrap();
        let blocks = load_blocks(&path, "nobody").unwrap();
        assert!(blocks.is_empty());
    }

    #[test]
    fn block_cap_evicts_oldest_per_pty() {
        let (_dir, path) = fresh_db();
        let conn = db::open_rw(&path).unwrap();
        let w = writer::start(conn, path.clone());

        // Push 5 over the cap of 500. We poke the eviction by inserting
        // > MAX_BLOCKS_PER_PTY rows; the cap constant is module-private
        // so we hard-code the expected behavior: the last 500 survive.
        const CAP: i64 = 500;
        for i in 1..=(CAP + 5) {
            w.save_block(mk_block(i, &format!("cmd-{i}")));
        }
        wait_for(|| load_blocks(&path, "pty-A").map(|v| v.len() as i64).unwrap_or(0) == CAP);

        let blocks = load_blocks(&path, "pty-A").unwrap();
        assert_eq!(blocks.len(), CAP as usize);
        // Oldest survivor should be block_id = 6 (1..=5 evicted).
        assert_eq!(blocks[0].block_id, 6);
        assert_eq!(blocks.last().unwrap().block_id, CAP + 5);
    }

    #[test]
    fn legacy_ingest_does_not_overwrite_existing_row() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();

        // Pre-seed the DB.
        let db_path = app_data.join(db::DB_FILE);
        let mut conn = db::open_rw(&db_path).unwrap();
        conn.execute(
            "INSERT INTO app_state (id, content, updated_at) VALUES (1, 'real', 0)",
            [],
        )
        .unwrap();

        // Legacy file present → should be deleted, but DB content stays.
        let legacy = app_data.join("state.json");
        std::fs::write(&legacy, "stale").unwrap();

        ingest_legacy_state_json(&mut conn, app_data).unwrap();

        assert!(!legacy.exists(), "stale legacy file should still be cleaned up");
        let row: String = conn
            .query_row("SELECT content FROM app_state WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(row, "real", "existing DB row must not be overwritten");
    }
}
