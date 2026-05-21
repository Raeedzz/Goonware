//! Enumerate Claude Code skills and MCP server definitions.
//!
//! Skills live in two places: `~/.claude/skills/<name>/SKILL.md` for the
//! user's own skills, and `~/.claude/plugins/.../skills/<name>/SKILL.md`
//! for skills bundled with installed plugins. MCP servers are declared
//! either at the top of `~/.claude.json` (`mcpServers`) or inside a
//! plugin's `.mcp.json`.
//!
//! Both readers are best-effort: a malformed SKILL.md or a missing
//! description field doesn't fail the whole list — we surface what we
//! found and skip the rest.
//!
//! **TCC caching invariant.** Every path scanned here sits inside
//! Claude.app's responsible-bundle MACL domain. The first read of any
//! such file from Goonware fires the macOS App Data Isolation popup
//! ("Goonware would like to access data from other apps"). To prevent
//! that popup from firing every time the user opens the ⌘K palette or
//! switches to the Skills tab, the disk walk runs at most ONCE per app
//! launch — subsequent calls return the cached `Vec`. The cache lives
//! until the process exits; a future "refresh" command can swap it.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Serialize, Clone)]
pub struct SkillEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    /// "user" for `~/.claude/skills/<name>`, otherwise the plugin name
    /// (e.g. "claude-mem@thedotmack").
    pub source: String,
    /// Absolute path to the skill's `SKILL.md` file. The frontend opens
    /// this as a markdown tab.
    pub path: String,
}

#[derive(Serialize, Clone)]
pub struct McpEntry {
    pub id: String,
    pub name: String,
    /// "stdio", "sse", "http" — whatever the server config sets.
    pub kind: String,
    /// "user" for entries in `~/.claude.json#mcpServers`, otherwise the
    /// owning plugin name.
    pub source: String,
    /// Best-effort one-liner — for stdio servers this is the command
    /// line, for sse/http it's the URL. Empty when nothing parseable.
    pub summary: String,
}

/// Process-lifetime caches. Populated lazily on first call to the
/// matching `*_list` command. The popup-suppression invariant in the
/// module docs depends on these — never bypass them from the public
/// commands.
static SKILLS_CACHE: OnceLock<Mutex<Option<Vec<SkillEntry>>>> = OnceLock::new();
static MCPS_CACHE: OnceLock<Mutex<Option<Vec<McpEntry>>>> = OnceLock::new();

#[tauri::command]
pub fn skills_list() -> Result<Vec<SkillEntry>, String> {
    let slot = SKILLS_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(g) = slot.lock() {
        if let Some(cached) = g.as_ref() {
            return Ok(cached.clone());
        }
    }
    let fresh = scan_skills_from_disk()?;
    if let Ok(mut g) = slot.lock() {
        *g = Some(fresh.clone());
    }
    Ok(fresh)
}

fn scan_skills_from_disk() -> Result<Vec<SkillEntry>, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let mut out = Vec::new();

    let user_skills = home.join(".claude").join("skills");
    collect_skills_in(&user_skills, "user", &mut out);

    let cache_root = home.join(".claude").join("plugins").join("cache");
    if let Ok(owners) = fs::read_dir(&cache_root) {
        for owner in owners.flatten() {
            let owner_name = owner.file_name().to_string_lossy().into_owned();
            let Ok(repos) = fs::read_dir(owner.path()) else { continue };
            for repo in repos.flatten() {
                let repo_name = repo.file_name().to_string_lossy().into_owned();
                let Ok(versions) = fs::read_dir(repo.path()) else { continue };
                let mut latest: Option<(String, PathBuf)> = None;
                for version in versions.flatten() {
                    let v = version.file_name().to_string_lossy().into_owned();
                    let p = version.path().join("skills");
                    if !p.is_dir() {
                        continue;
                    }
                    if latest.as_ref().map(|(lv, _)| v.as_str() > lv.as_str()).unwrap_or(true) {
                        latest = Some((v, p));
                    }
                }
                if let Some((_, skills_dir)) = latest {
                    let source = format!("{repo_name}@{owner_name}");
                    collect_skills_in(&skills_dir, &source, &mut out);
                }
            }
        }
    }

    out.sort_by(|a, b| a.source.cmp(&b.source).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

fn collect_skills_in(dir: &Path, source: &str, out: &mut Vec<SkillEntry>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let skill_md = entry.path().join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let description = read_skill_description(&skill_md).unwrap_or_default();
        out.push(SkillEntry {
            id: format!("{source}/{name}"),
            name,
            description,
            source: source.to_string(),
            path: skill_md.to_string_lossy().into_owned(),
        });
    }
}

/// Pull the `description:` field out of the SKILL.md YAML frontmatter.
/// Tolerates multiline descriptions wrapped in single or double quotes
/// and trims surrounding whitespace. Returns None if no frontmatter is
/// present or no description key was found in the first ~30 lines.
fn read_skill_description(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let mut lines = text.lines();
    if lines.next()? != "---" {
        return None;
    }
    let mut buf = String::new();
    let mut in_desc = false;
    for line in lines.by_ref().take(60) {
        if line == "---" {
            break;
        }
        if let Some(rest) = line.strip_prefix("description:") {
            in_desc = true;
            buf.push_str(rest.trim());
            continue;
        }
        if in_desc {
            let l = line.trim_start();
            if l.starts_with(|c: char| c.is_ascii_alphabetic())
                && l.contains(':')
                && !l.starts_with('-')
            {
                break;
            }
            if !buf.is_empty() {
                buf.push(' ');
            }
            buf.push_str(line.trim());
        }
    }
    let cleaned = buf.trim().trim_matches('"').trim_matches('\'').trim();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

#[tauri::command]
pub fn mcps_list() -> Result<Vec<McpEntry>, String> {
    let slot = MCPS_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(g) = slot.lock() {
        if let Some(cached) = g.as_ref() {
            return Ok(cached.clone());
        }
    }
    let fresh = scan_mcps_from_disk()?;
    if let Ok(mut g) = slot.lock() {
        *g = Some(fresh.clone());
    }
    Ok(fresh)
}

fn scan_mcps_from_disk() -> Result<Vec<McpEntry>, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let mut out = Vec::new();

    let user_json = home.join(".claude.json");
    if let Ok(text) = fs::read_to_string(&user_json) {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            collect_mcps_from(&value, "user", &mut out);
        }
    }

    let cache_root = home.join(".claude").join("plugins").join("cache");
    if let Ok(owners) = fs::read_dir(&cache_root) {
        for owner in owners.flatten() {
            let owner_name = owner.file_name().to_string_lossy().into_owned();
            let Ok(repos) = fs::read_dir(owner.path()) else { continue };
            for repo in repos.flatten() {
                let repo_name = repo.file_name().to_string_lossy().into_owned();
                let Ok(versions) = fs::read_dir(repo.path()) else { continue };
                let mut latest: Option<(String, PathBuf)> = None;
                for version in versions.flatten() {
                    let v = version.file_name().to_string_lossy().into_owned();
                    let p = version.path().join(".mcp.json");
                    if !p.is_file() {
                        continue;
                    }
                    if latest.as_ref().map(|(lv, _)| v.as_str() > lv.as_str()).unwrap_or(true) {
                        latest = Some((v, p));
                    }
                }
                if let Some((_, mcp_path)) = latest {
                    if let Ok(text) = fs::read_to_string(&mcp_path) {
                        if let Ok(value) = serde_json::from_str::<Value>(&text) {
                            let source = format!("{repo_name}@{owner_name}");
                            collect_mcps_from(&value, &source, &mut out);
                        }
                    }
                }
            }
        }
    }

    out.sort_by(|a, b| a.source.cmp(&b.source).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

fn collect_mcps_from(value: &Value, source: &str, out: &mut Vec<McpEntry>) {
    let Some(servers) = value.get("mcpServers").and_then(|v| v.as_object()) else {
        return;
    };
    for (name, cfg) in servers {
        let kind = cfg
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| {
                if cfg.get("url").is_some() {
                    "http"
                } else if cfg.get("command").is_some() {
                    "stdio"
                } else {
                    "unknown"
                }
            })
            .to_string();
        let summary = if let Some(url) = cfg.get("url").and_then(|v| v.as_str()) {
            url.to_string()
        } else if let Some(cmd) = cfg.get("command").and_then(|v| v.as_str()) {
            let args = cfg
                .get("args")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str())
                        .take(2)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            if args.is_empty() {
                cmd.to_string()
            } else {
                format!("{cmd} {args}")
            }
        } else {
            String::new()
        };
        out.push(McpEntry {
            id: format!("{source}/{name}"),
            name: name.clone(),
            kind,
            source: source.to_string(),
            summary,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn description_parses_simple_quoted_value() {
        let tmp = std::env::temp_dir().join("goonware-skill-test-1.md");
        fs::write(
            &tmp,
            "---\nname: foo\ndescription: \"hello world\"\nuser-invocable: true\n---\nbody\n",
        )
        .unwrap();
        let d = read_skill_description(&tmp).unwrap();
        assert_eq!(d, "hello world");
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn description_stops_at_next_yaml_key() {
        let tmp = std::env::temp_dir().join("goonware-skill-test-2.md");
        fs::write(
            &tmp,
            "---\ndescription: starts here continues here\nnext-key: value\n---\nbody\n",
        )
        .unwrap();
        let d = read_skill_description(&tmp).unwrap();
        assert_eq!(d, "starts here continues here");
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn description_returns_none_when_no_frontmatter() {
        let tmp = std::env::temp_dir().join("goonware-skill-test-3.md");
        fs::write(&tmp, "no frontmatter here\n").unwrap();
        assert!(read_skill_description(&tmp).is_none());
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn mcps_extract_stdio_and_http() {
        let json: Value = serde_json::from_str(
            r#"{"mcpServers":{"a":{"type":"stdio","command":"node","args":["x.js"]},"b":{"url":"https://example.com"}}}"#,
        ).unwrap();
        let mut v = Vec::new();
        collect_mcps_from(&json, "user", &mut v);
        v.sort_by(|x, y| x.name.cmp(&y.name));
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].name, "a");
        assert_eq!(v[0].kind, "stdio");
        assert!(v[0].summary.contains("node"));
        assert_eq!(v[1].name, "b");
        assert_eq!(v[1].kind, "http");
        assert_eq!(v[1].summary, "https://example.com");
    }
}
