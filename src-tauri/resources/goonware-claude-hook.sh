#!/bin/bash
# Goonware Hook — forwards Claude Code events to Goonware app via Unix socket.
# Installed and managed by Goonware; safe to remove (Goonware re-installs on next launch).

SOCKET_PATH="/tmp/goonware-agent.sock"

# Exit silently if socket doesn't exist (Goonware not running).
[ -S "$SOCKET_PATH" ] || exit 0

# Skip helper-agent invocations entirely. Goonware's helper_agent spawns
# `claude --print` (and the equivalents for codex / gemini) for things
# like commit-message drafting and PR descriptions; those one-shot
# runs aren't user-initiated turns, so they must not light the
# worktree spinner. The Rust spawn site sets this env var; bash
# inherits it into the agent CLI's hook subprocess.
[ -n "${GOONWARE_HELPER_AGENT}${GLI_HELPER_AGENT}" ] && exit 0

# Skip events from agents NOT running inside a Goonware PTY. The hook
# script is installed globally (~/.claude/settings.json), so it fires
# for every Claude invocation on the machine — including ones launched
# from Warp, iTerm, the bare Terminal app, etc. Goonware injects
# GOONWARE_SESSION_ID into every PTY it spawns; if neither it nor the
# legacy GLI_SESSION_ID / RLI_SESSION_ID is present, the agent isn't
# running under Goonware and its state must not move the worktree
# spinner.
GOONWARE_SID="${GOONWARE_SESSION_ID:-${GLI_SESSION_ID:-$RLI_SESSION_ID}}"
[ -z "$GOONWARE_SID" ] && exit 0

# Forward stdin JSON to the socket. CRITICAL: we use `python3 -c "..."`
# (inline string), NOT a heredoc — a heredoc replaces python's own
# stdin with the heredoc body, leaving NO stdin for the actual hook
# payload, so `json.load(sys.stdin)` reads empty and the script no-ops.
# Notchi uses the same `-c` form; we match it.
#
# We also walk up the parent process tree looking for `claude` and
# stash that PID on the envelope. The Rust side runs a 2-second
# liveness watchdog that synthesizes SessionEnd when the agent PID
# vanishes — without this, a hard-killed Claude (Ctrl+C double-tap,
# terminal crash, OOM kill) leaves its SessionRecord stuck at
# `working` forever, and the worktree spinner keeps spinning even
# though the agent is gone.
/usr/bin/python3 -c "
import json, os, socket, subprocess, sys

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)

def process_table():
    try:
        ps_output = subprocess.check_output(
            ['/bin/ps', '-axo', 'pid=,ppid=,comm='],
            text=True,
            timeout=0.5,
        )
    except Exception:
        return {}
    table = {}
    for line in ps_output.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) < 3 or not parts[0].isdigit() or not parts[1].isdigit():
            continue
        table[int(parts[0])] = {
            'ppid': int(parts[1]),
            'command': os.path.basename(parts[2]).lower(),
        }
    return table

def agent_pid():
    # Walk up from our parent. The shell hook runs as a child of the
    # claude process, so the nearest ancestor whose comm contains
    # 'claude' is what we want to watch for liveness.
    processes = process_table()
    pid = os.getppid()
    visited = set()
    for _ in range(8):
        if pid in visited:
            break
        visited.add(pid)
        info = processes.get(pid)
        if info is None:
            break
        if 'claude' in info['command']:
            return pid
        if info['ppid'] <= 1 or info['ppid'] == pid:
            break
        pid = info['ppid']
    return None

# Forward a flat envelope. The 'aux' field carries the event's
# sub-classifier — today only Notification needs one (its
# notification_type field, e.g. idle_prompt / permission_prompt).
# The Rust side uses (event, aux) together to derive status.
#
# 'prompt' carries the user's typed text for UserPromptSubmit
# events. We capture it here (the hook runs inside Claude's process
# tree, so it can read the payload that Claude already piped to
# stdin) and forward it to Goonware's tab-subtitle summarizer — which
# means Goonware never has to read ~/.claude/projects/*.jsonl to learn
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
    'goonware_session_id': '$GOONWARE_SID',
}

pid = agent_pid()
if pid is not None:
    # Generic wire name shared with codex / gemini hooks. The Rust
    # side feeds every session that carries this field into a single
    # 2-second liveness watchdog.
    out['agent_process_id'] = pid

try:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(0.5)
    sock.connect('$SOCKET_PATH')
    sock.sendall(json.dumps(out).encode())
    sock.close()
except Exception:
    pass
"
