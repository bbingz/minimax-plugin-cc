# minimax plugin CHANGELOG

## 2026-04-20 — Phase 2

- Add /minimax:ask command.
- Add callMiniAgent (one-shot spawn + log parse + progress streaming).
- Add classifyMiniAgentResult (three-layer sentinel). Refactor getMiniAgentAuthStatus to reuse it.
- Add minimax-result-handling skill v0.1 (ask-render reference).
- spawnWithHardTimeout: onStdoutLine callback + stdout/stderr ring-buffer caps.
- stripAnsiSgr now exported.
- Breaking: auth-status timeout label changed from `ping-timeout` to `llm-call-failed`.
- Smoke: T3 (UX, first-line 151ms) PASS. T10 (fake key non-success, no leak) PASS.
  T2 BLOCKED (no real API key on this machine; code pipeline verified via T10 equivalent).

## 0.1.0 (in progress)

- Initial scaffold (Phase 1 Task 1.1-1.2)
- `/minimax:setup` command (Phase 1 Task 1.10-1.11)
- Near-copy of gemini-plugin-cc lib files (args/process/render/git/state) (Phase 1 Task 1.3-1.5)
- `minimax.mjs` core wrapper (YAML reader/writer with hardened gate + spawnWithHardTimeout + log state-machine parser + async auth) (Phase 1 Task 1.6-1.9b)
- `minimax-cli-runtime` skill draft from Phase 0 probes (P0.13)
- `minimax-prompting` skill skeleton (Task 1.12)
