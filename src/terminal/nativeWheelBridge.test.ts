import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createNativeWheelBridge,
  type NativeWheelSnapshot,
} from "./nativeWheelBridge";

function harness(initial: Partial<NativeWheelSnapshot> = {}) {
  let snapshot: NativeWheelSnapshot = {
    altScreen: false,
    fallbackPageScroll: false,
    paneKey: "main",
    ptyId: "pty-a",
    left: 10,
    top: 20,
    width: 800,
    height: 600,
    ...initial,
  };
  const calls: Array<[string, Record<string, unknown>]> = [];
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  let prevented = 0;
  const bridge = createNativeWheelBridge({
    getSnapshot: () => snapshot,
    invokeCommand: (command, payload) => calls.push([command, payload]),
    requestFrame: (callback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
  });
  const wheel = (deltaY: number, extra: Partial<Parameters<typeof bridge.handleWheel>[0]> = {}) => {
    bridge.handleWheel({
      deltaX: 0,
      deltaY,
      deltaMode: 0,
      clientX: 88,
      clientY: 121,
      preventDefault: () => {
        prevented += 1;
      },
      ...extra,
    });
  };
  const runFrame = () => {
    const entry = frames.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    if (!entry) return false;
    frames.delete(entry[0]);
    entry[1](0);
    return true;
  };
  return {
    bridge,
    calls,
    frames,
    wheel,
    runFrame,
    prevented: () => prevented,
    setSnapshot: (patch: Partial<NativeWheelSnapshot>) => {
      snapshot = { ...snapshot, ...patch };
    },
  };
}

describe("createNativeWheelBridge", () => {
  test("BlockTerminal keeps one stable pane-level wheel listener", () => {
    const source = readFileSync(
      new URL("./BlockTerminal.tsx", import.meta.url),
      "utf8",
    );
    expect(source.match(/addEventListener\("wheel"/g)).toHaveLength(1);
    expect(source.match(/createNativeWheelBridge\(/g)).toHaveLength(1);
    expect(source).toContain(
      'containerRef.current;\n    if (!el || !nativeActive) return;',
    );
    expect(source).not.toContain("<AgentChrome");
    expect(source).not.toContain('from "./AgentChrome"');
    expect(source).toContain(
      "focusTerminalInput();\n      e.preventDefault();",
    );
  });

  test("coalesces transcript wheel bursts and normalizes line/page deltas", () => {
    const h = harness();
    h.wheel(2, { deltaMode: 1, deltaX: 3 });
    h.wheel(0.5, { deltaMode: 2 });
    expect(h.frames.size).toBe(1);
    h.runFrame();
    expect(h.calls).toEqual([
      ["term_native_scroll", { paneKey: "main", deltaPx: 332 }],
      ["term_native_hscroll", { paneKey: "main", deltaPx: 48 }],
    ]);
    expect(h.prevented()).toBe(2);
  });

  test("accumulates tiny trackpad deltas until an alt-screen line is real", () => {
    const h = harness({ altScreen: true });
    for (let i = 0; i < 4; i += 1) {
      h.wheel(4);
      h.runFrame();
    }
    expect(h.calls).toEqual([
      [
        "term_native_wheel",
        {
          id: "pty-a",
          deltaLines: 1,
          col: 11,
          row: 6,
          fallbackPageScroll: false,
        },
      ],
    ]);
  });

  test("keeps pre-transition transcript and post-transition alt-screen events", () => {
    const h = harness();
    h.wheel(-30);
    h.setSnapshot({ altScreen: true, ptyId: "pty-b" });
    h.wheel(-32);
    h.runFrame();
    expect(h.calls).toEqual([
      ["term_native_scroll", { paneKey: "main", deltaPx: -30 }],
      [
        "term_native_wheel",
        {
          id: "pty-b",
          deltaLines: -2,
          col: 11,
          row: 6,
          fallbackPageScroll: false,
        },
      ],
    ]);
  });

  test("keys queued work by pane and PTY so tab switches cannot misroute it", () => {
    const h = harness();
    h.wheel(20);
    h.setSnapshot({ paneKey: "main2" });
    h.wheel(30);
    h.setSnapshot({ altScreen: true, ptyId: "pty-a" });
    h.wheel(16);
    h.setSnapshot({ ptyId: "pty-b" });
    h.wheel(-16);
    h.runFrame();
    expect(h.calls.map(([command, payload]) => [command, payload.paneKey ?? payload.id])).toEqual([
      ["term_native_scroll", "main"],
      ["term_native_scroll", "main2"],
      ["term_native_wheel", "pty-a"],
      ["term_native_wheel", "pty-b"],
    ]);
  });

  test("caps fast alt-screen flicks and drains them over later frames", () => {
    const h = harness({ altScreen: true });
    h.wheel(16 * 14);
    while (h.runFrame()) {
      // Drain scheduled momentum frames.
    }
    expect(h.calls.map(([, payload]) => payload.deltaLines)).toEqual([6, 6, 2]);
  });

  test("requests the safe page fallback when the pane enables it", () => {
    const h = harness({ altScreen: true, fallbackPageScroll: true });
    h.wheel(-16);
    h.runFrame();
    expect(h.calls[0]?.[1].fallbackPageScroll).toBe(true);
  });

  test("survives synchronous and asynchronous native invoke failures", async () => {
    let count = 0;
    const frames: FrameRequestCallback[] = [];
    const bridge = createNativeWheelBridge({
      getSnapshot: () => ({
        altScreen: false,
        fallbackPageScroll: false,
        paneKey: "main",
        ptyId: "pty",
        left: 0,
        top: 0,
        width: 100,
        height: 100,
      }),
      invokeCommand: () => {
        count += 1;
        if (count === 1) throw new Error("sync failure");
        return Promise.reject(new Error("async failure"));
      },
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: () => {},
    });
    const event = {
      deltaX: 2,
      deltaY: 2,
      deltaMode: 0,
      clientX: 0,
      clientY: 0,
      preventDefault: () => {},
    };
    bridge.handleWheel(event);
    frames.shift()?.(0);
    await Promise.resolve();
    bridge.handleWheel(event);
    frames.shift()?.(0);
    await Promise.resolve();
    expect(count).toBe(4);
  });

  test("dispose cancels queued work and ignores later events", () => {
    const h = harness();
    h.wheel(100);
    h.bridge.dispose();
    h.wheel(100);
    expect(h.frames.size).toBe(0);
    expect(h.calls).toEqual([]);
  });
});
