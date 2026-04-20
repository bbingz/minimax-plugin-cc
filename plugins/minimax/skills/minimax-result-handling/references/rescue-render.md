# rescue-render reference

Rules for rendering `/minimax:rescue` / `/minimax:status` / `/minimax:result` output.

## Success JSON shape (foreground, exit 0)

```json
{
  "jobId": "mj-<uuid>",
  "status": "success" | "success-but-truncated",
  "response": "<string>",
  "toolCalls": [{"id":"...", "name":"bash", "arguments":{...}}],
  "finishReason": "stop|end_turn|...",
  "thinking": null | "<string>",
  "logPath": "/Users/.../.mini-agent/log/agent_run_....log"
}
```

## Background start shape (exit 0)

```json
{ "jobId": "mj-<uuid>", "status": "starting", "workdir": "<path>" }
```

Claude renders: "Rescue job `mj-<uuid>` started in background. Poll with `/minimax:status mj-<uuid>`." Do NOT pretend a result is available.

## Result JSON shape (exit 0)

```json
{ "jobId":"...", "status":"done|failed|canceled", "classifyStatus":"success|...",
  "response":"<string|null>", "finishReason":"...", "miniAgentLogPath":"...",
  "sandbox":<bool>, "workdir":"...", ... }
```

## Suspicious tool-calls tripwire APPLIES HERE

This is the command path where the model can actually run bash. Before rendering response or tool_calls, scan for the tripwire patterns in `SKILL.md`. If any match, surface the tool_use verbatim and ASK the user whether to proceed via AskUserQuestion -- do not silently transcribe.

## Sandbox messaging discipline

Never call `--sandbox` a security feature. Every mention should read as "isolated workdir" -- the agent CAN escape via absolute paths. The benefit is narrowed blast radius for honest mistakes, not protection against malicious behavior.

## Cross-session visibility

Detached `_worker` processes survive Claude Code session end. In a new session, the default `/minimax:status` filter matches the new session id and won't list old jobs. Users must pass `/minimax:status --all` to see them. Explain this once when the user asks "why don't I see my yesterday's job".
