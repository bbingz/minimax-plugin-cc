---
description: Run a MiniMax adversarial code review (red team + blue team) on the current diff
argument-hint: '[--json] [--base <ref>] [--scope <auto|working-tree|staged|branch>] [--timeout <ms>] [--cwd <path>] [focus ...]'
allowed-tools: Bash(node:*)
---

Invoke the minimax companion to run an adversarial review:

```bash
MINIMAX_COMPANION_CALLER=claude node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" adversarial-review "$ARGUMENTS"
```

Present the output to the user.

**Follow `minimax-result-handling/references/adversarial-review-render.md` for presentation rules.** Key points:

**If the companion exits 0** (both red and blue succeeded):
1. Render the red team block first (verdict, summary, findings, next_steps), then blue team block.
2. Within each block, sort findings by severity (critical > high > medium > low).
3. Do NOT merge findings across teams. Do NOT rank one team above the other in commentary.
4. If either team's `retry_used` is true, surface the per-team note inside that team's block.
5. Footer parenthesized: `(model: X · red-log: Y · blue-log: Z [· red-retry-used] [· blue-retry-used])`.
6. Do NOT auto-fix anything. The user picks which team's findings to address (often both are useful).

**If the companion exits non-zero**:
- exit 2 (`status` in JSON tells which): same `no-diff` / `no-base` / `bad-scope` / `merge-conflict-present` mapping as `/minimax:review`.
- exit 4 (`call-failed`, `side` indicates which team): mini-agent invocation failed on red or blue. Present the diagnostic block as-is. If `side === "blue"` and `red` payload is ok, surface the red verdict so the work isn't wasted.
- exit 5 (`parse-validate-failed`, `side` indicates which team): same as `/minimax:review` exit 5 — present `firstRawText` + `rawText` for the failing side under labeled headings; do NOT paraphrase. If `side === "blue"`, surface the red verdict.
- exit 6: git command failed. Surface the error directly.

**Do NOT retry automatically** on any failure. The user decides whether to rerun.

### Comparing with Claude's own `/review` or prior `/minimax:review`

If `/review` or `/minimax:review` ran earlier in the same conversation, present a 4-bucket comparison (Claude∩Red / Claude∩Blue / Red∩Blue / Unique-to-one). Do not merge findings; do not collapse Red and Blue into "MiniMax" — they are deliberately independent viewpoints. See `references/adversarial-review-render.md` for the bucket definitions and overlap criteria.
