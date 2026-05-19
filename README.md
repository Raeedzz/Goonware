# GLI

**GPU-accelerated terminal for running CLI coding agents in parallel.**

No chat panel. No wrapper around your agent. Just a fast, dark workspace where every `claude` / `codex` session lives in its own git worktree, every commit can be AI-drafted, and the browser, files, and git panels are one keystroke away.

> Built with Tauri (Rust) + React/TypeScript. xterm.js + WebGL for the terminal. macOS only in v1.

---

## What it is

A native macOS app for orchestrating CLI coding agents the way you already think about them — as real terminals, isolated by branch, working in parallel. Cursor + Warp + Superhuman, ruthlessly minimal.

- **No harness, just a terminal.** Your agent runs in a real PTY with xterm.js + WebGL. Nothing in between you and the model.
- **Every agent gets its own git worktree.** Spawn five `claude` sessions on five branches and they never step on each other.
- **Live, plain-English summaries.** Every tab carries a one-line summary of what the agent is doing right now, auto-drafted when the PTY goes idle.
- **In-house browser daemon.** A headless Chrome at `127.0.0.1:4000` exposes `/screenshot`, `/navigate`, `/click`, `/type`, `/console/recent`. Faster than Chrome MCP. The same HTTP contract works from any agent terminal.
- **AI commits and AI PRs.** Stage changes, hit `⌘⏎`, get a Gemini Flash-Lite draft. `⌘⌥P` drafts a PR title + body and ships it via `gh`.
- **Highlight → ask.** Select code, press `⌘L`, get an inline answer in the margin. No side panel. No thread.
- **Per-project memory.** `rli-memory add` / `recall` from any pane. Auto-scoped to the active worktree. Multiple agents in parallel panes coordinate without a scratch file.

---

## Download

The signed macOS build lives at **[goonware.dev](https://goonware.dev)** — one click, drag to `/Applications`, done. The same DMG is served directly from GitHub at:

```
https://github.com/Raeedzz/GLI/releases/latest/download/Goonware.dmg
```

Apple Silicon and Intel are bundled into a single universal binary. First launch may show a Gatekeeper prompt while notarization rolls in.

## Build from source

**Prereqs**

- macOS (Apple Silicon or Intel)
- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- [Rust toolchain](https://rustup.rs)
- Xcode CLT — `xcode-select --install`

**Build**

```bash
git clone https://github.com/Raeedzz/GLI.git
cd GLI
bun install
bun run tauri:dev      # dev with HMR
bun run tauri:build    # production .app
```

The bundle lands at `src-tauri/target/release/bundle/macos/GLI.app`.

**First run**

1. `⌘O` — open a project folder.
2. `⌘N` — create a worktree on a fresh branch (auto-named, or use the sidebar to pick).
3. Run `claude` (or `codex`) in the pane. The tab title and branch auto-slug from your first prompt.

---

## Keyboard shortcuts

v1 keymap is fixed. No remapping.

**Projects & worktrees**

| Chord | Action |
|---|---|
| `⌘O` | Open project |
| `⌘N` | New worktree in active project |
| `⌘W` | Close active tab |
| `⌘T` | New terminal tab in active worktree |
| `⌘1`–`⌘9` | Switch to the Nth worktree (flat across projects, in sidebar order) |
| `⌘⇧1`–`⌘⇧9` | Switch to the Nth project |

**Main column tabs**

| Chord | Action |
|---|---|
| `⌘⌥1`–`⌘⌥9` | Switch to the Nth shell / editor / diff / markdown tab in the active worktree |

**Right panel**

| Chord | Action |
|---|---|
| `⌘\` | Toggle right panel |
| `⌘⌥F` | Files |
| `⌘⌥G` | Changes (git) |
| `⌘⌥B` | Browser |
| `⌘⌥P` | Auto-draft & open Create PR |

**Workspace**

| Chord | Action |
|---|---|
| `⌘B` | Toggle sidebar |
| `⌘K` / `⌘F` | Search overlay |
| `⌘⇧F` | Toggle search |
| `⌘,` | Settings |
| `Esc` | Close overlays |

**AI & git**

| Chord | Action |
|---|---|
| `⌘L` | Highlight → ask (Flash-Lite, inline answer in the margin) |
| `⌘⏎` | Commit with AI-drafted message (preview required) |
| `⌘⇧⏎` | Push (explicit only — never auto) |

---

## Per-project memory + multi-agent coordination

GLI installs `rli-memory` to `~/.local/bin/` on first launch. Inside any pane:

- `rli-memory add "<fact>"` — persist a project fact (auto-deduped).
- `rli-memory recall "<query>"` — search this project's memory.
- `rli-memory extract <file>` — LLM-extract atomic facts from a transcript.

Every PTY launches with `RLI_PROJECT_ID` / `RLI_SESSION_ID` / `RLI_MEMORY_URL` in its env, so the wrapper picks up the right project without flags. When you run several agents in parallel worktrees, this is how they share context without colliding — each pane is an isolated worktree on its own branch, but they all read and write the same project store.

The `CLAUDE.md` at the repo root tells in-pane agents about `rli-memory` and the browser daemon — drop it into projects you want agents to coordinate on.

---

## Architecture

- **Backend (Rust):** Tauri 2 host. PTY mux via `portable-pty`. fs watcher via `notify`. Git by shelling out. SQLite via `rusqlite` + `sqlite-vec` for memory. Secrets in macOS Keychain via `keyring`. Search via `rg` + `ast-grep` with `--json`. Headless Chrome managed inside `src-tauri/src/browser/`.
- **Frontend (React + TS):** xterm.js + `xterm-addon-webgl` for terminals. CodeMirror 6 for the editor. Motion (Framer) for chrome animations only — never on terminal contents or editor contents. `react-arborist` for the file tree. `dnd-kit` for tab/pane drag.
- **Two-level navigation:** Project (a folder/repo) → Worktree (a `claude` / `codex` instance on its own branch).
- **State:** All durable state in Rust + SQLite, surfaced via Tauri commands. No state hidden in components.
- **AI:** One model — `gemini-3.1-flash-lite-preview` — for commit messages, PR drafts, highlight-and-ask, tab summaries, session naming. Gemini Embedding API for memory. No local models.

See `CONTEXT.md` for the full v1 spec.

---

## Project layout

```
src/                  React + TS frontend
  shell/              AppShell, MainColumn, RightPanel, Sidebar
  terminal/           BlockTerminal, prompt input, agent activity
  editor/             CodeMirror 6 wrapper
  browser/            BrowserPane (talks to the Rust daemon)
  files/              FileTree
  git/                Diff view, commit composer
  palette/            Command palette
  state/              AppState reducer, types
  hooks/              useKeyboardShortcuts, etc.
src-tauri/            Rust backend
  src/browser/        In-house headless-Chrome daemon
  src/                Tauri commands, PTY mux, git, fs, memory
docs/                 Design notes, motion guidelines
```

---

## Storage paths (macOS)

- App data: `~/Library/Application Support/GLI/`
  - `gli.db` — SQLite (sessions, memory, settings cache)
  - `config.toml` — hand-editable settings
- Logs: `~/Library/Logs/GLI/gli.log` (rotated at 10 MB)
- Worktrees: `<project>/.rli/sessions/<slug>` (gitignored automatically)
- Secrets: macOS Keychain (Gemini API key only)

---

## Development

```bash
bun run dev           # Vite-only dev server (no Tauri shell)
bun run tauri:dev     # full app with HMR
bun run typecheck     # tsc -b
bun run test          # frontend tests (Bun)
bun run test:rs       # Rust tests
bun run test:all      # everything
```

---

## What's not in v1

Deliberate cuts to keep the surface area honest: chat panel for the agent, file-tree git status badges, LSP / IntelliSense, preset keymaps or remapping, floating windows, telemetry, cross-platform builds, Python sidecar for memory. Full list in `CONTEXT.md`.

---

## Contributing

Issues and PRs welcome. The codebase prizes:

- **Direct code over abstractions.** Three similar lines beats a premature helper.
- **No new files unless something needs them.** Edit existing modules first.
- **Animations on chrome only.** Never on terminal or editor contents.
- **Comments only when the *why* is non-obvious.** Names explain the *what*.

If you're picking up a non-trivial task, open an issue first so we can sanity-check the approach.

---

## License

[MIT](LICENSE) © Raeed M. Zainuddin
