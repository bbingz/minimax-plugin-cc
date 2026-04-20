# minimax-plugin-cc working directory instructions

This repo is a Claude Code plugin that wraps MiniMax-AI/Mini-Agent. It mirrors the structure of `gemini-plugin-cc` at `/Users/bing/-Code-/gemini-plugin-cc/` and `kimi-plugin-cc` at `/Users/bing/-Code-/kimi-plugin-cc/`.

## Before coding

- Read `docs/superpowers/specs/2026-04-20-minimax-plugin-cc-design.md` (the spec, v5)
- Read `doc/probe/*.md` (Phase 0 probe conclusions — decisions were locked here)
- Read the most recent 5 entries of `CHANGELOG.md` (cross-AI hand-off log)
- If touching a "near-copy" file, read its gemini counterpart first — no sed, no cp

## After coding

- Append CHANGELOG.md entry with `status`, `scope`, `summary`, `next`
- Run the T checklist entries that your change could affect
- Never commit API keys (spec §3.4 redaction rules apply to logs and diagnostics too)
