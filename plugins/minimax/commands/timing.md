---
description: Show Mini-Agent spawn timing history (last-N or aggregate percentiles).
argument-hint: '[--kind <ask|review|adversarial-red|adversarial-blue|rescue>] [--last <N>] [--since <ISO>] [--aggregate] [--json]'
allowed-tools: Bash(node:*)
---

Run the minimax companion to emit timing history:

```bash
MINIMAX_COMPANION_CALLER=claude node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" timing "$ARGUMENTS"
```

Render per `references/timing-render.md`. `--aggregate` requires a single `--kind` (not `all`) per D7 rule — aggregating across ask + adversarial is bimodal-by-design and statistically meaningless.
