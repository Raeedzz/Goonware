#!/bin/bash
# GLI Hook — forwards Claude Code events to GLI app via Unix socket.
# Installed and managed by GLI; safe to remove (GLI re-installs on next launch).

SOCKET_PATH="/tmp/gli-agent.sock"

# Exit silently if socket doesn't exist (GLI not running).
[ -S "$SOCKET_PATH" ] || exit 0

# Skip helper-agent invocations entirely. GLI's helper_agent spawns
# `claude --print` (and the equivalents for codex / gemini) for things
# like commit-message drafting and PR descriptions; those one-shot
# runs aren't user-initiated turns, so they must not light the
# worktree spinner. The Rust spawn site sets this env var; bash
# inherits it into the agent CLI's hook subprocess.
[ -n "$GLI_HELPER_AGENT" ] && exit 0

# Skip events from agents NOT running inside a GLI PTY. The hook
# script is installed globally (~/.claude/settings.json), so it fires
# for every Claude invocation on the machine — including ones launched
# from Warp, iTerm, the bare Terminal app, etc. GLI injects
# GLI_SESSION_ID into every PTY it spawns; if neither it nor the
# legacy RLI_SESSION_ID is present, the agent isn't running under GLI
# and its state must not move the worktree spinner.
GLI_SID="${GLI_SESSION_ID:-$RLI_SESSION_ID}"
[ -z "$GLI_SID" ] && exit 0

# Forward stdin JSON to the socket. CRITICAL: we use `python3 -c "..."`
# (inline string), NOT a heredoc — a heredoc replaces python's own
# stdin with the heredoc body, leaving NO stdin for the actual hook
# payload, so `json.load(sys.stdin)` reads empty and the script no-ops.
# Notchi uses the same `-c` form; we match it.
/usr/bin/python3 -c "
import json, socket, sys

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)

# Forward a flat envelope. The 'aux' field carries the event's
# sub-classifier — today only Notification needs one (its
# notification_type field, e.g. idle_prompt / permission_prompt).
# The Rust side uses (event, aux) together to derive status.
#
# 'prompt' carries the user's typed text for UserPromptSubmit
# events. We capture it here (the hook runs inside Claude's process
# tree, so it can read the payload that Claude already piped to
# stdin) and forward it to GLI's tab-subtitle summarizer — which
# means GLI never has to read ~/.claude/projects/*.jsonl to learn
# what the user is working on, avoiding the App Data Isolation
# prompt that fires for every fresh transcript file.
out = {
    'provider': 'claude',
    'session_id': payload.get('session_id', ''),
    'transcript_path': payload.get('transcript_path', ''),
    'cwd': payload.get('cwd', ''),
    'event': payload.get('hook_event_name', ''),
    'tool': payload.get('tool_name', ''),
    'tool_use_id': payload.get('tool_use_id', ''),
    'permission_mode': payload.get('permission_mode', 'default'),
    'aux': payload.get('notification_type', ''),
    'prompt': payload.get('prompt', '') or '',
    'gli_session_id': '$GLI_SID',
}

try:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(0.5)
    sock.connect('$SOCKET_PATH')
    sock.sendall(json.dumps(out).encode())
    sock.close()
except Exception:
    pass
"
