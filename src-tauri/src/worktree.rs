//! Worktree lifecycle. Each "worktree" in RLI corresponds to a real
//! `git worktree` checkout: one branch, one directory, one running
//! agent (claude / codex / gemini). Worktrees are created via the
//! sidebar's `+` action and archived via the row's hover-✕.
//!
//! Archive convention:
//!   - JSON metadata: `<app_data_dir>/archive/<projectId>/<worktreeId>.json`
//!   - Optional stash: `git stash push -u -m "goonware-archive-<worktreeId>"` ran
//!     in the worktree before `git worktree remove`. Restores apply the
//!     matching stash.
//!   - Branch deletion is opt-in (deleteBranch flag).
//!
//! Worktree checkouts live under `<app_data_dir>/worktrees/<projectId>/<id>`
//! so they don't pollute the user's repo with `.goonware/sessions/...` dirs.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Output;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri::Manager;
use tokio::process::Command;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRow {
    pub id: String,
    pub project_id: String,
    pub branch: String,
    pub name: String,
    pub path: String,
    pub change_count: u32,
    pub agent_status: String,
    pub agent_cli: Option<String>,
    pub created_at: u64,
    pub tab_ids: Vec<String>,
    pub active_tab_id: Option<String>,
    pub right_panel: String,
    pub right_split_pct: u8,
    pub secondary_tab: String,
    pub secondary_pty_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveRecord {
    pub id: String,
    pub project_id: String,
    pub branch: String,
    pub name: String,
    pub created_at: u64,
    pub archived_at: u64,
    pub last_summary: String,
    pub change_count_at_archive: u32,
    pub original_path: String,
    pub agent_cli: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stash_ref: Option<String>,
}

/* ------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------ */

async fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    if !Path::new(cwd).exists() {
        return Err(format!("cwd does not exist: {cwd}"));
    }
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("spawn git: {e}"))?;
    output_to_string(out)
}

fn output_to_string(out: Output) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        Err(format!(
            "git exited {}: {}",
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ))
    }
}

/// Root of the per-project workspaces directory.
///
/// Layout (conductor-style — visible to the user, not buried in
/// Library/Application Support):
///
///   `~/Goonware/workspaces/<project-basename>/<worktree-id>`
///
/// `<project-basename>` is the last path segment of the project's
/// repo root (e.g. `OG-E_case_comp` for `/Users/raeedz/Developer/OG-E_case_comp`).
/// We fall back to the project id only if the path has no readable
/// last segment.
fn worktrees_root(project_path: &str, project_id: &str) -> Result<PathBuf, String> {
    let basename = Path::new(project_path)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| project_id.to_string());
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let dir = home.join("Goonware").join("workspaces").join(&basename);
    fs::create_dir_all(&dir).map_err(|e| format!("create workspaces root: {e}"))?;
    Ok(dir)
}

/// Sanitize a worktree label into a filesystem-safe directory segment.
/// Lowercases, maps non-alphanumeric runs to single dashes, and trims
/// dashes from the ends. Empty results fall back to a uuid stub so we
/// never hand `git worktree add` an empty path.
fn safe_dir_name(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    let mut prev_dash = true;
    for c in label.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        format!("w-{}", Uuid::new_v4().simple())
    } else {
        out
    }
}

/// Pick a directory name under `root` that doesn't collide with an
/// existing entry. Tries `base`, then `base-2`, `base-3`, … with a
/// hard ceiling that falls back to a uuid suffix.
fn pick_unique_dir(root: &Path, base: &str) -> String {
    if !root.join(base).exists() {
        return base.to_string();
    }
    for n in 2u32..=9999 {
        let candidate = format!("{base}-{n}");
        if !root.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{base}-{}", Uuid::new_v4().simple())
}

fn archive_dir(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let dir = base.join("archive").join(project_id);
    fs::create_dir_all(&dir).map_err(|e| format!("create archive dir: {e}"))?;
    Ok(dir)
}

fn now_secs() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ------------------------------------------------------------------
   Commands
   ------------------------------------------------------------------ */

#[tauri::command]
pub async fn worktree_list(project_path: String) -> Result<Vec<WorktreeRow>, String> {
    // Best-effort: parse `git worktree list --porcelain` and return rows.
    // Caller is responsible for assigning IDs that mirror frontend state.
    let raw = git(&project_path, &["worktree", "list", "--porcelain"]).await?;
    let mut rows = Vec::new();
    let mut path = String::new();
    let mut branch = String::new();
    for line in raw.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = p.to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            branch = b.trim_start_matches("refs/heads/").to_string();
        } else if line.is_empty() && !path.is_empty() {
            let id = format!("w_{}", Uuid::new_v4().simple());
            rows.push(WorktreeRow {
                id,
                project_id: String::new(),
                branch: branch.clone(),
                name: branch.clone(),
                path: path.clone(),
                change_count: 0,
                agent_status: "idle".to_string(),
                agent_cli: None,
                created_at: now_millis(),
                tab_ids: vec![],
                active_tab_id: None,
                right_panel: "files".to_string(),
                right_split_pct: 60,
                secondary_tab: "terminal".to_string(),
                secondary_pty_id: format!("pty_secondary_{}", Uuid::new_v4().simple()),
            });
            path.clear();
            branch.clear();
        }
    }
    Ok(rows)
}

/// Create a new git worktree under `<app_data>/worktrees/<projectId>/<id>`.
///
/// - `base_ref` — optional ref to branch off of (e.g. `origin/main`).
///   When None or empty, falls back to the project's current HEAD.
/// - `files_to_copy` — glob patterns to copy from `project_path` into
///   the new worktree after `git worktree add`. Supports trailing `*`
///   wildcards (e.g. `.env*`) and exact filenames.
/// - `setup_script` — shell snippet to run in the new worktree dir
///   after creation. Errors are logged, never aborting the create.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn worktree_create(
    app: AppHandle,
    project_id: String,
    project_path: String,
    branch: String,
    label: String,
    base_ref: Option<String>,
    files_to_copy: Option<Vec<String>>,
    setup_script: Option<String>,
) -> Result<WorktreeRow, String> {
    let id = format!("w_{}", Uuid::new_v4().simple());
    let root = worktrees_root(&project_path, &project_id)?;
    // On-disk directory is named after the friendly label (e.g.
    // `niagara`) so the user sees recognizable folders, not opaque
    // `w_<uuid>`. The internal `id` stays uuid-based — it's keyed
    // off in app state and must stay stable across renames.
    let dir_name = pick_unique_dir(&root, &safe_dir_name(&label));
    let path = root.join(&dir_name);
    let path_str = path.to_string_lossy().into_owned();
    // `app` is only kept for the archive flow below — silence unused
    // warning when the function compiles without referencing it.
    let _ = &app;

    // Branch off the configured base ref when provided, otherwise the
    // project's current HEAD. If the branch already exists, fall back
    // to adding the existing branch.
    let base = base_ref.as_deref().unwrap_or("").trim();
    let result = if base.is_empty() {
        git(
            &project_path,
            &["worktree", "add", "-b", &branch, &path_str],
        )
        .await
    } else {
        git(
            &project_path,
            &["worktree", "add", "-b", &branch, &path_str, base],
        )
        .await
    };
    if result.is_err() {
        git(&project_path, &["worktree", "add", &path_str, &branch]).await?;
    }

    if let Some(patterns) = files_to_copy.as_ref() {
        copy_matching_files(&project_path, &path_str, patterns);
    }

    if let Some(script) = setup_script.as_deref() {
        let trimmed = script.trim();
        if !trimmed.is_empty() {
            run_shell_script(&path_str, trimmed).await;
        }
    }

    let primary_tab = format!("t_{}", Uuid::new_v4().simple());
    let secondary_pty = format!("pty_{}", Uuid::new_v4().simple());

    Ok(WorktreeRow {
        id,
        project_id,
        branch,
        name: label,
        path: path_str,
        change_count: 0,
        agent_status: "idle".to_string(),
        agent_cli: None,
        created_at: now_millis(),
        tab_ids: vec![primary_tab.clone()],
        active_tab_id: Some(primary_tab),
        right_panel: "files".to_string(),
        right_split_pct: 60,
        secondary_tab: "terminal".to_string(),
        secondary_pty_id: secondary_pty,
    })
}

/// Copy files matching any of `patterns` from `src_root` into
/// `dst_root`, preserving relative paths. Supports `*` wildcards in
/// the final path segment only (Conductor's behavior); other patterns
/// are treated as exact paths. Best-effort: errors are logged and do
/// not fail worktree creation.
fn copy_matching_files(src_root: &str, dst_root: &str, patterns: &[String]) {
    let src = Path::new(src_root);
    let dst = Path::new(dst_root);
    for raw in patterns {
        let pat = raw.trim();
        if pat.is_empty() || pat.starts_with('#') {
            continue;
        }
        match expand_pattern(src, pat) {
            Ok(matches) => {
                for rel in matches {
                    let from = src.join(&rel);
                    let to = dst.join(&rel);
                    if let Some(parent) = to.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    if let Err(e) = fs::copy(&from, &to) {
                        eprintln!(
                            "[worktree] copy {} → {}: {e}",
                            from.display(),
                            to.display()
                        );
                    }
                }
            }
            Err(e) => eprintln!("[worktree] expand pattern '{pat}': {e}"),
        }
    }
}

/// Resolve a copy pattern into one or more relative paths. The last
/// path segment may contain a single `*` wildcard.
fn expand_pattern(src_root: &Path, pat: &str) -> Result<Vec<PathBuf>, String> {
    let trimmed = pat.trim_start_matches("./");
    let path = Path::new(trimmed);
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let file_name = match path.file_name().and_then(|s| s.to_str()) {
        Some(n) => n,
        None => return Ok(vec![]),
    };
    if !file_name.contains('*') {
        let abs = src_root.join(trimmed);
        return Ok(if abs.exists() {
            vec![PathBuf::from(trimmed)]
        } else {
            vec![]
        });
    }
    let dir = src_root.join(parent);
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut out: Vec<PathBuf> = Vec::new();
    let (prefix, suffix) = split_glob(file_name);
    for entry in entries.flatten() {
        let name = match entry.file_name().into_string() {
            Ok(s) => s,
            Err(_) => continue,
        };
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if name.starts_with(&prefix) && name.ends_with(&suffix) && name.len() >= prefix.len() + suffix.len() {
            out.push(parent.join(&name));
        }
    }
    Ok(out)
}

fn split_glob(s: &str) -> (String, String) {
    if let Some(idx) = s.find('*') {
        (s[..idx].to_string(), s[idx + 1..].to_string())
    } else {
        (s.to_string(), String::new())
    }
}

/// Spawn `bash -lc <script>` in `cwd`. Output is logged to stderr;
/// failures do not abort the calling flow because users may write
/// scripts with non-zero exits (e.g. `bun install || true`).
async fn run_shell_script(cwd: &str, script: &str) {
    let res = Command::new("bash")
        .arg("-lc")
        .arg(script)
        .current_dir(cwd)
        .output()
        .await;
    match res {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            if !stdout.is_empty() {
                eprintln!("[worktree script stdout]\n{stdout}");
            }
            if !stderr.is_empty() {
                eprintln!("[worktree script stderr]\n{stderr}");
            }
        }
        Err(e) => eprintln!("[worktree script] spawn bash: {e}"),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn worktree_archive(
    app: AppHandle,
    worktree_id: String,
    project_id: String,
    project_path: Option<String>,
    branch: String,
    name: String,
    path: String,
    created_at: u64,
    last_summary: String,
    change_count_at_archive: u32,
    agent_cli: Option<String>,
    stash: bool,
    force: bool,
    delete_branch: bool,
    archive_script: Option<String>,
) -> Result<ArchiveRecord, String> {
    // If the worktree directory was deleted out from under us (a manual
    // `rm -rf`, a system cleanup, a different machine that mounted the
    // disk, etc), the user is stuck — they can't open the worktree, AND
    // they can't archive it because every git op needs a real cwd.
    // Detect this up front and fall back to a "force-forget" path:
    //   - skip the archive script and stash (no working tree to act on)
    //   - skip `git worktree remove` (it would fail), and instead run
    //     `git worktree prune` from the parent repo so git's metadata
    //     for the dead worktree is reclaimed.
    // The archive record still gets written so the user sees the
    // worktree in History with a clear "(missing)" trail back.
    let worktree_path_exists = Path::new(&path).exists();
    let repo_root = project_path
        .clone()
        .filter(|p| Path::new(p).exists())
        .unwrap_or_else(|| infer_repo_root(&path));

    if worktree_path_exists {
        if let Some(script) = archive_script.as_deref() {
            let trimmed = script.trim();
            if !trimmed.is_empty() {
                run_shell_script(&path, trimmed).await;
            }
        }
    }
    let mut stash_ref = None;
    if stash && worktree_path_exists {
        let msg = format!("goonware-archive-{}", worktree_id);
        // Best effort — clean worktree → no stash → git returns non-zero.
        let _ = git(&path, &["stash", "push", "-u", "-m", &msg]).await;
        stash_ref = Some(msg);
    }

    if worktree_path_exists {
        let mut remove_args = vec!["worktree", "remove"];
        if force {
            remove_args.push("--force");
        }
        remove_args.push(path.as_str());
        git(&repo_root, &remove_args).await?;
    } else if Path::new(&repo_root).exists() {
        // Worktree directory is gone — clean up git's stale metadata so
        // the branch isn't permanently flagged as checked-out elsewhere.
        // Best-effort: if prune fails (corrupted git, permissions), the
        // archive record still lands, the user is no longer stuck.
        let _ = git(&repo_root, &["worktree", "prune"]).await;
    }

    if delete_branch {
        // Branch deletion targets the parent repo. If neither the
        // worktree nor a usable parent exists, silently skip — better
        // to land the archive record than to fail the whole operation
        // over a branch we can't reach anyway.
        if Path::new(&repo_root).exists() {
            let _ = git(&repo_root, &["branch", "-D", &branch]).await;
        }
    }

    let record = ArchiveRecord {
        id: format!("a_{}", Uuid::new_v4().simple()),
        project_id: project_id.clone(),
        branch,
        name,
        created_at,
        archived_at: now_secs() * 1000,
        last_summary,
        change_count_at_archive,
        original_path: path,
        agent_cli,
        stash_ref,
    };

    let dir = archive_dir(&app, &project_id)?;
    let file = dir.join(format!("{}.json", record.id));
    let json = serde_json::to_vec_pretty(&record).map_err(|e| e.to_string())?;
    fs::write(&file, json).map_err(|e| format!("write archive: {e}"))?;

    Ok(record)
}

#[tauri::command]
pub async fn worktree_restore(
    app: AppHandle,
    archive_id: String,
    project_id: String,
    project_path: String,
) -> Result<WorktreeRow, String> {
    let dir = archive_dir(&app, &project_id)?;
    let file = dir.join(format!("{}.json", archive_id));
    let raw = fs::read_to_string(&file).map_err(|e| format!("read archive: {e}"))?;
    let record: ArchiveRecord = serde_json::from_str(&raw)
        .map_err(|e| format!("parse archive: {e}"))?;

    // The worktree's own path is gone (that's what archive did), so we
    // can't infer the repo root from it like worktree_archive does.
    // The frontend hands us project_path explicitly — that's where the
    // main repo lives and where `git worktree add` must run from.
    if !Path::new(&project_path).exists() {
        return Err(format!("project path does not exist: {project_path}"));
    }

    // git worktree add creates the leaf dir but not its parents. The
    // archive was made under `~/Goonware/workspaces/<basename>/<id>`; the
    // parent `~/Goonware/workspaces/<basename>` may have been emptied or
    // collected since. Create it eagerly so the add never trips on a
    // missing intermediate.
    if let Some(parent) = Path::new(&record.original_path).parent() {
        let _ = fs::create_dir_all(parent);
    }

    // Re-target so the worktree id is fresh (the old one might still
    // be referenced by stale archive metadata if the user restored
    // before we deleted the JSON). The frontend keys session memory
    // off the worktree id, so a clean uuid is what we want here.
    let new_id = format!("w_{}", Uuid::new_v4().simple());
    let restored_path = match Path::new(&record.original_path).parent() {
        Some(parent) => {
            let _ = fs::create_dir_all(parent);
            let dir_name = pick_unique_dir(parent, &safe_dir_name(&record.name));
            parent.join(&dir_name).to_string_lossy().to_string()
        }
        None => record.original_path.clone(),
    };
    if let Some(parent) = Path::new(&restored_path).parent() {
        let _ = fs::create_dir_all(parent);
    }

    git(
        &project_path,
        &["worktree", "add", &restored_path, &record.branch],
    )
    .await?;

    if let Some(stash_msg) = &record.stash_ref {
        // Now that the worktree exists again we can run git inside it
        // to find and apply the matching stash. The stash itself lives
        // on the parent repo's reflog, so listing from the new
        // worktree resolves up via the `.git` file the same way.
        if let Ok(list) = git(&restored_path, &["stash", "list"]).await {
            if let Some(stash_idx) = list
                .lines()
                .position(|line| line.contains(stash_msg.as_str()))
            {
                let stash_ref = format!("stash@{{{stash_idx}}}");
                let _ = git(
                    &restored_path,
                    &["stash", "apply", "--index", &stash_ref],
                )
                .await;
            }
        }
    }

    // Remove the JSON marker — once restored, history is no longer holding it.
    let _ = fs::remove_file(&file);

    let primary_tab = format!("t_{}", Uuid::new_v4().simple());
    let secondary_pty = format!("pty_{}", Uuid::new_v4().simple());

    Ok(WorktreeRow {
        id: new_id,
        project_id,
        branch: record.branch,
        name: record.name,
        path: restored_path,
        change_count: 0,
        agent_status: "idle".to_string(),
        agent_cli: record.agent_cli,
        created_at: record.created_at,
        tab_ids: vec![primary_tab.clone()],
        active_tab_id: Some(primary_tab),
        right_panel: "files".to_string(),
        right_split_pct: 60,
        secondary_tab: "terminal".to_string(),
        secondary_pty_id: secondary_pty,
    })
}

#[tauri::command]
pub async fn archive_list(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<ArchiveRecord>, String> {
    let dir = archive_dir(&app, &project_id)?;
    let mut out = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(record) = serde_json::from_str::<ArchiveRecord>(&raw) {
                out.push(record);
            }
        }
    }
    out.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
    Ok(out)
}

/// Try to find the project repo root from a worktree path. Worktrees
/// created by us live under `<app_data>/worktrees/<projectId>/<id>`,
/// so we can't traverse parents to find a `.git` — those checkouts have
/// a `.git` file pointing back to the original repo. Calling git in the
/// worktree path itself is fine for `worktree remove` since git resolves
/// upward through `.git` files; we just default to the worktree path.
fn infer_repo_root(worktree_path: &str) -> String {
    worktree_path.to_string()
}
