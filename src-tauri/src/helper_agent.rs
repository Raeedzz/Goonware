//! Helper agent — replaces direct Gemini API calls for chrome features
//! (commit message generation, summaries, code explainers, PR
//! description drafting). Routes to whichever CLI the user is running
//! in the worktree (claude / codex / gemini).
//!
//! v1: the frontend tells us which CLI to use (worktree.agentCli, or a
//! safe default). Each call spawns a one-shot subprocess in the
//! worktree's path with the prompt on stdin and captures stdout.

use std::path::Path;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HelperMode {
    CommitMessage,
    Summary,
    Explain,
    PrDescription,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentCli {
    Claude,
    Codex,
    Gemini,
}

impl AgentCli {
    fn binary(self) -> &'static str {
        match self {
            AgentCli::Claude => "claude",
            AgentCli::Codex => "codex",
            AgentCli::Gemini => "gemini",
        }
    }

    /// Construct the full positional args for a one-shot invocation,
    /// inserting `--model <X>` at the right index per CLI when supplied.
    fn build_args(self, model: Option<&str>) -> Vec<String> {
        let m = model.filter(|s| !s.is_empty());
        let mut out: Vec<String> = Vec::new();
        match self {
            // Claude Code: `claude --print [--model X]`. Prompt via stdin.
            AgentCli::Claude => {
                out.push("--print".into());
                if let Some(m) = m {
                    out.push("--model".into());
                    out.push(m.into());
                }
            }
            // Codex CLI: `codex exec [--model X]`. Prompt via stdin.
            AgentCli::Codex => {
                out.push("exec".into());
                if let Some(m) = m {
                    out.push("--model".into());
                    out.push(m.into());
                }
            }
            // Gemini CLI: `gemini [--model X] --prompt PROMPT`. Model
            // must come before `--prompt` so its value isn't consumed
            // by the prompt flag.
            AgentCli::Gemini => {
                if let Some(m) = m {
                    out.push("--model".into());
                    out.push(m.into());
                }
                out.push("--prompt".into());
            }
        }
        out
    }

    /// Whether the CLI consumes the prompt as a CLI argument (true) or
    /// from stdin (false).
    fn prompt_via_arg(self) -> bool {
        matches!(self, AgentCli::Gemini)
    }

    fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "claude" | "claude-code" => Some(AgentCli::Claude),
            "codex" | "codex-cli" => Some(AgentCli::Codex),
            "gemini" | "gemini-cli" => Some(AgentCli::Gemini),
            _ => None,
        }
    }
}

fn mode_preface(mode: HelperMode) -> &'static str {
    match mode {
        HelperMode::CommitMessage => "Write a concise (≤72 char subject + optional body) git commit message for the diff below. Output the message only, no preamble.\n\n",
        HelperMode::Summary => "In one short sentence (≤120 chars), describe what the user is doing right now based on the snippet below. No preamble.\n\n",
        HelperMode::Explain => "Briefly explain the code below in one paragraph. No preamble.\n\n",
        HelperMode::PrDescription => "Draft a pull request title and body for the diff below.\n\nOutput format — strict, no preamble, no code fences, no JSON:\n  Line 1: the PR title (one short line, ≤72 chars).\n  Line 2: empty.\n  Lines 3+: the PR body in markdown, with sections `## Summary`, `## Why`, `## Test plan`.\n\n",
    }
}

/// Inline async helper — same logic as the Tauri command but callable
/// from other Rust modules (memory/extract.rs, etc.) without going
/// through invoke. The Tauri command below is a thin wrapper.
pub async fn run_inline(
    cwd: &str,
    cli: &str,
    mode: HelperMode,
    prompt: &str,
    model: Option<&str>,
) -> Result<String, String> {
    if !cwd.is_empty() && !Path::new(cwd).exists() {
        return Err(format!("cwd does not exist: {cwd}"));
    }
    let agent = AgentCli::parse(cli).ok_or_else(|| format!("unknown cli: {cli}"))?;
    let bin = agent.binary();
    let preface = mode_preface(mode);
    let full_prompt = format!("{preface}{prompt}");

    let mut args = agent.build_args(model);
    if agent.prompt_via_arg() {
        args.push(full_prompt);
        let mut command = Command::new(bin);
        command.args(&args);
        // Mark this as a one-shot helper invocation so our installed
        // hook scripts can skip their socket forward — the worktree
        // spinner is reserved for interactive turns the user actually
        // started, not background calls like "draft this commit msg".
        // Inherited through the agent CLI into its hook subprocesses.
        command.env("GOONWARE_HELPER_AGENT", "1");
        if !cwd.is_empty() {
            command.current_dir(cwd);
        }
        let out = command
            .output()
            .await
            .map_err(|e| format!("spawn {bin}: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!(
                "{bin} exited {}: {}",
                out.status.code().unwrap_or(-1),
                stderr.trim()
            ));
        }
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }

    let mut command = Command::new(bin);
    command.args(&args);
    command.env("GOONWARE_HELPER_AGENT", "1");
    if !cwd.is_empty() {
        command.current_dir(cwd);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn {bin}: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(full_prompt.as_bytes())
            .await
            .map_err(|e| format!("write {bin} stdin: {e}"))?;
        drop(stdin);
    }

    let out = child
        .wait_with_output()
        .await
        .map_err(|e| format!("{bin} wait: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "{bin} exited {}: {}",
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tauri::command]
pub async fn helper_run(
    cwd: String,
    cli: String,
    mode: HelperMode,
    prompt: String,
    model: Option<String>,
) -> Result<String, String> {
    run_inline(&cwd, &cli, mode, &prompt, model.as_deref()).await
}

/// Static detection — for v1, the frontend already classifies the
/// running CLI by pattern-matching on the command line. This command
/// just normalizes a command name string into our enum.
#[tauri::command]
pub fn detect_agent(command: String) -> Option<String> {
    AgentCli::parse(&command).map(|a| a.binary().to_string())
}
