//! Pull request creation. Drafts title + body via the worktree's
//! helper agent (Claude / Codex / Gemini), submits via `gh pr create`.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::helper_agent::{run_inline, HelperMode};

#[derive(Debug, Serialize, Deserialize)]
pub struct PrDraft {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PrCreated {
    pub url: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PrStatus {
    pub exists: bool,
    pub number: Option<u64>,
    pub url: Option<String>,
    /// One of OPEN, CLOSED, MERGED. None when no PR exists.
    pub state: Option<String>,
    /// One of MERGEABLE, CONFLICTING, UNKNOWN. None when no PR exists.
    pub mergeable: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResult {
    pub conflicts: bool,
    pub files: Vec<String>,
    /// True when local main was already up-to-date (no merge happened).
    pub already_up_to_date: bool,
}

/// Draft a PR title + body for the working-tree diff.
///
/// `extras` carries free-form custom instructions concatenated from
/// the repo's `general` + `createPR` preferences. Empty / None = no
/// extras.
#[tauri::command]
pub async fn pr_draft(
    cwd: String,
    cli: String,
    model: Option<String>,
    extras: Option<String>,
) -> Result<PrDraft, String> {
    if !Path::new(&cwd).exists() {
        return Err(format!("cwd does not exist: {cwd}"));
    }

    // Gather context: staged + unstaged diff (truncated) and the last
    // few commit subjects.
    let staged_diff = run_git(&cwd, &["diff", "--staged", "--no-color"]).await?;
    let working_diff = run_git(&cwd, &["diff", "--no-color"]).await?;
    let log = run_git(&cwd, &["log", "-n", "10", "--pretty=format:%s"]).await?;

    let mut prompt = String::new();
    if let Some(extras) = extras.as_deref() {
        let trimmed = extras.trim();
        if !trimmed.is_empty() {
            prompt.push_str("Custom instructions from this repo:\n");
            prompt.push_str(trimmed);
            prompt.push_str("\n\n");
        }
    }
    prompt.push_str("Recent commit subjects:\n");
    prompt.push_str(&log);
    prompt.push_str("\n\nStaged diff:\n");
    prompt.push_str(&truncate(&staged_diff, 4000));
    prompt.push_str("\n\nWorking-tree diff:\n");
    prompt.push_str(&truncate(&working_diff, 4000));

    let raw =
        run_inline(&cwd, &cli, HelperMode::PrDescription, &prompt, model.as_deref()).await?;

    // Parse the agent's output. The prompt asks for a plain
    // `<title>\n\n<body>` shape, but historically the helper has been
    // asked for JSON, so we accept either:
    //   1. Strict JSON `{"title": "...", "body": "..."}` (legacy).
    //   2. A markdown-fenced JSON block.
    //   3. Plain `<title>\n\n<body>` (current preferred shape).
    //
    // Anything that looks like a JSON wrapper but fails to parse —
    // because the agent included raw newlines inside string values,
    // which is invalid JSON — falls through to the plain-text path
    // rather than dumping `{"title":...}` into the user's PR body.
    let draft = parse_pr_draft(&raw);
    Ok(draft)
}

/// Try increasingly permissive shapes. Returns a clean PrDraft no
/// matter what — never leaks a raw JSON-looking blob into the body.
fn parse_pr_draft(raw: &str) -> PrDraft {
    // 1. Strip a leading "```json" / "```" fence pair if present.
    let unfenced = strip_code_fences(raw);

    // 2. If the whole thing is a JSON object, try to parse it
    //    strictly. Only accept if both fields parse to non-empty.
    if let Some((start, end)) = json_object_bounds(&unfenced) {
        let slice = &unfenced[start..end];
        if let Ok(parsed) = serde_json::from_str::<PrDraft>(slice) {
            if !parsed.title.trim().is_empty() {
                return PrDraft {
                    title: parsed.title.trim().to_string(),
                    body: parsed.body.trim().to_string(),
                };
            }
        }
    }

    // 3. Plain text path — first non-empty line is the title, the
    //    rest (after a blank line if present) is the body.
    let mut lines = unfenced.lines();
    let title = lines
        .by_ref()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string();
    let body = lines.collect::<Vec<&str>>().join("\n").trim().to_string();
    PrDraft { title, body }
}

fn strip_code_fences(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(stripped) = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
    {
        if let Some(content) = stripped.trim_start().strip_suffix("```") {
            return content.trim().to_string();
        }
        // Has opening fence but no closing — strip just the opener.
        return stripped.trim().to_string();
    }
    trimmed.to_string()
}

fn json_object_bounds(s: &str) -> Option<(usize, usize)> {
    let start = s.find('{')?;
    let end = s.rfind('}').map(|i| i + 1)?;
    if end > start {
        Some((start, end))
    } else {
        None
    }
}

#[tauri::command]
pub async fn pr_create(
    cwd: String,
    title: String,
    body: String,
) -> Result<PrCreated, String> {
    if !Path::new(&cwd).exists() {
        return Err(format!("cwd does not exist: {cwd}"));
    }
    // Get the branch ready: stage anything dirty, commit it under the PR
    // title, then push (setting upstream if needed). The dialog button
    // is a "ship it" gesture, not a "just call gh" call.
    prepare_branch_for_pr(&cwd, &title, &body).await?;

    let out = Command::new("gh")
        .args(["pr", "create", "--title", &title, "--body", &body])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("spawn gh: {e}. Is GitHub CLI installed? `brew install gh`"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "gh exited {}: {}",
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let url = stdout
        .lines()
        .rev()
        .find(|l| l.starts_with("https://"))
        .unwrap_or(stdout.as_str())
        .to_string();
    Ok(PrCreated { url })
}

/// Bring the worktree to a state where `gh pr create` can succeed:
/// every dirty file committed under the PR title (body as commit body),
/// and the branch pushed to its upstream (set with `-u` if missing).
///
/// Each step is conditional — a clean tree skips the commit, an already-
/// synced branch skips the push, so calling this on a fully-prepped
/// branch is a no-op.
pub(crate) async fn prepare_branch_for_pr(
    cwd: &str,
    title: &str,
    body: &str,
) -> Result<(), String> {
    // Resolve the branch FIRST. The default-branch handling below runs
    // before any mutation — landing a commit on `main` is a destructive
    // accident, and gh's "head == base" error would surface only after
    // we'd already shipped that commit.
    let mut branch = run_git_checked(cwd, &["symbolic-ref", "--short", "HEAD"])
        .await
        .map_err(|_| "could not determine current branch (detached HEAD?)".to_string())?
        .trim()
        .to_string();
    if branch.is_empty() {
        return Err("could not determine current branch (detached HEAD?)".into());
    }

    let porcelain = run_git_checked(cwd, &["status", "--porcelain"]).await?;
    let dirty = porcelain.lines().any(|l| !l.trim().is_empty());

    // If we're on the default branch with something to ship, lift those
    // changes onto a fresh feature branch derived from the PR title.
    // If there's nothing to ship, refuse — there's no PR to make.
    if is_default_branch(cwd, &branch).await {
        let ahead = branch_ahead_of_origin(cwd, &branch).await;
        if !dirty && !ahead {
            return Err(format!(
                "Refusing to create a PR from `{branch}` — it's the repo's default branch and there are no local changes to ship.\n\
                 Make a change first, or switch to a feature branch with unpushed commits."
            ));
        }
        let slug = title_to_branch_slug(title);
        let new_branch = unique_branch_name(cwd, &slug).await;
        run_git_checked(cwd, &["checkout", "-b", &new_branch]).await?;
        eprintln!(
            "[pr] auto-created feature branch `{new_branch}` from `{branch}` for the PR"
        );
        branch = new_branch;
    }

    if dirty {
        run_git_checked(cwd, &["add", "-A"]).await?;
        // Two -m flags becomes "title\n\nbody" in the commit — same shape
        // the PR will have. Skip the second when body is empty.
        let mut args: Vec<&str> = vec!["commit", "-m", title];
        let trimmed_body = body.trim();
        if !trimmed_body.is_empty() {
            args.push("-m");
            args.push(trimmed_body);
        }
        run_git_checked(cwd, &args).await?;
    }

    let has_upstream = run_git_checked(
        cwd,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .await
    .is_ok();

    let push_args: Vec<&str> = if has_upstream {
        // Already tracking. `git push` no-ops if up-to-date, pushes
        // otherwise — either way we end in the "remote matches local"
        // state pr_create needs.
        vec!["push"]
    } else {
        vec!["push", "-u", "origin", branch.as_str()]
    };

    push_with_https_fallback(cwd, &push_args).await?;
    Ok(())
}

/// Run a `git push`, and if it fails with `Permission denied (publickey)`
/// retry through HTTPS using `gh`'s credential helper.
///
/// Why: GLI inherits SSH_AUTH_SOCK from the login shell at startup, but
/// users who keep their key in a graphical agent (1Password, Secretive,
/// macOS keychain unlocked on-demand) sometimes have a socket path
/// their login shell can't see — the SSH push then fails even though
/// `gh` is already authenticated for HTTPS. Rather than make them
/// reconfigure their agent, we transparently push via HTTPS.
///
/// We do NOT mutate `remote.origin.url`. The retry passes
/// `-c remote.origin.pushurl=<https>` so the override is scoped to
/// this one process. Future SSH pushes still use the user's URL.
async fn push_with_https_fallback(cwd: &str, push_args: &[&str]) -> Result<(), String> {
    match run_git_push(cwd, push_args).await {
        Ok(()) => Ok(()),
        Err(err) if err.contains("Permission denied (publickey)") => {
            let Some(https) = ssh_remote_to_https(cwd, "origin").await else {
                return Err(explain_push_error(&err));
            };
            // Make sure `gh` is registered as a credential helper for
            // the remote host. Idempotent — safe to run every time.
            let _ = Command::new("gh")
                .args(["auth", "setup-git"])
                .current_dir(cwd)
                .output()
                .await;
            eprintln!("[pr] SSH push failed; retrying via HTTPS using gh credentials");
            let pushurl_cfg = format!("remote.origin.pushurl={https}");
            let mut retry: Vec<String> = vec!["-c".into(), pushurl_cfg];
            for a in push_args {
                retry.push((*a).to_string());
            }
            let retry_refs: Vec<&str> = retry.iter().map(String::as_str).collect();
            match run_git_push(cwd, &retry_refs).await {
                Ok(()) => Ok(()),
                Err(retry_err) => Err(format!(
                    "{}\n\nHTTPS fallback also failed: {}",
                    explain_push_error(&err),
                    retry_err.trim()
                )),
            }
        }
        Err(err) => Err(err),
    }
}

/// Translate a git SSH remote URL into its HTTPS form. Returns None for
/// any URL that isn't a recognized SSH shape — including URLs that are
/// already HTTPS (no conversion needed).
///
/// Forms handled:
///   git@github.com:user/repo(.git)         → https://github.com/user/repo(.git)
///   ssh://git@github.com/user/repo(.git)   → https://github.com/user/repo(.git)
///   ssh://git@github.com:22/user/repo.git  → https://github.com/user/repo.git
pub(crate) fn ssh_url_to_https(url: &str) -> Option<String> {
    let url = url.trim();
    if let Some(rest) = url.strip_prefix("ssh://git@") {
        // Strip optional port.
        let cleaned = match rest.split_once('/') {
            Some((host_with_port, path)) => {
                let host = host_with_port.split(':').next().unwrap_or(host_with_port);
                format!("{host}/{path}")
            }
            None => rest.to_string(),
        };
        return Some(format!("https://{cleaned}"));
    }
    if let Some(rest) = url.strip_prefix("git@") {
        // git@host:path
        let (host, path) = rest.split_once(':')?;
        if host.is_empty() || path.is_empty() {
            return None;
        }
        return Some(format!("https://{host}/{path}"));
    }
    None
}

async fn ssh_remote_to_https(cwd: &str, remote: &str) -> Option<String> {
    let raw = run_git(cwd, &["remote", "get-url", remote]).await.ok()?;
    ssh_url_to_https(raw.trim())
}

fn explain_push_error(err: &str) -> String {
    let trimmed = err.trim();
    if err.contains("Permission denied (publickey)") {
        format!(
            "git rejected your SSH key.\n\nTo fix:\n\
             • Make sure your key is loaded — run `ssh-add ~/.ssh/id_ed25519` (or your key path) from a terminal.\n\
             • Or relaunch GLI from a terminal so it inherits your SSH_AUTH_SOCK.\n\
             • Or switch the remote to HTTPS: `gh auth setup-git && git remote set-url origin <https-url>`.\n\n\
             Original: {trimmed}"
        )
    } else {
        format!("git push failed: {trimmed}")
    }
}

/// Lower-kebab-case slug derived from a PR title, suitable as a git
/// branch name. Non-alphanumerics become `-`, runs collapse, the result
/// is trimmed and capped at 50 chars. Empty / all-symbol titles fall
/// back to `pr-<unix-timestamp>` so we always return a valid ref name.
pub(crate) fn title_to_branch_slug(title: &str) -> String {
    let mut s: String = title
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    let trimmed = s.trim_matches('-').to_string();
    let mut out = if trimmed.len() > 50 {
        trimmed.chars().take(50).collect::<String>()
    } else {
        trimmed
    };
    out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        return format!("pr-{ts}");
    }
    out
}

/// Return a branch name that doesn't already exist in `cwd`, starting
/// from `base` and appending `-2`, `-3`, … as needed.
async fn unique_branch_name(cwd: &str, base: &str) -> String {
    let mut candidate = base.to_string();
    let mut n = 2;
    loop {
        let r = run_git_checked(
            cwd,
            &["rev-parse", "--verify", &format!("refs/heads/{candidate}")],
        )
        .await;
        if r.is_err() {
            return candidate;
        }
        if n > 50 {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            return format!("{base}-{ts}");
        }
        candidate = format!("{base}-{n}");
        n += 1;
    }
}

/// Does the local branch have commits not on `origin/<branch>`? Used
/// alongside the dirty-tree check to decide whether a default-branch
/// PR-creation has anything to actually ship.
async fn branch_ahead_of_origin(cwd: &str, branch: &str) -> bool {
    let arg = format!("origin/{branch}..HEAD");
    match run_git_checked(cwd, &["rev-list", "--count", &arg]).await {
        Ok(s) => s.trim().parse::<u32>().unwrap_or(0) > 0,
        Err(_) => false,
    }
}

/// Is `branch` the repo's base branch (so creating a PR from it would
/// either go nowhere or, worse, write commits to main)?
///
/// Prefers the authoritative source — `origin/HEAD` as set by `git
/// clone` — and falls back to the universal defaults when origin
/// hasn't published one (a fresh `git init`, an offline mirror, etc).
async fn is_default_branch(cwd: &str, branch: &str) -> bool {
    if let Ok(raw) =
        run_git_checked(cwd, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).await
    {
        if let Some(default) = raw.trim().strip_prefix("origin/") {
            if !default.is_empty() {
                return branch == default;
            }
        }
    }
    branch == "main" || branch == "master"
}

/// Env vars that keep network-touching git from blocking on credential
/// or passphrase prompts. Mirrors the rule in `git.rs::NON_INTERACTIVE_GIT_ENV`
/// so the PR push behaves like the git panel's push.
const NON_INTERACTIVE_GIT_ENV: &[(&str, &str)] = &[
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_ASKPASS", ""),
    ("SSH_ASKPASS", ""),
    ("GIT_SSH_COMMAND", "ssh -o BatchMode=yes"),
];

const PUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

async fn run_git_push(cwd: &str, args: &[&str]) -> Result<(), String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null());
    for (k, v) in NON_INTERACTIVE_GIT_ENV {
        command.env(k, v);
    }
    let out = tokio::time::timeout(PUSH_TIMEOUT, command.output())
        .await
        .map_err(|_| {
            format!(
                "git push timed out after {}s — check the remote URL, credentials, or network",
                PUSH_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("spawn git: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git push failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

async fn run_git_checked(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("spawn git: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.first().copied().unwrap_or(""),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Look up a PR for the worktree's branch via `gh pr view <branch>`.
/// Used by the chrome to flip the top-right button between Create-PR
/// and Merge once an open PR exists.
#[tauri::command]
pub async fn pr_status(cwd: String, branch: String) -> Result<PrStatus, String> {
    if !Path::new(&cwd).exists() {
        return Err(format!("cwd does not exist: {cwd}"));
    }
    if branch.is_empty() {
        return Ok(PrStatus {
            exists: false,
            number: None,
            url: None,
            state: None,
            mergeable: None,
        });
    }
    let out = Command::new("gh")
        .args([
            "pr",
            "view",
            &branch,
            "--json",
            "number,url,state,mergeable",
        ])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("spawn gh: {e}. Is GitHub CLI installed? `brew install gh`"))?;
    if !out.status.success() {
        // No PR for this branch is the common no-PR case; gh exits
        // non-zero with a "no pull requests found" message. Treat as
        // "not yet created" rather than an error.
        return Ok(PrStatus {
            exists: false,
            number: None,
            url: None,
            state: None,
            mergeable: None,
        });
    }
    #[derive(Deserialize)]
    struct ViewJson {
        number: u64,
        url: String,
        state: String,
        mergeable: String,
    }
    let parsed: ViewJson = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("parse gh json: {e}"))?;
    Ok(PrStatus {
        exists: true,
        number: Some(parsed.number),
        url: Some(parsed.url),
        state: Some(parsed.state),
        mergeable: Some(parsed.mergeable),
    })
}

/// Merge a PR via `gh pr merge` — server-side merge using the user's
/// existing GitHub auth. Defaults to `--merge` (merge commit). Pass
/// `"squash"` or `"rebase"` to override. Branch is deleted on remote
/// after a successful merge so the worktree's archive flow can be
/// followed up cleanly.
#[tauri::command]
pub async fn pr_merge(
    cwd: String,
    number: u64,
    method: String,
) -> Result<(), String> {
    if !Path::new(&cwd).exists() {
        return Err(format!("cwd does not exist: {cwd}"));
    }
    let flag = match method.as_str() {
        "squash" => "--squash",
        "rebase" => "--rebase",
        _ => "--merge",
    };
    let num = number.to_string();
    let out = Command::new("gh")
        .args(["pr", "merge", &num, flag, "--delete-branch"])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("spawn gh: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "gh pr merge failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Pull latest `<base>` from origin and merge it into the current
/// branch in the worktree. Surfaces conflict file paths so the chrome
/// can name them when delegating resolution to the agent. The merge is
/// left in-progress on conflict so the user / agent can edit and then
/// `git add` + `git commit` to finalize.
#[tauri::command]
pub async fn merge_base_into_branch(
    cwd: String,
    base: String,
) -> Result<ConflictResult, String> {
    if !Path::new(&cwd).exists() {
        return Err(format!("cwd does not exist: {cwd}"));
    }
    let base = if base.is_empty() {
        "main".to_string()
    } else {
        base
    };

    let _ = Command::new("git")
        .args(["fetch", "origin", &base])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("git fetch: {e}"))?;

    let merge_target = format!("origin/{base}");
    let out = Command::new("git")
        .args(["merge", "--no-edit", "--no-ff", &merge_target])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("git merge: {e}"))?;

    if out.status.success() {
        let stdout = String::from_utf8_lossy(&out.stdout);
        let already = stdout.contains("Already up to date")
            || stdout.contains("Already up-to-date");
        return Ok(ConflictResult {
            conflicts: false,
            files: vec![],
            already_up_to_date: already,
        });
    }

    // Probably conflicts. Confirm by listing unmerged paths.
    let lsout = Command::new("git")
        .args(["diff", "--name-only", "--diff-filter=U"])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("ls conflicts: {e}"))?;
    let files: Vec<String> = String::from_utf8_lossy(&lsout.stdout)
        .lines()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if files.is_empty() {
        // Merge failed for some other reason — surface the stderr so
        // we don't silently strand the user mid-operation.
        return Err(format!(
            "git merge failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(ConflictResult {
        conflicts: true,
        files,
        already_up_to_date: false,
    })
}

async fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("spawn git: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut head: String = s.chars().take(max).collect();
    head.push_str("\n…[truncated]…");
    head
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as SyncCommand;
    use tempfile::TempDir;

    /// Build an isolated local clone wired to a bare "remote" repo on
    /// disk. Returns (clone_dir, bare_dir). The clone has one initial
    /// commit on a feature branch with no upstream — the realistic
    /// pre-PR state.
    fn build_repo_with_bare_remote(initial_branch: &str) -> (TempDir, TempDir) {
        let bare = tempfile::tempdir().expect("tempdir bare");
        let clone = tempfile::tempdir().expect("tempdir clone");

        run_sync(bare.path(), &["init", "--bare", "--initial-branch=main"]);

        run_sync(clone.path(), &["init", "--initial-branch=main"]);
        run_sync(clone.path(), &["config", "user.email", "test@example.com"]);
        run_sync(clone.path(), &["config", "user.name", "Test User"]);
        run_sync(clone.path(), &["config", "commit.gpgsign", "false"]);
        run_sync(
            clone.path(),
            &["remote", "add", "origin", bare.path().to_str().unwrap()],
        );

        std::fs::write(clone.path().join("README.md"), "# init\n").unwrap();
        run_sync(clone.path(), &["add", "README.md"]);
        run_sync(clone.path(), &["commit", "-m", "init"]);
        run_sync(clone.path(), &["push", "-u", "origin", "main"]);

        run_sync(clone.path(), &["checkout", "-b", initial_branch]);
        (clone, bare)
    }

    fn run_sync(cwd: &std::path::Path, args: &[&str]) -> String {
        let out = SyncCommand::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn run_sync_allow_fail(cwd: &std::path::Path, args: &[&str]) -> (bool, String, String) {
        let out = SyncCommand::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("spawn git");
        (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        )
    }

    // ---- parse_pr_draft ------------------------------------------------

    #[test]
    fn parse_pr_draft_plain_text() {
        let raw = "Add login flow\n\nWires the new OAuth route into the\nhandler chain.";
        let d = parse_pr_draft(raw);
        assert_eq!(d.title, "Add login flow");
        assert_eq!(
            d.body,
            "Wires the new OAuth route into the\nhandler chain."
        );
    }

    #[test]
    fn parse_pr_draft_strict_json() {
        let raw = r#"{"title": "Fix race in cache", "body": "Use a Mutex around the map."}"#;
        let d = parse_pr_draft(raw);
        assert_eq!(d.title, "Fix race in cache");
        assert_eq!(d.body, "Use a Mutex around the map.");
    }

    #[test]
    fn parse_pr_draft_fenced_json() {
        let raw = "```json\n{\"title\":\"X\",\"body\":\"Y\"}\n```";
        let d = parse_pr_draft(raw);
        assert_eq!(d.title, "X");
        assert_eq!(d.body, "Y");
    }

    #[test]
    fn parse_pr_draft_invalid_json_falls_back_to_plain_text() {
        // Raw newlines inside a JSON string value break strict parsing;
        // the body should still come through, not the literal JSON.
        let raw = "{\"title\": \"hi\", \"body\": \"line1\nline2\"}";
        let d = parse_pr_draft(raw);
        // Title is the first non-empty line — the JSON header line in this case.
        assert!(!d.title.starts_with('{') || d.title.contains("title"));
        // Critical: the body must NOT be the raw JSON-looking blob.
        // It either parsed cleanly or fell back to plain-text lines.
        assert!(!d.body.contains("\"body\""));
    }

    // ---- prepare_branch_for_pr (behavior) ------------------------------

    #[tokio::test]
    async fn dirty_tree_gets_committed_and_pushed() {
        let (clone, _bare) = build_repo_with_bare_remote("feature/login");
        std::fs::write(clone.path().join("app.txt"), "hello\n").unwrap();

        let cwd = clone.path().to_str().unwrap();
        prepare_branch_for_pr(cwd, "Add login feature", "Body explaining why.")
            .await
            .expect("prepare succeeds");

        // Behavior 1: working tree is clean afterwards.
        let porcelain = run_sync(clone.path(), &["status", "--porcelain"]);
        assert!(porcelain.trim().is_empty(), "expected clean tree, got: {porcelain}");

        // Behavior 2: the head commit carries the PR title + body.
        let subject = run_sync(clone.path(), &["log", "-1", "--pretty=%s"]);
        assert_eq!(subject.trim(), "Add login feature");
        let bodymsg = run_sync(clone.path(), &["log", "-1", "--pretty=%b"]);
        assert!(
            bodymsg.contains("Body explaining why."),
            "expected body in commit, got: {bodymsg}"
        );

        // Behavior 3: branch has upstream set and is in sync with remote.
        let upstream = run_sync(
            clone.path(),
            &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        );
        assert_eq!(upstream.trim(), "origin/feature/login");
        let ahead = run_sync(
            clone.path(),
            &["rev-list", "--count", "@{u}..HEAD"],
        );
        assert_eq!(ahead.trim(), "0", "branch should be in sync with remote");
    }

    #[tokio::test]
    async fn clean_tree_with_unpushed_commits_only_pushes() {
        let (clone, _bare) = build_repo_with_bare_remote("feature/refactor");
        std::fs::write(clone.path().join("x.txt"), "x\n").unwrap();
        run_sync(clone.path(), &["add", "x.txt"]);
        run_sync(clone.path(), &["commit", "-m", "user's own commit"]);
        // No upstream yet; one commit ahead of where origin will be.

        let cwd = clone.path().to_str().unwrap();
        let head_before = run_sync(clone.path(), &["rev-parse", "HEAD"]);

        prepare_branch_for_pr(cwd, "PR title", "PR body")
            .await
            .expect("prepare succeeds");

        // No new commit was created — the user's existing commit is HEAD.
        let head_after = run_sync(clone.path(), &["rev-parse", "HEAD"]);
        assert_eq!(head_before.trim(), head_after.trim(),
            "no auto-commit when tree is clean");
        let subject = run_sync(clone.path(), &["log", "-1", "--pretty=%s"]);
        assert_eq!(subject.trim(), "user's own commit");

        // Branch is now pushed with upstream.
        let upstream = run_sync(
            clone.path(),
            &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        );
        assert_eq!(upstream.trim(), "origin/feature/refactor");
    }

    #[tokio::test]
    async fn fully_synced_branch_is_a_noop() {
        let (clone, _bare) = build_repo_with_bare_remote("feature/synced");
        std::fs::write(clone.path().join("x.txt"), "x\n").unwrap();
        run_sync(clone.path(), &["add", "x.txt"]);
        run_sync(clone.path(), &["commit", "-m", "already committed"]);
        run_sync(clone.path(), &["push", "-u", "origin", "feature/synced"]);

        let cwd = clone.path().to_str().unwrap();
        let head_before = run_sync(clone.path(), &["rev-parse", "HEAD"]);
        let remote_head_before =
            run_sync(clone.path(), &["rev-parse", "origin/feature/synced"]);

        prepare_branch_for_pr(cwd, "PR title", "PR body")
            .await
            .expect("prepare succeeds");

        let head_after = run_sync(clone.path(), &["rev-parse", "HEAD"]);
        let remote_head_after =
            run_sync(clone.path(), &["rev-parse", "origin/feature/synced"]);
        assert_eq!(head_before, head_after);
        assert_eq!(remote_head_before, remote_head_after);
    }

    #[tokio::test]
    async fn dirty_tree_with_empty_body_still_commits() {
        let (clone, _bare) = build_repo_with_bare_remote("feature/no-body");
        std::fs::write(clone.path().join("file.txt"), "content\n").unwrap();

        let cwd = clone.path().to_str().unwrap();
        prepare_branch_for_pr(cwd, "Title only", "")
            .await
            .expect("prepare succeeds");

        let porcelain = run_sync(clone.path(), &["status", "--porcelain"]);
        assert!(porcelain.trim().is_empty());
        let subject = run_sync(clone.path(), &["log", "-1", "--pretty=%s"]);
        assert_eq!(subject.trim(), "Title only");
    }

    #[tokio::test]
    async fn untracked_files_are_included_in_the_auto_commit() {
        // `git add -A` should pick up brand-new files, not just edits.
        let (clone, _bare) = build_repo_with_bare_remote("feature/new-files");
        std::fs::write(clone.path().join("brand_new.txt"), "shiny\n").unwrap();

        let cwd = clone.path().to_str().unwrap();
        prepare_branch_for_pr(cwd, "Add brand_new", "")
            .await
            .expect("prepare succeeds");

        // The new file is tracked in HEAD now.
        let (ok, stdout, _) = run_sync_allow_fail(
            clone.path(),
            &["ls-tree", "--name-only", "HEAD", "brand_new.txt"],
        );
        assert!(ok && stdout.trim() == "brand_new.txt",
            "brand_new.txt should be tracked in HEAD; got ok={ok} stdout={stdout:?}");
    }

    // ---- ssh_url_to_https ----------------------------------------------

    #[test]
    fn ssh_url_git_at_form_with_dot_git() {
        assert_eq!(
            ssh_url_to_https("git@github.com:foo/bar.git").as_deref(),
            Some("https://github.com/foo/bar.git")
        );
    }

    #[test]
    fn ssh_url_git_at_form_no_dot_git() {
        assert_eq!(
            ssh_url_to_https("git@github.com:foo/bar").as_deref(),
            Some("https://github.com/foo/bar")
        );
    }

    #[test]
    fn ssh_url_ssh_scheme_form() {
        assert_eq!(
            ssh_url_to_https("ssh://git@github.com/foo/bar.git").as_deref(),
            Some("https://github.com/foo/bar.git")
        );
    }

    #[test]
    fn ssh_url_ssh_scheme_with_port_strips_port() {
        assert_eq!(
            ssh_url_to_https("ssh://git@github.com:22/foo/bar.git").as_deref(),
            Some("https://github.com/foo/bar.git")
        );
    }

    #[test]
    fn ssh_url_https_passthrough_returns_none() {
        // Already HTTPS — there's nothing to convert.
        assert_eq!(
            ssh_url_to_https("https://github.com/foo/bar.git"),
            None
        );
    }

    #[test]
    fn ssh_url_non_github_host_also_converts() {
        assert_eq!(
            ssh_url_to_https("git@gitlab.example.com:team/repo.git").as_deref(),
            Some("https://gitlab.example.com/team/repo.git")
        );
    }

    #[test]
    fn ssh_url_malformed_returns_none() {
        assert_eq!(ssh_url_to_https("not-a-url"), None);
        assert_eq!(ssh_url_to_https("git@:foo/bar"), None);
        assert_eq!(ssh_url_to_https("git@github.com:"), None);
    }

    // ---- explain_push_error --------------------------------------------

    #[test]
    fn explain_publickey_includes_actionable_hints() {
        let msg = explain_push_error("git@github.com: Permission denied (publickey).");
        assert!(msg.contains("ssh-add"), "missing ssh-add hint: {msg}");
        assert!(msg.contains("HTTPS") || msg.contains("https"));
    }

    #[test]
    fn explain_other_error_passes_through() {
        let msg = explain_push_error("Could not resolve host: github.com");
        assert!(msg.contains("Could not resolve host"));
    }

    /// Set up a clone sitting on `main` with `origin/HEAD → main` and a
    /// shared bare remote. Returns (clone, bare). No feature branch.
    fn build_repo_on_main(default: &str) -> (TempDir, TempDir) {
        let bare = tempfile::tempdir().expect("tempdir bare");
        let clone = tempfile::tempdir().expect("tempdir clone");
        let init_arg = format!("--initial-branch={default}");
        run_sync(bare.path(), &["init", "--bare", init_arg.as_str()]);
        run_sync(clone.path(), &["init", init_arg.as_str()]);
        run_sync(clone.path(), &["config", "user.email", "test@example.com"]);
        run_sync(clone.path(), &["config", "user.name", "Test User"]);
        run_sync(clone.path(), &["config", "commit.gpgsign", "false"]);
        run_sync(
            clone.path(),
            &["remote", "add", "origin", bare.path().to_str().unwrap()],
        );
        std::fs::write(clone.path().join("README.md"), "# init\n").unwrap();
        run_sync(clone.path(), &["add", "README.md"]);
        run_sync(clone.path(), &["commit", "-m", "init"]);
        run_sync(clone.path(), &["push", "-u", "origin", default]);
        run_sync(clone.path(), &["remote", "set-head", "origin", default]);
        (clone, bare)
    }

    // ---- title_to_branch_slug ------------------------------------------

    #[test]
    fn slug_basic_title() {
        assert_eq!(title_to_branch_slug("Add login feature"), "add-login-feature");
    }

    #[test]
    fn slug_collapses_runs_and_strips_edges() {
        assert_eq!(title_to_branch_slug("  Fix!!  the  bug.  "), "fix-the-bug");
    }

    #[test]
    fn slug_truncates_long_titles() {
        let long = "a".repeat(200);
        let s = title_to_branch_slug(&long);
        assert!(s.len() <= 50, "expected <=50 chars, got {}", s.len());
    }

    #[test]
    fn slug_empty_or_symbolic_uses_fallback() {
        let s = title_to_branch_slug("");
        assert!(s.starts_with("pr-"), "expected pr- fallback, got {s}");
        let s2 = title_to_branch_slug("!@#$%^&*()");
        assert!(s2.starts_with("pr-"), "expected pr- fallback, got {s2}");
    }

    #[test]
    fn slug_unicode_becomes_hyphens_but_stays_valid() {
        // résumé → r-sum- → r-sum after trim
        let s = title_to_branch_slug("résumé update");
        assert!(!s.is_empty() && !s.starts_with('-') && !s.ends_with('-'));
    }

    // ---- prepare_branch_for_pr on default branch ------------------------

    #[tokio::test]
    async fn default_branch_dirty_tree_auto_branches_and_ships() {
        let (clone, _bare) = build_repo_on_main("main");
        std::fs::write(clone.path().join("feature.txt"), "new thing\n").unwrap();

        let main_head_before = run_sync(clone.path(), &["rev-parse", "main"]);
        let remote_main_before =
            run_sync(clone.path(), &["rev-parse", "refs/remotes/origin/main"]);

        prepare_branch_for_pr(
            clone.path().to_str().unwrap(),
            "Add new feature",
            "Body of the PR.",
        )
        .await
        .expect("auto-branch + ship should succeed");

        // We're on the new branch, derived from the title slug.
        let current = run_sync(clone.path(), &["symbolic-ref", "--short", "HEAD"]);
        assert_eq!(current.trim(), "add-new-feature");

        // The new branch holds the commit; main locally is untouched.
        let main_head_after = run_sync(clone.path(), &["rev-parse", "main"]);
        assert_eq!(
            main_head_before, main_head_after,
            "local main must not gain commits"
        );
        let subject = run_sync(clone.path(), &["log", "-1", "--pretty=%s"]);
        assert_eq!(subject.trim(), "Add new feature");

        // The remote main is untouched — only the new branch was pushed.
        let remote_main_after =
            run_sync(clone.path(), &["rev-parse", "refs/remotes/origin/main"]);
        assert_eq!(remote_main_before, remote_main_after,
            "remote main must not be pushed to");

        // The new branch has upstream set.
        let upstream = run_sync(
            clone.path(),
            &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        );
        assert_eq!(upstream.trim(), "origin/add-new-feature");

        // Working tree is clean.
        let porcelain = run_sync(clone.path(), &["status", "--porcelain"]);
        assert!(porcelain.trim().is_empty(), "expected clean tree: {porcelain}");
    }

    #[tokio::test]
    async fn default_branch_clean_and_synced_refuses() {
        // No dirty changes + main matches origin/main → nothing to PR.
        let (clone, _bare) = build_repo_on_main("main");

        let head_before = run_sync(clone.path(), &["rev-parse", "HEAD"]);
        let porcelain_before = run_sync(clone.path(), &["status", "--porcelain"]);
        let remote_main_before =
            run_sync(clone.path(), &["rev-parse", "refs/remotes/origin/main"]);

        let err = prepare_branch_for_pr(
            clone.path().to_str().unwrap(),
            "Some title",
            "Some body",
        )
        .await
        .expect_err("clean + synced default branch has nothing to PR");
        assert!(
            err.contains("default branch") || err.contains("main"),
            "expected default-branch error, got: {err}"
        );

        let head_after = run_sync(clone.path(), &["rev-parse", "HEAD"]);
        let porcelain_after = run_sync(clone.path(), &["status", "--porcelain"]);
        let remote_main_after =
            run_sync(clone.path(), &["rev-parse", "refs/remotes/origin/main"]);
        assert_eq!(head_before, head_after);
        assert_eq!(porcelain_before, porcelain_after);
        assert_eq!(remote_main_before, remote_main_after);
    }

    #[tokio::test]
    async fn default_branch_with_existing_slug_collides_then_picks_unique_name() {
        let (clone, _bare) = build_repo_on_main("main");
        // Pre-create a branch with the slug we'd derive — auto-branch
        // should pick the next available name, not error.
        run_sync(clone.path(), &["branch", "add-new-feature"]);
        std::fs::write(clone.path().join("x.txt"), "y\n").unwrap();

        prepare_branch_for_pr(
            clone.path().to_str().unwrap(),
            "Add new feature",
            "",
        )
        .await
        .expect("collision should resolve to a unique branch");

        let current = run_sync(clone.path(), &["symbolic-ref", "--short", "HEAD"]);
        assert_eq!(current.trim(), "add-new-feature-2");
    }

    #[tokio::test]
    async fn master_default_clean_and_synced_still_refuses() {
        let (clone, _bare) = build_repo_on_main("master");
        let head_before = run_sync(clone.path(), &["rev-parse", "HEAD"]);
        let err = prepare_branch_for_pr(
            clone.path().to_str().unwrap(),
            "Title",
            "Body",
        )
        .await
        .expect_err("master clean+synced should refuse");
        assert!(err.contains("default branch") || err.contains("master"));
        let head_after = run_sync(clone.path(), &["rev-parse", "HEAD"]);
        assert_eq!(head_before, head_after);
    }

    #[tokio::test]
    async fn missing_cwd_returns_error() {
        let err = prepare_branch_for_pr("/nonexistent/path/zzz", "x", "y")
            .await
            .expect_err("missing cwd should error");
        assert!(!err.is_empty());
    }
}
