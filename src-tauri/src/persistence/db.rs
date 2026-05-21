//! SQLite connection setup.
//!
//! Modeled on Warp's `app/src/persistence/sqlite.rs`. Two PRAGMA
//! batches matter here:
//!
//! 1. `journal_mode=WAL` — readers (RO connections used by
//!    [`open_ro`]) never block the writer thread. `wal_autocheckpoint`
//!    is lowered from the default 1000 pages to 500 because writes
//!    already run off the UI thread and can afford to checkpoint more
//!    often; without that lowering, the WAL grows larger than a
//!    typical Goonware DB during long sessions.
//!
//! 2. `busy_timeout=1000` — if a transient lock is held by another
//!    process (rare since we're single-process, but possible if the
//!    user runs `sqlite3` against the file), sleep up to 1s instead
//!    of returning `SQLITE_BUSY` immediately.
//!
//! `foreign_keys=ON` is set for future-proofing — the current schema
//! has no FKs, but the normalized layout schema (next slice) will.

use std::path::Path;

use rusqlite::Connection;

use super::migrations;

/// Filename used inside the app-data dir.
pub const DB_FILE: &str = "goonware.db";

/// Opens (creating if needed) the read-write connection, applies
/// pragmas, and runs any pending migrations. The returned connection
/// is intended to be moved into the writer thread — only one
/// read-write connection should exist for the lifetime of the
/// process.
pub fn open_rw(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        // If we can't create the parent dir, the open below will fail
        // with a more specific error — don't shadow it.
        let _ = std::fs::create_dir_all(parent);
    }
    let mut conn = Connection::open(path)?;
    setup_pragmas(&conn)?;
    migrations::run(&mut conn)?;
    Ok(conn)
}

/// Opens a read-only connection. Used by the synchronous load path so
/// reads don't have to round-trip through the writer thread's channel.
/// Cheap to call — SQLite RO opens just mmap the file.
pub fn open_ro(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
            | rusqlite::OpenFlags::SQLITE_OPEN_URI
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    setup_pragmas(&conn)?;
    Ok(conn)
}

fn setup_pragmas(conn: &Connection) -> rusqlite::Result<()> {
    // foreign_keys + busy_timeout are connection-scoped, so they're
    // set for every connection (RW or RO).
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 1000;",
    )?;
    // WAL / autocheckpoint are persistent file-level settings; setting
    // them on RO connections is harmless (SQLite ignores), but cleaner
    // to apply once on the RW open. RO connections still observe WAL
    // mode because it's stored in the file header.
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA wal_autocheckpoint = 500;",
    )?;
    Ok(())
}
