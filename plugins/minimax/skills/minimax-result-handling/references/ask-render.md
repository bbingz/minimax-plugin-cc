# ask-render reference

Detailed rules for rendering `/minimax:ask` output. The command file `plugins/minimax/commands/ask.md` is the authoritative source of truth -- this file captures the background rationale.

## Success text layout (text mode, exit 0)

The companion writes (literal):

```
Starting MiniMax (cold start ~3s)...
<mini-agent live stdout, ANSI stripped, as it streams>
...
Session Statistics:
...

---
<response text -- possibly multi-line, possibly Chinese>
(model: MiniMax-M2.5 · log: /Users/.../.mini-agent/log/agent_run_....log)
```

Claude's render:
1. Treat the progress lines (everything before the `---` separator) as live UX; do not re-quote.
2. Present the text between `---` and the footer `(model:...)` **verbatim** to the user.
3. Display the footer line as-is; do not reformat.
4. If disagreement worth flagging: append one line starting with "Note: Claude disagrees on ...".

## Success JSON layout (--json, exit 0)

```json
{
  "status": "success" | "success-but-truncated",
  "response": "<string, possibly Chinese>",
  "toolCalls": [],
  "finishReason": "stop" | "length" | ...,
  "logPath": "/Users/.../.mini-agent/log/agent_run_....log",
  "thinking": null | "<string>"
}
```

Claude's render when a calling script / agent receives this:
1. Primary payload = `response`.
2. `thinking` is optional reasoning trace -- **never inline with the response**. If presented at all, wrap in a details/collapse block. For `/minimax:ask`, default is to hide thinking.
3. `toolCalls` in text mode is not surfaced (simple Q&A). If any item matches the suspicious-tool-calls regex list in `SKILL.md`, escalate regardless of mode.

## Error text layout (stderr, exit non-zero)

```
Starting MiniMax (cold start ~3s)...
<possibly partial live stdout>

(stderr:)
Error: <status> -- <detail>

--- diagnostic (stderr head+tail, ANSI stripped) ---
<head (up to 256 chars)>
... <N bytes elided> ...
<tail (up to 2048 chars)>
log: /Users/.../.mini-agent/log/agent_run_....log
```

Claude's render:
1. Surface the `Error:` line directly.
2. Surface the diagnostic block under its heading (do not collapse for ask -- the user already saw it).
3. Append exactly one declarative suggestion from the status->opener table in `SKILL.md`. No question marks.

## Anti-patterns (things Claude has been tempted to do and must NOT)

- Translating the Chinese response to English unsolicited. **Don't.**
- Rewriting "---" and footer into Markdown headings. **Don't -- preserve format.**
- Interpreting `incomplete` status as "let me retry with a better prompt". **Don't -- surface status, let user decide.**
- Inlining `thinking` with response. **Don't -- thinking is reasoning, not conclusion.**
- Adding "MiniMax is slow because Python..." explainers. **Don't -- the UX contract handles cold start with the cold-start line; stop there.**
