/**
 * Design tokens for Warp-style shell command blocks. Sourced from
 * warpdotdev/warp at /tmp/warp-check (read-only mirror), specifically:
 *
 *   - app/src/settings/mod.rs:546-571   (BlockPadding "Normal" mode)
 *   - app/src/terminal/block_list_element.rs:96-180, 2352-2454
 *
 * Warp expresses block spacing in "cells" — multiples of the terminal's
 * line height. At the default UI font size and 1.5 line-height ratio,
 * one cell ≈ 19.5 px, which the constants below assume.
 *
 * The semantic CSS vars (--space-*, --surface-*, --border-*) already
 * cover most cross-block tokens. This file only exports values that
 * have no representation in the existing token system, OR pixel-locked
 * values Warp specifically calibrates.
 */

/** ~1.1 cells. Top padding of a block in Normal spacing mode. */
export const BLOCK_PADDING_TOP_PX = 21;
/** ~1.0 cells. Bottom padding. */
export const BLOCK_PADDING_BOTTOM_PX = 20;
/** ~0.19 cells. Gap between the snackbar header and the command line. */
export const BLOCK_COMMAND_TOP_PX = 4;
/** ~0.5 cells. Gap between command line and output body. */
export const BLOCK_MIDDLE_GAP_PX = 10;

/**
 * Width of the "flag pole" — the colored vertical stripe Warp paints
 * down the left edge of a failed (nonzero exit) block. Solid color,
 * no opacity. block_list_element.rs:2410-2413.
 */
export const BLOCK_FAILED_STRIPE_WIDTH_PX = 3;

/**
 * Opacity of the whole-block tint Warp lays over a failed block.
 * block_list_element.rs:2404 — `failed_block_color().with_opacity(10)`.
 */
export const BLOCK_FAILED_TINT_ALPHA = 0.1;

/**
 * Background tint when a block is hovered. Warp uses the accent
 * overlay at 60% opacity for the snackbar header band; we keep that
 * but scoped to the whole block hover as a more readable visual lift.
 */
export const BLOCK_HOVER_ALPHA = 0.04;

/** Hover-revealed action button height. block_list_element.rs:150. */
export const BLOCK_ACTION_BUTTON_HEIGHT_PX = 28;
/** Corner radius on action buttons and chips. block_list_element.rs:2086. */
export const BLOCK_ACTION_BUTTON_RADIUS_PX = 5;
/** Corner radius on the exit-code chip. block_list_element.rs:4146. */
export const BLOCK_EXIT_CHIP_RADIUS_PX = 4;
