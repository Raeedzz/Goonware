//! Connections view backend — scans the user's local config for
//! Claude Code skills + MCP servers and returns a unified list to the
//! frontend.
//!
//! Read-only: we parse, we don't mutate. Editing skill files or MCP
//! configs is a future feature.
//!
//! Sources scanned:
//!   ~/.claude/skills/<name>/SKILL.md
//!   ~/.claude/plugins/<plugin>/skills/<name>/SKILL.md
//!   <project>/.claude/skills/<name>/SKILL.md
//!   ~/.claude/.mcp.json   (mcpServers: { ... })
//!   ~/.claude/settings.json   (mcpServers: { ... })
//!   <project>/.mcp.json
//!
//! For each skill we read SKILL.md's YAML-ish frontmatter (between
//! `---` delimiters) for `name` and `description`. For MCPs we extract
//! the server name and command/args from the JSON config.
//!
//! **TCC popup invariant.** Every `~/.claude/*` path sits inside
//! Claude.app's responsible-bundle MACL domain, and the first read of
//! any of them from Goonware fires the "would like to access data
//! from other apps" prompt. The home-dir portion of the scan is
//! therefore cached per (project_path) for the life of the process —
//! reopening the Connections view doesn't re-fire the popup. Project-
//! local files (under the worktree) are scanned fresh each call since
//! they're inside Goonware's own MACL domain and don't trigger TCC.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct Connection {
    /// `skill` or `mcp`
    pub kind: String,
    /// Display name
    pub name: String,
    /// First-line description (from SKILL.md frontmatter or MCP config)
    pub description: Option<String>,
    /// Where it came from: `user` | `project` | `plugin`
    pub source: String,
    /// Absolute path to the source file
    pub path: String,
    /// For MCPs: the command line invoked
    pub command: Option<String>,
}

/// Cached home-dir scan. Keys: nothing (the home-dir half doesn't
/// depend on the project). Populated lazily on the first
/// `connections_scan` call. See the module-level TCC invariant.
static HOME_SCAN_CACHE: OnceLock<Mutex<Option<Vec<Connection>>>> = OnceLock::new();

#[tauri::command]
pub fn connections_scan(project_path: Option<String>) -> Result<Vec<Connection>, String> {
    let mut out = home_scan_cached()?;

    // Project-local paths are inside Goonware's own MACL domain, so
    // scanning them every call is TCC-free and keeps the list fresh
    // when the user edits the project's `.claude` dir.
    if let Some(proj) = project_path.as_deref() {
        scan_skills(&PathBuf::from(proj).join(".claude").join("skills"), "project", &mut out);
        parse_mcp_file(&PathBuf::from(proj).join(".mcp.json"), "project", &mut out);
    }

    // Stable sort: kind then name
    out.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// Walk `~/.claude/...` exactly once per process. Subsequent calls
/// return the cached copy so the macOS App Data Isolation popup fires
/// at most once. `HashMap` import is unused here today but kept for
/// the per-project variant if we ever decide to also cache project-
/// local scans.
fn home_scan_cached() -> Result<Vec<Connection>, String> {
    let slot = HOME_SCAN_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(g) = slot.lock() {
        if let Some(cached) = g.as_ref() {
            return Ok(cached.clone());
        }
    }
    let fresh = scan_home_from_disk()?;
    if let Ok(mut g) = slot.lock() {
        *g = Some(fresh.clone());
    }
    Ok(fresh)
}

fn scan_home_from_disk() -> Result<Vec<Connection>, String> {
    let mut out = Vec::new();
    let home = std::env::var("HOME").map_err(|_| "HOME unset")?;
    let home = PathBuf::from(home);

    // Skills — user
    scan_skills(&home.join(".claude").join("skills"), "user", &mut out);

    // Skills — plugins (one level deeper)
    let plugins = home.join(".claude").join("plugins");
    if let Ok(entries) = fs::read_dir(&plugins) {
        for entry in entries.flatten() {
            let p = entry.path().join("skills");
            if p.exists() {
                scan_skills(&p, "plugin", &mut out);
            }
        }
    }

    // MCP servers — user-level configs
    parse_mcp_file(&home.join(".claude").join(".mcp.json"), "user", &mut out);
    parse_mcp_file(&home.join(".claude").join("settings.json"), "user", &mut out);

    Ok(out)
}

fn scan_skills(dir: &Path, source: &str, out: &mut Vec<Connection>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }
        let Ok(text) = fs::read_to_string(&skill_md) else {
            continue;
        };
        let (name, description) = parse_skill_frontmatter(&text);
        let display_name = name.unwrap_or_else(|| {
            path.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("?")
                .to_string()
        });
        out.push(Connection {
            kind: "skill".into(),
            name: display_name,
            description,
            source: source.into(),
            path: skill_md.to_string_lossy().into_owned(),
            command: None,
        });
    }
}

fn parse_skill_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    // Look for opening "---" at the very top (allowing leading whitespace),
    // then a closing "---" later. Between them: simple `key: value` lines.
    let trimmed = text.trim_start();
    if !trimmed.starts_with("---") {
        return (None, None);
    }
    let after_open = &trimmed[3..];
    let Some(close_idx) = after_open.find("\n---") else {
        return (None, None);
    };
    let body = &after_open[..close_idx];

    let mut name = None;
    let mut description = None;
    for line in body.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("name:") {
            name = Some(unquote(rest.trim()).to_string());
        } else if let Some(rest) = line.strip_prefix("description:") {
            description = Some(unquote(rest.trim()).to_string());
        }
    }
    (name, description)
}

fn unquote(s: &str) -> &str {
    s.trim_matches(|c| c == '"' || c == '\'' || c == '`')
}

fn parse_mcp_file(path: &Path, source: &str, out: &mut Vec<Connection>) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    let path_str = path.to_string_lossy().into_owned();
    out.extend(parse_mcp_json(&text, &path_str, source));
}

fn parse_mcp_json(text: &str, path: &str, source: &str) -> Vec<Connection> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let servers = value
        .get("mcpServers")
        .or_else(|| value.get("mcp_servers"))
        .and_then(|v| v.as_object());
    let Some(servers) = servers else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(servers.len());
    for (name, cfg) in servers {
        let command = cfg
            .get("command")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let args = cfg
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        let cmd_line = match command.as_deref() {
            Some(c) if !args.is_empty() => Some(format!("{c} {args}")),
            Some(c) => Some(c.to_string()),
            None => None,
        };
        let description = cfg
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        out.push(Connection {
            kind: "mcp".into(),
            name: name.clone(),
            description,
            source: source.into(),
            path: path.to_string(),
            command: cmd_line,
        });
    }
    out
}

/* ------------------------------------------------------------------
   Tests
   ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------- skill frontmatter ---------- */

    #[test]
    fn frontmatter_extracts_name_and_description() {
        let text = "---\n\
                    name: tdd\n\
                    description: test-driven development workflow\n\
                    ---\n\
                    \n\
                    body content here\n";
        let (name, desc) = parse_skill_frontmatter(text);
        assert_eq!(name.as_deref(), Some("tdd"));
        assert_eq!(desc.as_deref(), Some("test-driven development workflow"));
    }

    #[test]
    fn frontmatter_strips_quotes_from_values() {
        let text = "---\n\
                    name: \"tdd\"\n\
                    description: 'a workflow'\n\
                    ---\n";
        let (name, desc) = parse_skill_frontmatter(text);
        assert_eq!(name.as_deref(), Some("tdd"));
        assert_eq!(desc.as_deref(), Some("a workflow"));
    }

    #[test]
    fn frontmatter_missing_returns_none() {
        let text = "no frontmatter here, just body\n";
        let (name, desc) = parse_skill_frontmatter(text);
        assert_eq!(name, None);
        assert_eq!(desc, None);
    }

    #[test]
    fn frontmatter_unclosed_returns_none() {
        let text = "---\nname: foo\ndescription: bar\nno closing delimiter\n";
        let (name, desc) = parse_skill_frontmatter(text);
        assert_eq!(name, None);
        assert_eq!(desc, None);
    }

    #[test]
    fn frontmatter_only_name() {
        let text = "---\nname: solo\n---\nbody\n";
        let (name, desc) = parse_skill_frontmatter(text);
        assert_eq!(name.as_deref(), Some("solo"));
        assert_eq!(desc, None);
    }

    #[test]
    fn frontmatter_with_leading_whitespace_still_parses() {
        let text = "   \n---\nname: foo\ndescription: bar\n---\n";
        let (name, desc) = parse_skill_frontmatter(text);
        assert_eq!(name.as_deref(), Some("foo"));
        assert_eq!(desc.as_deref(), Some("bar"));
    }

    #[test]
    fn frontmatter_ignores_unknown_keys() {
        let text = "---\n\
                    name: foo\n\
                    type: agent\n\
                    description: bar\n\
                    arguments: ignored\n\
                    ---\n";
        let (name, desc) = parse_skill_frontmatter(text);
        assert_eq!(name.as_deref(), Some("foo"));
        assert_eq!(desc.as_deref(), Some("bar"));
    }

    /* ---------- MCP JSON ---------- */

    #[test]
    fn mcp_parses_command_and_args() {
        let json = r#"{
            "mcpServers": {
                "filesystem": {
                    "command": "npx",
                    "args": ["-y", "@mcp/server-filesystem", "/tmp"]
                }
            }
        }"#;
        let entries = parse_mcp_json(json, "/test/.mcp.json", "user");
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert_eq!(e.kind, "mcp");
        assert_eq!(e.name, "filesystem");
        assert_eq!(e.source, "user");
        assert_eq!(e.path, "/test/.mcp.json");
        assert_eq!(
            e.command.as_deref(),
            Some("npx -y @mcp/server-filesystem /tmp")
        );
    }

    #[test]
    fn mcp_handles_command_without_args() {
        let json = r#"{"mcpServers": {"bare": {"command": "/usr/local/bin/srv"}}}"#;
        let entries = parse_mcp_json(json, "x", "user");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].command.as_deref(), Some("/usr/local/bin/srv"));
    }

    #[test]
    fn mcp_extracts_description_when_present() {
        let json = r#"{
            "mcpServers": {
                "fs": {"command": "x", "description": "filesystem access"}
            }
        }"#;
        let entries = parse_mcp_json(json, "x", "user");
        assert_eq!(entries[0].description.as_deref(), Some("filesystem access"));
    }

    #[test]
    fn mcp_accepts_snake_case_key() {
        let json = r#"{"mcp_servers": {"snake": {"command": "x"}}}"#;
        let entries = parse_mcp_json(json, "x", "project");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "snake");
    }

    #[test]
    fn mcp_returns_empty_for_invalid_json() {
        let entries = parse_mcp_json("{ this is not json", "x", "user");
        assert!(entries.is_empty());
    }

    #[test]
    fn mcp_returns_empty_when_no_servers_key() {
        let entries = parse_mcp_json(r#"{"some_other_key": {}}"#, "x", "user");
        assert!(entries.is_empty());
    }

    #[test]
    fn mcp_multiple_servers_all_parsed() {
        let json = r#"{
            "mcpServers": {
                "a": {"command": "ca"},
                "b": {"command": "cb", "args": ["x"]},
                "c": {"command": "cc"}
            }
        }"#;
        let entries = parse_mcp_json(json, "x", "user");
        assert_eq!(entries.len(), 3);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"a"));
        assert!(names.contains(&"b"));
        assert!(names.contains(&"c"));
    }

    #[test]
    fn mcp_server_without_command_yields_none() {
        let json = r#"{"mcpServers": {"empty": {}}}"#;
        let entries = parse_mcp_json(json, "x", "user");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].command, None);
    }
}
