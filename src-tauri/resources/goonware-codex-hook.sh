#!/bin/bash
# Goonware Hook — forwards OpenAI Codex CLI events to Goonware via Unix socket.
# Installed and managed by Goonware; safe to remove (Goonware re-installs on next launch).

# Exit silently if no Goonware instance is listening. Each running Goonware
# binds its OWN /tmp/goonware-agent-<pid>.sock and the python block fans every
# event out to all of them — see goonware-claude-hook.sh for the full rationale.
ls /tmp/goonware-agent-*.sock >/dev/null 2>&1 || exit 0

# Skip helper-agent invocations — see goonware-claude-hook.sh for rationale.
[ -n "${GOONWARE_HELPER_AGENT}${GLI_HELPER_AGENT}" ] && exit 0

# Skip agents running outside Goonware — see goonware-claude-hook.sh for rationale.
GOONWARE_SID="${GOONWARE_SESSION_ID:-${GLI_SESSION_ID:-$RLI_SESSION_ID}}"
[ -z "$GOONWARE_SID" ] && exit 0

# Codex's hook protocol mirrors Claude's, but only SessionStart /
# UserPromptSubmit / Stop are guaranteed on every Codex build — the
# richer events (PreToolUse / PostToolUse / Notification / PreCompact
# / SessionEnd) fire on newer CLIs and are forwarded verbatim when
# they do; the Rust classifier handles them all. Codex still has no
# reliable SessionEnd signal, so the Rust side compensates with
# PID-based liveness monitoring, for which it needs the codex
# process id. We walk up the parent process tree looking for "codex"
# so the Rust side has a PID to watch.
/usr/bin/python3 -c "
import glob, json, os, socket, subprocess, sys

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

# Same envelope shape as goonware-claude-hook.sh:
#  - 'aux' carries Notification's sub-classifier (notification_type)
#    so the Rust side can tell idle_prompt (→ Idle) from a real
#    question (→ Waiting).
#  - 'prompt' carries the user's typed text for UserPromptSubmit so
#    the tab-subtitle summarizer works for codex tabs too. Captured
#    here (inside codex's process tree) so Goonware never has to read
#    ~/.codex/sessions/*.jsonl — same TCC rationale as Claude.
out = {
    'provider': 'codex',
    'session_id': payload.get('session_id', ''),
    'transcript_path': payload.get('transcript_path', ''),
    'cwd': payload.get('cwd', ''),
    'event': payload.get('hook_event_name', ''),
    'tool': payload.get('tool_name', ''),
    'aux': payload.get('notification_type', ''),
    'prompt': payload.get('prompt', '') or '',
    'goonware_session_id': '$GOONWARE_SID',
    'goonware_instance_id': os.environ.get('GOONWARE_INSTANCE_ID', ''),
}

pid = codex_pid()
if pid is not None:
    # Shared with claude / gemini hooks. The legacy 'codex_process_id'
    # is parsed by older Rust builds during a Goonware upgrade window;
    # newer ones read 'agent_process_id'.
    out['agent_process_id'] = pid
    out['codex_process_id'] = pid

# Fan the event out to EVERY running Goonware instance's socket — peers ignore
# agents they didn't spawn (see goonware-claude-hook.sh).
payload_bytes = json.dumps(out).encode()
for sock_path in glob.glob('/tmp/goonware-agent-*.sock'):
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(0.5)
        sock.connect(sock_path)
        sock.sendall(payload_bytes)
        sock.close()
    except Exception:
        pass
"
