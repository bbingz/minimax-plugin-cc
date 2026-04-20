# Phase 2 smoke — T2 / T3 / T10

Run date: 2026-04-20 19:20 Asia/Shanghai (final pass)
Executor: Claude sonnet (controller, after initial subagent run BLOCKED on env)
Mini-Agent: mini-agent 0.1.0
Node: v25.9.0
Plugin baseline: git tag `phase-1-foundation` + 11 Phase 2 commits (through `380fc7e`)

## Timeline

1. First smoke run (at 18:45) BLOCKED on T2 because `~/.mini-agent/config/config.yaml` still
   held a Phase 0 probe placeholder key. Documented as such; tag not applied.
2. User supplied a real Coding Plan key + endpoint + model (`MiniMax-M2.7-highspeed` against
   `https://api.minimaxi.com/anthropic`).
3. `write-key` applied the real key atomically. T2 re-run returned `llm-call-failed` because
   classifier rejected `finish_reason: "end_turn"` (Anthropic-native, not in the OpenAI-only
   SUCCESS set).
4. Classifier fix landed as commit `380fc7e` (added `end_turn` to `FINISH_REASON_SUCCESS`,
   new unit test).
5. Final T2/T3/T10 rerun (this record) — all three PASS.

## T2 — ask --json "hello" (real Coding Plan key)

- Command: `node plugins/minimax/scripts/minimax-companion.mjs ask --json "hello"`
- exit: 0
- status: `success`
- finishReason: `end_turn`
- response (first 200 chars):
  ```
  Hello! 👋 I'm Mini-Agent, your AI assistant powered by MiniMax. I'm here to help you with a wide range of tasks, including:

  - **File operations**: Reading, writing, and editing files
  - **Bash command
  ```
- Raw API key leak check: CLEAN (response does not echo any config secrets).
- **Result: PASS**

## T3 — ask "讲个笑话" (progress UX)

- Command: (plan Step 2 boilerplate — first line timed via node wall-clock)
- exit: 0 (full success path)
- first_line_ms: **156** (threshold 1500 ms)
- First 8 lines of transcript:
  ```
  [156ms] Starting MiniMax (cold start ~3s)...
  [5983ms] ✅ LLM retry mechanism enabled (max 3 retries)
  [6056ms] ✅ Loaded Bash Output tool
  [6128ms] ✅ Loaded Bash Kill tool
  [6202ms] Loading Claude Skills...
  [6272ms] ✅ Discovered 15 Claude Skills
  [6345ms] ✅ Loaded Skill tool (get_skill)
  [6417ms] Loading MCP tools...
  ```
- Tail (footer / verbatim Chinese response preserved):
  ```
  [13226ms]
  [13298ms] ---
  [13369ms]
  [13440ms] 希望这些笑话能让你开心一笑！😊
  [13511ms] (model: MiniMax-M2.7-highspeed · log: /Users/bing/.mini-agent/log/agent_run_20260420_191840.log)
  ```
- UX verdict: cold-start banner fires at 156 ms (< 200 ms, user sees "not frozen"); full
  multi-line Chinese response + emoji preserved verbatim; footer format matches spec.
- **Result: PASS**

## T10 — ask --json "hello" (fake key via HOME override)

- Fake HOME: `$(mktemp -d)` under `/var/folders/...`
- Fake key: `fake-definitely-not-a-valid-key-abcdef123456`
- api_base / model in the fake config match the real config (so the only delta is the key)
- exit: 4
- status: `llm-call-failed`
- Raw fake-key leak grep: **CLEAN** — fake key bytes absent from stdout and stderr.
- **Result: PASS**

## Overall verdict

Phase 2 hard gates: **T2 PASS / T3 PASS / T10 PASS**.

Tag `phase-2-ask` applied on the Task 2.7 commit.

## Classifier spec-patch finding

During T2 debug I discovered Mini-Agent's `provider: "anthropic"` path returns
`finish_reason: "end_turn"` (Anthropic's native value). Spec v5 / P0.2 only sampled the
OpenAI-compatible endpoint and listed `{stop, length, tool_calls, ...}`. Mini-Agent simply
passes through whichever value the upstream provider emits — OpenAI endpoints give
`stop`/`length`/`tool_calls`; Anthropic endpoints give `end_turn`/`max_tokens`/`tool_use`.

The classifier sets now cover both families:

| Set | Values |
|---|---|
| `FINISH_REASON_SUCCESS` | `stop`, `stop_sequence`, `end_turn` |
| `FINISH_REASON_TRUNCATED` | `length`, `max_tokens` |
| `FINISH_REASON_INCOMPLETE` | `tool_calls`, `tool_use`, `content_filter`, `function_call` |

Fix commit: `380fc7e`. Test `success when finish_reason=end_turn (Anthropic provider)`
lands alongside.

Upstream Phase 3/4 code paths (review / rescue JSON extraction) inherit the same taxonomy
through `classifyMiniAgentResult` — no further patches needed.

## Notes

- Real API key was applied via `write-key` (atomic, goes through the hardened YAML gate).
- Config changes `api_base` and `model` for Coding Plan endpoint were made via direct Edit
  (plugin runtime only ever writes `api_key`; `api_base` / `model` are user-space config).
- No secrets appear in this document or in CHANGELOG; `redactSecrets` additionally covers
  `sk-...` and `eyJ...` prefixes if any future leak path emerges.
- Measured cold-start-to-LLM-response total for T3: ~13.5 s (includes skill/MCP load).
  Under 15 s comfortably; well within the spec's cold-start budget.
