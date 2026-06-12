//! Git layer — shells out to the system `git` for everything.
//!
//! Why shell out (per CONTEXT.md decision): correctness against the
//! user's existing git config, credentials, hooks, signing, LFS, and
//! submodules. Performance is fine — git operations happen at click
//! speed, not frame speed.
//!
//! This module exposes only what the v1 features need:
//!   - `status` — for the file tree dirty marks (deferred) + git panel
//!   - `diff` — for the git panel and AI commit messages
//!   - `stage`, `unstage`, `commit`, `push` — git panel actions
//!   - `branch_current`, `branch_create` — for session worktrees
//!   - `worktree_add`, `worktree_remove` — session lifecycle (Task #9)
//!   - `log` — for the merge-back UI
//!g
//! AI commit messages now live in the helper-agent layer — see
//! `helper_agent.rs` and `src/lib/git.ts::aiCommitMessage`.

use std::path::Path;
use std::process::{Output, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

/* ------------------------------------------------------------------
   Helpers - test change
   ------------------------------------------------------------------ */

async fn run(cwd: &str, args: &[&str]) -> Result<String, String> {
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

/* ------------------------------------------------------------------
   Status — porcelain v2
   ------------------------------------------------------------------ */

#[derive(Debug, Serialize)]
pub struct StatusEntry {
    pub path: String,
    pub kind: String, // "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted"
    pub staged: bool,
}

#[derive(Debug, Serialize)]
pub struct StatusResult {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<StatusEntry>,
}

#[tauri::command]
pub async fn git_status(cwd: String) -> Result<StatusResult, String> {
    // Refresh git's stat cache before reading status. After operations
    // like merge/checkout/commit, files can spuriously appear modified
    // because the index mtime is stale even though file content is
    // identical. `update-index --refresh` reconciles the cache without
    // touching the working tree. Best-effort — non-zero exits are fine
    // (e.g. when there are real "needs update" entries; the subsequent
    // status call still returns the correct picture).
    let _ = run(&cwd, &["update-index", "--refresh"]).await;
    let raw = run(&cwd, &["status", "--porcelain=v2", "--branch"]).await?;
    Ok(parse_status_v2(&raw))
}

fn parse_status_v2(raw: &str) -> StatusResult {
    let mut branch = None;
    let mut upstream = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut entries = Vec::new();

    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            if rest != "(detached)" {
                branch = Some(rest.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            upstream = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // Format: "+<ahead> -<behind>"
            let mut parts = rest.split_whitespace();
            if let Some(a) = parts.next() {
                ahead = a.trim_start_matches('+').parse().unwrap_or(0);
            }
            if let Some(b) = parts.next() {
                behind = b.trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if let Some(rest) = line.strip_prefix("1 ") {
            // Ordinary changed: "1 XY ... <path>"
            entries.push(parse_change_entry(rest, false));
        } else if let Some(rest) = line.strip_prefix("2 ") {
            // Renamed/copied: "2 XY ... <path>\t<orig>"
            entries.push(parse_change_entry(rest, true));
        } else if let Some(rest) = line.strip_prefix("u ") {
            // Unmerged
            let path = rest.split_whitespace().last().unwrap_or("").to_string();
            entries.push(StatusEntry {
                path,
                kind: "conflicted".into(),
                staged: false,
            });
        } else if let Some(rest) = line.strip_prefix("? ") {
            entries.push(StatusEntry {
                path: rest.to_string(),
                kind: "untracked".into(),
                staged: false,
            });
        }
    }

    StatusResult {
        branch,
        upstream,
        ahead,
        behind,
        entries,
    }
}

fn parse_change_entry(rest: &str, renamed: bool) -> StatusEntry {
    // Ordinary: XY sub modeH modeI modeW hashH hashI <path>           — 8 tokens
    // Renamed:  XY sub modeH modeI modeW hashH hashI X<score> <path>\t<orig> — 9 tokens
    let xy = rest.split_whitespace().next().unwrap_or("..");
    let path_part = if renamed {
        rest.splitn(9, ' ').nth(8).unwrap_or("").to_string()
    } else {
        rest.splitn(8, ' ').nth(7).unwrap_or("").to_string()
    };
    let path = path_part
        .split_once('\t')
        .map(|(p, _)| p.to_string())
        .unwrap_or(path_part);

    let staged_char = xy.chars().next().unwrap_or('.');
    let work_char = xy.chars().nth(1).unwrap_or('.');
    let staged = staged_char != '.' && staged_char != ' ';

    let kind = match work_char {
        'M' => "modified",
        'A' | 'a' => "added",
        'D' | 'd' => "deleted",
        'R' | 'r' => "renamed",
        '.' | ' ' => match staged_char {
            'M' => "modified",
            'A' => "added",
            'D' => "deleted",
            'R' => "renamed",
            _ => "modified",
        },
        _ => "modified",
    }
    .to_string();

    StatusEntry { path, kind, staged }
}

/* ------------------------------------------------------------------
   Diff
   ------------------------------------------------------------------ */

/// Synthesize a `/dev/null`-vs-file diff for one path via
/// `git diff --no-index`. Plain `git diff` skips untracked files
/// entirely, so this is how brand-new files get shown — as an
/// all-additions block — in both the single-file viewer and the
/// all-changes view. `--no-index` exits 1 when the two inputs differ
/// (the normal case here), so 0 and 1 both count as success. Git
/// normalizes the header to `a/<path> b/<path>` with a `new file mode`
/// line, so the frontend's `diff --git` slicer parses it like any other.
async fn untracked_diff(cwd: &str, path: &str) -> Result<String, String> {
    let out = Command::new("git")
        .args(["diff", "--no-color", "--no-index", "--", "/dev/null", path])
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("spawn git: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    match out.status.code() {
        Some(0) | Some(1) => Ok(stdout),
        code => {
            let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
            Err(format!("git exited {}: {}", code.unwrap_or(-1), stderr.trim()))
        }
    }
}

#[tauri::command]
pub async fn git_diff(
    cwd: String,
    path: Option<String>,
    staged: bool,
    // When true, expand context so the *whole file* surrounds the
    // changes — the single-file viewer wants every line on screen with
    // the edits tinted in place, not just the default 3-line hunks. A
    // very large `--unified` value collapses the file into one hunk.
    full_file: Option<bool>,
) -> Result<String, String> {
    let mut args: Vec<&str> = vec!["diff"];
    if staged {
        args.push("--staged");
    }
    args.push("--no-color");
    if full_file.unwrap_or(false) {
        args.push("--unified=100000");
    }
    if let Some(p) = path.as_deref() {
        args.push("--");
        args.push(p);
    }
    let primary = run(&cwd, &args).await?;
    if !primary.is_empty() || staged {
        return Ok(primary);
    }
    // `git diff` deliberately ignores untracked files. If we got an
    // empty unstaged diff for a specific path, check whether it's
    // actually untracked — if so, synthesize a /dev/null-vs-file diff
    // via `--no-index` so the user can read the new file's contents
    // in the same viewer instead of seeing "no changes".
    let Some(p) = path.as_deref() else {
        return Ok(primary);
    };
    let untracked = run(&cwd, &["ls-files", "--others", "--exclude-standard", "--", p])
        .await
        .unwrap_or_default();
    if untracked.trim().is_empty() {
        return Ok(primary);
    }
    untracked_diff(&cwd, p).await
}

/// Aggregate diff stats vs HEAD (working tree + index). Powers the
/// "+N -M" indicator in the window chrome — one HEAD-relative summary
/// across every uncommitted change in the worktree.
#[derive(Debug, serde::Serialize)]
pub struct DiffStat {
    pub files: u32,
    pub insertions: u32,
    pub deletions: u32,
}

#[tauri::command]
pub async fn git_diff_all(cwd: String) -> Result<String, String> {
    // HEAD-relative so staged + unstaged collapse into one stream.
    // The frontend parses `diff --git` boundaries to slice the
    // result into per-file sections for the all-changes view.
    let mut combined = run(&cwd, &["diff", "HEAD", "--no-color"]).await?;

    // `git diff HEAD` deliberately omits untracked files, so brand-new
    // files (status "U") would silently miss from the all-changes view.
    // Append a synthesized /dev/null-vs-file diff for each untracked path
    // — the same `--no-index` trick the single-file viewer uses — so new
    // files read as all-additions alongside the tracked changes. Reusing
    // `git_status` means we diff exactly the paths the UI marks untracked.
    let status = git_status(cwd.clone()).await?;
    for entry in status.entries.iter().filter(|e| e.kind == "untracked") {
        // Best-effort: one unreadable file shouldn't blank the whole view.
        let Ok(block) = untracked_diff(&cwd, &entry.path).await else {
            continue;
        };
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str(&block);
    }
    Ok(combined)
}

#[tauri::command]
pub async fn git_diff_stat(cwd: String) -> Result<DiffStat, String> {
    // `git diff HEAD --shortstat` collapses every uncommitted change
    // (staged + unstaged) into a single summary line:
    //   ` 5 files changed, 18 insertions(+), 3 deletions(-)`
    // Some axes can be absent (e.g., adds-only commits drop the
    // deletions clause); we tolerate any combination.
    let out = run(&cwd, &["diff", "HEAD", "--shortstat"]).await?;
    let mut files = 0u32;
    let mut insertions = 0u32;
    let mut deletions = 0u32;
    for tok in out.split(',') {
        let t = tok.trim();
        // Pluck the leading integer of each phrase, then key off the
        // phrase's lexical content so we don't depend on hyphenation
        // quirks ("file changed" vs "files changed").
        let num: Option<u32> = t
            .split_whitespace()
            .next()
            .and_then(|s| s.parse().ok());
        let Some(n) = num else { continue };
        if t.contains("file") {
            files = n;
        } else if t.contains("insertion") {
            insertions = n;
        } else if t.contains("deletion") {
            deletions = n;
        }
    }
    Ok(DiffStat {
        files,
        insertions,
        deletions,
    })
}

/* ------------------------------------------------------------------
   Stage / commit / push
   ------------------------------------------------------------------ */

#[tauri::command]
pub async fn git_stage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["add", "--"];
    for p in &paths {
        args.push(p);
    }
    run(&cwd, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_unstage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    for p in &paths {
        args.push(p);
    }
    run(&cwd, &args).await.map(|_| ())
}

/// Discard local changes for the given paths — both staged AND worktree
/// modifications go back to HEAD. Untracked files are deleted from disk.
///
/// Tracked path → `git restore --source=HEAD --staged --worktree -- <path>`
/// Untracked file → `std::fs::remove_file`
/// Untracked directory → `std::fs::remove_dir_all`
///
/// This is destructive — there is no undo from git's perspective for
/// untracked files. The frontend gates it behind a confirm.
#[tauri::command]
pub async fn git_discard(cwd: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let status = git_status(cwd.clone()).await?;
    let mut tracked: Vec<String> = Vec::new();
    let mut untracked: Vec<String> = Vec::new();
    for p in &paths {
        let is_untracked = status
            .entries
            .iter()
            .any(|e| &e.path == p && e.kind == "untracked");
        if is_untracked {
            untracked.push(p.clone());
        } else {
            tracked.push(p.clone());
        }
    }
    if !tracked.is_empty() {
        let mut args: Vec<&str> = vec![
            "restore",
            "--source=HEAD",
            "--staged",
            "--worktree",
            "--",
        ];
        for p in &tracked {
            args.push(p);
        }
        run(&cwd, &args).await?;
    }
    for p in &untracked {
        let full = Path::new(&cwd).join(p);
        let result = if full.is_dir() {
            std::fs::remove_dir_all(&full)
        } else {
            std::fs::remove_file(&full)
        };
        result.map_err(|e| format!("delete {p}: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_commit(cwd: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("commit message cannot be empty".into());
    }
    run(&cwd, &["commit", "-m", &message]).await
}

/// Env vars we set on every network-touching git command so it can
/// never block on a credential prompt. The UI's "Pushing" button can
/// only return to idle when the Tauri command resolves; if git hangs
/// on a hidden askpass/passphrase prompt the spinner sticks forever.
/// With these set, missing credentials fail fast and the toast layer
/// shows the actual error.
///
///   * `GIT_TERMINAL_PROMPT=0` — disables git's own username/password
///     prompts (refuses the auth attempt instead of blocking on tty).
///   * `GIT_ASKPASS=` / `SSH_ASKPASS=` — neutralizes any external
///     askpass helper (Keychain Access, gnome-keyring, custom scripts).
///   * `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` — disables SSH's
///     interactive password / passphrase prompt for key-based pushes.
///
/// Tuple list (rather than mutating a Command directly) so the rule
/// is unit-testable without spawning a process.
const NON_INTERACTIVE_GIT_ENV: &[(&str, &str)] = &[
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_ASKPASS", ""),
    ("SSH_ASKPASS", ""),
    ("GIT_SSH_COMMAND", "ssh -o BatchMode=yes"),
];

/// Wall-clock limit for `git push`. Set high enough that a slow push
/// over a poor connection completes, but low enough that a genuinely
/// hung command surfaces to the user instead of looking dead. 60s is
/// the same ceiling the GitHub git client uses.
const PUSH_TIMEOUT: Duration = Duration::from_secs(60);

#[tauri::command]
pub async fn git_push(
    cwd: String,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<String, String> {
    if !Path::new(&cwd).exists() {
        return Err(format!("cwd does not exist: {cwd}"));
    }
    // Determine what to push:
    //   • If the caller specified remote+branch explicitly, honor them
    //     verbatim — power-user override stays power-user-shaped.
    //   • Otherwise resolve the current branch name and push with an
    //     explicit `HEAD:<branch>` refspec to origin. This works in
    //     every case the bare `git push` form does NOT:
    //       - upstream missing (would otherwise need -u)
    //       - upstream points at a *different* branch name (would
    //         otherwise fail with "The upstream branch of your current
    //         branch does not match the name of your current branch"
    //         under push.default=simple)
    //   We also pass `-u` so a successful push retargets the upstream
    //   to origin/<branch> — subsequent plain `git push` from the
    //   terminal will then work without flags.
    let mut args: Vec<String> = vec!["push".into()];
    if let Some(r) = remote.as_deref() {
        args.push(r.to_string());
        if let Some(b) = branch.as_deref() {
            args.push(b.to_string());
        }
    } else {
        let resolved_branch = run(&cwd, &["symbolic-ref", "--short", "HEAD"])
            .await
            .map_err(|e| format!("could not determine current branch: {e}"))?
            .trim()
            .to_string();
        if resolved_branch.is_empty() {
            return Err("could not determine current branch (detached HEAD?)".into());
        }
        args.extend([
            "-u".into(),
            "origin".into(),
            format!("HEAD:{resolved_branch}"),
        ]);
    }
    let args_refs: Vec<&str> = args.iter().map(String::as_str).collect();

    let mut command = Command::new("git");
    command
        .args(&args_refs)
        .current_dir(&cwd)
        // Close stdin so git can never block on a read (some flows ask
        // for confirmation via stdin even when askpass is suppressed).
        .stdin(Stdio::null());
    for (k, v) in NON_INTERACTIVE_GIT_ENV {
        command.env(k, v);
    }

    let output = tokio::time::timeout(PUSH_TIMEOUT, command.output())
        .await
        .map_err(|_| {
            format!(
                "git push timed out after {}s — check the remote URL, credentials, or network",
                PUSH_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("spawn git: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(explain_push_error(&stderr))
    }
}

/// Translate a raw `git push` stderr into a user-actionable message.
/// Plain bubble-up is fine for most failures, but the two we see
/// repeatedly in support — SSH auth and unreachable remote — get
/// expanded hints because the raw line ("Permission denied
/// (publickey)") doesn't tell a non-git-expert user what to do.
fn explain_push_error(stderr: &str) -> String {
    let trimmed = stderr.trim();
    if stderr.contains("Permission denied (publickey)") {
        format!(
            "git rejected your SSH key. To fix:\n\
             • Make sure the key is registered with the remote (e.g. github.com/settings/keys).\n\
             • Make sure ssh-agent has it loaded — run `ssh-add ~/.ssh/id_ed25519` (or your key path) from a terminal.\n\
             • If push works from your terminal but not from Goonware, relaunch Goonware from a terminal as a workaround — Goonware tries to pick up SSH_AUTH_SOCK automatically but if it failed, launching from a terminal is the bypass.\n\n\
             Original: {trimmed}"
        )
    } else if stderr.contains("Could not resolve host") {
        format!("Couldn't reach the remote host. Check your network connection.\n\nOriginal: {trimmed}")
    } else if stderr.contains("Updates were rejected because the remote contains work") {
        format!(
            "Remote has commits you don't. Pull (or rebase) first, then push again.\n\nOriginal: {trimmed}"
        )
    } else {
        format!("git push failed: {trimmed}")
    }
}

/* ------------------------------------------------------------------
   Branches & worktrees (Task #9 builds on these)
   ------------------------------------------------------------------ */

/// List configured remotes for the repo at `cwd`. Used by the
/// Repository settings page to populate the "Remote origin" dropdown.
#[tauri::command]
pub async fn git_remotes(cwd: String) -> Result<Vec<String>, String> {
    let raw = run(&cwd, &["remote"]).await?;
    Ok(raw
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

#[tauri::command]
pub async fn git_branch_current(cwd: String) -> Result<String, String> {
    run(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
}

/// Local branches, sorted by recency of last commit. Used to populate
/// the BranchSwitcher popover. Each entry includes whether it's the
/// currently checked-out branch so the UI can mark it.
#[derive(Debug, Serialize)]
pub struct BranchEntry {
    pub name: String,
    pub current: bool,
}

#[tauri::command]
pub async fn git_branch_list(cwd: String) -> Result<Vec<BranchEntry>, String> {
    let raw = run(
        &cwd,
        &[
            "for-each-ref",
            "--format=%(HEAD)\t%(refname:short)",
            "--sort=-committerdate",
            "refs/heads",
        ],
    )
    .await?;
    Ok(raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let mut parts = line.splitn(2, '\t');
            let head = parts.next()?;
            let name = parts.next()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some(BranchEntry {
                name,
                current: head.trim() == "*",
            })
        })
        .collect())
}

#[tauri::command]
pub async fn git_checkout(cwd: String, branch: String) -> Result<(), String> {
    run(&cwd, &["checkout", &branch]).await.map(|_| ())
}

/// Create a new branch from the current HEAD and check it out. If
/// `from` is provided, branches off that ref instead.
#[tauri::command]
pub async fn git_branch_create(
    cwd: String,
    name: String,
    from: Option<String>,
) -> Result<(), String> {
    let mut args = vec!["checkout", "-b", name.as_str()];
    let from_owned: String;
    if let Some(f) = from.as_deref() {
        from_owned = f.to_string();
        args.push(&from_owned);
    }
    run(&cwd, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_worktree_add(
    cwd: String,
    path: String,
    branch: String,
) -> Result<(), String> {
    run(&cwd, &["worktree", "add", "-b", &branch, &path])
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn git_worktree_remove(
    cwd: String,
    path: String,
    force: bool,
) -> Result<(), String> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&path);
    run(&cwd, &args).await.map(|_| ())
}

/* ------------------------------------------------------------------
   History graph — commits across ALL refs (local, remote, tags) so
   the right-panel git tree can show what teammates pushed to main
   alongside local work. The frontend computes lane layout; this
   command just emits structured commits in date order.
   ------------------------------------------------------------------ */

/// A decorated ref on a commit. `kind` is one of "head" (the local
/// branch HEAD currently points at), "branch" (other local branch),
/// "remote" (e.g. origin/main), "tag".
#[derive(Debug, Serialize, PartialEq)]
pub struct CommitRef {
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Serialize)]
pub struct GraphCommit {
    pub hash: String,
    pub short: String,
    pub parents: Vec<String>,
    pub refs: Vec<CommitRef>,
    pub author: String,
    pub email: String,
    /// Unix seconds — the frontend formats compact absolute times.
    pub timestamp: i64,
    pub subject: String,
}

/// Unit separator — cannot appear in author names / subjects, unlike
/// tabs. Same trick `%x09` plays in `git_log`, but collision-proof.
const US: char = '\u{1f}';

#[tauri::command]
pub async fn git_log_graph(
    cwd: String,
    n: Option<u32>,
) -> Result<Vec<GraphCommit>, String> {
    let count = n.unwrap_or(200).to_string();
    let remotes = remote_names(&cwd).await;
    let raw = run(
        &cwd,
        &[
            "log",
            // Stash entries are refs too — without the exclude they'd
            // litter the graph with "WIP on <branch>" merge commits.
            "--exclude=refs/stash",
            "--all",
            // Children before parents, ordered by commit date within
            // that constraint — the layout the lane algorithm expects
            // and the order every git GUI's graph reads in.
            "--date-order",
            "-n",
            &count,
            "--pretty=format:%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%at%x1f%s",
        ],
    )
    .await?;
    Ok(parse_log_graph(&raw, &remotes))
}

/// Remote names for ref classification. Best-effort — an empty list
/// just means every decorated ref classifies as a local branch/tag.
async fn remote_names(cwd: &str) -> Vec<String> {
    run(cwd, &["remote"])
        .await
        .map(|raw| {
            raw.lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn parse_log_graph(raw: &str, remotes: &[String]) -> Vec<GraphCommit> {
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let mut p = line.splitn(8, US);
            let hash = p.next()?.to_string();
            let short = p.next()?.to_string();
            let parents = p
                .next()?
                .split_whitespace()
                .map(str::to_string)
                .collect();
            let refs = parse_decorations(p.next()?, remotes);
            let author = p.next()?.to_string();
            let email = p.next()?.to_string();
            let timestamp = p.next()?.trim().parse().ok()?;
            let subject = p.next().unwrap_or("").to_string();
            Some(GraphCommit {
                hash,
                short,
                parents,
                refs,
                author,
                email,
                timestamp,
                subject,
            })
        })
        .collect()
}

/// Parse `%D` decorations: `HEAD -> main, origin/main, tag: v1.2`.
/// Detached `HEAD` (no arrow) is surfaced as a "head" ref named HEAD.
/// Remote refs are recognized by their first path segment matching a
/// configured remote — a name test alone can't do it, since local
/// branches legitimately contain slashes (`feature/auth`).
fn parse_decorations(raw: &str, remotes: &[String]) -> Vec<CommitRef> {
    raw.split(", ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|part| {
            if let Some(branch) = part.strip_prefix("HEAD -> ") {
                CommitRef {
                    name: branch.to_string(),
                    kind: "head".into(),
                }
            } else if let Some(tag) = part.strip_prefix("tag: ") {
                CommitRef {
                    name: tag.to_string(),
                    kind: "tag".into(),
                }
            } else if part == "HEAD" {
                CommitRef {
                    name: "HEAD".into(),
                    kind: "head".into(),
                }
            } else {
                let is_remote = part
                    .split_once('/')
                    .is_some_and(|(first, _)| remotes.iter().any(|r| r == first));
                CommitRef {
                    name: part.to_string(),
                    kind: if is_remote { "remote" } else { "branch" }.into(),
                }
            }
        })
        .collect()
}

/* ------------------------------------------------------------------
   Commit inspection — metadata + diff for the commit-detail tab.
   ------------------------------------------------------------------ */

#[derive(Debug, Serialize)]
pub struct CommitDetail {
    pub hash: String,
    pub short: String,
    pub parents: Vec<String>,
    pub refs: Vec<CommitRef>,
    pub author: String,
    pub email: String,
    pub date: String,
    pub relative_time: String,
    pub subject: String,
    pub body: String,
}

#[tauri::command]
pub async fn git_commit_detail(
    cwd: String,
    hash: String,
) -> Result<CommitDetail, String> {
    let remotes = remote_names(&cwd).await;
    let raw = run(
        &cwd,
        &[
            "show",
            "-s",
            "--date=format:%B %-d, %Y at %-I:%M %p",
            "--pretty=format:%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%ad%x1f%ar%x1f%s%x1f%b",
            &hash,
        ],
    )
    .await?;
    parse_commit_detail(&raw, &remotes)
        .ok_or_else(|| format!("could not parse commit {hash}"))
}

fn parse_commit_detail(raw: &str, remotes: &[String]) -> Option<CommitDetail> {
    // %b (the body) is last and may contain anything including
    // newlines, so split the whole record — not line-by-line.
    let mut p = raw.splitn(10, US);
    Some(CommitDetail {
        hash: p.next()?.to_string(),
        short: p.next()?.to_string(),
        parents: p
            .next()?
            .split_whitespace()
            .map(str::to_string)
            .collect(),
        refs: parse_decorations(p.next()?, remotes),
        author: p.next()?.to_string(),
        email: p.next()?.to_string(),
        date: p.next()?.to_string(),
        relative_time: p.next()?.to_string(),
        subject: p.next()?.to_string(),
        body: p.next().unwrap_or("").trim().to_string(),
    })
}

/// Unified diff a commit introduced. Merge commits diff against their
/// FIRST parent — "what landed on this branch when the merge happened"
/// — matching what Fork/Tower show. Root commits (no parent) fall back
/// to `git show`, which renders them as all-additions.
#[tauri::command]
pub async fn git_commit_diff(cwd: String, hash: String) -> Result<String, String> {
    let parents = run(&cwd, &["rev-list", "--parents", "-n", "1", &hash]).await?;
    let first_parent = parents.split_whitespace().nth(1).map(str::to_string);
    match first_parent {
        Some(parent) => {
            run(&cwd, &["diff", "--no-color", &parent, &hash]).await
        }
        None => run(&cwd, &["show", "--no-color", "--format=", &hash]).await,
    }
}

/* ------------------------------------------------------------------
   Network ops — fetch / pull / clone. All run with the same
   non-interactive env as push so a missing credential fails fast
   instead of hanging the UI on an invisible prompt.
   ------------------------------------------------------------------ */

const FETCH_TIMEOUT: Duration = Duration::from_secs(60);
/// Clones move whole repos, not refs — give them room.
const CLONE_TIMEOUT: Duration = Duration::from_secs(300);

async fn run_network(
    cwd: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let mut command = Command::new("git");
    command.args(args).stdin(Stdio::null());
    if let Some(dir) = cwd {
        if !Path::new(dir).exists() {
            return Err(format!("cwd does not exist: {dir}"));
        }
        command.current_dir(dir);
    }
    for (k, v) in NON_INTERACTIVE_GIT_ENV {
        command.env(k, v);
    }
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| {
            format!(
                "git {} timed out after {}s — check the remote URL, credentials, or network",
                args.first().unwrap_or(&"command"),
                timeout.as_secs()
            )
        })?
        .map_err(|e| format!("spawn git: {e}"))?;
    if output.status.success() {
        // fetch/clone narrate progress on stderr; surface it so the
        // caller has something to show ("From github.com:… main -> …").
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        if stdout.trim().is_empty() {
            Ok(String::from_utf8_lossy(&output.stderr).into_owned())
        } else {
            Ok(stdout)
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(explain_push_error(&stderr))
    }
}

/// `git fetch --all --prune` — refresh every remote so the history
/// graph shows what teammates pushed without touching the worktree.
#[tauri::command]
pub async fn git_fetch(cwd: String) -> Result<String, String> {
    run_network(Some(&cwd), &["fetch", "--all", "--prune"], FETCH_TIMEOUT).await
}

/// Plain `git pull` — honors the user's configured merge/rebase
/// strategy rather than imposing one.
#[tauri::command]
pub async fn git_pull(cwd: String) -> Result<String, String> {
    run_network(Some(&cwd), &["pull"], FETCH_TIMEOUT).await
}

/// Clone `url` into `dest_dir/<repo-name>` and return the new repo's
/// absolute path so the frontend can register it as a project.
#[tauri::command]
pub async fn git_clone(url: String, dest_dir: String) -> Result<String, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("repository URL cannot be empty".into());
    }
    let name = clone_dir_name(&url);
    if name.is_empty() {
        return Err(format!("could not derive a directory name from {url}"));
    }
    let target = Path::new(&dest_dir).join(&name);
    if target.exists() {
        return Err(format!("{} already exists", target.display()));
    }
    let target_str = target.to_string_lossy().into_owned();
    run_network(None, &["clone", &url, &target_str], CLONE_TIMEOUT).await?;
    Ok(target_str)
}

/// `git@github.com:org/repo.git` / `https://github.com/org/repo` →
/// `repo`. Mirrors git's own default-directory derivation.
fn clone_dir_name(url: &str) -> String {
    url.trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()
        .unwrap_or("")
        .trim_end_matches(".git")
        .to_string()
}

#[tauri::command]
pub async fn git_log(cwd: String, n: Option<u32>) -> Result<Vec<LogEntry>, String> {
    let count = n.unwrap_or(20).to_string();
    let raw = run(
        &cwd,
        &[
            "log",
            "-n",
            &count,
            "--pretty=format:%H%x09%an%x09%ar%x09%s",
        ],
    )
    .await?;
    Ok(parse_log(&raw))
}

fn parse_log(raw: &str) -> Vec<LogEntry> {
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let mut parts = line.splitn(4, '\t');
            Some(LogEntry {
                hash: parts.next()?.to_string(),
                author: parts.next()?.to_string(),
                relative_time: parts.next()?.to_string(),
                subject: parts.next().unwrap_or("").to_string(),
            })
        })
        .collect()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LogEntry {
    pub hash: String,
    pub author: String,
    pub relative_time: String,
    pub subject: String,
}

/* ------------------------------------------------------------------
   AI commit message — moved to the helper-agent layer.

   The frontend now reads the staged diff via `git_diff` and calls
   `helper_run` with the worktree's CLI directly. See
   `src/lib/git.ts::aiCommitMessage` for the new path.
   ------------------------------------------------------------------ */

/* ------------------------------------------------------------------
   Tests
   ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_head_and_upstream() {
        let raw = "# branch.oid abc123\n\
                   # branch.head main\n\
                   # branch.upstream origin/main\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.branch.as_deref(), Some("main"));
        assert_eq!(r.upstream.as_deref(), Some("origin/main"));
    }

    #[test]
    fn detached_head_leaves_branch_none() {
        let raw = "# branch.head (detached)\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.branch, None);
    }

    #[test]
    fn parses_branch_ab_into_ahead_and_behind() {
        let raw = "# branch.ab +3 -1\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.ahead, 3);
        assert_eq!(r.behind, 1);
    }

    #[test]
    fn branch_ab_with_zero_zero() {
        let raw = "# branch.ab +0 -0\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.ahead, 0);
        assert_eq!(r.behind, 0);
    }

    #[test]
    fn parses_unstaged_modified_entry() {
        // XY = .M → unstaged worktree modification
        let raw = "1 .M N... 100644 100644 100644 abc def src/main.rs\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.entries.len(), 1);
        let e = &r.entries[0];
        assert_eq!(e.path, "src/main.rs");
        assert_eq!(e.kind, "modified");
        assert!(!e.staged);
    }

    #[test]
    fn parses_staged_modified_entry() {
        // XY = M. → staged modification, worktree clean
        let raw = "1 M. N... 100644 100644 100644 abc def src/main.rs\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.entries.len(), 1);
        let e = &r.entries[0];
        assert_eq!(e.path, "src/main.rs");
        assert_eq!(e.kind, "modified");
        assert!(e.staged);
    }

    #[test]
    fn parses_staged_added_entry() {
        // XY = A. → staged add
        let raw = "1 A. N... 000000 100644 100644 0000000 abc src/new_file.rs\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.entries.len(), 1);
        let e = &r.entries[0];
        assert_eq!(e.path, "src/new_file.rs");
        assert_eq!(e.kind, "added");
        assert!(e.staged);
    }

    #[test]
    fn parses_staged_deleted_entry() {
        let raw = "1 D. N... 100644 000000 000000 abc 0000000 src/gone.rs\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.entries.len(), 1);
        let e = &r.entries[0];
        assert_eq!(e.path, "src/gone.rs");
        assert_eq!(e.kind, "deleted");
        assert!(e.staged);
    }

    #[test]
    fn parses_untracked_entry() {
        let raw = "? src/foo.rs\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.entries.len(), 1);
        let e = &r.entries[0];
        assert_eq!(e.path, "src/foo.rs");
        assert_eq!(e.kind, "untracked");
        assert!(!e.staged);
    }

    #[test]
    fn parses_conflicted_entry() {
        // u XY sub m1 m2 m3 mW h1 h2 h3 path  (10 tokens after the 'u ' prefix)
        let raw = "u UU N... 100644 100644 100644 100644 abc def ghi src/conflict.rs\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.entries.len(), 1);
        let e = &r.entries[0];
        assert_eq!(e.path, "src/conflict.rs");
        assert_eq!(e.kind, "conflicted");
    }

    #[test]
    fn parses_renamed_entry_extracts_new_path() {
        // 2 XY sub modeH modeI modeW hashH hashI <X><score> <new>\t<old>
        let raw = "2 R. N... 100644 100644 100644 abc def R100 src/new.rs\tsrc/old.rs\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.entries.len(), 1);
        let e = &r.entries[0];
        assert_eq!(e.path, "src/new.rs");
        assert_eq!(e.kind, "renamed");
        assert!(e.staged);
    }

    #[test]
    fn full_status_with_branch_and_mixed_entries() {
        let raw = "# branch.oid abc123\n\
                   # branch.head feature/auth\n\
                   # branch.upstream origin/feature/auth\n\
                   # branch.ab +2 -3\n\
                   1 .M N... 100644 100644 100644 abc def src/lib.rs\n\
                   1 M. N... 100644 100644 100644 abc def src/main.rs\n\
                   ? README.new\n\
                   2 R. N... 100644 100644 100644 abc def R100 src/new.rs\tsrc/old.rs\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.branch.as_deref(), Some("feature/auth"));
        assert_eq!(r.upstream.as_deref(), Some("origin/feature/auth"));
        assert_eq!(r.ahead, 2);
        assert_eq!(r.behind, 3);
        assert_eq!(r.entries.len(), 4);

        assert_eq!(r.entries[0].path, "src/lib.rs");
        assert_eq!(r.entries[0].kind, "modified");
        assert!(!r.entries[0].staged);

        assert_eq!(r.entries[1].path, "src/main.rs");
        assert_eq!(r.entries[1].kind, "modified");
        assert!(r.entries[1].staged);

        assert_eq!(r.entries[2].path, "README.new");
        assert_eq!(r.entries[2].kind, "untracked");
        assert!(!r.entries[2].staged);

        assert_eq!(r.entries[3].path, "src/new.rs");
        assert_eq!(r.entries[3].kind, "renamed");
        assert!(r.entries[3].staged);
    }

    #[test]
    fn empty_status_returns_no_entries() {
        let r = parse_status_v2("");
        assert!(r.entries.is_empty());
        assert_eq!(r.branch, None);
        assert_eq!(r.ahead, 0);
        assert_eq!(r.behind, 0);
    }

    /* ---------- log parser ---------- */

    #[test]
    fn parses_single_log_entry() {
        let raw = "abc1234\tRaeed\t2 days ago\tfix the parser bug\n";
        let entries = parse_log(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].hash, "abc1234");
        assert_eq!(entries[0].author, "Raeed");
        assert_eq!(entries[0].relative_time, "2 days ago");
        assert_eq!(entries[0].subject, "fix the parser bug");
    }

    #[test]
    fn parses_multiple_log_entries() {
        let raw = "h1\tA\t1 day ago\tfirst\n\
                   h2\tB\t2 days ago\tsecond\n\
                   h3\tC\t3 days ago\tthird\n";
        let entries = parse_log(raw);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].subject, "first");
        assert_eq!(entries[1].author, "B");
        assert_eq!(entries[2].hash, "h3");
    }

    #[test]
    fn parse_log_skips_blank_lines() {
        let raw = "\n\
                   h1\tA\t1 day ago\ttest\n\
                   \n";
        let entries = parse_log(raw);
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn parse_log_preserves_tabs_in_subject() {
        // splitn(4, '\t') keeps the rest of the line — including tabs — in the subject.
        let raw = "h1\tA\t1d\tsubject\twith\ttabs\n";
        let entries = parse_log(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].subject, "subject\twith\ttabs");
    }

    #[test]
    fn parse_log_empty_input_returns_empty() {
        assert!(parse_log("").is_empty());
    }

    #[test]
    fn parse_log_subject_with_unicode() {
        let raw = "h1\tÅlex\t1 hour ago\t✨ initial commit\n";
        let entries = parse_log(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].author, "Ålex");
        assert_eq!(entries[0].subject, "✨ initial commit");
    }

    #[test]
    fn parse_log_malformed_line_is_skipped() {
        let raw = "h1\tA\t1d\tgood\n\
                   no_tabs_here\n\
                   h2\tB\t2d\talso good\n";
        let entries = parse_log(raw);
        // The malformed line lacks the required hash/author/time fields.
        // splitn produces only 1 part → parts.next() returns hash but parts.next() for
        // author returns None → ? short-circuits filter_map, dropping the line.
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].subject, "good");
        assert_eq!(entries[1].subject, "also good");
    }

    /* ---------- history graph parser ---------- */

    #[test]
    fn parses_graph_commit_with_refs_and_parents() {
        let raw = "aaa\u{1f}aa1\u{1f}bbb ccc\u{1f}HEAD -> main, origin/main, tag: v1.0\u{1f}Raeed\u{1f}r@x.dev\u{1f}1717200000\u{1f}merge it\n";
        let commits = parse_log_graph(raw, &["origin".to_string()]);
        assert_eq!(commits.len(), 1);
        let c = &commits[0];
        assert_eq!(c.hash, "aaa");
        assert_eq!(c.short, "aa1");
        assert_eq!(c.parents, vec!["bbb", "ccc"]);
        assert_eq!(c.author, "Raeed");
        assert_eq!(c.email, "r@x.dev");
        assert_eq!(c.timestamp, 1717200000);
        assert_eq!(c.subject, "merge it");
        assert_eq!(
            c.refs,
            vec![
                CommitRef { name: "main".into(), kind: "head".into() },
                CommitRef { name: "origin/main".into(), kind: "remote".into() },
                CommitRef { name: "v1.0".into(), kind: "tag".into() },
            ]
        );
    }

    #[test]
    fn graph_commit_without_decorations_or_parents() {
        let raw = "root\u{1f}r00\u{1f}\u{1f}\u{1f}A\u{1f}a@b.c\u{1f}100\u{1f}initial\n";
        let commits = parse_log_graph(raw, &["origin".to_string()]);
        assert_eq!(commits.len(), 1);
        assert!(commits[0].parents.is_empty());
        assert!(commits[0].refs.is_empty());
    }

    #[test]
    fn decorations_detached_head() {
        let refs = parse_decorations("HEAD, origin/feat", &["origin".to_string()]);
        assert_eq!(refs[0].kind, "head");
        assert_eq!(refs[0].name, "HEAD");
        assert_eq!(refs[1].kind, "remote");
    }

    #[test]
    fn decorations_local_branch_without_head() {
        let refs = parse_decorations("feature/auth", &["origin".to_string()]);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].kind, "branch");
        assert_eq!(refs[0].name, "feature/auth");
    }

    /* ---------- commit detail parser ---------- */

    #[test]
    fn parses_commit_detail_with_multiline_body() {
        let raw = "aaa\u{1f}aa1\u{1f}bbb\u{1f}origin/main\u{1f}dorocha\u{1f}me@dorocha.dev\u{1f}June 1, 2026 at 12:04 AM\u{1f}2 days ago\u{1f}docs: remove refs\u{1f}line one\n\nline two\n";
        let d = parse_commit_detail(raw, &["origin".to_string()]).expect("parses");
        assert_eq!(d.short, "aa1");
        assert_eq!(d.parents, vec!["bbb"]);
        assert_eq!(d.refs[0].kind, "remote");
        assert_eq!(d.subject, "docs: remove refs");
        assert_eq!(d.body, "line one\n\nline two");
        assert_eq!(d.date, "June 1, 2026 at 12:04 AM");
    }

    #[test]
    fn commit_detail_empty_body() {
        let raw = "a\u{1f}a1\u{1f}\u{1f}\u{1f}A\u{1f}a@b.c\u{1f}d\u{1f}now\u{1f}subject\u{1f}";
        let d = parse_commit_detail(raw, &[]).expect("parses");
        assert_eq!(d.body, "");
        assert!(d.parents.is_empty());
    }

    /* ---------- clone dir derivation ---------- */

    #[test]
    fn clone_dir_name_handles_common_url_shapes() {
        assert_eq!(clone_dir_name("git@github.com:org/repo.git"), "repo");
        assert_eq!(clone_dir_name("https://github.com/org/repo"), "repo");
        assert_eq!(clone_dir_name("https://github.com/org/repo.git/"), "repo");
        assert_eq!(clone_dir_name("ssh://git@host/path/to/proj.git"), "proj");
    }

    /* ---------- git_push: stuck-Pushing UI guard ---------- */

    /// Every known channel git can use to prompt for credentials is
    /// suppressed before we shell out. Missing any of these and the UI
    /// can sit on "Pushing" forever waiting for a tty prompt no one
    /// will ever see — the bug this list is meant to prevent.
    #[test]
    fn non_interactive_env_covers_every_prompt_source() {
        let env: std::collections::HashMap<&str, &str> =
            NON_INTERACTIVE_GIT_ENV.iter().copied().collect();

        // git's own HTTPS username/password prompt.
        assert_eq!(env.get("GIT_TERMINAL_PROMPT"), Some(&"0"));

        // External askpass helpers — empty string means "no helper".
        assert!(env.contains_key("GIT_ASKPASS"));
        assert!(env.contains_key("SSH_ASKPASS"));

        // SSH key passphrase + host-key prompts.
        let ssh = env.get("GIT_SSH_COMMAND").expect("GIT_SSH_COMMAND set");
        assert!(
            ssh.contains("BatchMode=yes"),
            "GIT_SSH_COMMAND must include -o BatchMode=yes to suppress ssh prompts (got {ssh:?})"
        );
    }

    /// The publickey-denied case must surface as something a non-git
    /// expert can act on. Verifying the raw stderr is included
    /// verbatim — surface area for the user to paste into a bug
    /// report — plus our actionable hints.
    #[test]
    fn explain_push_error_translates_publickey_denial() {
        let raw = "git@github.com: Permission denied (publickey).\n\
                   fatal: Could not read from remote repository. Please make sure you have the correct access rights and the repository exists.";
        let msg = explain_push_error(raw);
        // Mentions SSH at all.
        assert!(msg.to_lowercase().contains("ssh"));
        // At least one of the concrete hints.
        assert!(
            msg.contains("ssh-add") || msg.contains("/settings/keys"),
            "expected an actionable SSH hint in message, got: {msg}"
        );
        // Preserves the original git output verbatim (trimmed).
        assert!(msg.contains(raw.trim()));
    }

    #[test]
    fn explain_push_error_translates_unreachable_host() {
        let raw = "fatal: Could not resolve host: github.com";
        let msg = explain_push_error(raw);
        assert!(msg.to_lowercase().contains("network"));
        assert!(msg.contains(raw));
    }

    #[test]
    fn explain_push_error_translates_non_fast_forward() {
        let raw = "! [rejected]        main -> main (fetch first)\n\
                   error: failed to push some refs to 'origin'\n\
                   hint: Updates were rejected because the remote contains work that you do not have locally.";
        let msg = explain_push_error(raw);
        assert!(msg.to_lowercase().contains("pull") || msg.to_lowercase().contains("rebase"));
        assert!(msg.contains(raw.trim()));
    }

    /// Unknown errors should pass through with the raw stderr intact.
    /// We never want to swallow a useful git message just because we
    /// haven't catalogued it.
    #[test]
    fn explain_push_error_passes_unknown_errors_through() {
        let raw = "fatal: some entirely new failure we have not seen yet";
        let msg = explain_push_error(raw);
        assert!(msg.contains(raw));
    }

    /// 60s is the upper bound that lets the user know the operation
    /// died versus thinking it's still running. Encoded so a refactor
    /// can't quietly relax it.
    #[test]
    fn push_timeout_is_at_most_one_minute() {
        assert!(
            PUSH_TIMEOUT <= Duration::from_secs(60),
            "PUSH_TIMEOUT must stay ≤60s so a hung push surfaces to the UI quickly"
        );
        assert!(
            PUSH_TIMEOUT >= Duration::from_secs(15),
            "PUSH_TIMEOUT must be ≥15s so a real slow push isn't killed mid-upload"
        );
    }
}
