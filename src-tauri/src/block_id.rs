//! Stable identifiers for terminal blocks.
//!
//! Ports Warp's `BlockId` + `BlockIndex` split from
//! `crates/warp_terminal/src/model/block_id.rs` and `block_index.rs`.
//!
//! Two concerns, deliberately decoupled:
//!
//!   * `BlockId`     — globally unique stable identifier. Survives
//!                     reordering, filtering, and serialization. Two
//!                     construction forms:
//!                       - `{session_id}-{num}` from the shell's precmd
//!                         hook (a monotonic counter incremented per
//!                         prompt). Cheap — no UUID generation in the
//!                         shell bootstrap path, which runs around
//!                         every prompt.
//!                       - `manual-{uuid}` for blocks the app creates
//!                         out-of-band (synthetic blocks, error
//!                         placeholders, …).
//!   * `BlockIndex`  — ordinal position in the current block list. A
//!                     plain `usize` wrapper. Useful for sequence
//!                     iteration and arithmetic; meaningless across
//!                     sessions because blocks can be evicted.
//!
//! Goonware's existing `term.rs` uses raw `u64` for the "active block id"
//! (in the per-prompt counter sense). This module introduces the
//! richer typed shape for use by future code paths; the legacy `u64`
//! stays alive until the FlatStorage wiring is in place.

#![allow(dead_code)]

use std::fmt;

use serde::{Deserialize, Serialize};

/// Globally-unique block identifier. Wraps a `String` rather than
/// holding a discriminated enum so wire formats stay friendly to JSON
/// + TypeScript consumers — frontends compare BlockIds as opaque
/// strings.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BlockId(String);

impl BlockId {
    /// Build a precmd-style id: `{session_id}-{num}`. Used by the
    /// shell integration's preexec hook — the shell hands us a
    /// monotonic counter so we avoid generating UUIDs in the
    /// per-prompt path.
    pub fn from_precmd(session_id: &str, num: u64) -> Self {
        Self(format!("{session_id}-{num}"))
    }

    /// Build a synthetic id for blocks the app itself manufactures
    /// (placeholders, error envelopes, etc). Prefixed `manual-` so
    /// downstream parsing can tell precmd ids from synthetic ones
    /// without a second metadata field.
    pub fn manual() -> Self {
        Self(format!("manual-{}", uuid::Uuid::new_v4()))
    }

    /// True iff this id was produced by `manual()` rather than coming
    /// from a shell prompt. Useful when surfacing block lineage to
    /// the UI (synthetic blocks may want a different chrome).
    pub fn is_manual(&self) -> bool {
        self.0.starts_with("manual-")
    }

    /// Raw string view. Consumers shouldn't reach for the inner
    /// String — prefer comparing whole BlockIds — but the wire layer
    /// needs it for JSON serialisation outside of serde.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for BlockId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Ordinal position of a block in the current block list. Cheap
/// arithmetic + iteration. Decoupled from `BlockId` so the
/// underlying block list can reorder / evict / filter without
/// invalidating stable ids.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BlockIndex(pub usize);

impl BlockIndex {
    pub const ZERO: Self = Self(0);

    pub fn next(self) -> Self {
        Self(self.0 + 1)
    }

    pub fn checked_prev(self) -> Option<Self> {
        self.0.checked_sub(1).map(Self)
    }

    /// Inclusive range iterator over `self ..= other`. Empty when
    /// `self > other` so callers can use `range_to` without
    /// pre-checking order.
    pub fn range_to(self, other: Self) -> impl Iterator<Item = Self> {
        let start = self.0.min(other.0);
        let end = self.0.max(other.0);
        (start..=end).map(Self)
    }
}

impl fmt::Display for BlockIndex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn precmd_id_format() {
        let id = BlockId::from_precmd("session-abc", 7);
        assert_eq!(id.as_str(), "session-abc-7");
        assert!(!id.is_manual());
    }

    #[test]
    fn manual_id_carries_prefix() {
        let id = BlockId::manual();
        assert!(id.is_manual());
        assert!(id.as_str().starts_with("manual-"));
        // UUIDs are 36 chars; "manual-" is 7 → 43 total.
        assert_eq!(id.as_str().len(), 7 + 36);
    }

    #[test]
    fn manual_ids_are_unique() {
        let a = BlockId::manual();
        let b = BlockId::manual();
        assert_ne!(a, b);
    }

    #[test]
    fn block_index_arithmetic() {
        let z = BlockIndex::ZERO;
        let one = z.next();
        assert_eq!(one.0, 1);
        assert_eq!(one.checked_prev(), Some(z));
        assert_eq!(z.checked_prev(), None);
    }

    #[test]
    fn block_index_range_to_works_either_direction() {
        let a = BlockIndex(2);
        let b = BlockIndex(5);
        let fwd: Vec<_> = a.range_to(b).collect();
        let bwd: Vec<_> = b.range_to(a).collect();
        assert_eq!(fwd.len(), 4);
        assert_eq!(bwd.len(), 4);
        assert_eq!(fwd, bwd);
    }

    #[test]
    fn block_id_serde_is_transparent_string() {
        let id = BlockId::from_precmd("sess", 42);
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, "\"sess-42\"");
        let parsed: BlockId = serde_json::from_str("\"sess-42\"").unwrap();
        assert_eq!(parsed, id);
    }
}
