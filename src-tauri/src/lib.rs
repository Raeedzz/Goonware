// Doc comments in this crate use a mix of indented and unindented list
// styles that pre-date the rustdoc list-indent lints. The rendered
// output is unaffected; suppress the noise crate-wide so real warnings
// stand out.
#![allow(clippy::doc_lazy_continuation)]
#![allow(clippy::doc_overindented_list_items)]

/// Goonware Tauri entry point.
///
/// Plugin set is the minimum needed for v1 features:
///   - shell:   spawn `git`, `rg`, etc. from the frontend
///   - fs:      read project files, write per-session config
///   - dialog:  "Open Folder" picker
///   - os:      platform queries (we're macOS-only v1, but used for paths)
///   - process: required for the auto-update plugin's restart hook
///   - updater: pulls signed updates from GitHub Releases on a check
///
/// Per-feature plumbing lives in `crate::*` modules — registered below.
#[cfg(target_os = "macos")]
mod browser;
mod agent_hooks;
mod block_id;
mod claude_usage;
mod connections;
mod flat_storage;
mod flat_term;
mod fs;
mod git;
mod helper_agent;
mod pr;
mod search;
mod skills;
mod state;
mod term;
mod worktree;

#[cfg(target_os = "macos")]
use browser::BrowserState;
use term::TerminalState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    inherit_login_shell_env();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(TerminalState::default())
        .manage(agent_hooks::AgentHookState::default());

    // macOS Edit menu: without an explicit menu, bundled .app builds
    // get a stripped-down OS-default menu whose Edit items aren't
    // wired to AppKit's responder chain, so ⌘C / ⌘V / ⌘X / ⌘A /
    // ⌘Z silently no-op inside the WKWebView. (It works under
    // `tauri dev` because the dev shim installs its own menu.)
    // `Menu::default` builds the full standard macOS menu — App /
    // Edit (cut/copy/paste/select-all/undo/redo) / View / Window /
    // Help — using `PredefinedMenuItem`s that send the native
    // cut:/copy:/paste:/selectAll: selectors WebKit honors out of
    // the box for both selected text and focused inputs.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|app| tauri::menu::Menu::default(app));

    #[cfg(target_os = "macos")]
    let builder = builder
        .manage(BrowserState::default())
        .setup(|app| {
            // Browser daemon: in-house replacement for gstack's
            // localhost:4000 service. Binds the port + spawns the axum
            // server in the background; Chrome itself is forked lazily
            // on the first /navigate or /screenshot HTTP call.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match browser::daemon::start(handle).await {
                    Ok(port) => eprintln!("[browser daemon] bound on 127.0.0.1:{port}"),
                    Err(e) => eprintln!("[browser daemon] failed to start: {e}"),
                }
            });

            // Window-focus → terminal-frame cadence gate. When the
            // user switches to another app, macOS WKWebView suspends
            // the JS context. Any term frame events we emit during
            // that window queue up in V8's message buffer and only
            // drain when the user comes back — and with 20+ agents
            // streaming at 60 Hz, that backlog can be tens of
            // thousands of events deep. JS spends a "frozen forever"
            // window draining it before it can repaint.
            //
            // The fix is to track the window's focus state and emit
            // backend frames at 1 Hz while unfocused (vs the normal
            // 60 Hz). On focus return, we additionally do one
            // immediate flush of every active session so idle
            // terminals don't appear stuck on stale content.
            use tauri::Manager as _;
            if let Some(window) = app.get_webview_window("main") {
                let handle_for_focus = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(focused) = event {
                        term::set_app_focused(*focused);
                        if *focused {
                            if let Some(state) =
                                handle_for_focus.try_state::<term::TerminalState>()
                            {
                                term::flush_all_sessions(
                                    &handle_for_focus,
                                    state.inner(),
                                );
                            }
                        }
                    }
                });
            }

            migrate_legacy_app_data();

            // Install per-CLI hook scripts (Claude / Codex / Gemini)
            // + register entries in each tool's settings, then bind
            // the shared Unix socket the scripts will write to on
            // every fire. Idempotent — installer no-ops on existing
            // entries; socket server unlinks any stale path first.
            // CLIs that aren't installed are silently skipped.
            agent_hooks::install_hooks();
            agent_hooks::start_socket_server(app.handle().clone());

            Ok(())
        });

    builder
        .invoke_handler(tauri::generate_handler![
            // Terminal (alacritty_terminal + custom React renderer)
            term::term_start,
            term::term_input,
            term::term_resize,
            term::term_reset_grid,
            term::term_close,
            term::term_kill_foreground,
            term::term_set_visible_set,
            term::term_running_session_ids,
            // Claude usage (OAuth API + hook-fed activity summarizer)
            claude_usage::claude_usage_status,
            claude_usage::claude_activity_summary,
            agent_hooks::agent_sessions,
            // Git (Task #8)
            git::git_status,
            git::git_diff,
            git::git_diff_all,
            git::git_diff_stat,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_push,
            git::git_branch_current,
            git::git_branch_list,
            git::git_remotes,
            git::git_checkout,
            git::git_branch_create,
            git::git_worktree_add,
            git::git_worktree_remove,
            git::git_log,
            // Worktree lifecycle (v2 UI rewrite)
            worktree::worktree_list,
            worktree::worktree_create,
            worktree::worktree_archive,
            worktree::worktree_restore,
            worktree::archive_list,
            // Helper agent (claude/codex/gemini one-shot)
            helper_agent::helper_run,
            helper_agent::detect_agent,
            // Pull request creation
            pr::pr_draft,
            pr::pr_create,
            pr::pr_status,
            pr::pr_merge,
            pr::merge_base_into_branch,
            pr::gh_username,
            // Connections (Task #10)
            connections::connections_scan,
            // Search (Task #15)
            search::search_rg,
            search::search_files,
            // Skills + MCP enumeration for the right-panel Skills tab
            skills::skills_list,
            skills::mcps_list,
            // Filesystem
            fs::fs_read_dir,
            fs::fs_read_text_file,
            fs::fs_write_text_file,
            fs::fs_scan_project_icon,
            fs::fs_cwd,
            fs::system_home_dir,
            fs::system_open,
            fs::system_open_with,
            fs::system_save_image_to_temp,
            // State persistence
            state::state_save,
            state::state_load,
            state::state_clear,
            // In-app browser (macOS only). Stubs on other platforms
            // would just live elsewhere; keep them inside the cfg so
            // non-macOS builds don't get unresolved-symbol errors.
            #[cfg(target_os = "macos")]
            browser::browser_bound_port,
            #[cfg(target_os = "macos")]
            browser::browser_restart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Goonware");
}

/// One-shot migration of the previous `dev.raeedz.rli` / `dev.raeedz.gli`
/// Application Support directories to the new `dev.raeedz.goonware`
/// location. Tauri's `app_data_dir()` resolves off the bundle
/// identifier, so a rename of the identifier orphans state.json and
/// the worktrees archive. We move the old tree across once on first
/// launch under the new identifier — no-op afterwards.
#[cfg(target_os = "macos")]
fn migrate_legacy_app_data() {
    let Some(home) = dirs::home_dir() else { return };
    let support = home.join("Library").join("Application Support");

    // Bundle-id rename chain: dev.raeedz.rli → dev.raeedz.gli →
    // dev.raeedz.goonware. Tauri's `app_data_dir()` resolves off the
    // bundle identifier so a rename would otherwise orphan
    // state.json and the worktrees archive. Prefer the most recent
    // legacy dir (gli) so users on current GLI don't lose their state.
    let bundle_new = support.join("dev.raeedz.goonware");
    for legacy in ["dev.raeedz.gli", "dev.raeedz.rli"] {
        let bundle_old = support.join(legacy);
        if bundle_old.exists() && !bundle_new.exists() {
            if let Err(e) = std::fs::rename(&bundle_old, &bundle_new) {
                eprintln!(
                    "[migrate] couldn't rename {} → {}: {e}",
                    bundle_old.display(),
                    bundle_new.display()
                );
            } else {
                eprintln!(
                    "[migrate] moved app data {} → {}",
                    bundle_old.display(),
                    bundle_new.display()
                );
            }
            break;
        }
    }

    // Shared-cache rename chain: ~/Library/Application Support/RLI →
    // GLI → Goonware. Holds the downloaded Chrome-for-Testing binary
    // + per-PID chrome profiles. Rename in place so the user doesn't
    // re-download a ~200 MB Chrome on first launch under the new
    // name.
    let cache_new = support.join("Goonware");
    for legacy in ["GLI", "RLI"] {
        let cache_old = support.join(legacy);
        if cache_old.exists() && !cache_new.exists() {
            if let Err(e) = std::fs::rename(&cache_old, &cache_new) {
                eprintln!(
                    "[migrate] couldn't rename {} → {}: {e}",
                    cache_old.display(),
                    cache_new.display()
                );
            } else {
                eprintln!(
                    "[migrate] moved cache {} → {}",
                    cache_old.display(),
                    cache_new.display()
                );
            }
            break;
        }
    }

    // Workspace dir rename: ~/GLI/workspaces → ~/Goonware/workspaces.
    // Worktrees archived inside live here; the parent is a plain dir
    // we can rename in place without touching the worktrees
    // themselves (so their absolute paths in flat_storage still
    // resolve once the parent is renamed).
    let workspaces_new = home.join("Goonware");
    let workspaces_old = home.join("GLI");
    if workspaces_old.exists() && !workspaces_new.exists() {
        if let Err(e) = std::fs::rename(&workspaces_old, &workspaces_new) {
            eprintln!(
                "[migrate] couldn't rename {} → {}: {e}",
                workspaces_old.display(),
                workspaces_new.display()
            );
        } else {
            eprintln!(
                "[migrate] moved workspaces {} → {}",
                workspaces_old.display(),
                workspaces_new.display()
            );
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn migrate_legacy_app_data() {}

/// Pull SSH_AUTH_SOCK and PATH from the user's login shell into our
/// own process env, so child processes (git, ssh, claude, codex,
/// gemini) inherit them.
///
/// Why this exists: when Goonware is launched from Finder / Dock /
/// Spotlight on macOS, launchd hands it a near-empty environment.
/// `SSH_AUTH_SOCK` is missing, so `git push` over SSH can't reach
/// ssh-agent and falls back to passphrase-prompting the key file —
/// which our `BatchMode=yes` setting then refuses, producing
/// `Permission denied (publickey)` even when the user has a working
/// SSH setup that pushes fine from their terminal. PATH is usually
/// trimmed to `/usr/bin:/bin:/usr/sbin:/sbin`, hiding homebrew /
/// asdf / mise-installed binaries.
///
/// The fix is the same fix VS Code's macOS bundle has shipped for
/// years: spawn the user's login shell once at startup, ask it for
/// its env, and copy the keys we care about into our own.
#[cfg(target_os = "macos")]
fn inherit_login_shell_env() {
    let env = match read_login_shell_env() {
        Some(e) => e,
        None => return,
    };

    // SSH_AUTH_SOCK: required for ssh-agent–backed git pushes.
    // Don't overwrite if we already have one (e.g. user launched
    // Goonware from a terminal where it was already set).
    if std::env::var_os("SSH_AUTH_SOCK").is_none() {
        if let Some(sock) = env.get("SSH_AUTH_SOCK") {
            if !sock.is_empty() && std::path::Path::new(sock).exists() {
                std::env::set_var("SSH_AUTH_SOCK", sock);
                eprintln!("[goonware] inherited SSH_AUTH_SOCK from login shell");
            }
        }
    }

    // PATH: merge, login-shell first. Without this, spawned `git` /
    // `claude` / `codex` / `gemini` may be unfindable when Goonware is
    // launched outside a terminal.
    if let Some(shell_path) = env.get("PATH") {
        if !shell_path.is_empty() {
            let current = std::env::var("PATH").unwrap_or_default();
            std::env::set_var("PATH", merge_path(shell_path, &current));
        }
    }
}

/// Spawn the user's login shell with `-l -i -c env` and parse the
/// dumped environment. Returns None on any error (no $SHELL, shell
/// not found, non-zero exit). Login-shell flags chosen to mirror what
/// VS Code's `shell-env` helper does: `-l` so login dotfiles run
/// (.zprofile, .bash_profile), `-i` so interactive ones do too
/// (.zshrc, .bashrc) — between them they cover every realistic
/// user-customization path.
#[cfg(target_os = "macos")]
fn read_login_shell_env() -> Option<std::collections::HashMap<String, String>> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = std::process::Command::new(&shell)
        .args(["-l", "-i", "-c", "env"])
        .output()
        .ok()?;
    if !output.status.success() {
        eprintln!(
            "[goonware] login-shell env probe exited {} — leaving env alone",
            output.status.code().unwrap_or(-1)
        );
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Some(parse_env_dump(&text))
}

/// Parse `env`-style output into a (name → value) map. Values may
/// contain `=` (e.g. `URL=foo?a=b`), so we split on the FIRST `=` only.
fn parse_env_dump(text: &str) -> std::collections::HashMap<String, String> {
    text.lines()
        .filter_map(|line| {
            let (k, v) = line.split_once('=')?;
            if k.is_empty() {
                return None;
            }
            Some((k.to_string(), v.to_string()))
        })
        .collect()
}

/// Merge two colon-separated PATH-style lists. Entries from
/// `primary` win on duplicates (preserved at their earlier position).
/// Empty entries are skipped — they'd mean "current directory" which
/// is a security smell when inherited from arbitrary env.
fn merge_path(primary: &str, secondary: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<&str> = Vec::new();
    for entry in primary.split(':').chain(secondary.split(':')) {
        if entry.is_empty() {
            continue;
        }
        if seen.insert(entry.to_string()) {
            out.push(entry);
        }
    }
    out.join(":")
}

#[cfg(test)]
mod env_inherit_tests {
    use super::*;

    #[test]
    fn parse_env_dump_basic() {
        let text = "FOO=bar\nBAZ=qux\n";
        let env = parse_env_dump(text);
        assert_eq!(env.get("FOO").map(String::as_str), Some("bar"));
        assert_eq!(env.get("BAZ").map(String::as_str), Some("qux"));
    }

    #[test]
    fn parse_env_dump_values_can_contain_equals() {
        // URLs / connection strings frequently include `=`.
        let text = "DATABASE_URL=postgres://u:p@h/db?sslmode=require\n";
        let env = parse_env_dump(text);
        assert_eq!(
            env.get("DATABASE_URL").map(String::as_str),
            Some("postgres://u:p@h/db?sslmode=require")
        );
    }

    #[test]
    fn parse_env_dump_skips_malformed_and_empty() {
        let text = "GOOD=1\n\n=novalue\nNOEQ\nALSO=ok\n";
        let env = parse_env_dump(text);
        assert_eq!(env.len(), 2);
        assert!(env.contains_key("GOOD"));
        assert!(env.contains_key("ALSO"));
    }

    #[test]
    fn parse_env_dump_preserves_empty_values() {
        // An exported-but-empty var (`export FOO=`) should round-trip.
        let text = "FOO=\nBAR=value\n";
        let env = parse_env_dump(text);
        assert_eq!(env.get("FOO").map(String::as_str), Some(""));
    }

    #[test]
    fn merge_path_dedups_primary_wins() {
        let merged = merge_path("/opt/homebrew/bin:/usr/local/bin", "/usr/bin:/opt/homebrew/bin");
        // /opt/homebrew/bin should appear once, in primary's position.
        assert_eq!(merged, "/opt/homebrew/bin:/usr/local/bin:/usr/bin");
    }

    #[test]
    fn merge_path_skips_empty_entries() {
        // ::foo:: would otherwise add a "" entry meaning current dir.
        let merged = merge_path("/a::/b", "::/c::");
        assert_eq!(merged, "/a:/b:/c");
    }

    #[test]
    fn merge_path_handles_either_side_empty() {
        assert_eq!(merge_path("", "/a:/b"), "/a:/b");
        assert_eq!(merge_path("/a:/b", ""), "/a:/b");
        assert_eq!(merge_path("", ""), "");
    }
}
