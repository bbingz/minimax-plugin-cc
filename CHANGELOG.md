
## 2026-04-22 [Claude opus controller] — v0.1.3 — timing + SessionStart cleanup + upstream absorbed

- **status**: done (code + tests + docs; T14 real-Mini-Agent smoke pending user-side verification before tag)
- **scope**: per spec `docs/superpowers/specs/2026-04-22-v0.1.3-timing-cleanup-upstream.md` v2.1:
  - `lib/timing.mjs`: `TimingAccumulator` class (field names mirror gemini-plugin-cc, `invariantKind: "3term"` discriminator) + `percentile` / `computeAggregateStats` / `filterHistory` / render helpers (history table / aggregate / one-liner)
  - `lib/state.mjs::appendTimingHistory` (O_EXCL lock, 10 MB cap + half-trim retention, crash-recovery leading `\n`, separate `TIMING_FALLBACK_DIR` so telemetry lands at Gemini-compat path, not jobs' tmpdir)
  - `callMiniAgent` signature gains optional `{jobId, kind}`; 5 call sites wired to persist post-return (runAsk / runReview → _callReviewLike / callMiniAgentAdversarial red+blue / runRescue foreground + _worker)
  - `/minimax:timing` command (history / `--aggregate --kind <single>` / `--json`) + D7 composition rule (exit 2 when `--aggregate` lacks valid `--kind`) + `--since` ISO validation (exit 3)
  - `session-lifecycle-hook.mjs`: SessionEnd per-session terminal cleanup + SessionStart 4-branch mtime sweep (terminal / non-terminal+dead / missing-meta / corrupt-meta+fresh-skip), `MINIMAX_STALE_JOB_THRESHOLD_MS` env override (D4 flipped)
  - `skills/minimax-result-handling/references/timing-render.md` (exit codes + aggregate `—` semantics)
  - Upstream Mini-Agent issue: **not filed** (user decision 2026-04-22; limitations absorbed internally, documented in `PROGRESS.md §Upstream limitations`)
- **summary**:
  - Three fields (`firstEventMs` / `streamMs` / `retryMs`) share Gemini names but carry different semantic — `firstEventMs` measures Mini-Agent CLI boot (probe P0.1), `streamMs` is stdout-line bracket and silently absorbs Mini-Agent's 1+2+4s internal retries (probe P0.2/P0.5), `retryMs` null by design. Documented in spec §4 compat callout.
  - `invariantKind: "3term"` lets cross-plugin tools branch on `firstEventMs + streamMs + tailMs === totalMs` vs Gemini's 6-term sum.
  - `usage: []` (not null) — matches Gemini's `this._usage || []` so downstream `.length` / `.map()` stay safe. Empty until upstream adds `served_model` (which we chose not to request).
  - `fallback rate` renders `—` (not `0.0%`) when no record has populated `usage` — avoids misleading "no fallback detected" vs true "cannot detect".
  - 6-way spec review (11 Critical + 17 High + 11 Medium) + 3-way sanity (5 new H + 2 M) + 3-way plan review (5 Critical + 7 High) all folded before execution.
- **tests**: 133 pass / 0 fail (prior 86 + timing 22 + state 6 + hook 13 + adversarial D7 integration 1 + callMiniAgent regression 1 + other extras = +47). Full test paths: `plugins/minimax/scripts/lib/*.test.mjs` + `plugins/minimax/scripts/session-lifecycle-hook.test.mjs`.
- **next**: T14 real-Mini-Agent smoke (user-run 11 assertions) → tag `v0.1.3` → push → `gh release create` → Gemini re-alignment signal in PROGRESS.md.

## 2026-04-22 04:30 [Claude opus controller] — v0.1.2 patch — review fixes + release prep

- **status**: done
- **scope**: prompt-substitution hardening, review/adversarial regression coverage, command default fix, test-mock isolation fix, `extractReviewJson` recovery fix, version bump 0.1.1 → 0.1.2
- **summary**:
  - **Critical (Gemini)**: `buildReviewPrompt` + `buildAdversarialPrompt` now use callback-form `.replace(pat, () => value)` for all user-derived substitutions, so `$&` / `$$` / `$1-$9` inside focus / retryHint / context are preserved verbatim instead of being interpreted by JS replacement semantics.
  - **High (mirror coverage)**: added `buildReviewPrompt` regression tests for both M2 sentinel behavior and replacement-token survival; existing adversarial-path regression retained.
  - **High (Codex)**: `/minimax:adversarial-review` default command now passes `--json`, preserving the red block when blue fails and aligning with the render reference.
  - **High (Qwen + Gemini + MiniMax)**: `minimax-adversarial.test.mjs` no longer uses `process.env.MOCK_*`; per-fake-bin trace path and finish reason are baked into the generated helper invocation, removing shared mutable test state.
  - **High (Gemini)**: `extractReviewJson` now ignores stray leading `}` and keeps scanning for a later valid object, while still returning `raw-parse-failed` when only malformed candidates exist.
- **tests**: `node --test plugins/minimax/scripts/lib/*.test.mjs` → 86 pass / 0 fail.
- **next**: tag `v0.1.2`, push, GitHub Release, then land Gemini alignment response in `PROGRESS.md`.

## 2026-04-21 19:30 [Claude opus controller] — v0.1.1 patch — minimax-agent self-review findings landed

- **status**: done
- **scope**: 3 fixes from `minimax:minimax-agent` self-review of Phase 5 dual-spawn code (M5 / M2 / H4) + 2 new tests + version bump 0.1.0 → 0.1.1
- **summary**:
  - **M5**: `_callReviewLike` short-circuit when first-shot `truncated && !extracted.ok` — retry would identically truncate, wastes a spawn + queue slot. Returns `truncated-and-unparseable` error directly. Saves up to 1 × timeout per affected adversarial-review.
  - **M2**: `buildAdversarialPrompt` + `buildReviewPrompt` use a sentinel (`__MINIMAX_CONTEXT_SLOT__`) to swap the real `{{CONTEXT}}` slot BEFORE substituting other placeholders. Eliminates first-match-shadowing risk when previousRaw / focus / retryHint contains literal `{{CONTEXT}}`. C3 patch (Phase 5) was incomplete; this is the proper fix.
  - **H4**: `callMiniAgentAdversarial` JSDoc clarifies `timeout` is per-spawn, worst-case wall = 4 × timeout. Existing call site in companion already accounts for this (`maxWaitMs: timeout * 4 + 30_000`); fix is doc-only but prevents future schedulers from miscalculating.
- **review provenance**: dispatched via `Task` tool with `subagent_type: minimax:minimax-agent` against the just-shipped v0.1.0 code — first end-to-end use of the subagent path. 7 tool calls, 149s, 16 findings (4 H / 6 M / 6 L); 3 most actionable picked here.
- **tests**: 83 pass / 0 fail (+1 over 82). Replaced 1 obsolete review test (now asserts new correct behavior under M2) + added 1 buildAdversarialPrompt M2 regression + 1 callMiniAgentAdversarial M5 short-circuit test.
- **next**: tag v0.1.1, push, gh release. User runs `/plugin update` to pull fix.

## 2026-04-21 18:50 [Claude opus controller] — Phase 5 done (T9 PASS, ready to tag v0.1.0)

- **status**: done
- **scope**: Phase 5 — `/minimax:adversarial-review` (red+blue dual spawn) + 三 skill v1 (cli-runtime / prompting / result-handling) + lessons.md §A-§G + T9 PASS。13 tasks committed individually 5.0→5.10。
- **summary**: D5.1 双 spawn (sequential under one queue slot); D5.2 single prompt + `{{STANCE_INSTRUCTION}}` + module constants `RED_STANCE_INSTRUCTION` / `BLUE_STANCE_INSTRUCTION`; D5.3 queue slot integral hold across red+blue+retries (maxWaitMs = timeout*4 + 30s)。`_callReviewLike` extracted as zero-behavior-change refactor (Task 5.0); `callMiniAgentAdversarial` reuses it twice with errorPrefix="prompt-build-failed" (I1)。C3 follow-on: `buildReviewPrompt` leftover guard 同步改白名单 set（latent bug 顺手修）。3 skill 全部 v1 定稿；C7 把 cli-runtime 历史段移到 lessons.md §D。lessons.md 含 12 坑 + Phase 4-5 实现要点 + 5-way review 修订表 (M13)。T9 smoke: 红 needs-attention (2 critical) vs 蓝 approve (1 low) — effective disagreement, 0 retry, 41s elapsed (under 50-90s estimate)。tests: 82 pass / 0 fail (was 79 + 3 adversarial mock tests; minimax.test.mjs internal 50 (was 45) + 5 buildAdversarialPrompt unit tests)。
- **5-way review revisions**: 7 Critical (C1 Chinese 「」 quotes / C2 dissent T9 lenient / C3 placeholder whitelist / C4 Chinese retry hint / C5 4-tick fences / C6 column labels / C7 SKILL no history) + 21 Important + 14 Minor — all but M5/M10 (rejected after deliberation) embedded in v2 plan and shipped.
- **I9 observation**: T9 fixture red 100% critical (2/2) but findings are well-grounded technical bugs (network → TypeError, HTTP error → silent JSON), confidence 0.95; **not** stance-language hallucination. Sample (n=2) too small; stance softening pre-plan NOT triggered. Recorded in lessons.md 坑 11 延伸.
- **next**: Tag v0.1.0 (Task 5.12). v0.2 路线见 spec §8.5。

## 2026-04-21 16:30 [Claude opus controller] — Phase 5 plan v2 locked (5-way review complete; ready for cloud execution)

- **status**: handed-off-to-cloud-executor
- **scope**: docs/superpowers/plans/2026-04-21-phase-5-adversarial.md (2393 lines, 13 tasks); docs/superpowers/plans/2026-04-21-phase-4-rescue.md (Phase 4 historical plan committed for completeness); .gitignore += .claude/
- **summary**: Phase 5 plan drafted (`/minimax:adversarial-review` dual-spawn red+blue under one queue slot, reuse review-output.schema.json, no new schema). Architectural decisions D5.1 (双 spawn) / D5.2 (single prompt + stance constants) / D5.3 (queue slot integral hold) registered. **5-way review** (Codex + Gemini + Claude-opus + Kimi + Qwen) returned 7 Critical + 21 Important + 14 Minor; all-but-3 嵌入 v2 (M5/M10 reject after deliberation; **C2 dissent** Codex-strict vs Kimi-lenient on T9 — selected Kimi's lenient interpretation: schema-valid output with at least one viewpoint having non-empty findings = T9 PASS; rationale登记 in plan v2 revision index + lessons.md §G plan). v2 patches were targeted Edit calls (preserving v1 history per memory `feedback-3way-review`). Plan ready for inline controller execution.
- **process upgrade**: 3-way → 5-way review pattern validated. Non-overlapping coverage observed: Qwen alone caught template-literal injection (mock test), Kimi alone caught command-vs-render column-name mismatch (C6), Gemini alone caught placeholder-regex-misfires-on-user-diff (C3), Claude-opus + Codex co-caught stance-quote-syntax-error (C1). Memory `feedback-3way-review.md` updated to N-way default (3-way for routine; 5-way for ship-bar phases).
- **next**: cloud session pulls this commit, reads project-phase-status.md memory + plan v2, executes Tasks 5.0–5.12 sequentially (per executing-plans skill, NOT subagent-dispatch — `feedback-direct-impl-when-plan-tight` applies). T9 smoke (Task 5.10) is the only step needing real LLM call. Tag v0.1.0 at Task 5.12 ships v0.1.

## 2026-04-21 15:10 [Claude sonnet executor] — Phase 4 complete (T6 / T11 PASS)

- **status**: done
- **scope**: /minimax:rescue + /minimax:status + /minimax:result + /minimax:cancel + /minimax:task-resume-candidate + job-control.mjs (serial queue per P0.10) + minimax-agent subagent + hooks (SessionStart/End + Stop review-gate). Live-verified against Coding Plan endpoint `api.minimaxi.com/anthropic` with model `MiniMax-M2.7-highspeed`.
- **summary**: job-control data layer (atomic meta.json rewrites; mj-<uuid> ids); directory-based serial queue (mkdirSync atomic primitive + rename-and-rmSync stale reclaim — avoids the TOCTOU race an O_EXCL variant had); cancelJob SIGTERM→SIGKILL with pid-reuse caveat; detached background worker (`_worker` internal subcommand, wrapped in try/finally so queue release is guaranteed); runRescue foreground + --background + --sandbox (isolated workdir, explicitly NOT a security boundary per spec §4.6); status/result/cancel/task-resume-candidate subcommands; 5 command.md files (rescue + result have AskUserQuestion in allowed-tools for tripwire confirmation); minimax-agent thin-wrapper contract; hooks.json + dual-protocol session-lifecycle-hook (appends CLAUDE_ENV_FILE AND emits JSON `{env:{...}}`) + stop-review-gate-hook with --timeout 600000 passthrough; prompts/stop-review-gate.md placeholder; rescue-render skill reference with tripwire-applies directive. T6 + T11 smoke: **PASS** (see doc/smoke/phase-4-T6-T11.md).
- **serial-queue enforcement**: v0.1 permits a single `mini-agent` child at a time (P0.10 conditional hard gate FAILED — concurrent spawn log attribution is unreliable under seconds-precision log-file timestamps). Queue implemented as a *directory lock*: global ~/.claude/plugins/minimax/jobs/.queue-lock/ via mkdirSync + owner.json inside; stale reclaim via atomic renameSync + rmSync. **Retroactively applied**: Phase 2 /minimax:ask and Phase 3 /minimax:review were re-wired to also route through the queue (Task 4.0). New rescue/ask/review calls block up to 5 min waiting for the slot. v0.2 will revisit once Mini-Agent upstream injects job-ids into log file names.
- **spec §6.5 extension**: plan registers `SessionStart` in addition to the spec-listed `SessionEnd + Stop`. SessionStart injects `MINIMAX_COMPANION_SESSION_ID`. Intentional extension — env injection must occur at session start.
- **v0.1 limitations made explicit**:
  - `task-resume-candidate` command lists recent log files but cannot actually resume a prior Mini-Agent session (P0.9 — no external session id).
  - Detached `_worker` continues running after a Claude Code session ends; the job is visible in a new session via `/minimax:status --all` (sessionId filter won't match the new session's random id).
  - `stop-review-gate-hook` in Phase 4 runs the default review prompt; `prompts/stop-review-gate.md` is a spec §6.6 deliverable whose wiring is deferred to Phase 5.
  - `cancelJob`'s `kill(pid,0)` check cannot distinguish the real worker from a reused pid (documented in JSDoc).
- **3-way review outcome**: pre-implementation review (Codex / Gemini / Claude) surfaced 6 Critical + 5 Important + 4 Minor issues; all were folded into plan v2 before any code landed. No post-implementation spec/quality review rounds needed — direct implementation by controller following the v2 plan.
- **next**: Phase 5 plan (/minimax:adversarial-review + 3 skill 定稿 + lessons.md 收尾).

## 2026-04-20 22:40 [Claude sonnet executor] — Phase 3 complete (T5 PASS)

- **status**: done
- **scope**: Phase 3 — /minimax:review + schemas/review-output.schema.json + prompts/review.md + callMiniAgentReview (1-shot retry) + companion runReview + review-render skill reference. Live-verified against Coding Plan endpoint `api.minimaxi.com/anthropic` with model `MiniMax-M2.7-highspeed`.
- **summary**: Hand-rolled draft 2020-12 subset validator (no ajv dep); buildReviewPrompt with placeholder substitution + defensive leftover-placeholder assertion + retry-hint block carrying verbatim prior response (redacted + 1500 char cap per spec §4.5); extractReviewJson uses brace-balanced scanner over string/escape states (not first-to-last slice); callMiniAgentReview wires build -> callMiniAgent -> classify -> extract -> validate -> retry-once-if-needed; reviewSuccess/reviewError helpers keep retriedOnce alias derived from retry_used in one place. Companion collects git diff (auto/working-tree/staged/branch) with upfront merge-conflict refusal via git ls-files --unmerged. All raw-text fields pass through redactSecrets; classifier success-but-truncated flag propagates into review result. Severity-sorted findings rendering with defensive ??99 fallback. Skill reference clarifies the suspicious-bash tripwire does NOT apply to review output. T5 smoke: real 4-line diff -> exit 0, status=ok, verdict=approve, findings_count=1, retry_used=false, retriedOnce=false, truncated=false (see doc/smoke/phase-3-T5.md).
- **spec alignment**: schemas/review-output.schema.json byte-aligned with gemini except for the $id URI and two intentional tightenings — findings[].file.minLength:1 and findings[].recommendation.minLength:1. Registered as a minimax-specific divergence.
- **phase 5 heads-up**: prompts/review.md placeholder scheme + brace-balanced extractor + 1-shot retry wiring are directly reusable for /minimax:adversarial-review. Phase 5 author should compose over these rather than duplicate.
- **process**: 3-way plan review (Codex/Gemini/Claude) landed before execution; 15 revision entries traced. Each task dispatched to codex:codex-rescue for implementation, Claude sonnet for spec compliance review, superpowers:code-reviewer for code quality. Two-stage review caught 5 post-implementation issues (schema description drift, validator null/path bugs, placeholder-shadow risk, retriedOnce divergence risk, USAGE legend miss, severity-sort NaN risk) — all fixed on follow-up commits.
- **next**: Phase 4 plan (/minimax:rescue + --sandbox + job-control MUST serialize per P0.10 + minimax-agent subagent + 2 hooks).

## 2026-04-20 19:25 [Claude sonnet executor] — Phase 2 complete (T2/T3/T10 all PASS)

- **status**: done
- **scope**: Phase 2 — /minimax:ask + callMiniAgent + classifyMiniAgentResult (spec §4.1 three-layer sentinel) + minimax-result-handling skill v0.1 + /minimax:ask command.md. Live-verified against MiniMax Coding Plan (`api.minimaxi.com/anthropic`, model `MiniMax-M2.7-highspeed`).
- **summary**: spawnWithHardTimeout extended with onStdoutLine + ring-buffer cap (Task 2.1); callMiniAgent with Log file capture + snapshot-diff fallback (Task 2.2); classifyMiniAgentResult unifies the three-layer sentinel, ALSO refactors getMiniAgentAuthStatus to reuse it (Task 2.3, BREAKING: old `reason:"ping-timeout"` is now outer `reason:"llm-call-failed"` + inner `reason:"hard-timeout"`); ask subcommand with immediate T3 banner, stripAnsiSgr exported to avoid duplicate (Task 2.4); /minimax:ask command.md with status→opener map (Task 2.5); minimax-result-handling SKILL.md + references/ask-render.md with suspicious-bash tripwire (Task 2.6). Smoke run: **T2 PASS** (status=success, finishReason=end_turn), **T3 PASS** (first line 156ms, full response 13.5s, Chinese preserved), **T10 PASS** (fake key → llm-call-failed, no key leak). Tag `phase-2-ask` applied.
- **spec patch**: Mid-smoke discovered Mini-Agent passes the upstream provider's native `finish_reason` to the log untranslated — OpenAI endpoints emit `stop`, Anthropic endpoints (including MiniMax Coding Plan) emit `end_turn`. P0.2 missed the Anthropic variant. Classifier sets now include `end_turn` in SUCCESS, alongside `stop`/`stop_sequence`. Fix in commit `380fc7e`. See doc/smoke/phase-2-T2-T3-T10.md for the full timeline.
- **next**: Phase 3 plan (/minimax:review + JSON schema + 1-shot retry + diagnostic bundle). Phase 4 author MUST serialize job-control (P0.10 warning still active).

## 2026-04-20 16:57 [Claude Sonnet 4.6 executor] — Phase 0+1 complete

- **status**: done
- **scope**: Phase 0 probes (12 committed reports at `doc/probe/`) + Phase 1 skeleton (root files, plugin manifests, lib near-copies for args/process/render/git/state, minimax.mjs core with YAML gate v3 state machine + writeApiKey via withLockAsync + spawnWithHardTimeout + log state-machine parser + async getMiniAgentAuthStatus with three-layer sentinel, minimax-companion.mjs with setup + write-key subcommands, /minimax:setup command.md with 5-case branch, minimax-cli-runtime skill v0.1 consolidated, minimax-prompting skill skeleton)
- **summary**: T1 (degraded with fake key; installed/version/model/apiBase/apiKeyMasked all populated, authenticated=false) / T8 (fresh-env install branch) / T12 (mock config path, 3 rounds of writeApiKey, all other fields preserved, line count invariant) / T13 (SOCKS detection via mock binary) all PASS. 用户真 `~/.mini-agent/config/config.yaml` 全程未触碰。P0.9 env-auth confirmed no shortcut. P0.1/P0.2 hard gates passed. P0.10 FAILED → Phase 4 must use serial job scheduling (warning logged). P0.3/P0.4/P0.7/P0.11 各自结论见 doc/probe/ + SKILL.md。
- **next**: hand off to Phase 2 plan (/minimax:ask + callMiniAgent + stream 透传 + 日志后解析 + minimax-result-handling skill 初稿). Phase 2 author MUST read `plugins/minimax/skills/minimax-cli-runtime/SKILL.md` v0.1 (consolidated probe facts). Phase 4 author MUST serialize job-control (P0.10 conditional gate).

## 2026-04-20 16:16 [Claude Sonnet 4.6 executor]

- **status**: in-progress
- **scope**: Phase 1 Task 1.1 (root files)
- **summary**: .gitignore 扩充 + README.md + CLAUDE.md created; baseline complete for Phase 1.
- **next**: Task 1.2 manifests.

## 2026-04-20 15:49 [executor]

- **status**: in-progress
- **scope**: Phase 0 / P0.10 — **CONDITIONAL GATE FAILED**
- **summary**: Concurrent log attribution 不稳定（详见 doc/probe/10-concurrent-spawn-log.md）。Phase 1 继续；Phase 4 job-control.mjs 必须串行化 job 调度。
- **next**: Phase 4 作者必须读本条目。
