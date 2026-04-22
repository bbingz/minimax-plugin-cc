# minimax-plugin-cc progress

> Cross-session handoff pointer. For full history read `CHANGELOG.md`.

## Phase status

| Phase | Status | Tag | Notes |
|---|---|---|---|
| 0 | done | (13 probe reports + SKILL v0.1) | P0.10 FAILED → serial-only mandate |
| 1 | done | `phase-1-foundation` | YAML write gate + callMiniAgent scaffolding |
| 2 | done | `phase-2-ask` | `/minimax:ask`; classifier end_turn added mid-smoke |
| 3 | done | `phase-3-review` | `/minimax:review` + schema + 1-shot retry |
| 4 | done | `phase-4-rescue` | rescue/status/result/cancel/task-resume-candidate + serial queue + subagent + hooks |
| 5 | done | `v0.1.0` | `/minimax:adversarial-review` + skill v1 + lessons.md (T9 PASS) |

Last Phase 5 work commit: `6235f60` (Task 5.10 T9 smoke). v0.1.0 tag attached at Task 5.12.

<details>
<summary>Phase 5 — remaining scope (historical, completed)</summary>

> Historical: Phase 5 done as of 2026-04-21 — section preserved for traceability.

Per spec §8.2:
- `/minimax:adversarial-review` command (red-team + blue-team 双视角 review of current diff)
- `prompts/adversarial-review.md` (new prompt; red/blue Chinese-direct style)
- Skill finalization:
  - `minimax-cli-runtime` bump to v1.0
  - `minimax-prompting` content (currently skeleton from Phase 1)
  - `minimax-result-handling` consolidation + adversarial-render reference
- `lessons.md` — full write-up:
  - §A 命名替换规则 (spec §2.4)
  - §B 重写 9 项 (spec §B appendix)
  - §C 几乎纯复制 8 项 (spec §C appendix)
  - §D 本次踩坑 — e.g. Phase 2 end_turn discovery, Phase 4 pid-reuse caveat, P0.10 serial mandate
  - §E CLI 集成层前置调研清单 (spec §E)
  - §F LLM 行为层前置调研清单 (spec §F)
- **T9 hard gate**: `/minimax:adversarial-review` on a 3–5 line diff yields two distinct viewpoint blocks (red finds risk; blue finds mitigation) both schema-valid.
- Final step: tag `v0.1.0`.

</details>

<details>
<summary>How to start Phase 5 (historical, completed)</summary>

> Historical: see git log + lessons.md for actual sequence.

1. Read `plugins/minimax/skills/minimax-cli-runtime/SKILL.md` (canonical probe facts).
2. Read `docs/superpowers/specs/2026-04-20-minimax-plugin-cc-design.md` §6.2 (/minimax:adversarial-review block) + §8.1 T9 + §6.6 (prompts).
3. Read `docs/superpowers/plans/2026-04-21-phase-4-rescue.md` v2 revision index — same 3-way review pattern should apply to Phase 5 plan.
4. Skim `plugins/minimax/scripts/lib/minimax.mjs` `callMiniAgentReview` + `buildReviewPrompt` — adversarial-review composes over these (plan v2 Phase 5 heads-up entry).
5. Start writing-plans skill → 3-way review → execute.

</details>

## Useful invariants

- All spawn paths go through `acquireQueueSlot` (P0.10; Task 4.0 retrofit applied to ask/review; Task 5.4 adversarial-review acquires once for entire red+blue pair per D5.3).
- `--sandbox` = isolated workdir, NOT a security boundary (language discipline in every surface text).
- Classifier SUCCESS set covers both `stop` (OpenAI) and `end_turn` (Anthropic/Coding Plan).
- No emoji in files; secrets always pass through `redactSecrets`.
- Adversarial-review reuses `review-output.schema.json` (no new schema); red and blue spawn independently with own 1-shot retry budget; both must succeed for ok=true.

## Test suite

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
node --test plugins/minimax/scripts/lib/*.test.mjs
```

Current: **82 pass / 0 fail** (as of v0.1.0; was 79 at `phase-4-rescue` baseline + 3 callMiniAgentAdversarial mock tests in `minimax-adversarial.test.mjs`. The `minimax.test.mjs` custom test framework grew internal counter from 45 to 50 with +5 buildAdversarialPrompt unit tests but those don't bump node:test's outer count.)

## Cross-plugin alignment response (Gemini v0.6.0 baseline → minimax v0.1.2)

> Response to `/Users/bing/-Code-/gemini-plugin-cc/docs/alignment/minimax.md` (their 2026-04-21 review of our v0.1.0). Per `/Users/bing/-Code-/gemini-plugin-cc/docs/alignment/README.md` and its "单向流动" rule, the reply lives here. Each point below was re-checked against actual v0.1.2 code and local runtime artifacts before writing.

**Per-finding verdicts**

- **P0 — Timing 完全缺席**: confirmed.
  - `grep -rE "timing|appendTiming|TimingAccumulator|timings\.ndjson" plugins/minimax/scripts/` returned no hits.
  - `grep -n "TIMING\|timing" plugins/minimax/scripts/lib/state.mjs` returned no hits.
  - Their broad conclusion is correct: this is not a stubbed feature, it is absent. The architectural follow-up we agree with is "minimum viable timing", not a copy of Gemini's full six-segment streaming model.
  - Current fit for Mini-Agent is likely `spawnAt -> first-log-timestamp -> last-log-timestamp -> process-close`, which naturally yields cold / effective / tail without pretending we have per-event stream timing.

- **P1 — Primary-model attestation missing**: confirmed as currently blocked by upstream log shape.
  - Inspected the latest local Mini-Agent log: `~/.mini-agent/log/agent_run_20260421_214527.log`.
  - Verified fields present: REQUEST/RESPONSE timestamps and `finish_reason`.
  - Did **not** find a discrete served-model field in the RESPONSE block or another machine-readable equivalent to Gemini's `stats.models`.
  - The word `MiniMax` appears in prompt text/system prompt, which is not evidence of the actually served model. So their request for verification was right, and the result is: attestation is not implementable from current logs without upstream Mini-Agent changes.

- **P2 — Hook cleanup likely missing**: confirmed.
  - Our [`plugins/minimax/scripts/session-lifecycle-hook.mjs`](/Users/bing/-Code-/minimax-plugin-cc/plugins/minimax/scripts/session-lifecycle-hook.mjs) is 30 lines vs Gemini's 114 lines.
  - Actual behavior today is minimal by design: `SessionStart` injects `MINIMAX_COMPANION_SESSION_ID`; `SessionEnd` deletes the session-id file. No workspace scan, no stale-job pruning, no orphan-PID cleanup.
  - Gemini's size-based suspicion was therefore directionally correct. More importantly, the growth risk is real for our own state paths: `job-control.mjs` defaults to `~/.claude/plugins/minimax/jobs`, and the hook currently does nothing to prune it.

- **P3 — `/minimax:timing` missing**: accepted as dependent on P0.
  - No command exists today.
  - We should only add it after the underlying telemetry schema exists; otherwise the command becomes UI theater over empty data.

- **P4 — `lib/*.test.mjs` inline style**: acknowledged, not treated as a defect.
  - We are keeping the co-located `lib/*.test.mjs` layout for now.
  - After the v0.1.2 patch set, `node --test plugins/minimax/scripts/lib/*.test.mjs` is at 86 pass / 0 fail, so the current layout is not impeding verification.

**Answers to Gemini's "我看不到的地方"**

1. **Mini-Agent 是什么**: third-party CLI/runtime from `MiniMax-AI/Mini-Agent`, not an official minimax-plugin-maintained runner. We wrap it because it gives us a tool-capable agent surface plus stable log artifacts to parse.
2. **Why log-file fallback instead of stdout-only parsing**: stdout is human-oriented and ANSI/noise-prone; logs are the most structured artifact Mini-Agent gives us. That design is intentional, not accidental.
3. **Log format / timing implications**: current log files are sectioned plain text with REQUEST/RESPONSE blocks and timestamps, not NDJSON. They are good enough for coarse timing, not rich enough for Gemini-style per-event telemetry or served-model attestation.
4. **Why no timing constants in `state.mjs`**: because timing has not been bootstrapped yet. This is an actual gap, not hidden code.
5. **Role of `PROGRESS.md`**: cross-session handoff + decision summary. Deep plan detail still lives under `docs/superpowers/plans/*.md`.
6. **How `task-resume-candidate` is triggered**: currently as an explicit user-facing command, not an automatic rescue preflight.

**Adoption / non-adoption**

- We are adopting the core of Gemini's timing criticism, but not the exact implementation shape. Mini-Agent lacks stream events, so a coarse 3-segment model is a better fit than pretending we can reproduce Gemini's 6-segment event-router model.
- We are adopting the hook-cleanup criticism directly. A lightweight stale-job cleanup on `SessionStart` is appropriate for our current `~/.claude/plugins/minimax/jobs` path.
- We are **not** claiming parity on primary-model attestation until Mini-Agent exposes a real served-model field.

**Tentative v0.1.3 scope seeded by this review**

1. Add coarse timing telemetry for Mini-Agent-backed runs.
2. Add stale-job cleanup to `session-lifecycle-hook.mjs`.
3. ~~Open/track an upstream Mini-Agent request for served-model logging.~~ — **dropped 2026-04-22**: decision is to absorb the limitation internally rather than file an upstream issue. See "Upstream limitations (accepted)" below.

## Upstream limitations (accepted)

Mini-Agent 0.1.0's log RESPONSE block does NOT expose the following. We note these as accepted constraints, NOT as open tickets:

- `served_model` (would enable silent-fallback detection) — not present; we record `requestedModel` from our own `config.yaml` only
- `usage` (input/output/thoughts token counts) — not present; downstream `tokensPerSec` cannot be computed
- per-line timestamps — not present; downstream `ttftMs`/`toolMs`/`retryMs` cannot be measured, silent auto-retries absorbed into `streamMs`

v0.1.3's `TimingAccumulator` emits these fields as `null` / `[]` and documents the gap in `spec §4 compat callout`. Forward-compat scaffolding (reserved no-op methods in `TimingAccumulator`) is in place so if upstream behavior changes in a future Mini-Agent release we can wire stream events without restructuring the class.

**Not open as an upstream issue** — user decision, 2026-04-22. Re-visit if/when upstream behavior visibly changes.

## v0.1.0 shipped

Last Phase 5 work commit: `6235f60`. v0.2 路线见 `docs/superpowers/specs/2026-04-20-minimax-plugin-cc-design.md` §8.5。
