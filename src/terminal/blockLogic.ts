import { parseAnsi } from "./parseAnsi";
import type { BlockRow, Span } from "./types";
import { detectAgentCommand } from "./agentCommand";

/**
 * Pure helpers behind the closed-block render path. Lives in its own
 * file (separate from Block.tsx) so unit tests can import the logic
 * without dragging in CellRow + the rest of the React tree.
 */

/**
 * True when `input` invokes one of our known TUI agents. Strips leading
 * env-var assignments (`FOO=bar claude`) and resolves the basename so
 * wrapper paths still match. Mirrors the logic in BlockTerminal so the
 * two stay in lockstep.
 */
export function isAgentInput(input: string): boolean {
  return detectAgentCommand(input) !== null;
}

/**
 * Decide which row stream to render for a closed block.
 *
 * Order of fidelity:
 *   1. Per-block grid snapshot (`blockRows`) when present — the Warp-
 *      style replay from the Rust side, which strips trailing screen-
 *      destruction sequences so agent TUI state survives the Ctrl+C
 *      cleanup.
 *   2. `parseAnsi(transcript)` for shell blocks only — works for
 *      linear output; would produce garbage for agent redraws.
 *   3. `[]` for agent blocks without a snapshot — better an empty
 *      body than a corrupted one.
 *
 * The "Ctrl+C an agent preserves its last TUI frame" behaviour rides
 * on rule (1) firing for agent inputs. See block_logic.test.ts.
 */
export function computeClosedBlockLines(
  blockRows: BlockRow[] | undefined,
  transcript: string,
  isAgent: boolean,
): Span[][] {
  if (blockRows && blockRows.length > 0) {
    return blockRows.map((r) => r.spans);
  }
  if (isAgent) return [];
  return parseAnsi(transcript);
}
