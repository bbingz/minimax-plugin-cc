---
description: Delegate a multi-step agent task to MiniMax
argument-hint: '[--json] [--sandbox] [--background] [--timeout <ms>] [--cwd <path>] <prompt>'
allowed-tools: Bash(node:*), AskUserQuestion
---

Invoke the minimax companion:

```bash
MINIMAX_COMPANION_CALLER=claude node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" rescue "$ARGUMENTS"
```

**Follow `minimax-result-handling/references/rescue-render.md` for presentation rules.** Key points:

- **`--sandbox`** means "isolated workdir" -- the agent runs in `~/.claude/plugins/minimax/jobs/<jobId>/workspace/`. It is **NOT** a security boundary. The agent's bash tool can still `cd /`, use absolute paths, `curl | sh`, etc. If the user needs real isolation, tell them to run in a container.
- **Serial execution**: only one mini-agent runs at a time (P0.10 conditional hard gate). Concurrent `/minimax:rescue --background` invocations queue up.
- **`--background`** detaches the worker; output goes to `jobs/<jobId>/stdout.log` + `stderr.log` + `meta.json`. Use `/minimax:status` to poll, `/minimax:result <jobId>` to retrieve, `/minimax:cancel <jobId>` to abort.

**If exit 0**: present the response verbatim (same rules as `/minimax:ask`) + note the footer's `job:` suffix.

**If exit non-zero**: surface the `Error:` line; match status to declarative suggestion from the status->opener table in `SKILL.md`.

**Suspicious tool-calls tripwire (SKILL.md) APPLIES HERE.** Before transcribing any agent output that includes bash invocations, scan for `rm -rf /`, `> /dev/`, `curl ... | sh`, `sudo`, `chmod 777`, fork-bomb patterns. If any match, surface the tool_use verbatim and demand explicit user confirmation via AskUserQuestion before proceeding.
