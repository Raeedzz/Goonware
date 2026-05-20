/**
 * Tauri IPC wrappers for the `term::*` commands.
 *
 * Centralizing every `invoke("term_*")` call here is the only way to
 * prevent the JS-Rust wire format from drifting silently. The
 * `term::StartArgs` Rust struct uses snake_case field names, and the
 * `term_start` Tauri command takes the frame channel as a top-level
 * argument (because `tauri::ipc::Channel<T>` is a `CommandArg`, not
 * a Deserialize struct field). Both of those are easy to get wrong
 * in an ad-hoc invoke call — and the failure mode is a runtime
 * "missing required key" error that only surfaces when the terminal
 * actually tries to start.
 *
 * Pinning the call shape in one typed function means a wire-format
 * mismatch is a compile error, not a runtime crash. The shape is
 * mirrored on the Rust side by a unit test in `term.rs` that
 * deserializes a hand-built JSON payload into `StartArgs` — see
 * `term_start_args_match_frontend_wire_format`.
 */
import { Channel, invoke } from "@tauri-apps/api/core";

import type { RenderFrame } from "@/terminal/types";

/**
 * Arguments matching the Rust `term::StartArgs` struct. Field names
 * use snake_case to match the Rust struct's default serde naming —
 * the JSON keys on the wire have to match exactly, no camelCase
 * conversion happens for fields nested inside the `args` value.
 *
 * If you add a field on the Rust side, add it here AND update the
 * `term_start_args_match_frontend_wire_format` Rust test in
 * `src-tauri/src/term.rs`.
 */
export interface TermStartArgs {
  id: string;
  command: string;
  args: string[];
  cwd?: string;
  rows: number;
  cols: number;
  project_id?: string;
  session_id?: string;
}

/**
 * Build the exact JSON payload `invoke("term_start", ...)` sends.
 * Factored out from `termStart` so a unit test can pin the wire
 * shape without needing Tauri's IPC bridge available — see
 * `term.test.ts` in the same directory.
 *
 * `frameChannel` is sent as a TOP-LEVEL invoke argument, NOT inside
 * `args`. Tauri's `Channel<T>` is implemented as a `CommandArg`, so
 * it has to live at the same level as `args`.
 *
 * The wire key uses **camelCase** (`frameChannel`), NOT the snake_case
 * Rust parameter name. Tauri's `#[tauri::command]` macro defaults to
 * `ArgumentCase::Camel` and converts every snake_case Rust param
 * name to camelCase for the JS lookup — so a Rust signature like
 * `frame_channel: Channel<RenderFrame>` becomes a required JS key
 * named `frameChannel`. Sending `frame_channel` instead yields the
 * exact runtime error this comment exists to prevent:
 *
 *     invalid args `frameChannel` for command `term_start`:
 *     command term_start missing required key frameChannel
 *
 * (Verified via the Tauri source: `tauri-macros/src/command/wrapper.rs`
 * branches on `ArgumentCase::Camel` and calls `to_lower_camel_case()`
 * on every param name before populating `CommandItem::key`.)
 *
 * The fields INSIDE `args` are different — those flow through serde's
 * default deserialization for `StartArgs`, which keeps snake_case
 * keys unless explicitly renamed. Hence `project_id` / `session_id`
 * stay snake_case here while `frameChannel` is camelCase.
 */
export function buildTermStartPayload(
  args: TermStartArgs,
  frameChannel: Channel<RenderFrame>,
): { args: TermStartArgs; frameChannel: Channel<RenderFrame> } {
  return { args, frameChannel };
}

/**
 * Start (or re-attach to) a PTY session. See `buildTermStartPayload`
 * for the wire-format details.
 */
export async function termStart(
  args: TermStartArgs,
  frameChannel: Channel<RenderFrame>,
): Promise<void> {
  await invoke("term_start", buildTermStartPayload(args, frameChannel));
}

/**
 * Forward keystrokes / bytes into a PTY's stdin. Used by both
 * PromptInput (line-mode submissions) and PtyPassthrough (raw key
 * pipe for agent TUIs).
 */
export async function termInput(id: string, data: Uint8Array): Promise<void> {
  await invoke("term_input", {
    id,
    data: Array.from(data),
  });
}

/**
 * Update a PTY's terminal dimensions. Bookkept on the Rust side so
 * repeated calls with the same dimensions are no-ops.
 */
export async function termResize(
  id: string,
  rows: number,
  cols: number,
): Promise<void> {
  await invoke("term_resize", { id, rows, cols });
}

/**
 * Force-clear alacritty's grid and the snapshot baseline so the next
 * frame lands as a full repaint of an empty grid. Used right before
 * starting a new agent (claude / codex / aider) so any leftover
 * cells from the previous foreground process can't ghost through
 * the new agent's banner — covers the "Ctrl+C → type claude → new
 * claude doesn't show up properly" race that beats OSC 133's own
 * clear path on flaky integration setups.
 *
 * Safe to call between commands; a no-op on shells with nothing to
 * clear. The bytes go through alacritty's parser, NOT the PTY
 * writer — zsh never sees them.
 */
export async function termResetGrid(id: string): Promise<void> {
  await invoke("term_reset_grid", { id });
}

/**
 * Hand the backend the set of PTY ids currently visible in the UI.
 * The backend uses this to throttle hidden sessions from 60 Hz down
 * to 4 Hz so backgrounded agents don't burn the IPC bus.
 */
export async function termSetVisibleSet(ids: string[]): Promise<void> {
  await invoke("term_set_visible_set", { ids });
}
