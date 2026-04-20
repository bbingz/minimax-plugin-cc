---
description: Check whether the local Mini-Agent is ready, configure API key if needed, and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(uv:*), Bash(pipx:*), Bash(sh:*), Bash(curl:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" setup --json "$ARGUMENTS"
```

Parse the JSON output and branch:

### Case 1 — `installed: false`

- Examine `installers.uv` / `installers.pipx` / `installers.curl`
- Use `AskUserQuestion` once with these options (skip any whose installer is not available):
  - `Install via uv (recommended)` → runs `uv tool install --with socksio git+https://github.com/MiniMax-AI/Mini-Agent.git`
  - `Install via pipx` → runs `pipx install git+https://github.com/MiniMax-AI/Mini-Agent.git` (warn: may miss `socksio` for SOCKS-proxied environments)
  - `Skip for now`
- After install succeeds, re-run the setup subcommand
- If setup still reports `installed: false` but `~/.local/bin/mini-agent` exists → tell the user: "mini-agent is installed at `~/.local/bin/mini-agent` but not on your PATH. Add `~/.local/bin` to PATH and reopen your shell, then re-run `/minimax:setup`."

### Case 2 — `installed: true`, `authReason: "needs-socksio"`

Tell the user: "Your environment has a SOCKS proxy but the installed mini-agent is missing the `socksio` httpx extra. Run:
`uv tool install --force --with socksio git+https://github.com/MiniMax-AI/Mini-Agent.git`"

### Case 3 — `installed: true`, `authReason: "auth-not-configured"`

- **First check `MINIMAX_TEST_API_KEY` env variable** (for CI/automation bypass):
  - If set, silently call:
    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" write-key --api-key "$MINIMAX_TEST_API_KEY" --json
    ```
  - Parse result; if `ok: false`, print `reason` + `lineNumber`; else re-run setup.
- Otherwise, use `AskUserQuestion`:
  - **First question**: "Which MiniMax region?" options:
    - `International (api.minimax.io)`
    - `China (api.minimaxi.com)`
  - **Second question**: "Paste your MiniMax API key:" (提醒用户 "Claude Code's AskUserQuestion may not hide input; consider cancelling + using env `MINIMAX_TEST_API_KEY` instead if your terminal is shared")
- After user submits both answers, call:
    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" write-key --api-key "<user-provided>" --json
    ```
- Parse `{ok, reason?, lineNumber?, form?}`:
  - `ok: true` → re-run `setup --json`；若 `authenticated: true` → Case 5
  - `ok: false, reason: "plain-scalar-requires-quoting"` → 告诉用户"检测到 `~/.mini-agent/config/config.yaml` 里的 api_key 行不是引号形式（第 {lineNumber} 行）。我们的自动写入只接受 `api_key: "..."` 或 `api_key: '...'`。请手动把该行改为引号形式，然后重跑 `/minimax:setup`。"
  - `ok: false, reason: "duplicate-api-key" | "block-scalar-indicator" | "flow-style" | "anchor-alias-or-tag" | ...` → 逐条给出精确指导
  - `ok: false, reason: "control-char-in-key" | "whitespace-newline-in-key" | "key-too-long"` → key 内容非法
  - 任何 `ok: false` 都不应直接把 raw key 显示回给用户（setup 的 output 已脱敏，companion 的 stderr 可能含值）

### Case 4 — `installed: true`, `authReason: "config-missing"`

Tell the user: "Mini-Agent config file missing. Run:
```bash
curl -fsSL https://raw.githubusercontent.com/MiniMax-AI/Mini-Agent/main/mini_agent/config/config-example.yaml -o ~/.mini-agent/config/config.yaml
curl -fsSL https://raw.githubusercontent.com/MiniMax-AI/Mini-Agent/main/mini_agent/config/mcp-example.json -o ~/.mini-agent/config/mcp.json
curl -fsSL https://raw.githubusercontent.com/MiniMax-AI/Mini-Agent/main/mini_agent/config/system_prompt.md -o ~/.mini-agent/config/system_prompt.md
```
Then re-run `/minimax:setup`."

### Case 5 — `installed: true` AND `authenticated: true`

- Print the full status JSON block for user reference (**do NOT paraphrase or strip fields**; apiKeyMasked already safe).
- If user passed `--enable-review-gate` or `--disable-review-gate`, acknowledge (runtime toggle implemented Phase 4).

### General output rules

- Present the final setup output verbatim to the user.
- Do NOT suggest installation changes if already installed and authenticated.
- **Never print the raw `api_key` value** — always use `apiKeyMasked`.
- Mention the cold-start UX契约: "⚠ Each `/minimax:ask` invocation has ~3–5s Python cold-start. For long tasks, prefer `/minimax:rescue --background`."
