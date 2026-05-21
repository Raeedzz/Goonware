/**
 * Per-frame coalescer for high-frequency producers (mousemove during
 * a drag, window `resize` during a window-drag, trackpad-driven
 * scroll signals, …). The consumer runs at most once per animation
 * frame on the most recent value pushed.
 *
 * Why this exists: the bundled DMG showed visible jitter while
 * dragging the splitter and resizing the window because macOS fires
 * those events well above 60 Hz (often 120 Hz on high-refresh
 * displays). Each event drove a full React commit → flex relayout →
 * CanvasGrid ResizeObserver → WebGPU backbuffer reallocation. Aligning
 * the dispatch to rAF gives the layout one chance per frame to settle
 * and matches the cadence the GPU is rendering at anyway. Warp's
 * equivalent is `Debounce<Stream>` / `Throttle<Stream>` in
 * `app/src/throttle.rs`; on the web side rAF is the natural primitive.
 *
 * `push(value)` overwrites any previously-pushed-but-unflushed value
 * — that's the whole point. `flush()` fires the pending value
 * synchronously (used on mouseup so the final drag position lands even
 * if mouseup arrives between the last rAF schedule and its fire).
 * `cancel()` drops any pending value without firing — used by useEffect
 * cleanup so a teardown mid-frame doesn't dispatch one last stale value.
 */
export interface FrameCoalescer<T> {
  push(value: T): void;
  flush(): void;
  cancel(): void;
}

export function coalesceFrame<T>(
  apply: (value: T) => void,
): FrameCoalescer<T> {
  let rafId: number | null = null;
  let pending: T | undefined;
  let hasPending = false;

  const fire = () => {
    rafId = null;
    if (!hasPending) return;
    const next = pending as T;
    pending = undefined;
    hasPending = false;
    apply(next);
  };

  return {
    push(value) {
      pending = value;
      hasPending = true;
      if (rafId === null) rafId = requestAnimationFrame(fire);
    },
    flush() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      fire();
    },
    cancel() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      pending = undefined;
      hasPending = false;
    },
  };
}
