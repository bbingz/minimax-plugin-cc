# review-render reference

Detailed rules for rendering `/minimax:review` output. Authoritative source of truth is `plugins/minimax/commands/review.md`; this file captures cross-command context and anti-patterns.

## Success JSON shape (exit 0)

```json
{
  "status": "ok",
  "verdict": "approve" | "needs-attention",
  "summary": "<one-paragraph string>",
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "title": "<short>",
      "body": "<1-3 sentences>",
      "file": "<repo-relative path>",
      "line_start": <int>, "line_end": <int>,
      "confidence": <0..1>,
      "recommendation": "<short actionable>"
    }
  ],
  "next_steps": ["<short action>"],
  "retry_used": <bool>,
  "retriedOnce": <bool>,
  "retry_notice": "<string|null>",
  "truncated": <bool>,
  "logPath": "<absolute path>"
}
```

## Presentation

1. Verdict line first, uncolored, verbatim: `Verdict: approve` or `Verdict: needs-attention`.
2. Summary verbatim.
3. Findings sorted by severity (critical first, low last). Within same severity, preserve the model's order. Format each finding as:
   ```
   - [<severity>] <title>
     <file>:<line_start>[-<line_end>]  (confidence <conf>)
     <body>
     fix: <recommendation>
   ```
4. Next steps verbatim, bulleted.
5. If `retry_used` is true, add a single line: `(note: review retry used -- <retry_notice>)`.
6. Footer last: `(model: X · log: Y [· truncated] [· retry-used])`, parenthesized.

## Disagreement

If Claude has independently reviewed the same diff (e.g. via native `/review`), Claude MAY add a comparison section AFTER the MiniMax output. Do not merge findings; present two sets side by side.

## Relation to the suspicious-tool-calls tripwire (SKILL.md)

Review responses are pure data -- the schema has no `toolCalls[]` field. The model is explicitly instructed in `prompts/review.md` to return RAW JSON ONLY; any attempt to invoke tools is treated as non-conforming JSON and rejected during validation (triggers the 1-shot retry). **Therefore the suspicious-bash tripwire in `SKILL.md` does NOT apply to `/minimax:review` output.** The tripwire lives in `/minimax:rescue` (Phase 4) where the agent genuinely does run bash.

## Anti-patterns

- Do NOT suggest a fix Claude thinks is better than `recommendation`. Respect MiniMax's verbatim suggestion; if Claude disagrees, add a single "Note: Claude disagrees on <id> because Y." line.
- Do NOT silently drop a `low` finding because it seems trivial. Render all findings.
- Do NOT collapse findings into a single summary if there are several -- make each one visible.
- Do NOT reformat `body` text. Preserve Chinese / mixed-language output.
- Do NOT auto-apply any `recommendation`. Ask the user which to act on.

## Error JSON shape (exit non-zero)

```json
{
  "status": "no-diff" | "git-diff-failed" | "call-failed" | "parse-validate-failed" | ...,
  "error": "<message>",
  "firstRawText": "<string|null, redacted>",
  "rawText": "<string|null, redacted>",
  "parseError": "<string|null>",
  "retry_used": <bool>,
  "retriedOnce": <bool>,
  "diagnostic": <classifier-diagnostic|null>
}
```

When `status === "parse-validate-failed"`, the user needs the raw texts to debug their prompt or the model's non-conformance. Present both under clearly labeled headings. Claude MUST NOT rewrite them into "valid JSON"; the whole point is exposing the model's failure mode.
