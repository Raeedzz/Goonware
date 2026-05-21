import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { termResize, termStart } from "@/lib/tauri/term";
import {
  getAltScreen,
  getBellTick,
  getBlocks,
  getCwd,
  getExited,
  getLiveFrame,
  getRows,
  getScrollback,
  setAltScreen as memSetAltScreen,
  setBellTick as memSetBellTick,
  setBlocks as memSetBlocks,
  setCwd as memSetCwd,
  setExited as memSetExited,
  setLiveFrame as memSetLiveFrame,
  setRows as memSetRows,
  setScrollback as memSetScrollback,
} from "./sessionMemory";
import type {
  Block,
  ClosedBlock,
  DirtyRow,
  RenderFrame,
  Span,
} from "./types";

interface Args {
  /** Stable PTY session id — must be unique per running PTY. */
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  /** Initial size in cells. The hook re-emits term_resize on container resize. */
  rows: number;
  cols: number;
  /**
   * Active project id, forwarded to term_start so the PTY's env gets
   * `GOONWARE_PROJECT_ID` / `RLI_PROJECT_ID` set. In-pane agents (claude,
   * codex, gemini) read this to identify which project they're in.
   */
  projectId?: string;
  /** Active session id. Mirrors `GOONWARE_SESSION_ID` / `RLI_SESSION_ID` in PTY env. */
  sessionId?: string;
  /**
   * Whether this terminal is currently visible to the user (i.e. the
   * active tab in the active worktree). The TerminalKeepaliveLayer
   * pre-mounts every terminal across every worktree, so most
   * BlockTerminals are mounted but hidden behind `display: none`.
   * When hidden, we still receive frame events from the backend's
   * Channel (at the per-session 4 Hz hidden cadence set by A3), but
   * we MUST NOT call `setLiveFrame` / `setAltScreen` / etc. — those
   * trigger React commits that propagate down through CellRow /
   * FullGrid subtrees, doing real vdom work even though nothing
   * paints. With 19 hidden terminals × 4 Hz × N rows of vdom work,
   * that's the single biggest contributor to "switching feels
   * sluggish" after the keepalive layer was added.
   *
   * Behavior:
   *   - While `false`: frame events update `rowsRef` and
   *     `pendingFrameRef` in place (cheap), but no React state
   *     changes fire.
   *   - When `false → true`: schedule a flush so the freshly-
   *     visible terminal's React state catches up to whatever's
   *     in the refs in one commit.
   *   - Default `true` so callers that don't pass it (legacy /
   *     standalone uses) keep working as before.
   */
  isVisible?: boolean;
}

interface SessionApi {
  blocks: Block[];
  liveFrame: RenderFrame | null;
  altScreen: boolean;
  exited: boolean;
  /**
   * Live terminal cwd — updates as the shell emits OSC 7 `cd` reports.
   * Null until the integration script's initial `_rli_chpwd` fires.
   * Consumers should fall back to the static launch cwd while null.
   */
  cwd: string | null;
  /** Bell event counter — increments on every BEL. Frontend animates on diff. */
  bellTick: number;
  /** Submit a line + trailing \n. Used by the block-mode prompt input. */
  sendLine: (text: string) => Promise<void>;
  /** Send raw bytes (passthrough for ⌃C, alt-screen keystrokes, etc.). */
  sendBytes: (bytes: Uint8Array) => Promise<void>;
  /** Tell Rust the cell-grid size changed. */
  resize: (rows: number, cols: number) => Promise<void>;
}

const encoder = new TextEncoder();

/**
 * Lifecycle owner for one terminal session.
 *
 *   - Mount  → invoke `term_start`; listen for frame, block, alt-screen,
 *              bell, exit events.
 *   - Update → keep `liveFrame` (rolling render of in-flight rows) and
 *              `blocks` (closed-block log) in React state.
 *   - Unmount → invoke `term_close`, drop listeners.
 *
 * Frame events arrive throttled to ~60 Hz from Rust; we apply them to the
 * Map<rowIndex, Span[]> in `frameRowsRef`, then push the merged frame
 * to React state. We keep the rows in a ref to avoid re-rendering when
 * only off-screen rows change.
 */
export function useTerminalSession(opts: Args): SessionApi {
  // Hydrate from module-scoped memory so switching sessions/projects
  // doesn't wipe scrollback OR the live grid. Memory is keyed by
  // terminal id and survives the component's React lifecycle.
  const [blocks, setBlocks] = useState<Block[]>(() => getBlocks(opts.id));
  const [liveFrame, setLiveFrame] = useState<RenderFrame | null>(() =>
    getLiveFrame(opts.id),
  );
  const [altScreen, setAltScreen] = useState<boolean>(() => getAltScreen(opts.id));
  const [exited, setExited] = useState<boolean>(() => getExited(opts.id));
  const [cwd, setCwd] = useState<string | null>(() => getCwd(opts.id));
  const [bellTick, setBellTick] = useState<number>(() => getBellTick(opts.id));
  // Snapshot of every row's spans, keyed by row index. Hydrated from
  // memory so the visible grid is preserved across remounts. We then
  // mutate it in place on each frame and shallow-copy into
  // liveFrame.dirty for React. Memory holds the canonical copy.
  const rowsRef = useRef<Span[][]>(getRows(opts.id));
  // Append-only buffer of rows that have scrolled out of the visible
  // grid into PTY scrollback (oldest first). Each frame's
  // `scrollback_appended` is pushed onto the tail; `scrollback_reset`
  // wipes and replaces. Persists across remounts via session memory so
  // a tab-switch round-trip doesn't lose agent history. This is what
  // lets the user scroll back through everything the agent has written,
  // not just whatever currently fits in the PTY's visible grid.
  const scrollbackRowsRef = useRef<Span[][]>(getScrollback(opts.id));
  // Latest frame metadata (cursor + alt-screen flag).
  const lastFrameRef = useRef<RenderFrame | null>(getLiveFrame(opts.id));
  // FIFO of commands the user has submitted via sendLine but whose
  // closing OSC 133 D event hasn't arrived yet. The Rust segmenter
  // doesn't capture user input (we omit the OSC 133 B marker on
  // purpose because zsh's line editor makes the byte stream between
  // B and C unreliable), so the frontend stamps block.input from
  // this queue when each block closes.
  const pendingInputsRef = useRef<string[]>([]);
  // rAF coalescing for frame events. Rust emits frames at ~60 Hz
  // baseline but burst output (agent streaming, big paste, `cat
  // large.log`) can arrive in tighter clusters across separate
  // event-loop ticks. Without coalescing, every event triggers a
  // setState and a React commit. With it, all events landed before
  // the next paint collapse to a single commit.
  const rafIdRef = useRef<number | null>(null);
  const pendingFrameRef = useRef<RenderFrame | null>(null);

  // Mirror of the `isVisible` prop into a ref so the long-lived
  // onFrame closure inside the main effect can read the latest
  // value without re-mounting. The visibility-flip effect (right
  // below) keeps this in sync and schedules a flush on the
  // `false → true` edge.
  const isVisible = opts.isVisible ?? true;
  const isVisibleRef = useRef(isVisible);
  // Bridge into the main effect's flushFrame closure so the
  // visibility-flip effect can request a flush. The main effect
  // assigns this on each run.
  const requestFlushRef = useRef<() => void>(() => {});

  useEffect(() => {
    const wasVisible = isVisibleRef.current;
    isVisibleRef.current = isVisible;
    // On false → true, push whatever's in the refs into React state
    // so the freshly-visible terminal catches up in a single commit.
    if (isVisible && !wasVisible) {
      requestFlushRef.current();
    }
  }, [isVisible]);

  useEffect(() => {
    let cancelled = false;
    const unlisten: UnlistenFn[] = [];
    // Reset the pending-input queue for THIS effect run. The other
    // local state (rows, frame, blocks, etc.) is intentionally NOT
    // wiped — the user wants to come back to whatever the terminal
    // was showing. Hydration already happened in useState init.
    pendingInputsRef.current = [];

    const flushFrame = () => {
      rafIdRef.current = null;
      if (cancelled) return;
      // Prefer the pending frame (latest from the backend); fall
      // back to lastFrameRef so a flush triggered by visibility-flip
      // (with no new frame since hidden) still hydrates React state
      // from the cached snapshot.
      const frame = pendingFrameRef.current ?? lastFrameRef.current;
      if (!frame) return;
      pendingFrameRef.current = null;
      const rows = rowsRef.current;
      // FullGrid still expects `dirty` to contain every row it should
      // paint (legacy semantic — a true sparse path lands with the
      // canvas renderer). Build it once per rAF, not once per event.
      const allDirty: DirtyRow[] = new Array(rows.length);
      for (let i = 0; i < rows.length; i++) {
        allDirty[i] = { row: i, spans: rows[i] };
      }
      // Pack scrollback rows into the merged frame so LiveBlock /
      // CanvasGrid can concatenate them above the visible grid. The
      // array is a fresh wrapper each flush (slice) so React's identity
      // check sees a change; the inner Span[] entries stay shared with
      // scrollbackRowsRef, which is fine because they're never mutated
      // after being appended (alacritty freezes scrollback rows once
      // they leave the visible grid).
      const scrollbackRows = scrollbackRowsRef.current;
      const scrollback: DirtyRow[] = new Array(scrollbackRows.length);
      for (let i = 0; i < scrollbackRows.length; i++) {
        scrollback[i] = { row: i, spans: scrollbackRows[i] };
      }
      const merged: RenderFrame = {
        ...frame,
        dirty: allDirty,
        // Re-pack so consumers can read the canonical scrollback off
        // `liveFrame.scrollback_appended` regardless of whether the
        // backend frame carried a per-frame delta or not. The original
        // wire field semantic (delta-only) ends at the onFrame handler
        // — past that point it means "full scrollback for rendering".
        scrollback_appended: scrollback,
        scrollback_reset: false,
      };
      lastFrameRef.current = merged;
      setAltScreen(frame.alt_screen);
      memSetAltScreen(opts.id, frame.alt_screen);
      setLiveFrame(merged);
      memSetLiveFrame(opts.id, merged);
      memSetRows(opts.id, rows);
      memSetScrollback(opts.id, scrollbackRows);
    };

    // Expose the flush trigger to the outer visibility-flip effect.
    requestFlushRef.current = () => {
      if (cancelled) return;
      if (rafIdRef.current !== null) return;
      rafIdRef.current = requestAnimationFrame(flushFrame);
    };

    const onFrame = (frame: RenderFrame) => {
      if (cancelled) return;
      // Apply the dirty rows to the canonical row map immediately —
      // this is cheap (in-place writes) and keeps rowsRef coherent
      // for any synchronous reader. The expensive part — the React
      // commit — is what we defer.
      const rows = rowsRef.current;
      while (rows.length < frame.rows) rows.push([]);
      while (rows.length > frame.rows) rows.pop();
      for (const dr of frame.dirty as DirtyRow[]) {
        rows[dr.row] = dr.spans;
      }
      // Apply the per-frame scrollback delta. The backend ships rows
      // that just left the visible grid since the previous flush —
      // append them to scrollbackRowsRef in temporal order. On
      // `scrollback_reset` (term_start re-emit, or history shrunk
      // server-side via resize-evict / Ctrl+L clear-saved), drop the
      // local mirror first so we don't end up with duplicates or stale
      // rows interleaved with the fresh sync.
      const appended = frame.scrollback_appended ?? [];
      if (frame.scrollback_reset) {
        scrollbackRowsRef.current = appended.map((dr) => dr.spans);
      } else if (appended.length > 0) {
        const next = scrollbackRowsRef.current.slice();
        for (const dr of appended) next.push(dr.spans);
        scrollbackRowsRef.current = next;
      }
      // Latest frame wins. If multiple events arrive before the next
      // paint, the rAF flush sees only the most recent metadata
      // (cursor, alt-screen, command_running) — exactly what the
      // user would see anyway.
      pendingFrameRef.current = frame;
      // Visibility gate. While the terminal is hidden (its
      // BlockTerminal lives behind display:none in the keepalive
      // layer), we still update the refs above so the cached
      // grid + last-frame meta stays current — but we DO NOT
      // schedule a React commit. The setLiveFrame chain inside
      // flushFrame would otherwise force a re-render of CellRow /
      // FullGrid subtrees for every hidden terminal, doing real
      // vdom work at the backend's hidden cadence (4 Hz × N).
      // The visibility-flip effect calls requestFlushRef on
      // false → true to apply the cached state in one commit.
      if (!isVisibleRef.current) return;
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(flushFrame);
      }
    };

    const onBlock = (b: ClosedBlock) => {
      if (cancelled) return;
      // Drain one entry from the pending queue — its order is
      // guaranteed by the order in which the user pressed Enter.
      const stamped = pendingInputsRef.current.shift() ?? b.input;
      setBlocks((prev) => {
        const next = [
          ...prev,
          {
            id: `b_${Date.now().toString(36)}_${prev.length}`,
            block_id: b.block_id,
            input: stamped,
            transcript: b.transcript,
            blockRows: b.blockRows ?? [],
            exit_code: b.exit_code,
            cwd: b.cwd,
            durationMs: b.durationMs,
          },
        ];
        memSetBlocks(opts.id, next);
        return next;
      });
    };

    const onCwd = (path: string) => {
      if (cancelled) return;
      setCwd(path);
      memSetCwd(opts.id, path);
    };

    const onBell = () => {
      if (cancelled) return;
      setBellTick((n) => {
        const next = n + 1;
        memSetBellTick(opts.id, next);
        return next;
      });
    };

    const onExit = () => {
      if (cancelled) return;
      setExited(true);
      memSetExited(opts.id, true);
    };

    // Frame events flow over a dedicated Tauri Channel instead of the
    // global event bus. With 20 PTYs streaming, this saves the
    // per-event topic-name string dispatch overhead AND avoids
    // serializing through the broadcast `app.emit` path on the Rust
    // side. The channel is one-shot per BlockTerminal mount — when
    // this effect tears down, the channel is dropped and the backend's
    // next `send()` silently fails (a no-op). On remount, a new
    // channel is created and passed to term_start, which updates the
    // Session's stored channel before re-emitting the catch-up frame.
    const frameChannel = new Channel<RenderFrame>();
    frameChannel.onmessage = (frame) => onFrame(frame);

    (async () => {
      try {
        // Register the four remaining low-frequency listeners (block,
        // cwd, bell, exit) in parallel. Each `await listen()` is a
        // Tauri IPC round-trip; doing them sequentially used to cost
        // ~25–100 ms on every BlockTerminal mount before any frames
        // could land. Promise.all collapses the latency to one
        // round-trip.
        const listeners = await Promise.all([
          listen<ClosedBlock>(`term://${opts.id}/block`, (e) =>
            onBlock(e.payload),
          ),
          listen<string>(`term://${opts.id}/cwd`, (e) => onCwd(e.payload)),
          listen(`term://${opts.id}/bell`, onBell),
          listen(`term://${opts.id}/exit`, onExit),
        ]);
        if (cancelled) {
          for (const fn of listeners) fn();
          return;
        }
        for (const fn of listeners) unlisten.push(fn);

        await termStart(
          {
            id: opts.id,
            command: opts.command,
            args: opts.args ?? [],
            cwd: opts.cwd,
            rows: opts.rows,
            cols: opts.cols,
            project_id: opts.projectId,
            session_id: opts.sessionId,
          },
          frameChannel,
        );
      } catch (err) {
        // Surface as a synthetic block so the user sees the error.
        if (!cancelled) {
          setBlocks((prev) => {
            const next: Block[] = [
              ...prev,
              {
                id: `err_${Date.now().toString(36)}`,
                block_id: 0,
                input: "",
                transcript: `error starting terminal: ${String(err)}`,
                exit_code: 1,
                cwd: null,
                durationMs: null,
                // Synthetic error block has no real grid snapshot —
                // the frontend's parseAnsi fallback handles the
                // transcript display. Empty blockRows signals "no
                // pre-rendered snapshot available."
                blockRows: [],
              },
            ];
            memSetBlocks(opts.id, next);
            return next;
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      pendingFrameRef.current = null;
      for (const fn of unlisten) fn();
      // We deliberately do NOT call term_close here — the PTY needs to
      // survive a session/project switch so the user comes back to
      // their work. PTYs are torn down only when the session is
      // permanently deleted, via forgetSession() in sessionMemory.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.id, opts.command, JSON.stringify(opts.args), opts.cwd]);

  const sendBytes = async (bytes: Uint8Array) => {
    await invoke("term_input", {
      id: opts.id,
      data: Array.from(bytes),
    });
  };

  const sendLine = async (text: string) => {
    // Push to the pending queue BEFORE sending bytes — there's a real
    // (if tiny) chance the block-close event lands before this function
    // resolves on a fast machine, so the queue must be primed first.
    pendingInputsRef.current.push(text);
    const bytes = encoder.encode(text + "\n");
    await sendBytes(bytes);
  };

  const resize = async (rows: number, cols: number) => {
    await termResize(opts.id, rows, cols);
  };

  return {
    blocks,
    liveFrame,
    altScreen,
    exited,
    cwd,
    bellTick,
    sendLine,
    sendBytes,
    resize,
  };
}
