//! Single-writer background thread.
//!
//! Mirrors Warp's `start_writer` (`app/src/persistence/sqlite.rs`).
//! Architectural points worth keeping straight:
//!
//! - **One writer.** Only this thread holds the read-write SQLite
//!   connection. Reads go through [`super::db::open_ro`] on a fresh
//!   RO connection, never touching this thread's mailbox.
//! - **Bounded mailbox.** A `sync_channel(CAPACITY)` so a runaway
//!   producer can't unbounded-buffer writes into memory. On overflow,
//!   `state_save` is best-effort fire-and-forget (see [`save`]).
//! - **Batch drain + dedupe.** Every loop iteration we drain
//!   everything pending and collapse redundant `Save` events down to
//!   the latest one — under burst load (e.g. the user resizing the
//!   sidebar at 60 Hz) we issue one disk write, not sixty.
//! - **Best-effort shutdown.** We do not block app exit on draining
//!   the channel; macOS will SIGTERM the writer thread on quit and
//!   the WAL recovers any partial transaction on next launch.
//!
//! When we add per-table writes (Save Block, Snapshot Layout, etc.)
//! for the normalized schema slice, they slot in as new `Event`
//! variants and `dedupe`/`apply` learn about them — the channel +
//! thread skeleton stays the same.

use std::path::PathBuf;
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::thread;

use rusqlite::Connection;

/// Bounded so a misbehaving producer can't grow memory unchecked.
/// 1024 matches Warp's `CHANNEL_SIZE` — it's "a power of 2 that
/// seems to be a reasonable upper bound for how many events to
/// queue."
const CAPACITY: usize = 1024;

/// Messages the writer thread can process.
#[derive(Debug)]
enum Event {
    /// Snapshot of the persisted slice of `AppState`. Stored as the
    /// singleton `app_state` row. Multiple of these in the queue
    /// collapse to the latest — see [`dedupe`].
    Save(String),
    /// Wipe the singleton. Used by the `state_clear` command.
    Clear,
    /// Append one finished terminal block. Fired from `term.rs`'s
    /// reader thread on every OSC 133 D close. Pre-serialized to
    /// JSON so the writer thread does no allocator-heavy work.
    SaveBlock(SavedBlockPayload),
    /// Cascade-delete every block for a given pty_id, plus the
    /// `terminal_panes` row itself. Fired by the permanent-delete
    /// path (`forgetSession` in `sessionMemory.ts`), NOT by routine
    /// `term_close` — the user often kills + restarts a session and
    /// expects the history to survive.
    ForgetPty(String),
}

/// Wire format the writer expects for one block. Built from
/// `term::ClosedBlock` at enqueue time so the writer thread doesn't
/// need to know about the terminal module.
#[derive(Debug)]
pub struct SavedBlockPayload {
    pub pty_id: String,
    pub block_id: i64,
    pub input: String,
    pub transcript: String,
    /// JSON-encoded `Vec<RowSnapshot>`.
    pub block_rows_json: String,
    pub exit_code: Option<i32>,
    pub cwd: Option<String>,
    pub duration_ms: Option<i64>,
}

// Block history is retained in full on disk — Warp-parity: terminal
// history is never cut off across restarts. The read path restores the
// full source of truth; renderers virtualize deep transcripts so paint
// work stays bounded to the viewport.

/// Public handle to the writer. Cloneable so multiple Tauri commands
/// can hold a sender without coordinating.
#[derive(Clone)]
pub struct WriterHandle {
    tx: SyncSender<Event>,
}

impl WriterHandle {
    /// Fire-and-forget save. Returns `Ok(())` once the event is on
    /// the mailbox; the actual disk write happens asynchronously on
    /// the writer thread.
    ///
    /// If the mailbox is full, drops the save and returns `Ok(())`
    /// anyway — the next save will supersede it (we dedupe Saves down
    /// to the latest), and front-end state is the in-memory source of
    /// truth that drives subsequent saves. Returning an error here
    /// would only force the front-end to retry the *same* stale
    /// payload, which doesn't help.
    pub fn save(&self, content: String) -> Result<(), String> {
        match self.tx.try_send(Event::Save(content)) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                eprintln!(
                    "[persistence] writer mailbox full; dropping save \
                     (a later save will subsume it)"
                );
                Ok(())
            }
            Err(TrySendError::Disconnected(_)) => {
                Err("persistence writer thread has exited".into())
            }
        }
    }

    /// Synchronously enqueues a clear. Uses the blocking send so the
    /// caller knows the wipe is at least durably queued — unlike
    /// `Save`, callers of `state_clear` are typically debugging / dev
    /// flows where dropping the event silently would be surprising.
    pub fn clear(&self) -> Result<(), String> {
        self.tx
            .send(Event::Clear)
            .map_err(|_| "persistence writer thread has exited".to_string())
    }

    /// Fire-and-forget block append. Called from `term.rs`'s reader
    /// thread once per finished command (OSC 133 D). Drops the block
    /// silently if the mailbox is full — losing a single command's
    /// scrollback line is preferable to back-pressuring the terminal
    /// reader thread, which would stall live render frames for every
    /// other PTY too. The user can always re-run.
    pub fn save_block(&self, payload: SavedBlockPayload) {
        match self.tx.try_send(Event::SaveBlock(payload)) {
            Ok(()) | Err(TrySendError::Full(_)) => {}
            Err(TrySendError::Disconnected(_)) => {
                eprintln!("[persistence] writer disconnected; block dropped");
            }
        }
    }

    /// Cascade-delete a pty's history. Blocking send: the caller
    /// (`forgetSession`) expects the history to be gone before the
    /// session is considered "gone."
    pub fn forget_pty(&self, pty_id: String) -> Result<(), String> {
        self.tx
            .send(Event::ForgetPty(pty_id))
            .map_err(|_| "persistence writer thread has exited".to_string())
    }
}

/// Spawns the writer thread and returns its handle.
pub fn start(conn: Connection, db_path: PathBuf) -> WriterHandle {
    let (tx, rx) = sync_channel::<Event>(CAPACITY);

    thread::Builder::new()
        .name("goonware-persistence-writer".into())
        .spawn(move || run(conn, db_path, rx))
        .expect("failed to spawn persistence writer thread");

    WriterHandle { tx }
}

fn run(
    mut conn: Connection,
    db_path: PathBuf,
    rx: std::sync::mpsc::Receiver<Event>,
) {
    loop {
        // Block for the first event, then opportunistically drain
        // anything else already waiting. The drain is what lets us
        // collapse a burst of Saves into one write.
        let first = match rx.recv() {
            Ok(e) => e,
            Err(_) => {
                // Sender side dropped → app is shutting down.
                return;
            }
        };
        let mut batch = vec![first];
        batch.extend(rx.try_iter());

        for event in dedupe(batch) {
            if let Err(err) = apply(&mut conn, &db_path, event) {
                // Don't tear down the writer on a single failure —
                // the next event might succeed (e.g. transient disk
                // pressure), and even if not we'd rather keep the
                // app responsive than panic the thread.
                eprintln!("[persistence] write failed: {err}");
            }
        }
    }
}

/// Collapses a batch down to the minimum set of events that produces
/// the same final state. Right now:
///
/// - Multiple `Save`s → keep only the last one (full-blob snapshots
///   are idempotent: latest wins).
/// - **`SaveBlock` is never deduped.** Each block is an append to the
///   history table — dropping one would lose a command.
/// - **`ForgetPty` is never deduped against itself either.** Cheap
///   DELETEs, and ordering with intervening SaveBlocks matters
///   (a `SaveBlock(pty=X)` issued after `ForgetPty(pty=X)` must
///   survive — see ordering note below).
///
/// Order within the surviving events is preserved so a `Save` issued
/// after a `Clear` still lands, and so a late `SaveBlock` after a
/// `ForgetPty` (e.g. a block in-flight when the user hit "forget")
/// lands cleanly on a fresh `terminal_panes` row.
fn dedupe(events: Vec<Event>) -> Vec<Event> {
    let last_save = events
        .iter()
        .enumerate()
        .rev()
        .find_map(|(i, e)| matches!(e, Event::Save(_)).then_some(i));

    events
        .into_iter()
        .enumerate()
        .filter_map(|(i, e)| match (&e, last_save) {
            (Event::Save(_), Some(last)) if i < last => None,
            _ => Some(e),
        })
        .collect()
}

fn apply(
    conn: &mut Connection,
    _db_path: &std::path::Path,
    event: Event,
) -> rusqlite::Result<()> {
    match event {
        Event::Save(content) => {
            let now = unix_millis();
            // Singleton upsert against the `id = 1` row defined by
            // the v1 migration. UPSERT keeps it atomic without a
            // separate DELETE + INSERT pair.
            conn.execute(
                "INSERT INTO app_state (id, content, updated_at) \
                 VALUES (1, ?1, ?2) \
                 ON CONFLICT(id) DO UPDATE SET \
                     content = excluded.content, \
                     updated_at = excluded.updated_at",
                rusqlite::params![content, now],
            )?;
        }
        Event::Clear => {
            conn.execute("DELETE FROM app_state", [])?;
        }
        Event::SaveBlock(p) => {
            // Two writes in one transaction: ensure the
            // `terminal_panes` row exists (FK target), then append
            // the block. The trailing eviction query keeps each pty's
            // history bounded — without it a chatty long-running
            // session would grow the table forever.
            let tx = conn.transaction()?;
            let now = unix_millis();
            tx.execute(
                "INSERT INTO terminal_panes (pty_id, cwd, created_at, last_seen_at) \
                 VALUES (?1, ?2, ?3, ?3) \
                 ON CONFLICT(pty_id) DO UPDATE SET \
                     cwd = COALESCE(excluded.cwd, cwd), \
                     last_seen_at = excluded.last_seen_at",
                rusqlite::params![p.pty_id, p.cwd, now],
            )?;
            tx.execute(
                "INSERT INTO blocks (\
                     pty_id, block_id, input, transcript, block_rows, \
                     exit_code, cwd, duration_ms, completed_at\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    p.pty_id,
                    p.block_id,
                    p.input,
                    p.transcript,
                    p.block_rows_json,
                    p.exit_code,
                    p.cwd,
                    p.duration_ms,
                    now,
                ],
            )?;
            // Warp-parity: never evict by count. Full block history is
            // retained on disk and restored in full; the native painter
            // virtualizes deep transcripts.
            tx.commit()?;
        }
        Event::ForgetPty(pty_id) => {
            // DELETE on `terminal_panes` cascades into `blocks` via
            // the FK declared in migration v2 — one statement, one
            // disk hop.
            conn.execute(
                "DELETE FROM terminal_panes WHERE pty_id = ?1",
                rusqlite::params![pty_id],
            )?;
        }
    }
    Ok(())
}

fn unix_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
