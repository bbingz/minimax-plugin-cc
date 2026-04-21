# minimax plugin CHANGELOG

## 2026-04-22 — v0.1.2 (review hardening + release)

- **Critical**: switch `buildReviewPrompt` + `buildAdversarialPrompt` placeholder substitution to callback-form `.replace(pat, () => value)` so JS does not interpret `$&` / `$$` / `$1-$9` inside user-derived content.
- **High**: add `buildReviewPrompt` regression coverage for M2 sentinel behavior and replacement-token survival.
- **High**: `/minimax:adversarial-review` defaults to `--json`, preserving the red block when blue fails.
- **High**: adversarial mock tests no longer rely on `process.env.MOCK_*`; per-instance config is passed via generated-script literals/argv.
- **High**: `extractReviewJson` ignores stray leading `}` and can recover to a later valid JSON object while preserving malformed-candidate parse errors.
- **Tests**: 86 pass / 0 fail.

## 2026-04-21 — v0.1.1 (Phase 5 follow-up patch)

- **M5**: `_callReviewLike` short-circuits when first-shot is `truncated && !extracted.ok` — retry would identically truncate, no point wasting another spawn + queue slot. New error code: `truncated-and-unparseable`.
- **M2**: `buildAdversarialPrompt` + `buildReviewPrompt` swap real `{{CONTEXT}}` slot to a sentinel BEFORE substituting other placeholders. Prevents first-match-shadowing when previousRaw / focus / retryHint contains literal `{{CONTEXT}}` text. C3 patch was incomplete; this is the proper fix.
- **H4**: `callMiniAgentAdversarial` JSDoc clarifies `timeout` is per-spawn (worst-case wall = 4 × timeout). Doc-only; existing call site already accounts for this.
- **Provenance**: 3 fixes ranked top-3-actionable from a 16-finding self-review by `minimax:minimax-agent` subagent against just-shipped v0.1.0 code.
- **Tests**: 83 pass / 0 fail (+1 over v0.1.0). 1 obsolete test replaced; +2 regression tests (M2 previousRaw poisoning / M5 truncated short-circuit).

## 2026-04-21 — Phase 5

- Add /minimax:adversarial-review command (red team + blue team dual stance).
- Add prompts/adversarial-review.md (single template, {{STANCE_INSTRUCTION}}
  switches stance; Chinese-direct M2.7 idiom).
- Add lib/minimax.mjs::_callReviewLike (zero-behavior-change refactor of
  callMiniAgentReview's single-spawn + 1-shot retry skeleton).
- Add lib/minimax.mjs::callMiniAgentAdversarial (sequential red→blue, both
  must succeed; errorPrefix="prompt-build-failed" per I1; no "red-team failed:"
  prefix per I5; stance-prefixed onProgressLine wrapper).
- Add RED_STANCE_INSTRUCTION / BLUE_STANCE_INSTRUCTION module constants
  (Chinese 「」 internal quotes per C1; blue mitigation-gap focus per I10;
  blue severity calibration per M9).
- Add buildAdversarialPrompt with whitelist leftover guard (C3) + Chinese
  retry hint (C4); same C3 guard pattern back-applied to buildReviewPrompt.
- Add minimax-companion.mjs::runAdversarialReview subcommand: single
  acquireQueueSlot held across both spawns (D5.3); maxWaitMs = timeout*4 + 30s;
  stdout queue-hold notice per I15; pickViewpointPayload + renderViewpointText
  helpers; text mode renders === Red Team === then === Blue Team === blocks.
- Bump skills to v1: minimax-cli-runtime frontmatter; minimax-prompting SKILL
  finalized (drop "skeleton") + 3 references (recipes / antipatterns /
  prompt-blocks); minimax-result-handling adds adversarial-review-render
  reference, drops "What still needs Phase 3+ work" → "v1 status".
- C7: skip appending Phase 4-5 deltas to cli-runtime SKILL.md (LLM context
  consumed; history goes to lessons.md §D instead).
- Tests: +5 buildAdversarialPrompt unit tests (red / blue / unknown-stance /
  retry-redaction / C3 regression); +3 callMiniAgentAdversarial mock tests
  (both-succeed / red-fail-no-blue-spawn-trace / blue-fail-red-surfaced).
  Total: 82 pass / 0 fail.
- Smoke: T9 PASS (doc/smoke/phase-5-T9.md) — red needs-attention (2 critical)
  vs blue approve (1 low), 0 retry, 41s elapsed.

## 2026-04-21 — Phase 4

- Add /minimax:rescue / :status / :result / :cancel / :task-resume-candidate commands.
- Add lib/job-control.mjs: createJob / readJob / updateJobMeta / listJobs /
  filterJobsBySession / cancelJob + serial-queue acquireQueueSlot /
  releaseQueueSlot (directory-based lock with atomic rename-reclaim).
- Add internal _worker subcommand for detached background execution
  (true try/finally so queue slot always releases).
- Add minimax-agent subagent (thin-wrapper contract; --sandbox is isolated
  workdir, NOT a security boundary).
- Add hooks/hooks.json + session-lifecycle-hook.mjs (dual-protocol env
  injection: CLAUDE_ENV_FILE + stdout JSON) + stop-review-gate-hook.mjs
  (default-disabled, --timeout 600000 passthrough to review).
- Add prompts/stop-review-gate.md (spec §6.6 deliverable; wiring deferred
  to Phase 5).
- Add minimax-result-handling references/rescue-render.md (tripwire applies;
  cross-session visibility note).
- Retroactive: runAsk (Phase 2) and runReview (Phase 3) now route through
  acquireQueueSlot so P0.10 single-spawn holds across all commands.
- v0.1 limitations: task-resume-candidate is informational only; stop-review
  -gate runs default review prompt; detached workers survive session end;
  cancelJob kill(pid,0) has pid-reuse gap.
- Smoke: T6 (background rescue → status → result) + T11 (sandbox mtime
  invariant + note.txt written into workspace) PASS. Tag `phase-4-rescue`
  applied.

## 2026-04-20 — Phase 3

- Add /minimax:review command + companion runReview subcommand.
- Add schemas/review-output.schema.json (draft 2020-12; byte-aligned with
  gemini version except for $id URI and two minLength tightenings on
  findings[].file and findings[].recommendation).
- Add prompts/review.md (strict JSON-only review template; placeholders for
  {{SCHEMA_JSON}}/{{FOCUS}}/{{CONTEXT}}/{{RETRY_HINT}} with post-substitute
  leftover assertion).
- Add buildReviewPrompt / extractReviewJson (brace-balanced scanner) /
  validateReviewOutput (hand-rolled draft 2020-12 subset) / reviewSuccess /
  reviewError / callMiniAgentReview.
- callMiniAgentReview: 1-shot retry with error hint + verbatim redacted prior
  response (first 1500 chars) echoed into the retry prompt.
- Companion collectDiff runs git ls-files --unmerged first; auto-scope falls
  working-tree -> staged -> branch (needs --base). Exit code map for
  no-diff/no-base/bad-scope/merge-conflict-present/call-failed/
  parse-validate-failed/git-diff-failed.
- onProgressLine streams ANSI-stripped stdout to stderr in text mode (keeps
  JSON mode clean).
- Failure text-mode surfaces lastPartialResponseRaw + firstRawText + rawText,
  each redacted and 1500-char capped.
- Severity sort has ?? 99 defensive fallback.
- retriedOnce spec §4.5 alias always derived from retry_used (one source).
- Add minimax-result-handling references/review-render.md; explicit note that
  the suspicious-tool-calls tripwire does NOT apply to review output.
- Smoke: T5 (review --json, real 4-line diff, Coding Plan) PASS.

## 2026-04-20 — Phase 2

- Add /minimax:ask command.
- Add callMiniAgent (one-shot spawn + log parse + progress streaming).
- Add classifyMiniAgentResult (three-layer sentinel). Refactor getMiniAgentAuthStatus to reuse it.
- Add minimax-result-handling skill v0.1 (ask-render reference).
- spawnWithHardTimeout: onStdoutLine callback + stdout/stderr ring-buffer caps.
- stripAnsiSgr now exported.
- Breaking: auth-status timeout label changed from `ping-timeout` to `llm-call-failed`.
- Classifier now accepts Anthropic-native `end_turn` as success (MiniMax
  provider=anthropic / Coding Plan endpoint emits this instead of OpenAI's `stop`).
- Smoke: T2 PASS (real Coding Plan key, status=success, finishReason=end_turn),
  T3 PASS (first-line 156ms, full Chinese response verbatim),
  T10 PASS (fake key → llm-call-failed, no key leak). Tag `phase-2-ask` applied.

## 0.1.0 (in progress)

- Initial scaffold (Phase 1 Task 1.1-1.2)
- `/minimax:setup` command (Phase 1 Task 1.10-1.11)
- Near-copy of gemini-plugin-cc lib files (args/process/render/git/state) (Phase 1 Task 1.3-1.5)
- `minimax.mjs` core wrapper (YAML reader/writer with hardened gate + spawnWithHardTimeout + log state-machine parser + async auth) (Phase 1 Task 1.6-1.9b)
- `minimax-cli-runtime` skill draft from Phase 0 probes (P0.13)
- `minimax-prompting` skill skeleton (Task 1.12)
