#!/bin/bash
# Goonware Hook — forwards Google Gemini CLI events to Goonware via Unix socket.
# Installed and managed by Goonware; safe to remove (Goonware re-installs on next launch).

SOCKET_PATH="/tmp/goonware-agent.sock"

# Exit silently if socket doesn't exist (Goonware not running).
[ -S "$SOCKET_PATH" ] || exit 0

# Skip helper-agent invocations — see goonware-claude-hook.sh for rationale.
[ -n "${GOONWARE_HELPER_AGENT}${GLI_HELPER_AGENT}" ] && exit 0

# Skip agents running outside Goonware — see goonware-claude-hook.sh for rationale.
GOONWARE_SID="${GOONWARE_SESSION_ID:-${GLI_SESSION_ID:-$RLI_SESSION_ID}}"
[ -z "$GOONWARE_SID" ] && exit 0

/usr/bin/python3 -c "
import json, socket, sys

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)

out = {
    'provider': 'gemini',
    'session_id': payload.get('session_id', ''),
    'transcript_path': payload.get('transcript_path', ''),
    'cwd': payload.get('cwd', ''),
    'event': payload.get('hook_event_name', ''),
    'tool': payload.get('tool_name', ''),
    'aux': payload.get('notification_type', ''),
    'goonware_session_id': '$GOONWARE_SID',
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
