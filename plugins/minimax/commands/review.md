---
description: Run a MiniMax code review on the current diff
argument-hint: '[--json] [--base <ref>] [--scope <auto|working-tree|staged|branch>] [--timeout <ms>] [--cwd <path>] [focus ...]'
allowed-tools: Bash(node:*)
---

Invoke the minimax companion to run a review:

```bash
MINIMAX_COMPANION_CALLER=claude node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" review "$ARGUMENTS"
```

Present the output to the user.

**Follow `minimax-result-handling/references/review-render.md` for presentation rules.** Key points:

**If the companion exits 0** (review succeeded, with or without retry):
1. Present the verdict, summary, findings, and next_steps verbatim.
2. Sort findings by severity (critical > high > medium > low).
3. Do NOT auto-fix any finding. The user picks which to address.
4. If `retry_used` is true, mention it in one line after the findings: "(note: review retry used -- the first response failed validation)".
5. If the diff was truncated upstream (not v0.1), warn the user -- v0.1 always passes the full diff through argv.

**If the companion exits non-zero**:
- exit 2 (check `status` in JSON payload to distinguish):
  - `no-diff`: nothing to review. Detail describes which scope was tried; suggest `--base <ref>` if they meant a branch compare.
  - `no-base`: user passed `--scope branch` without `--base`. Suggest supplying `--base main` (or their branch's merge-base).
  - `bad-scope`: user passed an unknown `--scope` value. Echo the detail (lists accepted values).
  - `merge-conflict-present`: `git ls-files --unmerged` showed conflicts. Tell the user "Resolve merge conflicts before running review."
- exit 4: mini-agent call failed. Present the diagnostic block as-is; suggest running `/minimax:setup` if auth-not-configured, or retrying if llm-call-failed.
- exit 5: JSON parse/validation failed even after 1 retry. Present both raw responses (`firstRawText` and `rawText`) under clearly labeled headings; do NOT paraphrase. Declarative suggestion: "The model returned non-conforming output twice. Rerun with a narrower focus to reduce confusion."
- exit 6: git command failed. Surface the error directly.

**Do NOT retry automatically** on any failure. The user decides.

### Comparing with Claude's own `/review`

If `/review` (Claude's native review) was already run earlier in the same conversation, compare findings:
- Both found: overlap
- Only MiniMax: unique
- Only Claude: unique

Surface the comparison as a small table; do not merge or re-rank.
