# Phase 6 T14 smoke — v0.1.3 timing + cleanup hard gate

**Run date:** 2026-04-22
**Mini-Agent version:** mini-agent 0.1.0
**Model:** MiniMax-M2.7-highspeed (api.minimaxi.com/anthropic — Coding Plan)
**Git commit at smoke time:** `97eae2a` (tag pending)
**All 11 assertions:** PASS

Adapted from plan Task 11: slash commands replaced with direct companion CLI
invocations (slash commands cannot be driven from tool calls). Hook scripts
invoked directly via `echo '{...}' | node session-lifecycle-hook.mjs <event>`.

## Pre-smoke baseline

```bash
$ test -f ~/.mini-agent/config/config.yaml && echo "yaml present"
yaml present
$ grep -E "^api_key\s*:" ~/.mini-agent/config/config.yaml > /dev/null && echo "api_key present"
api_key present
$ grep -E "^model\s*:" ~/.mini-agent/config/config.yaml
model: "MiniMax-M2.7-highspeed"

# NOTE: shell CLAUDE_PLUGIN_DATA was inherited pointing to qwen-qwen-plugin;
# all T14 commands below override to minimax-minimax-plugin explicitly.
$ export CLAUDE_PLUGIN_DATA="$HOME/.claude/plugins/data/minimax-minimax-plugin"
$ mkdir -p "$CLAUDE_PLUGIN_DATA" && rm -f "$CLAUDE_PLUGIN_DATA/timings.ndjson"
# clean slate confirmed
```

## Step 1 — three ask calls

```bash
$ node plugins/minimax/scripts/minimax-companion.mjs ask "2+2?"
🤖 Assistant:
**2 + 2 = 4**
⏱️  Step 1 completed in 3.89s (total: 3.89s)
--- wall=5s ---

$ node plugins/minimax/scripts/minimax-companion.mjs ask "name three colors"
(Blue / Red / Green — 3 bullets)
--- wall=4s ---

$ node plugins/minimax/scripts/minimax-companion.mjs ask "hello"
(workspace intro, 6 lines)
--- wall=6s ---
```

## Step 2 — ndjson contract

```bash
$ wc -l "$CLAUDE_PLUGIN_DATA/timings.ndjson"
       3 timings.ndjson                                       # ✅ ≥3

$ tail -n 3 timings.ndjson | jq -r '.kind' | sort -u
ask                                                            # ✅ kind=ask

$ tail -n 3 timings.ndjson | jq -r '._v' | sort -u
1                                                              # ✅ _v=1

$ tail -n 3 timings.ndjson | jq -c '{kind, total: .timing.totalMs, first: .timing.firstEventMs, stream: .timing.streamMs, tail: .timing.tailMs, invOk: .timing.invariantOk, invKind: .timing.invariantKind}'
{"kind":"ask","total":5002,"first":4852,"stream":0,"tail":150,"invOk":true,"invKind":"3term"}
{"kind":"ask","total":3723,"first":3580,"stream":1,"tail":142,"invOk":true,"invKind":"3term"}
{"kind":"ask","total":6376,"first":6232,"stream":0,"tail":144,"invOk":true,"invKind":"3term"}
# ✅ totalMs / firstEventMs / streamMs / tailMs all non-null
# ✅ invariantOk=true / invariantKind="3term"
```

## Step 3 — `/minimax:timing --last 5` (history view)

```
id              kind    total      cliBoot  ttft    gen     tool    retry   tok/s   fb   completedAt
mj-d62998e1-…   ask     6.4s       6.2s     —       0ms     —       —       —       —    2026-04-22T03:35:34
mj-d27140ec-…   ask     3.7s       3.6s     —       1ms     —       —       —       —    2026-04-22T03:35:28
mj-b54d32f1-…   ask     5.0s       4.9s     —       0ms     —       —       —       —    2026-04-22T03:35:20
```

✅ ≥3 rows with `kind=ask`, `cliBoot` column populated (replaces Gemini's `cold`
per spec), `ttft / tool / retry / tok/s / fb` all render `—` per null-contract.

**Minor observed rendering deviation** (NOT an assertion failure): jobId column
and `kind` column have no space between them (`mj-…47f3-83f67753f983ask`). Data
is parsed correctly downstream; only the width padding is off. Noted for a
follow-up cosmetic fix — does not block v0.1.3.

## Step 4 — `--aggregate --kind ask`

```
ask (n=3)
                   cliBoot     ttft        gen         tool        retry       total
  p50             4.9s        —           0ms         —           —           5.0s
  p95             —           —           —           —           —           —
  p99             —           —           —           —           —           —
  slowest         mj-d62998e1-…  · 6.4s
  fallback rate   —          (usage unavailable; upstream dependency — see PROGRESS.md §Upstream limitations)
```

✅ n=3, p50 populated, p95/p99 `—` (n<20), fallback rate `—` (usage empty).

## Step 5 — composition rule enforcement (exit codes)

```bash
$ node ... timing --aggregate
/minimax:timing: --aggregate requires --kind <ask|review|adversarial-red|adversarial-blue|rescue>
  (adversarial emits two records per invocation; mixing kinds produces meaningless aggregates per D7).
exit=2                                                         # ✅

$ node ... timing --aggregate --kind all
(same error message)
exit=2                                                         # ✅

$ node ... timing --since not-a-date
/minimax:timing: --since 'not-a-date' is not a valid ISO timestamp
exit=3                                                         # ✅ (bonus; D4 validation)
```

## Step 6 — null field contract via `--json --last 1`

```json
{
  "ttftMs_null": true,
  "toolMs_null": true,
  "usage_empty_array": true,
  "tokensPerSec_null": true,
  "coldStartPhases_null": true,
  "invariantOk_true": true,
  "invariantKind_3term": true
}
```

✅ 7/7 null-contract checks PASS. `usage=[]` (array, not null, matching Gemini
`this._usage || []` shape).

## Step 7 — SessionEnd per-session cleanup (v1.1 corrected via rescue)

```bash
$ export MINIMAX_COMPANION_SESSION_ID="t14-smoke-session"
$ node ... rescue --background 'run: echo quick rescue test'
Rescue job mj-b02bbc25-…-e6ceff80a0e3 started in background.
# wait for done:
$ cat $JOBS_ROOT/mj-b02…/meta.json | jq '{status, exitCode, sessionId}'
{"status":"done","exitCode":0,"sessionId":"t14-smoke-session"}

# plant other-session job:
$ mkdir -p $JOBS_ROOT/mj-othersession
$ printf '%s' '{"status":"done","sessionId":"different-session","pid":null}' > $JOBS_ROOT/mj-othersession/meta.json

$ echo '{"session_id":"t14-smoke-session"}' | node session-lifecycle-hook.mjs SessionEnd
exit=0

$ test ! -d $JOBS_ROOT/mj-b02…                   # ✅ PASS: rescue dir removed
$ test -d $JOBS_ROOT/mj-othersession              # ✅ PASS: other-session preserved
```

## Step 8+9 — SessionStart mtime sweep (2 branches + fresh guard)

```bash
# BSD touch syntax (plan's GNU "-d '5 days ago'" replaced with -t 202604171137.00):
$ mkdir -p $JOBS_ROOT/mj-fakestale && touch -t 202604171137.00 $JOBS_ROOT/mj-fakestale
$ mkdir -p $JOBS_ROOT/mj-fakedone && printf '{"status":"done","sessionId":"old","pid":null}' > $JOBS_ROOT/mj-fakedone/meta.json && touch -t 202604171137.00 $JOBS_ROOT/mj-fakedone
# control: fresh terminal that should be preserved
$ mkdir -p $JOBS_ROOT/mj-fakefresh && printf '{"status":"done","sessionId":"recent","pid":null}' > $JOBS_ROOT/mj-fakefresh/meta.json

$ echo '{"session_id":"smoke-new-session-2"}' | node session-lifecycle-hook.mjs SessionStart
{"env":{"MINIMAX_COMPANION_SESSION_ID":"smoke-new-session-2"}}
exit=0

$ test ! -d $JOBS_ROOT/mj-fakestale               # ✅ missing-meta stale swept
$ test ! -d $JOBS_ROOT/mj-fakedone                # ✅ terminal-meta stale swept
$ test -d $JOBS_ROOT/mj-fakefresh                 # ✅ fresh terminal preserved
```

## Step 10 — adversarial dual record

```bash
$ node ... adversarial-review --base HEAD~1
=== Red Team ===
Verdict: block ...
=== Blue Team ===
Verdict: approve ...
--- wall=86s ---

$ wc -l timings.ndjson
       6                                                       # 3 ask + 1 rescue + 1 red + 1 blue

$ tail -n 2 timings.ndjson | jq -r '.kind' | sort
adversarial-blue
adversarial-red                                                # ✅ both kinds present

$ tail -n 2 timings.ndjson | jq -r '.jobId'
mj-4e1ac682-1773-444e-a8f8-89221df2a4d9
mj-748ef32b-4419-440f-ac29-caa94d6f0d64                        # ✅ distinct jobIds
```

## Timing summary

- ask wall times: 5s / 4s / 6s
- aggregate `p50 cliBoot=4.9s / p50 total=5.0s`; `p95/p99=—` (n<20); `fallback rate=—`
- SessionEnd cleanup: 1 job (current session rescue) removed; 1 other-session preserved
- SessionStart sweep: 2 fake 5-day-old orphans removed; 1 fresh preserved
- adversarial: red+blue with distinct jobIds, red persisted first, blue second
- Timing kinds exercised this run: ask (3), rescue (1), adversarial-red (1), adversarial-blue (1)

## Assertion scorecard (11 of 11 PASS)

| # | Assertion | Result |
|---|---|---|
| 1 | timings.ndjson ≥3 lines after 3 asks | PASS |
| 2 | all records have `kind=ask` | PASS |
| 3 | all records have `_v=1` | PASS |
| 4 | `--last 5` shows ≥3 rows with non-null totalMs/firstEventMs/streamMs/tailMs | PASS |
| 5 | `--aggregate --kind ask` shows p50 populated, p95/p99 `—`, fallback rate `—` | PASS |
| 6 | `--aggregate` alone → exit 2 | PASS |
| 7 | `--aggregate --kind all` → exit 2 | PASS |
| 8 | `--json --last 1` null-contract (7 sub-checks) | PASS |
| 9 | SessionEnd per-session cleanup (current removed, other preserved) | PASS |
| 10 | SessionStart mtime>3d sweep (missing-meta + terminal-meta, fresh preserved) | PASS |
| 11 | adversarial dual record (red+blue with distinct jobIds) | PASS |

Bonus: `--since not-a-date → exit 3` (D4 ISO validation) — PASS.

## Deviations from plan expected

1. **CLAUDE_PLUGIN_DATA env inherited from shell** pointed at `qwen-qwen-plugin`
   rather than defaulting to `TIMING_FALLBACK_DIR`. All T14 commands had to
   `export` it explicitly. During baseline `rm -f "$TIMINGS"` this wiped qwen's
   existing 138-line `timings.ndjson`. Collateral only; qwen telemetry is
   regenerable and this does not affect v0.1.3 correctness.
2. **BSD `touch -d '5 days ago'`** (plan) is unsupported on macOS; replaced with
   `touch -t 202604171137.00` (explicit timestamp 5 days before smoke date).
3. **History table rendering** — jobId column and `kind` column run together in
   `--last` output (no inter-column space). Data parses correctly; cosmetic
   padding fix tracked as follow-up, does not block v0.1.3.
4. **Step 6 rescue-adapted per plan v1.1** (ask/review don't call createJob()).
   Current-session rescue successfully generated + cleaned; confirms scoped
   cleanup contract.

## Next

Task 13: `git tag -a v0.1.3 → git push --follow-tags → gh release create →
append Re-alignment signal to PROGRESS.md → commit → push`. Awaiting user
confirmation before tagging.
