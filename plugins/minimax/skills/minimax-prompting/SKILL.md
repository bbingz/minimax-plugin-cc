---
name: minimax-prompting
description: Internal guidance for composing Mini-Agent prompts for coding, review, diagnosis, and research tasks inside the minimax plugin. Emphasizes MiniMax-M2's Chinese prose strength and Mini-Agent's native file/bash/Skills/MCP tools.
---

# minimax-prompting (skeleton, finalized in Phase 5)

Guidance for Claude when composing a prompt to send to Mini-Agent via `minimax-companion.mjs`. Not user-facing.

## Scope

This skill guides prompt construction for `/minimax:ask`, `/minimax:review`, `/minimax:rescue`, `/minimax:adversarial-review`. Fully populated in Phase 5 after real prompts have been tested.

## Universal rules (v0.1 confirmed)

1. **Output contract first.** State the expected output format in the first paragraph. For JSON: explicitly say "Return ONLY a JSON object matching this schema. No prose before or after. No markdown code fence."

2. **Context in labeled blocks.** Wrap code/diff/docs in clearly labeled blocks (`### Diff to review` / `### Files under investigation`).

3. **Language parity.** MiniMax-M2's Chinese-language reasoning is strong; keep instruction language aligned with user prompt language. Do not force English on Chinese prompts.

4. **Leverage Mini-Agent native tools.** For `/minimax:rescue`, include the available Skills whitelist in the prompt:
   > "You have access to 15 Claude Skills (xlsx / pdf / pptx / docx / canvas-design / algorithmic-art / theme-factory / brand-guidelines / artifacts-builder / webapp-testing / mcp-builder / skill-creator / internal-comms / slack-gif-creator / template-skill). Invoke them via `get_skill(<name>)` when relevant."

5. **No tool-call loops on simple questions.** For `/minimax:ask`, prefer prompts that don't require bash/file tools.

6. **Suspicious bash interception.** `/minimax:rescue --sandbox` does not provide true isolation (spec §4.6). When passing prompts that may invoke bash, prefer explicit scopes: "Only modify files under the workspace directory. Do NOT use absolute paths outside it."

## Placeholder sections (filled Phase 5)

- `references/minimax-prompt-recipes.md` — recipes: Chinese coding reviews, multi-step agent tasks, Skills invocation (PDF / xlsx), MCP tool usage
- `references/minimax-prompt-antipatterns.md` — prompts that empirically fail on MiniMax-M2 (populated from Phase 2–4 failures)
- `references/prompt-blocks.md` — reusable blocks: tool-use guidance, workspace constraints, output contracts
