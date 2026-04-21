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

## v0.1.0 shipped

Last Phase 5 work commit: `6235f60`. v0.2 路线见 `docs/superpowers/specs/2026-04-20-minimax-plugin-cc-design.md` §8.5。
