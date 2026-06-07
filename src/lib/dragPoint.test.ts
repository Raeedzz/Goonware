import { afterEach, describe, expect, test } from "bun:test";
import { toLogicalDragPoint } from "./dragPoint";

/**
 * Locks the macOS drag-drop coordinate fix. The bug: Tauri reports the
 * drag position in logical points on macOS, but the code divided by
 * devicePixelRatio (correct only for physical pixels), halving the
 * coords on Retina — so right-hand file-tree drops fell into the
 * center terminal. `toLogicalDragPoint` must leave in-viewport (already
 * logical) values alone and only scale genuine physical overshoots.
 */

function stubWindow(dpr: number, w: number, h: number) {
  (globalThis as { window?: unknown }).window = {
    devicePixelRatio: dpr,
    innerWidth: w,
    innerHeight: h,
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("toLogicalDragPoint", () => {
  test("dpr=1: returns coords unchanged", () => {
    stubWindow(1, 1440, 900);
    expect(toLogicalDragPoint(1300, 400)).toEqual({ x: 1300, y: 400 });
  });

  test("Retina + in-viewport (logical) coords are left as-is — the macOS case", () => {
    // 1300 < innerWidth 1440 → already logical, must NOT be halved
    // (halving → 650 would land in the center terminal, the bug).
    stubWindow(2, 1440, 900);
    expect(toLogicalDragPoint(1300, 400)).toEqual({ x: 1300, y: 400 });
  });

  test("Retina + out-of-viewport (physical) coords scale down by dpr", () => {
    // 2600 > innerWidth 1440 → a genuine physical report → /2 = 1300.
    stubWindow(2, 1440, 900);
    expect(toLogicalDragPoint(2600, 1600)).toEqual({ x: 1300, y: 800 });
  });

  test("either axis overshooting triggers the physical scale-down", () => {
    stubWindow(2, 1440, 900);
    // x in-bounds but y overshoots → still treated as physical.
    expect(toLogicalDragPoint(400, 1700)).toEqual({ x: 200, y: 850 });
  });
});
