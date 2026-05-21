//! Ordered migrations, applied in `user_version` order.
//!
//! Modeled on Warp's `crates/persistence/migrations/`. We use SQLite's
//! built-in `PRAGMA user_version` instead of a separate
//! `schema_migrations` table — simpler, atomic with the migration's
//! own transaction, and one less dep than `rusqlite_migration`.
//!
//! ## Adding a migration
//!
//! Append a new `Migration { version, up }` to [`ALL`]. **Never**
//! reorder, rewrite, or delete an applied migration — `version` must
//! strictly increase. If you need to undo something, write a new
//! migration that does the undo.
//!
//! Each `up` runs inside a transaction. If it returns an error, the
//! transaction rolls back and the DB stays at the previous version.

use rusqlite::Connection;

pub struct Migration {
    pub version: u32,
    pub up: &'static str,
}

/// All migrations in version order. New ones go at the end.
pub const ALL: &[Migration] = &[
    Migration {
        version: 1,
        // Singleton row pattern: `CHECK (id = 1)` makes the table hold
        // exactly one row, matching today's whole-blob save semantics.
        // Goonware's layout is flat (no recursive pane tree like Warp)
        // and the persisted shape is small KBs of metadata — full-blob
        // UPSERTs win on simplicity vs. normalized layout tables.
        up: r#"
            CREATE TABLE app_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                content TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
        "#,
    },
    Migration {
        version: 2,
        // Terminal block history — per-pty, per-command.
        //
        // `terminal_panes` is a registry of every pty_id we've ever
        // persisted a block for; it carries the most recent cwd we saw
        // so a fresh tab open can show a hint before the new shell
        // emits its first OSC 7. ON DELETE CASCADE on `blocks.pty_id`
        // is intentional — when the user permanently forgets a session
        // (sessionMemory.forgetSession), wiping the pty row takes the
        // history with it.
        //
        // Diverging from Warp: Warp deliberately avoids the FK from
        // blocks → pane_leaves because their snapshot-and-rewrite
        // would cascade-delete history. Goonware doesn't snapshot
        // terminal_panes; the upsert is incremental, so the cascade
        // direction we want is exactly the FK direction.
        up: r#"
            CREATE TABLE terminal_panes (
                pty_id        TEXT    PRIMARY KEY NOT NULL,
                cwd           TEXT,
                created_at    INTEGER NOT NULL,
                last_seen_at  INTEGER NOT NULL
            );

            CREATE TABLE blocks (
                -- Surrogate PK lets us ORDER BY id for stable insertion
                -- order even if the segmenter restarts its block_id
                -- counter (which it does on every term_start).
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                pty_id         TEXT    NOT NULL
                                  REFERENCES terminal_panes(pty_id)
                                  ON DELETE CASCADE,
                -- Stable monotonic id minted by the Rust segmenter at
                -- OSC 133 A. NOT unique across rows (counter restarts
                -- on session relaunch) — `id` carries true uniqueness.
                block_id       INTEGER NOT NULL,
                input          TEXT    NOT NULL,
                transcript     TEXT    NOT NULL,
                -- JSON-encoded Vec<RowSnapshot>. Text not BLOB because
                -- the renderer needs to JSON.parse() it anyway and the
                -- size win from binary is < 10% for typical output.
                block_rows     TEXT    NOT NULL,
                exit_code      INTEGER,
                cwd            TEXT,
                duration_ms    INTEGER,
                completed_at   INTEGER NOT NULL
            );

            -- (pty_id, id) covers both the load-by-pty path (history
            -- restore) and the per-pty eviction path (cap to MAX_BLOCKS).
            CREATE INDEX blocks_by_pty ON blocks (pty_id, id);
        "#,
    },
];

/// Runs every migration whose `version` exceeds `PRAGMA user_version`,
/// then bumps `user_version` to the highest applied. Each migration
/// runs in its own transaction so a failure rolls back cleanly.
pub fn run(conn: &mut Connection) -> rusqlite::Result<()> {
    let current: u32 =
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    for m in ALL.iter().filter(|m| m.version > current) {
        let tx = conn.transaction()?;
        tx.execute_batch(m.up)?;
        // `user_version` doesn't support param binding, so embed.
        tx.execute_batch(&format!("PRAGMA user_version = {}", m.version))?;
        tx.commit()?;
    }
    Ok(())
}
