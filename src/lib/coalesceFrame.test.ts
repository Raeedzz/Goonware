import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { coalesceFrame } from "./coalesceFrame";

// Drive rAF deterministically. The implementation must not rely on
// wall-clock timing; one queued rAF should fire exactly once per
// `flushRaf()` call regardless of how many `push`es preceded it.
let queue: Array<() => void> = [];
let nextId = 0;

beforeEach(() => {
  queue = [];
  nextId = 0;
  globalThis.requestAnimationFrame = ((cb: () => void) => {
    const id = ++nextId;
    queue.push(cb);
    return id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (id: number) => {
    // Mark cancelled by replacing with a noop at the matching slot.
    // We don't actually track ids here — `coalesceFrame` only calls
    // cancel for the most recently scheduled id, and the queue is
    // drained per test, so a simple "drop everything ≤ id" is fine.
    queue = queue.slice(id);
  };
});

afterEach(() => {
  queue = [];
});

function flushRaf() {
  const pending = queue;
  queue = [];
  for (const cb of pending) cb();
}

describe("coalesceFrame", () => {
  test("fires once per frame on the most recent value", () => {
    const apply = mock<(v: number) => void>(() => {});
    const c = coalesceFrame(apply);
    c.push(1);
    c.push(2);
    c.push(3);
    expect(apply).toHaveBeenCalledTimes(0);
    flushRaf();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith(3);
  });

  test("schedules a fresh rAF after a flush", () => {
    const apply = mock<(v: number) => void>(() => {});
    const c = coalesceFrame(apply);
    c.push(1);
    flushRaf();
    c.push(2);
    flushRaf();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith(2);
  });

  test("flush() fires the pending value synchronously", () => {
    const apply = mock<(v: number) => void>(() => {});
    const c = coalesceFrame(apply);
    c.push(42);
    c.flush();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith(42);
    // The scheduled rAF must have been cancelled — draining the
    // queue should not call apply a second time.
    flushRaf();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  test("flush() with no pending value is a no-op", () => {
    const apply = mock<(v: number) => void>(() => {});
    const c = coalesceFrame(apply);
    c.flush();
    expect(apply).toHaveBeenCalledTimes(0);
  });

  test("cancel() drops the pending value", () => {
    const apply = mock<(v: number) => void>(() => {});
    const c = coalesceFrame(apply);
    c.push(99);
    c.cancel();
    flushRaf();
    expect(apply).toHaveBeenCalledTimes(0);
  });

  test("falsy values still trigger apply", () => {
    const apply = mock<(v: number) => void>(() => {});
    const c = coalesceFrame(apply);
    c.push(0);
    flushRaf();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith(0);
  });
});
