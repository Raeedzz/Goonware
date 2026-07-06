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
#[cfg(target_os = "macos")]
mod warp_term;
mod agent_hooks;
mod block_id;
mod claude_usage;
mod connections;
mod flat_storage;
mod flat_term;
mod fs;
mod git;
mod helper_agent;
mod persistence;
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

            // Persistence (Warp-style SQLite): open the DB, run
            // migrations, ingest any legacy `state.json`, spawn the
            // single-writer thread. Must come AFTER
            // `migrate_legacy_app_data` so we resolve `app_data_dir()`
            // against the post-rename location — otherwise we'd open
            // a fresh empty DB next to the orphaned `dev.raeedz.gli`
            // tree and the user would appear to lose their state.
            match persistence::init(app.handle()) {
                Ok(state) => {
                    app.manage(state);
                }
                Err(e) => eprintln!("[persistence] init failed: {e}"),
            }

            // Install per-CLI hook scripts (Claude / Codex / Gemini)
            // + register entries in each tool's settings, then bind
            // the shared Unix socket the scripts will write to on
            // every fire. Idempotent — installer no-ops on existing
            // entries; socket server unlinks any stale path first.
            // CLIs that aren't installed are silently skipped.
            agent_hooks::install_hooks();
            agent_hooks::start_socket_server(app.handle().clone());

            // Seed the skills Goonware ships with into ~/.claude/skills so
            // every install gets them in Claude Code automatically (e.g. the
            // `browser` skill that points agents at the built-in browser
            // daemon instead of the Claude-in-Chrome MCP). Same lifecycle as
            // the hooks above: idempotent, runs once per launch, only touches
            // directories we own.
            skills::install_bundled_skills();

            // Native terminal migration (M0 spike): stand up an embedded
            // warpui render surface under Tauri's run loop (no second
            // [NSApp run]). v0 renders a solid surface to prove the
            // runtime works embedded; the grid renderer (fed by term.rs
            // RenderFrames) lands in M1.
            eprintln!("[warpui] attaching embedded surface…");
            // Hand warpui the app handle: it reparents its surface into the
            // Goonware window (host NSWindow) and registers the in-process
            // frame sink so term.rs frames drive the native grid directly.
            warp_term::attach(app.handle());

            // Make the green button / ⌃⌘F do borderless full-bleed fullscreen in
            // the SAME Space (native fullscreen's separate Space can't composite
            // the embedded Metal surface below the webview). Setup runs on the
            // main thread, so the AppKit calls are safe here.
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(parent) = win.ns_window() {
                    warp_term::configure_fullscreen(parent);
                }
            }

            Ok(())
        });

    // Non-macOS still gets a setup call so the persistence layer
    // initializes on those targets too. The macOS branch above already
    // covers them, so this is just the fallback for cross-platform
    // dev builds.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.setup(|app| {
        match persistence::init(app.handle()) {
            Ok(state) => app.manage(state),
            Err(e) => eprintln!("[persistence] init failed: {e}"),
        }
        Ok(())
    });

    builder
        .invoke_handler(tauri::generate_handler![
            // Terminal (alacritty_terminal + custom React renderer)
            term::term_start,
            term::term_input,
            term::term_native_wheel,
            term::term_resize,
            term::term_reset_grid,
            term::term_close,
            term::term_kill_foreground,
            term::term_set_visible_set,
            term::term_running_session_ids,
            term::term_history_load,
            term::term_history_forget,
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
            git::git_log_graph,
            git::git_commit_detail,
            git::git_commit_diff,
            git::git_fetch,
            git::git_pull,
            git::git_clone,
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
            // PRs tab (list / review / checkout / return)
            pr::pr_list,
            pr::pr_checkout,
            pr::pr_checkout_return,
            pr::pr_review_enter,
            pr::pr_review_restore,
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
            fs::fs_rename,
            fs::fs_delete,
            fs::fs_import_paths,
            fs::fs_scan_project_icon,
            fs::fs_cwd,
            fs::fs_paths_exist,
            fs::system_home_dir,
            fs::system_open,
            fs::system_open_with,
            fs::system_save_image_to_temp,
            fs::system_clipboard_read_text,
            fs::system_clipboard_write_text,
            fs::system_clipboard_save_image_to_temp,
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
            #[cfg(target_os = "macos")]
            warp_term::term_surface_set_rect,
            #[cfg(target_os = "macos")]
            warp_term::term_native_attach,
            #[cfg(target_os = "macos")]
            warp_term::term_native_detach,
            #[cfg(target_os = "macos")]
            warp_term::term_native_set_agent_mode,
            #[cfg(target_os = "macos")]
            warp_term::term_native_scroll,
            #[cfg(target_os = "macos")]
            warp_term::term_native_hscroll,
            #[cfg(target_os = "macos")]
            warp_term::term_native_mouse,
            #[cfg(target_os = "macos")]
            warp_term::term_native_selection_text,
            #[cfg(target_os = "macos")]
            warp_term::term_native_set_viewport,
            #[cfg(target_os = "macos")]
            warp_term::term_native_link_at,
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

/// Regression guards for the macOS Edit menu wiring.
///
/// Without an explicit `Menu::default(app_handle)` call on the Tauri
/// builder, bundled `.app` builds get a stripped-down OS-default menu
/// whose Edit items aren't wired to AppKit's responder chain. The
/// observable failure is that ⌘C / ⌘V / ⌘X / ⌘A silently no-op
/// everywhere outside the PTY-aware terminal handlers — including
/// the right-panel side terminal's PromptInput textarea, the commit
/// composer, the file editor, etc. `tauri dev` masks the bug because
/// its dev shim installs its own menu, so the only way the regression
/// surfaces is in a built DMG — which is the worst place to find out.
///
/// These tests grep this file's own source to pin the menu call in
/// place. A future refactor that drops the `.menu(...)` line will
/// flunk `cargo test` long before it reaches a release build.
#[cfg(test)]
mod macos_menu_pinning_tests {
    /// Source text of this file at compile time. `include_str!` resolves
    /// at the call site, so this is exactly `lib.rs` as it sits on disk.
    const LIB_RS: &str = include_str!("lib.rs");

    #[test]
    fn macos_default_menu_is_installed_on_builder() {
        // The exact shape the menu fix took. We assert presence of
        // both the `Menu::default` call AND its `#[cfg(target_os = "macos")]`
        // gate — either alone would let the regression sneak back in
        // (a non-macOS menu, or a macOS menu missing the cut/copy/paste
        // PredefinedMenuItems that Menu::default builds).
        assert!(
            LIB_RS.contains("tauri::menu::Menu::default(app)"),
            "lib.rs must call `tauri::menu::Menu::default(app)` so the \
             macOS Edit menu's cut/copy/paste/select-all items reach \
             AppKit's responder chain. Without this, bundled .app builds \
             silently break ⌘C / ⌘V / ⌘X / ⌘A in every non-PTY input \
             (commit composer, side-terminal prompt, file editor, ...).",
        );
        assert!(
            LIB_RS.contains("#[cfg(target_os = \"macos\")]\n    let builder = builder.menu("),
            "the `.menu(...)` builder call must be gated by \
             `#[cfg(target_os = \"macos\")]` and applied to `builder` — \
             other platforms get their menu from elsewhere.",
        );
    }
}

/// Regression guards for the JS-side keyboard-handler gating contract.
///
/// The Edit-menu pin above keeps macOS's native Cmd+C/V/X/A path alive.
/// But any window-level keydown listener that React installs runs
/// BEFORE WebKit's responder chain — so if a JS handler calls
/// `e.preventDefault()` on Cmd+C/V, the menu items never fire and
/// users see "Cmd+C/V is broken everywhere."
///
/// The contract every clipboard-adjacent handler must follow:
///
///   1. **Visibility gating**: `BlockTerminal`'s window-level
///      keydown listeners must be gated by `if (!isVisible) return;`,
///      and every site that mounts a hidden BlockTerminal must forward
///      `isVisible={…}` correctly. Otherwise hidden terminals race the
///      visible one and `O(n)` handlers steal events on each chord.
///
///   2. **Editable bailout**: When the focused element / selection
///      anchor is a textarea, input, or contenteditable surface,
///      window-level Cmd+C handlers must `return` BEFORE calling
///      `preventDefault()`. That lets the editor's native copy fire.
///
///   3. **Container scoping**: Window-level handlers that DO
///      preventDefault must verify the selection is inside the
///      component's own container — never copy text from one pane
///      when the user pressed Cmd+C while focused in another.
///
/// These tests grep the relevant `.tsx` files to pin every clause.
/// They're cheap (text inclusion checks), they run on every
/// `cargo test`, and they break loudly the moment someone removes
/// a load-bearing guard. Combined with the JS unit tests in
/// `src/terminal/keyEncoding.test.ts` and
/// `src/terminal/clipboardContract.test.ts`, the regression that
/// shipped — and re-shipped — in 0.0.22 / 0.0.23 cannot recur
/// without flunking the test suite on `bun run test:all`.
#[cfg(test)]
mod clipboard_handler_gating_tests {
    use std::path::PathBuf;

    /// Repo-relative paths to the `.tsx` files we pin. Resolved via
    /// `CARGO_MANIFEST_DIR` so the tests run from any cwd `cargo
    /// test` was invoked under (the harness `cd`s into `src-tauri`
    /// before running test binaries, but CI scripts vary).
    fn read_repo_file(rel: &str) -> String {
        let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        path.pop(); // src-tauri → repo root
        path.push(rel);
        std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "could not read {} — expected at {}: {}",
                rel,
                path.display(),
                e
            )
        })
    }

    #[test]
    fn block_terminal_window_cmd_c_is_visibility_gated() {
        // The two window-level keydown listeners in BlockTerminal
        // (the Ctrl+C fallback and the Cmd+C copy) MUST each bail
        // out at the top of the listener if the terminal is hidden.
        // Without these, every hidden BlockTerminal in the
        // TerminalKeepaliveLayer / SecondaryTerminals re-mount
        // contends with the visible one for every keystroke — the
        // original 4856c46 regression.
        let src = read_repo_file("src/terminal/BlockTerminal.tsx");
        // Both effects open with `if (!isVisible) return;` immediately
        // inside the useEffect body. Pin the exact early-return so
        // a future refactor that drops the gate (or accidentally
        // re-orders it after a `window.addEventListener(...)`) is
        // caught here.
        let occurrences = src.matches("if (!isVisible) return;").count();
        assert!(
            occurrences >= 3,
            "BlockTerminal.tsx must early-return on !isVisible in \
             ALL window-level useEffect bodies (drag-drop, Ctrl+C \
             fallback, Cmd+C copy). Found only {} occurrence(s) of \
             `if (!isVisible) return;` — at least 3 are load-bearing.",
            occurrences
        );
    }

    #[test]
    fn block_terminal_cmd_c_bails_on_contenteditable_selection() {
        // Pin the editable-bailout in BlockTerminal's Cmd+C handler.
        // The user-facing failure mode if this regresses: select
        // text in CodeMirror / the markdown editor, press Cmd+C,
        // get the BlockTerminal's stale closed-block selection on
        // the clipboard instead of the editor text.
        //
        // We grep for `isContentEditable` (the standardized DOM
        // getter that catches every form of `contenteditable` —
        // `="true"`, `=""`, `="plaintext-only"` — that CodeMirror,
        // TipTap, or any other editor might use) rather than the
        // older strict `[contenteditable='true']` selector that
        // silently missed TipTap's variants.
        let src = read_repo_file("src/terminal/BlockTerminal.tsx");
        assert!(
            src.contains("isContentEditable"),
            "BlockTerminal.tsx must use `isContentEditable` (the \
             standard DOM property, not the strict attribute \
             selector) to detect when Cmd+C should pass through to \
             a focused editor. Otherwise CodeMirror / TipTap \
             selections silently break."
        );
        assert!(
            src.contains("anchorEl.closest(\"textarea, input\")"),
            "BlockTerminal.tsx Cmd+C handler must also bail when the \
             selection anchor is inside a plain textarea or input — \
             checked via `.closest('textarea, input')`. The \
             contenteditable check alone misses commit-composer-style \
             plain textareas."
        );
    }

    #[test]
    fn secondary_terminals_forward_is_visible() {
        // The fix from 4856c46 — pin that the right-panel side
        // terminals still forward `isVisible={isActive}` to their
        // BlockTerminal. Without this every hidden side terminal
        // in the keepalive layer keeps its window-level Cmd+C /
        // Ctrl+C / drag-drop listeners armed.
        let src = read_repo_file("src/shell/RightPanel.tsx");
        assert!(
            src.contains("isVisible={isActive}"),
            "RightPanel.tsx SecondaryTerminals must pass \
             `isVisible={{isActive}}` to BlockTerminal so only the \
             active side terminal owns its window-level keyboard \
             listeners. Dropping this prop re-introduces the \
             4856c46 regression: Cmd+C/V silently breaks in the \
             active side terminal because hidden siblings race \
             every keystroke."
        );
    }

    #[test]
    fn pbpaste_primary_path_command_is_registered() {
        // Cmd+V's primary clipboard-read path is a Tauri command
        // that shells out to `/usr/bin/pbpaste`. Going through
        // AppKit's NSPasteboard (the path pbpaste uses) does NOT
        // trigger the macOS "Apps want to read your clipboard" TCC
        // popup — exactly the "weird paste popup" the user reported.
        //
        // The path ONLY works if (a) the command exists in fs.rs,
        // and (b) lib.rs registers it in invoke_handler. Either gap
        // re-introduces the bug. Pin both points here so a future
        // commit dropping either flunks `cargo test --lib`.
        let fs_rs = read_repo_file("src-tauri/src/fs.rs");
        assert!(
            fs_rs.contains("pub async fn system_clipboard_read_text"),
            "src-tauri/src/fs.rs must declare a `system_clipboard_read_text` \
             #[tauri::command] — that's the pbpaste path the Cmd+V \
             handlers in PromptInput.tsx / PtyPassthrough.tsx call FIRST. \
             Without this command, the fallback drops to WebKit's \
             clipboard API and the macOS TCC popup re-surfaces."
        );
        assert!(
            fs_rs.contains("Command::new(\"/usr/bin/pbpaste\")"),
            "system_clipboard_read_text must shell out to the absolute \
             path `/usr/bin/pbpaste`. A bare `pbpaste` would ENOENT when \
             Goonware is launched from the Dock with a stripped PATH — \
             see inherit_login_shell_env() in lib.rs for the same gotcha \
             on the spawned-PTY side."
        );
        // Pin the image clipboard reader — second part of the no-
        // popup contract. Without this, the image-paste branch in
        // PtyPassthrough falls back to `navigator.clipboard.read()`
        // which fires the same TCC popup as readText().
        assert!(
            fs_rs.contains("pub async fn system_clipboard_save_image_to_temp"),
            "src-tauri/src/fs.rs must declare \
             `system_clipboard_save_image_to_temp` — the AppKit-routed \
             image clipboard reader. The PtyPassthrough Cmd+V handler \
             calls this BEFORE the text path so screenshot pastes \
             (Cmd+Shift+Ctrl+4 → Cmd+V) don't fire the TCC popup. \
             Drop this command and image paste silently fails OR \
             re-introduces the popup."
        );
        let lib_rs = read_repo_file("src-tauri/src/lib.rs");
        assert!(
            lib_rs.contains("fs::system_clipboard_read_text"),
            "lib.rs invoke_handler must register \
             `fs::system_clipboard_read_text` or the frontend's \
             invoke(\"system_clipboard_read_text\") rejects with \
             \"command not found\" and Cmd+V drops to the WebKit \
             API + its TCC popup."
        );
        assert!(
            lib_rs.contains("fs::system_clipboard_save_image_to_temp"),
            "lib.rs invoke_handler must register \
             `fs::system_clipboard_save_image_to_temp` or the image \
             clipboard branch in PtyPassthrough rejects with \"command \
             not found\" and screenshot paste silently no-ops."
        );
    }

    #[test]
    fn pbcopy_primary_path_command_is_registered() {
        // Symmetric pin to the pbpaste read path. Cmd+C against a
        // closed-block selection routes through Rust pbcopy because
        // `navigator.clipboard.writeText` fails SILENTLY in WKWebView
        // under bundled .app builds — Cmd+C looks like it worked but
        // NSPasteboard is unchanged. pbcopy goes through the same
        // AppKit pathway pbpaste uses, so it's exempt from the same
        // TCC silent-failure mode that breaks the JS API.
        //
        // Both gates must hold: command declared in fs.rs AND
        // registered in lib.rs. Either gap drops the frontend back
        // to the silently-broken WebKit path.
        let fs_rs = read_repo_file("src-tauri/src/fs.rs");
        assert!(
            fs_rs.contains("pub async fn system_clipboard_write_text"),
            "src-tauri/src/fs.rs must declare a `system_clipboard_write_text` \
             #[tauri::command] — that's the pbcopy path the Cmd+C \
             handlers in BlockTerminal.tsx and PtyPassthrough.tsx call \
             via clipboardWrite.ts. Without this command, the fallback \
             drops to WebKit's writeText which fails silently in bundled \
             builds and the user's Cmd+C copies nothing."
        );
        assert!(
            fs_rs.contains("Command::new(\"/usr/bin/pbcopy\")"),
            "system_clipboard_write_text must shell out to the absolute \
             path `/usr/bin/pbcopy`. A bare `pbcopy` would ENOENT when \
             Goonware is launched from the Dock with a stripped PATH — \
             same gotcha as pbpaste."
        );
        let lib_rs = read_repo_file("src-tauri/src/lib.rs");
        assert!(
            lib_rs.contains("fs::system_clipboard_write_text"),
            "lib.rs invoke_handler must register \
             `fs::system_clipboard_write_text` or the frontend's \
             invoke(\"system_clipboard_write_text\") rejects with \
             \"command not found\" and Cmd+C drops to WebKit's \
             writeText, which fails silently in bundled .app builds."
        );
    }

    #[test]
    fn clipboard_read_helper_tries_native_before_webkit() {
        // The whole point of the inverted fallback order is to skip
        // the macOS TCC clipboard popup on every Cmd+V. The browser
        // `navigator.clipboard.readText()` is the layer that triggers
        // it — calling that BEFORE the native pbpaste path defeats
        // the purpose. Pin the structural ordering so a future
        // "WebKit is faster, try it first" refactor regresses loudly
        // instead of silently.
        //
        // Strip line comments from the source before searching — the
        // doc-comment at the top of clipboardRead.ts legitimately
        // mentions `navigator.clipboard.readText()` to explain why
        // we route around it, and we don't want that comment to
        // confuse the ordering grep.
        let raw = read_repo_file("src/terminal/clipboardRead.ts");
        let src: String = raw
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !t.starts_with("//") && !t.starts_with("*")
            })
            .collect::<Vec<_>>()
            .join("\n");
        let native_idx = src
            .find("nativeReader()")
            .expect("clipboardRead.ts must call the native reader in code");
        let web_idx = src
            .find("navigator.clipboard.readText()")
            .expect("clipboardRead.ts must reference navigator.clipboard.readText as the fallback in code");
        assert!(
            native_idx < web_idx,
            "clipboardRead.ts must call the native (pbpaste) reader BEFORE \
             navigator.clipboard.readText(). Reversing the order re-introduces \
             the macOS TCC clipboard popup on every Cmd+V."
        );
    }

    #[test]
    fn keepalive_layers_use_visibility_not_display_none() {
        // WKWebView releases a canvas's WebGPU swapchain under
        // `display: none` without firing `device.lost`. The next
        // paint after un-hiding lands on a dead surface and the
        // user sees a fully-black agent pane. Switching the
        // keepalive layers to `visibility: hidden` keeps the GPU
        // surface alive across tab/worktree switches — structural
        // fix that doesn't depend on a recovery layer holding up.
        for path in [
            "src/shell/MainColumn.tsx",
            "src/shell/RightPanel.tsx",
        ] {
            let src = read_repo_file(path);
            // Locate the keepalive slot's style block and assert the
            // visibility toggle is present. We don't grep the full
            // file for `display: "none"` because legitimate non-
            // keepalive callsites use it (e.g. modal close, dropdown
            // hide). The visibility chord is unique enough to the
            // keepalive contract that finding it is sufficient.
            assert!(
                src.contains("visibility:") && src.contains("\"hidden\""),
                "{} must use `visibility: \"hidden\"` (not `display: \"none\"`) \
                 for its terminal keepalive slot. `display: none` releases \
                 WKWebView's WebGPU swapchain and the user sees a black \
                 pane on tab/worktree switch.",
                path,
            );
        }
    }

    #[test]
    fn main_column_keepalive_layer_forwards_is_visible() {
        // The same gating contract as SecondaryTerminals, applied
        // to the main column. The TerminalKeepaliveLayer pre-mounts
        // every terminal tab in the active worktree and toggles
        // `display: none` on inactive ones. Each BlockTerminal must
        // know its visibility so its window-level handlers stay
        // dormant when hidden.
        let src = read_repo_file("src/shell/MainColumn.tsx");
        assert!(
            src.contains("isVisible={visible}"),
            "MainColumn.tsx TerminalKeepaliveLayer must pass \
             `isVisible={{visible}}` to TerminalTabContent so hidden \
             main-column tabs don't contend for clipboard chords. \
             Mirrors the SecondaryTerminals contract."
        );
        assert!(
            src.contains("isVisible={isVisible}"),
            "MainColumn.tsx TerminalTabContent must forward \
             `isVisible={{isVisible}}` down to BlockTerminal."
        );
    }

    #[test]
    fn no_window_keydown_unconditionally_prevents_default() {
        // A backstop: scan every .tsx/.ts under src/ for any
        // window-level keydown listener that calls
        // `e.preventDefault()` without an early bailout on the
        // common clipboard chord conditions. Right now no such
        // listener exists — but if a future feature ever adds
        // `e.preventDefault()` to a global keydown handler with
        // no guard, this test flags it as a Cmd+C/V regression
        // risk before it ships.
        let walked = collect_ts_sources();
        let mut offenders = Vec::new();
        for (rel, src) in walked {
            // Find every `window.addEventListener("keydown", ...)`
            // and inspect the next ~80 lines for an unconditional
            // preventDefault. We allow files to opt out via the
            // sentinel comment below.
            for (idx, _) in src.match_indices("window.addEventListener(\"keydown\"") {
                let snippet_end = (idx + 2400).min(src.len());
                let snippet = &src[idx..snippet_end];
                if snippet.contains("// clipboard-handler-audited") {
                    continue;
                }
                // The simplest red flag: a preventDefault() that
                // isn't preceded by a check for `e.key` or `key`.
                // We can't AST-parse from a grep test, but every
                // legitimate handler in the tree today gates on
                // `e.key` / `e.metaKey` / `e.ctrlKey` before
                // calling preventDefault. Flag any block that has
                // preventDefault without those tokens nearby.
                if snippet.contains("e.preventDefault()")
                    && !snippet.contains("e.key")
                    && !snippet.contains("e.metaKey")
                    && !snippet.contains("e.ctrlKey")
                {
                    offenders.push(rel.clone());
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "Found window-level keydown listener(s) that may \
             unconditionally preventDefault — risks breaking \
             Cmd+C/V/X/A across the app: {:?}. Add a key/modifier \
             gate or annotate the file with \
             `// clipboard-handler-audited` if intentional.",
            offenders
        );
    }

    /// Walk `src/` and read every `.tsx` / `.ts` file, returning
    /// `(repo-relative-path, contents)` pairs. Skips `.test.ts`
    /// files (test code is allowed to call `preventDefault` more
    /// liberally) and the `node_modules` / `dist` / `target` trees
    /// in case any of those slip into the search path.
    fn collect_ts_sources() -> Vec<(String, String)> {
        let mut root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        root.pop(); // src-tauri → repo root
        root.push("src");
        let mut out = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
                    if matches!(name, "node_modules" | "dist" | "target" | ".git") {
                        continue;
                    }
                    stack.push(path);
                    continue;
                }
                let Some(ext) = path.extension().and_then(|s| s.to_str()) else {
                    continue;
                };
                if ext != "tsx" && ext != "ts" {
                    continue;
                }
                let s = path.to_string_lossy();
                if s.ends_with(".test.ts") || s.ends_with(".test.tsx") {
                    continue;
                }
                let Ok(body) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let rel = path
                    .strip_prefix(root.parent().unwrap_or(&root))
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .into_owned();
                out.push((rel, body));
            }
        }
        out
    }
}
