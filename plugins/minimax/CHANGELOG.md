# minimax plugin CHANGELOG

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
