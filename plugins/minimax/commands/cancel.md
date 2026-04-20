---
description: Cancel a running rescue job
argument-hint: '[--json] [--keep-workspace] <jobId>'
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" cancel "$ARGUMENTS"
```

SIGTERM the worker, wait 5s, SIGKILL if still alive. Always marks the job as `canceled` in meta.json. Default: removes the sandbox workspace directory. `--keep-workspace` preserves it for debugging.

If the job was never running (still queued) or already finished, reports `already-finished`.

Present output verbatim; do NOT re-run the job automatically.
