//! Front-end-facing Tauri commands for app-state persistence.
//!
//! The actual durability story lives in [`crate::persistence`] — see
//! that module's header for the architecture. This file is just the
//! thin command surface that the front-end's `lib/persistence.ts`
//! talks to.
//!
//! ## Storage
//!
//! `~/Library/Application Support/dev.raeedz.goonware/goonware.db`
//!
//! Singleton row pattern (`app_state` table, `CHECK (id = 1)`). The
//! row holds the same JSON blob that the front-end serializes via
//! `pickPersistent`, so this layer is opaque to schema changes on the
//! front-end side. When we normalize layout into per-table windows /
//! tabs / panes, a new `Event` variant + a v2 migration drops in here
//! without touching the front-end.
//!
//! ## Why the old single-file `state.json` was replaced
//!
//! - JSON was a full-blob rewrite on every save, with no schema
//!   versioning beyond a hand-rolled `version: 2` field. WAL +
//!   transactional UPSERT in SQLite is both faster (incremental WAL
//!   appends) and crash-safer.
//! - Adding any new sub-state (terminal block history, search
//!   indexes, AI memory) required either a separate file each or a
//!   monolithic blob. The DB centralizes them under one migration
//!   chain.
//! - One-shot ingest of the legacy file happens in
//!   [`crate::persistence::init`]; the JSON is deleted after import.

use tauri::{AppHandle, Manager, Runtime};

use crate::persistence::PersistenceState;

#[tauri::command]
pub fn state_save<R: Runtime>(app: AppHandle<R>, content: String) -> Result<(), String> {
    app.state::<PersistenceState>().writer.save(content)
}

#[tauri::command]
pub fn state_load<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let state = app.state::<PersistenceState>();
    crate::persistence::load(&state.db_path)
}

#[tauri::command]
pub fn state_clear<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.state::<PersistenceState>().writer.clear()
}
