---
description: List the 5 most recent Mini-Agent log files (v0.1 informational only; no resume)
argument-hint: '[--json]'
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" task-resume-candidate "$ARGUMENTS"
```

v0.1 limitation: Mini-Agent does NOT expose an external session id (P0.9 probe finding), so these logs cannot be re-entered. This command is a viewer only -- it helps you locate the log for a previous task.

Present the output verbatim. Do NOT pretend `--resume` or `--resume-last` flags exist; they don't in v0.1.
