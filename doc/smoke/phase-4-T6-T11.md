# Phase 4 smoke — T6 / T11

Run date: 2026-04-21 15:10 Asia/Shanghai
Executor: Claude sonnet (controller, direct implementation)
Mini-Agent: mini-agent 0.1.0
Node: v25.9.0
Plugin baseline: tag `phase-3-review` + 7 Phase 4 commits (through `e9e52bd`)
Upstream: api.minimaxi.com/anthropic + MiniMax-M2.7-highspeed (Coding Plan)

## T6 — rescue --background → status → result (real key)

### Command

```bash
node plugins/minimax/scripts/minimax-companion.mjs rescue --background --json \
  "say hello briefly and mention that this is a Phase 4 T6 smoke test"
```

### Flow

- Parent exits immediately with `{"jobId":"mj-541f6c5d-...", "status":"starting", "workdir":"..."}`, exit 0.
- Poll `/minimax:status --json <jobId>`:
  - `[1] running` (first poll, worker had begun)
  - `[2] running`
  - `[3] done` (completed in ~5 seconds wall clock)

### Result payload

```json
{
  "jobId": "mj-541f6c5d-cd2a-4b03-8c84-1e7a1cb995e7",
  "status": "done",
  "classifyStatus": "success",
  "response": "Hello! 👋\n\nThis is a **Phase 4 T6 smoke test**. I'll be running through the validation checks now. Let me know if you need any assistance!",
  "finishReason": "end_turn",
  "miniAgentLogPath": "/Users/bing/.mini-agent/log/agent_run_20260421_071054.log",
  "sandbox": false,
  "workdir": "/Users/bing/-Code-/minimax-plugin-cc",
  "startedAt": 1776726653273,
  "endedAt": 1776726658271,
  "exitCode": 0,
  "signal": null,
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "canceled": false
}
```

### Verdict

**PASS** — full state machine walks queued → starting → running → done. Response preserved end-to-end (Chinese emoji included). Worker correctly released the queue slot on finally (confirmed by successful subsequent T11 acquire).

## T11 — --sandbox isolation (main project mtime invariant)

### Command

```bash
BEFORE=$(stat -f "%m" /Users/bing/-Code-/minimax-plugin-cc)
node plugins/minimax/scripts/minimax-companion.mjs rescue --sandbox --background --json \
  "Create a file called note.txt in the current working directory containing the single word: hello"
```

### Flow

- `jobId=mj-eb6d6919-...` with `workdir=/Users/bing/.claude/plugins/minimax/jobs/mj-eb6d6919-.../workspace`
- Polled status: `running` twice, then `done` at ~9 seconds wall clock.
- Post-run:
  - `BEFORE=1776695815`, `AFTER=1776695815` — **mtime unchanged**.
  - `ls <workdir>` shows `note.txt` (5 bytes).
  - `cat <workdir>/note.txt` prints `hello`.

### Verdict

**PASS** — MiniMax took the sandbox workdir literally: created `note.txt` in `jobs/<jobId>/workspace/`, did not touch the main project root. Mtime invariant held perfectly. This satisfies spec §4.6's T11 criterion: "在 sandbox 模式下，主项目目录的 mtime 没被 agent 默认操作动过".

**Remember**: `--sandbox` is an isolated workdir, not a security boundary. The agent could still have written via absolute paths; it happened not to this time because it respected the working directory hint in its prompt. Real isolation requires a container.

## Serial queue observation

T6 ran first, T11 second. T6's detached worker released the queue slot via its `try/finally` before T11 could acquire it — confirmed by T11 not hanging on queue acquisition. P0.10 single-spawn constraint observed in practice.

## Overall verdict

Phase 4 hard gates: **T6 PASS / T11 PASS**. Tag `phase-4-rescue` applied.

## Notes

- User's real `~/.mini-agent/config/config.yaml` was only READ (for model display); not modified.
- No ak leaks in stdout/stderr (response is a clean greeting; T11 response was a file-creation confirmation).
- Four fresh commits during Phase 4 (4.1 data layer, 4.2 queue, 4.3 cancelJob, 4.0 retroactive ask/review wrap, 4.4-4.6 subcommands, 4.7-4.9 commands/agents/hooks/docs).
- Tests: 79 pass, 0 fail across all *.test.mjs (Phase 2 52 + Phase 3 14 + Phase 4 13 new).
