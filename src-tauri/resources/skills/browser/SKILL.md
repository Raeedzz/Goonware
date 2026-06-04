---
name: browser
description: Drive the Goonware built-in headless browser (the RLI Chrome daemon at $RLI_BROWSER_URL) instead of the Claude-in-Chrome MCP. Use for ANY web/browser automation while running inside a Goonware/RLI pane — navigating to a URL, taking a screenshot, clicking, typing, pressing keys, reading the DOM/console/network, or testing a local web app the user is building. Prefer this over any mcp__claude-in-chrome__* tool.
---

# browser — use Goonware's built-in browser, not the Chrome MCP

You are running inside a Goonware/RLI terminal pane. It ships its own in-house headless
Chrome daemon. **Drive that daemon with `curl`. Do NOT use the `mcp__claude-in-chrome__*`
tools** — they target a different browser the user isn't looking at.

The daemon's base URL is in the `$RLI_BROWSER_URL` environment variable (default
`http://127.0.0.1:4000`). Always reference it as `$RLI_BROWSER_URL` so the skill keeps
working if the port changes.

## Step 0 — confirm it's up

```bash
curl -s "$RLI_BROWSER_URL/health"     # -> {"ok":true,"version":"..."}
```

If this fails or `$RLI_BROWSER_URL` is empty, you are NOT in an RLI pane. Tell the user
the Goonware browser isn't reachable and stop — do not silently fall back to the Chrome
MCP.

## Endpoints

All POST bodies are JSON; always send `-H 'content-type: application/json'`.

| Action      | Command |
|-------------|---------|
| Health      | `curl -s "$RLI_BROWSER_URL/health"` |
| Status      | `curl -s "$RLI_BROWSER_URL/status"` → `{ url, title, ready }` |
| Navigate    | `curl -s -X POST "$RLI_BROWSER_URL/navigate" -d '{"url":"http://localhost:3000"}' -H 'content-type: application/json'` |
| Screenshot  | `curl -s "$RLI_BROWSER_URL/screenshot" -o /tmp/shot.png` (writes PNG bytes) |
| Click       | `curl -s -X POST "$RLI_BROWSER_URL/click" -d '{"x":120,"y":80}' -H 'content-type: application/json'` |
| Type        | `curl -s -X POST "$RLI_BROWSER_URL/type" -d '{"text":"hello"}' -H 'content-type: application/json'` |
| Key         | `curl -s -X POST "$RLI_BROWSER_URL/key" -d '{"key":"Enter"}' -H 'content-type: application/json'` |
| Console+net | `curl -s "$RLI_BROWSER_URL/console/recent"` → recent console + network logs |
| Back        | `curl -s -X POST "$RLI_BROWSER_URL/back"` (no body) |
| Forward     | `curl -s -X POST "$RLI_BROWSER_URL/forward"` (no body) |
| Reload      | `curl -s -X POST "$RLI_BROWSER_URL/reload"` (no body) |

## Seeing the page

`/screenshot` returns raw PNG bytes — pipe it to a file, then **Read that file** so you
can actually look at the pixels and find coordinates to click:

```bash
curl -s "$RLI_BROWSER_URL/screenshot" -o /tmp/shot.png
```
Then call the Read tool on `/tmp/shot.png`. Coordinates you pass to `/click` are the
pixel coordinates from that screenshot (viewport is 800×600 by default).

## Typical loop

1. `navigate` to the URL.
2. `screenshot` → Read the PNG → find the element.
3. `click` / `type` / `key` to interact.
4. `screenshot` again to confirm the result.
5. `console/recent` to catch JS errors or failed network requests.

```bash
curl -s -X POST "$RLI_BROWSER_URL/navigate" -d '{"url":"http://localhost:3000"}' -H 'content-type: application/json'
curl -s "$RLI_BROWSER_URL/status"                       # wait for ready:true
curl -s "$RLI_BROWSER_URL/screenshot" -o /tmp/shot.png  # then Read /tmp/shot.png
```

## Tips

- After a `navigate`, poll `/status` until `"ready": true` before screenshotting, so you
  don't capture a blank/loading page.
- Use a fresh filename (or `/tmp/shot-<n>.png`) per screenshot so Read doesn't show a
  stale cached image.
- `type` enters text into the currently focused element — click the field first.
- `/console/recent` is the fastest way to debug: navigate, then read it for errors and
  network failures instead of guessing.
- This is the same browser the user has open in Goonware, so what you do is visible to
  them — narrate what you're testing.

---

<!-- Installed and managed by Goonware: this skill is bundled with the app and
re-installed into ~/.claude/skills/browser/ on every launch. Safe to delete — Goonware
restores it next time it starts. Edit the canonical copy at
src-tauri/resources/skills/browser/SKILL.md in the Goonware repo. -->
