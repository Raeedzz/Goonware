export interface NativeWheelSnapshot {
  altScreen: boolean;
  fallbackPageScroll: boolean;
  paneKey: "main" | "side" | "main2";
  ptyId: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NativeWheelEvent {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  clientX: number;
  clientY: number;
  preventDefault: () => void;
}

type FrameRequest = (callback: FrameRequestCallback) => number;
type FrameCancel = (id: number) => void;
type InvokeCommand = (
  command: string,
  payload: Record<string, unknown>,
) => Promise<unknown> | unknown;

interface NativeWheelBridgeOptions {
  getSnapshot: () => NativeWheelSnapshot;
  invokeCommand: InvokeCommand;
  requestFrame?: FrameRequest;
  cancelFrame?: FrameCancel;
}

interface TranscriptBucket {
  paneKey: NativeWheelSnapshot["paneKey"];
  x: number;
  y: number;
}

interface AltScreenBucket {
  ptyId: string;
  px: number;
  col: number;
  row: number;
  fallbackPageScroll: boolean;
}

const LINE_PX = 16;
const MAX_ALT_LINES_PER_FRAME = 6;
const CELL_WIDTH = 13 * 0.6;
const CELL_HEIGHT = 13 * 1.3;

function toPixels(delta: number, mode: number, pageSize: number): number {
  if (!Number.isFinite(delta)) return 0;
  if (mode === 1) return delta * LINE_PX;
  if (mode === 2) return delta * Math.max(1, pageSize || 400);
  return delta;
}

function clampCell(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

/**
 * One stable wheel bridge for the whole native pane.
 *
 * Normal-screen transcript deltas and alternate-screen PTY deltas are queued
 * separately and keyed by the pane/PTY that owned the event. That means a mode
 * or tab transition between the wheel event and the next animation frame can
 * never drop the gesture or deliver it to the newly-active process.
 */
export function createNativeWheelBridge({
  getSnapshot,
  invokeCommand,
  requestFrame = requestAnimationFrame,
  cancelFrame = cancelAnimationFrame,
}: NativeWheelBridgeOptions) {
  const transcript = new Map<string, TranscriptBucket>();
  const alternate = new Map<string, AltScreenBucket>();
  let frameId: number | null = null;
  let disposed = false;

  const safeInvoke = (command: string, payload: Record<string, unknown>) => {
    try {
      void Promise.resolve(invokeCommand(command, payload)).catch(() => {});
    } catch {
      // A missing native command must not break future wheel gestures.
    }
  };

  const schedule = () => {
    if (disposed || frameId !== null) return;
    frameId = requestFrame(flush);
  };

  const flush = () => {
    frameId = null;
    if (disposed) return;

    for (const bucket of transcript.values()) {
      if (bucket.y !== 0) {
        safeInvoke("term_native_scroll", {
          paneKey: bucket.paneKey,
          deltaPx: bucket.y,
        });
      }
      if (bucket.x !== 0) {
        safeInvoke("term_native_hscroll", {
          paneKey: bucket.paneKey,
          deltaPx: bucket.x,
        });
      }
    }
    transcript.clear();

    let needsAnotherFrame = false;
    for (const [ptyId, bucket] of alternate) {
      const wanted = Math.trunc(bucket.px / LINE_PX);
      if (wanted === 0) continue;
      const lines = Math.max(
        -MAX_ALT_LINES_PER_FRAME,
        Math.min(MAX_ALT_LINES_PER_FRAME, wanted),
      );
      bucket.px -= lines * LINE_PX;
      safeInvoke("term_native_wheel", {
        id: bucket.ptyId,
        deltaLines: lines,
        col: bucket.col,
        row: bucket.row,
        fallbackPageScroll: bucket.fallbackPageScroll,
      });
      if (Math.abs(bucket.px) >= LINE_PX) {
        needsAnotherFrame = true;
      } else if (bucket.px === 0) {
        alternate.delete(ptyId);
      }
    }
    if (needsAnotherFrame) schedule();
  };

  const handleWheel = (event: NativeWheelEvent) => {
    if (disposed) return;
    event.preventDefault();
    const snapshot = getSnapshot();
    const x = toPixels(event.deltaX, event.deltaMode, snapshot.width);
    const y = toPixels(event.deltaY, event.deltaMode, snapshot.height);

    if (snapshot.altScreen) {
      if (y === 0) return;
      const bucket = alternate.get(snapshot.ptyId) ?? {
        ptyId: snapshot.ptyId,
        px: 0,
        col: 1,
        row: 1,
        fallbackPageScroll: false,
      };
      bucket.px += y;
      bucket.col = clampCell((event.clientX - snapshot.left) / CELL_WIDTH + 1);
      bucket.row = clampCell((event.clientY - snapshot.top) / CELL_HEIGHT + 1);
      bucket.fallbackPageScroll =
        bucket.fallbackPageScroll || snapshot.fallbackPageScroll;
      alternate.set(snapshot.ptyId, bucket);
    } else {
      const bucket = transcript.get(snapshot.paneKey) ?? {
        paneKey: snapshot.paneKey,
        x: 0,
        y: 0,
      };
      bucket.x += x;
      bucket.y += y;
      transcript.set(snapshot.paneKey, bucket);
    }
    schedule();
  };

  const dispose = () => {
    disposed = true;
    if (frameId !== null) cancelFrame(frameId);
    frameId = null;
    transcript.clear();
    alternate.clear();
  };

  return { handleWheel, dispose };
}
