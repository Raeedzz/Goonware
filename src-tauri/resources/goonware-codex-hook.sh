#!/bin/bash
# Goonware Hook — forwards OpenAI Codex CLI events to Goonware via Unix socket.
# Installed and managed by Goonware; safe to remove (Goonware re-installs on next launch).

SOCKET_PATH="/tmp/goonware-agent.sock"

# Exit silently if socket doesn't exist (Goonware not running).
[ -S "$SOCKET_PATH" ] || exit 0

# Skip helper-agent invocations — see goonware-claude-hook.sh for rationale.
[ -n "${GOONWARE_HELPER_AGENT}${GLI_HELPER_AGENT}" ] && exit 0

# Skip agents running outside Goonware — see goonware-claude-hook.sh for rationale.
GOONWARE_SID="${GOONWARE_SESSION_ID:-${GLI_SESSION_ID:-$RLI_SESSION_ID}}"
[ -z "$GOONWARE_SID" ] && exit 0

# Codex's hook protocol is similar to Claude's but emits fewer events
# (only SessionStart / UserPromptSubmit / Stop are reliably wired).
# That means we have no SessionEnd signal — the Rust side compensates
# with PID-based liveness monitoring, for which it needs the codex
# process id. We walk up the parent process tree looking for "codex"
# so the Rust side has a PID to watch.
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

def codex_pid():
    # Walk up from our parent. The shell hook runs as a child of the
    # codex process, so the nearest ancestor whose comm contains
    # 'codex' is what we want to watch for liveness.
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
        if 'codex' in info['command']:
            return pid
        if info['ppid'] <= 1 or info['ppid'] == pid:
            break
        pid = info['ppid']
    return None

out = {
    'provider': 'codex',
    'session_id': payload.get('session_id', ''),
    'transcript_path': payload.get('transcript_path', ''),
    'cwd': payload.get('cwd', ''),
    'event': payload.get('hook_event_name', ''),
    'tool': payload.get('tool_name', ''),
    'aux': '',
    'goonware_session_id': '$GOONWARE_SID',
}

pid = codex_pid()
if pid is not None:
    out['codex_process_id'] = pid

try:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(0.5)
    sock.connect('$SOCKET_PATH')
    sock.sendall(json.dumps(out).encode())
    sock.close()
except Exception:
    pass
"
