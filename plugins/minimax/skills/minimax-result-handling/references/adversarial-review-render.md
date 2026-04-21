# adversarial-review-render reference

Detailed rules for rendering `/minimax:adversarial-review` output. Authoritative source of truth is `plugins/minimax/commands/adversarial-review.md`; this file captures cross-command context and anti-patterns.

## Success JSON shape (exit 0)

```json
{
  "status": "ok",
  "red": {
    "ok": true,
    "verdict": "approve" | "needs-attention",
    "summary": "<one-paragraph string>",
    "findings": [ ... same finding shape as /minimax:review ... ],
    "next_steps": ["<short action>"],
    "retry_used": <bool>,
    "retriedOnce": <bool>,
    "retry_notice": "<string|null>",
    "truncated": <bool>,
    "logPath": "<absolute path>"
  },
  "blue": { ... same shape as red ... }
}
```

## Error JSON shape (exit 4 or 5)

```json
{
  "status": "call-failed" | "parse-validate-failed",
  "side": "red" | "blue",
  "error": "<message>",
  "red":  { "ok": true, "verdict": ..., ... }  | { "ok": false, "error": ... } | null,
  "blue": { "ok": true, ... } | { "ok": false, ... } | null,
  "firstRawText": "<string|null>",
  "rawText": "<string|null>",
  "parseError": "<string|null>",
  "diagnostic": <classifier-diagnostic|null>
}
```

When `side === "blue"` and `red.ok === true`, the red team's verdict is salvageable — surface it so the user doesn't lose half the work. When `side === "red"`, blue never spawned (red failure short-circuits).

## Presentation

1. Render red team block first (it always ran first):
   ```
   === Red Team ===
   Verdict: <red.verdict>
   Summary: <red.summary>
   Findings (<n>):
     - [<severity>] <title>
       <file>:<line_start>[-<line_end>]  (confidence <conf>)
       <body>
       fix: <recommendation>
   Next steps:
     - <step>
   ```
2. Blank line.
3. Render blue team block in identical format.
4. Within each block, sort findings by severity (critical > high > medium > low). Within same severity, preserve the model's order.
5. If `red.retry_used`, render `(Red Team: retry used -- <retry_notice>)` inside the red block. Same for blue.
6. Footer last: `(model: X · red-log: Y · blue-log: Z [· red-retry-used] [· blue-retry-used])`.

## Disagreement (vs Claude's analysis or prior /minimax:review)

If Claude has independently reviewed the same diff:
- Add a comparison table AFTER both team blocks
- Two findings are "the same" if they share `file` AND their `[line_start..line_end]` ranges overlap
- Bucket into **4 explicit intersections** (v2 I13):
  - **Claude ∩ Red** — Claude and red team both flagged
  - **Claude ∩ Blue** — Claude and blue team both flagged (rare; usually means Claude noted a mitigation gap blue also caught)
  - **Red ∩ Blue** — Both teams flagged (high-confidence signal)
  - **Unique-to-one** — Each remaining finding tagged with its sole source (Claude / Red / Blue)
- DO NOT collapse Red and Blue into "MiniMax" — they are deliberately independent viewpoints.
- v2 (I16): MiniMax's red+blue is a deliberate divergence from kimi/gemini (single red-team only). When the user has a `/kimi:adversarial-review` or `/gemini:adversarial-review` output also in conversation, do NOT merge it with MiniMax red+blue as if they were the same shape; treat the kimi/gemini result as a third independent voice (its own row in the comparison).

## Relation to the suspicious-tool-calls tripwire (SKILL.md)

Adversarial-review responses are pure data — the schema has no `toolCalls[]` field. Both red and blue stance prompts explicitly forbid markdown code fences and prose. Any tool invocation attempt fails JSON validation, triggering the per-team 1-shot retry. **The suspicious-bash tripwire in `SKILL.md` does NOT apply to `/minimax:adversarial-review` output.** That tripwire lives in `/minimax:rescue` (Phase 4).

## Anti-patterns

- Do NOT merge red and blue findings. Their value is the spread.
- Do NOT rank one team above the other ("blue is right" / "red is overblown"). Both stances are deliberate.
- Do NOT silently drop a viewpoint because it was empty (e.g. blue found nothing). Empty findings list is signal — surface it as "Blue Team: (no mitigation gaps found)". v2 (C2): empty blue findings is a **valid T9 PASS state** — it means the blue team's evaluation found no mitigation gap worth fixing, not that the team failed.
- Do NOT auto-apply any `recommendation` from either team.
- Do NOT translate Chinese summary / findings / recommendations. M2.7 is fluent in Chinese; preserve verbatim.
- Do NOT paraphrase the verdict to soften it ("kind of needs-attention"). Render verbatim.
- v2 (I7): Do NOT recommend file-write actions in the `recommendation` field — adversarial-review's `recommendation` is text-only guidance the user reads, not an action a tool will execute. If a finding implies a fix, render it as prose suggestion ("change line X to ..."), never as "I will now run `git apply` ...".

## When red succeeds but blue fails (exit 5, side="blue")

This is the most common partial-failure mode. Render order:
1. Surface red verdict + summary first ("Red team analysis completed below; blue team failed to produce schema-valid output and would require rerun:").
2. Render full red team block.
3. Then render blue's failure diagnostic (raw texts under labeled headings, do NOT paraphrase).
4. Suggest: "Rerun `/minimax:adversarial-review` to retry blue team; the red analysis above is independent and remains valid."

## When red fails (exit 5, side="red")

Blue never spawned. Red's failure diagnostic is all that's available:
1. State clearly: "Adversarial review failed at the red team stage. Blue team did not run."
2. Render red's failure diagnostic (raw texts under labeled headings).
3. Suggest: "Rerun `/minimax:adversarial-review` to try again, or fall back to `/minimax:review` for a non-adversarial review."
