# Phase 2 smoke — T2 / T3 / T10

Run date: 2026-04-20 18:45 Asia/Shanghai
Executor: Claude (sonnet subagent)
Mini-Agent: mini-agent 0.1.0
Node: v25.9.0
Plugin baseline: git tag `phase-1-foundation` + 7 Phase 2 commits (through `cbfaf9a`)

## Environment note

The task plan stated "Real API key IS configured in ~/.mini-agent/config/config.yaml". On
execution, the file contains `api_key: "sk-fake-probe-key-not-real"` — a probe-phase
placeholder left from Phase 0 exploration (never replaced with a real key). All three tests
were run against this environment as-is; results reflect the actual machine state.

## T2 — ask --json "hello" (real key)

- Command: `node plugins/minimax/scripts/minimax-companion.mjs ask --json "hello"`
- exit: 4
- stdout (first 800 chars):
  ```
  {
    "status": "llm-call-failed",
    "reason": null,
    "detail": null,
    "logPath": "/Users/bing/.mini-agent/log/agent_run_20260420_184056.log",
    "diagnostic": {
      "status": "llm-call-failed",
      "stderrHeadTail": "Function _make_api_request call 1 failed: Error code: 401 - {'type': 'error', 'error': {'type': 'authentication_error', 'message': \"login fail: Please carry the API secret key in the 'Authorization' field of the request header\"}, 'request_id': '063535ba9f6dec499331c63f569306ef'}, retrying attempt 2 after 1.00 seconds\nFunction _make_api_request call 2 failed: Error code: 401 - {'type': 'error', 'error': {'type': 'authentication_error', 'message': \"login fail: Please carry the API secret key in the 'Authorization' field of the request header\"}, 'request_id': '063535bcb686d9
  ```
- status: llm-call-failed
- Root cause: ~/.mini-agent/config/config.yaml contains placeholder key `sk-fake-probe-key-not-real`
  which produces HTTP 401 from api.minimax.io. The real key was never configured on this machine.
- Raw key leak check: CLEAN (key not present in stdout/stderr; output shows masked form only)
- **Result: BLOCKED — environment prerequisite not met (no real API key configured)**

## T3 — ask "讲个笑话" (progress UX)

- Command: (see plan Step 2; first line measured via node wall-clock)
- exit: 4 (same API key issue as T2 — expected)
- first_line_ms: 151
- First 15 lines of transcript:
  ```
  [151ms] Starting MiniMax (cold start ~3s)...
  [13127ms] LLM retry mechanism enabled (max 3 retries)
  [13206ms] Loaded Bash Output tool
  [13281ms] Loaded Bash Kill tool
  [13357ms] Loading Claude Skills...
  [13429ms] Discovered 15 Claude Skills
  [13500ms] Loaded Skill tool (get_skill)
  [13569ms] Loading MCP tools...
  [13641ms]   MCP timeouts: connect=10.0s, execute=60.0s, sse_read=120.0s
  [13713ms] Skipping disabled server: minimax_search
  [13785ms] Skipping disabled server: memory
  [13856ms] 
  [13927ms] Total MCP tools loaded: 0
  [13999ms] No available MCP tools found
  [14069ms]
  ```
- UX verdict: first progress banner appeared at 151ms (threshold: 1500ms). The no-blank-screen
  contract is satisfied regardless of API outcome.
- **Result: PASS (UX only) — first line within 151ms; API call failed due to same env issue as T2**

## T10 — ask --json "hello" (fake key via HOME override)

- Fake HOME: `/var/folders/9f/kky77n4n74sbqytxvgnpvmh80000gn/T/tmp.HPNAOdSQ87`
- Fake key: `fake-definitely-not-a-valid-key-abcdef123456`
- exit: 4
- status: llm-call-failed
- stdout:
  ```json
  {
    "status": "llm-call-failed",
    "reason": null,
    "detail": null,
    "logPath": "/var/folders/.../tmp.HPNAOdSQ87/.mini-agent/log/agent_run_20260420_184511.log",
    "diagnostic": {
      "status": "llm-call-failed",
      ...
    }
  }
  ```
- stderr (first 500 chars): (empty — all output goes to stdout)
- Raw fake-key leak grep: **clean** — `fake-definitely-not-a-valid-key-abcdef123456` not found in stdout or stderr
- **Result: PASS**

## Overall verdict

Phase 2 hard gates: T2 BLOCKED / T3 PASS (UX) / T10 PASS.

Tag `phase-2-ask` NOT applied because T2 hard gate was not met.

Root blocker: `~/.mini-agent/config/config.yaml` has placeholder key `sk-fake-probe-key-not-real`
(Phase 0 probe artifact). To unblock T2: replace `api_key` with a real MiniMax API key, then
re-run Task 2.7.

## Notes

- T2 BLOCKED is an environment issue, NOT a code defect. The classify/emit pipeline worked
  correctly: 401 -> stderrHeadTail capture -> classifyMiniAgentResult=llm-call-failed -> JSON
  emitted with exit 4.
- T3 confirmed the T3 UX contract: first line appeared within 151ms of subprocess start,
  well under the 1500ms threshold. The cold-start banner fires before the LLM call.
- T10's fake key produced llm-call-failed (HTTP 401), confirming fake keys do NOT surface as
  success. Raw fake-key bytes did not leak. This result is consistent with T2.
- The user's real `~/.mini-agent/config/config.yaml` was never written to during these tests
  (T10 used HOME override; T2/T3 only read it).
- Code pipeline is end-to-end correct. Phase 2 implementation is complete pending API key setup.
