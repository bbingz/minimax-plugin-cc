---
description: Delegate a one-shot question or task to MiniMax (via Mini-Agent)
argument-hint: '[--json] [--timeout <ms>] [--cwd <path>] <prompt>'
allowed-tools: Bash(node:*)
---

Invoke the minimax companion to run `mini-agent -t` and return its answer:

```bash
MINIMAX_COMPANION_CALLER=claude node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" ask "$ARGUMENTS"
```

The companion streams mini-agent stdout live (ANSI-stripped) so the user sees progress during the ~3s Python cold start. On close, the companion parses the log file and emits the final answer.

**Follow `minimax-result-handling` skill for presentation rules.** Key points (quoted verbatim there):

**If the companion exits 0** (success or success-but-truncated):
1. Present the response **verbatim** — everything between the `---` separator line and the footer line `(model: ... · log: ... [· truncated])`.
2. **Preserve the original language.** MiniMax M2 often replies in Chinese when the prompt is Chinese; do NOT auto-translate unless the user explicitly asks.
3. **MUST NOT** prepend commentary like "Here is MiniMax's answer:" / "MiniMax 回答如下：". The companion stdout is the complete user-facing payload.
4. After the footer you MAY add **exactly one** line flagging disagreement: "Note: Claude disagrees on X because Y." Keep it to one sentence; omit when you agree.
5. Do NOT auto-apply suggestions. If the response contains code / commands, the user decides whether to run them.
6. If the footer contains `truncated`: add one line "Note: response was truncated by model `length` finish reason; consider retrying with a shorter prompt or splitting the task."

**If the companion exits non-zero** (status != success):
1. Present the `Error: <status> -- <detail>` line from stderr directly.
2. If stderr contains a `--- diagnostic (stderr head+tail, ANSI stripped) ---` block, include it under that heading.
3. Add **exactly one** declarative suggestion based on the status. Use these literal templates -- do NOT paraphrase, do NOT turn into a question. **MUST NOT end with '?'.** Declarative sentences only:
   - `auth-not-configured` / `config-missing` -> "Run `/minimax:setup` to configure your API key."
   - `needs-socksio` -> "Reinstall Mini-Agent with `uv tool install --force --with socksio git+https://github.com/MiniMax-AI/Mini-Agent.git`."
   - `not-installed` -> "Run `/minimax:setup` to install Mini-Agent."
   - `llm-call-failed` -> "The LLM call failed after MiniMax's own retries. Check the log at the path shown; retry when the upstream is healthy."
   - `incomplete` -> "The agent stopped with pending tool calls. Restart with a clearer prompt or use `/minimax:rescue` for multi-step tasks (Phase 4)."
   - `unknown-crashed` / `success-claimed-but-no-log` -> "Mini-Agent crashed or finished without writing a terminal response. Check the log path shown and rerun."
4. Do NOT retry automatically. Do NOT pose a question. The user decides whether to retry.

### Suspicious tool-calls (safety tripwire from `minimax-result-handling`)

If the response footer is `model: ... · log: ...` and the JSON mode would have surfaced `toolCalls[]` containing any of `rm -rf /`, `> /dev/`, `curl ... | sh`, `sudo`, `chmod 777` -- call them out explicitly rather than summarize the response. v0.1 ask does not expose toolCalls in text mode; use `--json` when auditing.

### Options

- `--json` -- emit structured JSON `{status, response, toolCalls, finishReason, logPath, thinking}` or `{status, reason, detail, diagnostic, logPath}`. Designed for scripting; in interactive Claude flows prefer the text mode.
- `--timeout <ms>` -- override hard timeout (default 120000 = 2 min). Cold start alone is ~3-10 s; long multi-step tasks need larger values. Beyond 10 min, prefer Phase 4 `/minimax:rescue --background`.
- `--cwd <path>` -- set mini-agent workdir. Defaults to the Claude Code cwd.
