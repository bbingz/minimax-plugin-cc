---
name: minimax-prompting
description: Internal guidance for composing Mini-Agent prompts for coding, review, diagnosis, and adversarial-review tasks inside the minimax plugin. Emphasizes MiniMax-M2's Chinese prose strength and Mini-Agent's native file/bash/Skills/MCP tools.
---

# minimax-prompting (v1, Phase 5 finalization)

Guidance for Claude when composing a prompt to send to Mini-Agent via `minimax-companion.mjs`. Not user-facing.

## Scope

This skill guides prompt construction for `/minimax:ask`, `/minimax:review`, `/minimax:rescue`, `/minimax:adversarial-review`. v1 reflects what was actually validated through Phase 1-5 smoke tests against MiniMax-M2 7B / Coding-Plan endpoints.

## Universal rules

1. **Output contract first.** State the expected output format in the first paragraph. For JSON: explicitly say "Return ONLY a JSON object matching this schema. No prose before or after. No markdown code fence." Echo the schema as a fenced JSON block immediately after.

2. **Context in labeled blocks.** Wrap code/diff/docs in labeled blocks (`### Diff to review` / `### Files under investigation`). Do not interleave instructions and content.

3. **Language parity.** MiniMax-M2's Chinese reasoning is strong; keep instruction language aligned with user prompt language. Do not force English on Chinese prompts. The output schema enums (severity / verdict) MUST stay English even when surrounding prose is Chinese — explicitly call this out in the prompt (see `references/prompt-blocks.md` `output-contract-bilingual` block).

4. **Stance prompts are single-stance.** For `/minimax:adversarial-review`, do NOT mix red and blue stance instructions in one prompt — even if asked nicely, the model biases toward whichever stance appears last. Use two independent spawns (Phase 5 architecture), each with one stance constant from `minimax.mjs` (`RED_STANCE_INSTRUCTION` / `BLUE_STANCE_INSTRUCTION`).

5. **Leverage Mini-Agent native tools.** For `/minimax:rescue`, include the available Skills whitelist in the prompt:
   > "You have access to 15 Claude Skills (xlsx / pdf / pptx / docx / canvas-design / algorithmic-art / theme-factory / brand-guidelines / artifacts-builder / webapp-testing / mcp-builder / skill-creator / internal-comms / slack-gif-creator / template-skill). Invoke them via `get_skill(<name>)` when relevant."

6. **No tool-call loops on simple questions.** For `/minimax:ask`, prefer prompts that don't require bash/file tools. Mini-Agent's classifier treats unfinished tool-call sessions as incomplete (详见 `minimax-cli-runtime` SKILL §classifier).

7. **Suspicious bash interception.** `/minimax:rescue --sandbox` does not provide true isolation (spec §4.6). When passing prompts that may invoke bash, prefer explicit scopes: "Only modify files under the workspace directory. Do NOT use absolute paths outside it." This is best-effort; the actual tripwire lives in `minimax-result-handling`.

8. **Retry hint reuse.** When a JSON parse/validate fails, the second-shot retry prompt MUST include the schema validation error AND the previous response (redacted, capped 1500 chars) — this lets the model self-correct. See `buildReviewPrompt` and `buildAdversarialPrompt` for the canonical implementation.

## References

- `references/minimax-prompt-recipes.md` — recipes for Chinese coding reviews, multi-step agent tasks, Skills invocation (PDF / xlsx), MCP tool usage, both-stance adversarial setup
- `references/minimax-prompt-antipatterns.md` — prompts that empirically fail on MiniMax-M2 (collected from Phase 2-5 smoke runs)
- `references/prompt-blocks.md` — reusable blocks: tool-use guidance, workspace constraints, output contracts, stance instructions
