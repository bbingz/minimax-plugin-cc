---
description: List rescue jobs from the current Claude Code session
argument-hint: '[--json] [--all] [<jobId>]'
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" status "$ARGUMENTS"
```

Default lists jobs for the current session (session id comes from the `MINIMAX_COMPANION_SESSION_ID` env injected by the session-lifecycle hook). Use `--all` to list every session's jobs.

Supply a single `<jobId>` for a one-job snapshot.

Output columns (text mode): `<jobId>  <status>  <elapsed>  <prompt truncated>`. Status is one of `queued|starting|running|done|failed|canceled`.

Present the output verbatim.
