import { beforeAll, describe, expect, test } from "bun:test";

// The Tauri `Channel<T>` constructor calls
// `window.__TAURI_INTERNALS__.transformCallback(...)` at construction
// time to mint an IPC id. There's no window in `bun test` (it runs
// under Node-style globals), so we stub the bridge with the minimum
// surface the constructor uses. The stub returns a synthetic numeric
// id; nothing in these wire-format tests cares what the value is.
beforeAll(() => {
  (
    globalThis as unknown as {
      window: { __TAURI_INTERNALS__: { transformCallback: () => number } };
    }
  ).window = {
    __TAURI_INTERNALS__: {
      transformCallback: () => 0,
    },
  };
});

import { Channel } from "@tauri-apps/api/core";

import { buildTermStartPayload, type TermStartArgs } from "./term";
import type { RenderFrame } from "@/terminal/types";

/**
 * Wire-format guards for the `term_start` invoke payload.
 *
 * The bug these tests guard against: Tauri's `#[tauri::command]`
 * macro defaults to `ArgumentCase::Camel`, which converts every
 * snake_case Rust parameter name to camelCase for the JS-side
 * lookup. A Rust param named `frame_channel: Channel<RenderFrame>`
 * therefore expects a JS payload key named `frameChannel`. Sending
 * `frame_channel` instead produces the exact runtime error:
 *
 *     invalid args `frameChannel` for command `term_start`:
 *     command term_start missing required key frameChannel
 *
 * Because `Channel<T>` is not a Deserialize struct field — it's a
 * `CommandArg` — the standard Rust-side deserialization tests in
 * `term.rs` can't catch a key-name regression here. These TS-level
 * unit tests are the only mechanical guard.
 */

const SAMPLE_ARGS: TermStartArgs = {
  id: "pty_test",
  command: "zsh",
  args: ["-l"],
  cwd: "/tmp/goonware-test",
  rows: 24,
  cols: 80,
  project_id: "p_test",
  session_id: "s_test",
};

describe("buildTermStartPayload", () => {
  test("emits the channel at top level under the camelCase key `frameChannel`", () => {
    const channel = new Channel<RenderFrame>();
    const payload = buildTermStartPayload(SAMPLE_ARGS, channel);
    expect(payload).toHaveProperty("frameChannel");
    expect(payload.frameChannel).toBe(channel);
  });

  test("does NOT emit a snake_case `frame_channel` key", () => {
    const channel = new Channel<RenderFrame>();
    const payload = buildTermStartPayload(SAMPLE_ARGS, channel);
    // If a future refactor mistakenly switches to snake_case, this
    // assertion catches it before the IPC contract breaks at runtime.
    expect(payload).not.toHaveProperty("frame_channel");
  });

  test("nests every StartArgs field inside the `args` object verbatim", () => {
    // The fields INSIDE `args` flow through serde's default
    // deserialization for the Rust `StartArgs` struct — that struct
    // has no `rename_all` attribute, so the JSON keys must match
    // the Rust field names byte-for-byte (i.e. snake_case where
    // present). This test pins each one so a careless camelCase
    // rename ("projectId" instead of "project_id") would fail loudly.
    const channel = new Channel<RenderFrame>();
    const payload = buildTermStartPayload(SAMPLE_ARGS, channel);
    expect(payload.args).toEqual(SAMPLE_ARGS);
    expect(payload.args).toHaveProperty("project_id");
    expect(payload.args).toHaveProperty("session_id");
    expect(payload.args).not.toHaveProperty("projectId");
    expect(payload.args).not.toHaveProperty("sessionId");
  });

  test("payload has exactly two top-level keys (`args` and `frameChannel`)", () => {
    // Any third key would be a sign of accidental drift — e.g.
    // someone adding both a camelCase and snake_case variant
    // "for safety". The Rust signature has exactly two non-injected
    // params (`args`, `frame_channel`), so the JS payload must too.
    const channel = new Channel<RenderFrame>();
    const payload = buildTermStartPayload(SAMPLE_ARGS, channel);
    expect(Object.keys(payload).sort()).toEqual(["args", "frameChannel"]);
  });
});
