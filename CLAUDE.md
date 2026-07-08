# RLI capabilities (for in-pane agents)

You are running inside an RLI terminal pane. Use these.

## Memory — `rli-memory`

Per-project persistent memory. Auto-scoped via `$RLI_PROJECT_ID`.

- `rli-memory recall "<query>"` — search facts before answering project questions.
- `rli-memory add "<fact>"` — store a fact you discover. Dedupes automatically.

## Multi-agent tips

You may be one of several agents running in parallel panes of the same project.

- Coordinate via `rli-memory`, not scratch files — every agent reads the same store.
- Each pane has its own PTY and cwd; assume your peers cannot see your shell state.
- Before starting work, `rli-memory recall` for prior decisions. After finishing, `add` what's worth keeping.
- Distinguish your work from peers by checking the git branch (sessions are isolated worktrees).
