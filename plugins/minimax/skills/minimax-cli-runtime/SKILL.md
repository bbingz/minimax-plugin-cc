---
name: minimax-cli-runtime
description: Internal helper contract for calling the minimax-companion runtime from Claude Code. v0.1 — finalized after 13 Phase 0 probes against Mini-Agent 0.1.0.
---

# minimax-cli-runtime

Internal contract for code invoking `scripts/minimax-companion.mjs`. Not user-facing. Claude uses this when dispatched via `/minimax:*` commands or the `minimax-agent` subagent (Phase 4).

## Runtime requirements

- `mini-agent` CLI ≥ 0.1.0 on PATH (installed via `uv tool install --with socksio git+https://github.com/MiniMax-AI/Mini-Agent.git`)
- `~/.mini-agent/config/config.yaml` present with valid `api_key` (not placeholder `YOUR_API_KEY_HERE`)
- Node.js ≥ 18

## Companion script subcommands (Phase 1)

| Subcommand | Purpose | JSON shape |
|---|---|---|
| `setup --json` | Check availability + auth | `{installed, version, authenticated, authReason, authDetail, model, apiBase, apiKeyMasked, configPath, installers}` |
| `write-key --api-key <k> [--api-base <u>] [--json]` | Atomic YAML api_key write | `{ok, reason?, form?, lineNumber?}` |

Phase 2+ subcommands: `ask`, `review`, `task`, `status`, `result`, `cancel`, `task-resume-candidate`, `adversarial-review`.

## Mini-Agent CLI invocation facts (probe-confirmed)

### P0.1 — `--task` one-shot stability
- `mini-agent --version` returns `mini-agent 0.1.0`
- One-shot: `mini-agent -t "<prompt>" -w <cwd>`；自然退出率 5/5
- `Log file: <absolute>.log` 出现在 stdout 前 30 行内（P0.1 实测约在 line 27）
- **含 ANSI escape codes**（`[0m` 后缀等），使用前必 strip
- Exit code 恒为 0（含 auth failure）
- 冷启动 p50 10543ms / p95 11466ms（P0.1 实测，包含 401 retry 约 10-11s；真实 key 下 <3s）

### P0.2 — Log file structure (CRITICAL: OpenAI schema)
- Log path: `~/.mini-agent/log/agent_run_YYYYMMDD_HHMMSS.log`（秒级 timestamp）
- **3 种 block kind**：REQUEST / RESPONSE / TOOL_RESULT
- Block header: `^\[(\d+)\]\s+(REQUEST|RESPONSE|TOOL_RESULT)$`；`log_index` 跨 kind 连续递增
- **Separator 2 种**：文件 header `=` × 80 / block 分隔 `-` × 80（parser 必须区分，不能用 `^[=-]{80}$`）
- **RESPONSE JSON 是 OpenAI 兼容规范化格式**（非 Anthropic 原始）：
  ```json
  {
    "content": "<string, assistant text reply>",
    "thinking": "<optional string>",
    "tool_calls": [{"id": "...", "name": "...", "arguments": {...}}],
    "finish_reason": "stop|length|tool_calls|tool_use|content_filter"
  }
  ```
- **终态选择规则**：倒序遍历 RESPONSE blocks，选第一个有 `finish_reason ∈ {stop, length, tool_calls, tool_use, content_filter, max_tokens, stop_sequence}` 或非空 `content` 字符串的 block
- auth 失败（401/SIGTERM during retry）时 Mini-Agent 跳过 `log_response` → 日志里 0 个 RESPONSE block（`agent.py:371` 行为）——这是**预期行为**

### P0.3 — Log flush timing
- **非增量 flush**：日志在 API 请求发出时一次性写 REQUEST block，RESPONSE 等进程完成才写
- `fs.watch` 实时订阅无效
- 后果：spec §1.3 "实时事件流 UX" **永久关门**

### P0.4 — Large prompt transfer
- argv `-t "<prompt>"` 可达 **210KB+**（macOS ARG_MAX 1MB，Linux 128KB+）
- stdin pipe **不支持**（会进入交互模式）
- v0.1 `callMiniAgent` 直接 argv 传，不做 tmpfile 备选

### P0.5 — Failure sentinel matrix (16 samples, 4 locales)
- **Layer 1 源码常量 sentinel**（跨 locale 稳定，ASCII 硬编码）：
  - `"Please configure a valid API Key"` — 仅当 api_key 是 placeholder / 空
  - `"Configuration file not found"` — config.yaml 不存在
  - `"ImportError: Using SOCKS proxy"` — httpx 缺 socksio extra
- **Layer 3 stdout sentinel**（同样 ASCII 硬编码，跨 locale 稳定）：
  - `"Retry failed"` — LLM retry 耗尽（命中 8/16 场景：401 × 4 + invalid_model × 4）
  - `"Session Statistics:"` — stdout 尾部总结（正常 + 401 失败都有）
  - `"Log file:"` — 前 30 行内（含 emoji 前缀，匹配用 `contains`）
- **locale 敏感点**：OSError 消息在 Linux glibc 下可能 i18n；bad_cwd 检测用 exit 信号而非 strerror
- **重要**：invalid_model 与 invalid_key 在无有效 key 时行为**一致**（均 401）；需有效 key + parse error body JSON 才能区分。v0.1 不做，`authReason` 合并归 `llm-call-failed`
- bad_cwd → exit code=1（无 sentinel）；SIGTERM → exit code=143（无 sentinel）
- 所有 L3 sentinel 含 ANSI escape codes，匹配前必须 strip

### P0.6 — YAML concurrent write
- 无锁 20 并发写在 macOS APFS 下**偶然未损坏**（单写原子副作用），但竞态窗口确认存在
- `withLockAsync` 必要；`MINI_AGENT_LOCK_PATH` 支持 env 覆盖（测试用）

### P0.7 — Workspace-local config（v0.2 第五路径评估）
- `mini-agent --workspace <path>` **不改 config 搜索路径**（只改 `workspace_dir`）
- 只有 `cd <path>` 后 cwd 命中 `<cwd>/mini_agent/config/config.yaml` 才读局部 config
- config 搜索顺序：(1) `cwd/mini_agent/config/` → (2) `~/.mini-agent/config/` → (3) package 内置
- spec §8.5 "第五路径" 复杂度上修：v0.2 要么等上游改 `find_config_file` 接受 workspace 注入，要么用 cd-into-workspace workaround

### P0.8 — API key format
- Mini-Agent 对 key **零格式校验**（只拒 `YOUR_API_KEY_HERE`）
- 形态：opaque Bearer string（`Authorization: Bearer <key>` header）
- 推断常见前缀：`eyJ...`（JWT-like，MiniMax 平台主力） / `sk-...`（Anthropic-style）
- **v0.1 validateKeyContent 约束**：长度 1-4096，无控制字符，无换行/tab，UTF-16 代理对完整

### P0.9 — env-auth（已完成，无捷径）
- Mini-Agent 源码全局 0 次 `os.environ` 调用
- 实证：`MINIMAX_API_KEY=xxx` 无效
- 后果：Q2 决策锁定"AskUserQuestion + YAML 原地替换"（§3.4）

### P0.10 — Concurrent spawn log attribution (CONDITIONAL GATE FAILED)
- 秒级 timestamp 精度下并发 spawn 会产生**同名日志文件**（3 轮 × 3 并发 → 每轮 3 个 spawn diff 到同一个文件）
- **Phase 4 `job-control.mjs` 必须串行化 job 调度**（一次只允许一个 mini-agent 在跑）
- v0.2 等上游引入 job-id 注入到日志文件名后再改造

### P0.11 — `mini-agent log <file>` subcommand
- 输出与 `cat` 原文件基本相同（仅头尾 ANSI 装饰行：前 3 行 + 后 2 行）
- **Phase 1 Task 1.9a 的 fallback 可用但可简化为直接读原文件**（`~/.mini-agent/log/<filename>`）
- fallback 是 best-effort，失败只记录不传染主路径

### P0.12 — YAML anti-pattern fixtures
`doc/probe/fixtures/p12-antipatterns/` 含 7 个 fixture，用于 validateYamlForApiKeyWrite 单元测试：
- **拒绝**：`multiline-block-scalar.yaml` / `duplicate-key.yaml` / `flow-style.yaml` / `anchor-alias.yaml` / `bom.yaml` / `plain-scalar.yaml`
- **通过**：`upstream-placeholder.yaml`（Mini-Agent 官方 config-example.yaml 形态：`api_key: "YOUR_API_KEY_HERE" # comment`）

## Config write contract (spec §3.4)

`writeMiniAgentApiKey` (Task 1.7) 实现：
- **Predicate gate**（fails closed 返回 reason；所有 reason 与 spec §3.4.2 对齐）：
  - BOM / 0 match / duplicate-api-key / block-scalar-indicator / flow-style / anchor-alias-or-tag / form-D-unclosed / form-D-trailing-content / form-S-unclosed / form-S-trailing-content / suspicious-continuation-after-api-key / plain-scalar-requires-quoting / empty-value-looks-like-block-scalar
- Key content 校验（validateKeyContent）：empty-key / key-too-long / control-char-in-key / whitespace-newline-in-key / unpaired-surrogate
- Atomic write: 同目录 tmpfile + `fsync(fd)` + `fsync(dirFd)` + `rename`
- Lock: `withLockAsync(MINI_AGENT_LOCK_PATH, fn)` with stale-lock recovery（PID 校验 + mtime 60s + 损坏文件 auto-unlink + 3×100ms retry）

## Log attribution (spec §3.3)

**P0.10 结论：snapshot-diff 归属不可靠**。Phase 4 job-control **必须串行化**。当前 v0.1 的 `/minimax:setup` + `/minimax:ask` 一次只起一个子进程，不受影响。Phase 4 `/minimax:rescue --background` 必须排队。

## API key redaction (spec §3.4)

Secrets 不可出现在: argv, state.json, jobs/*/meta.json, CHANGELOG.md, probe 报告, Claude-visible diagnostic bundles。

`redactSecrets` regex（Task 1.7）：
```js
text.replace(/sk-[A-Za-z0-9_\-\.]{20,}/g, "sk-***REDACTED***")
   .replace(/eyJ[A-Za-z0-9_\-\.]{20,}/g, "eyJ***REDACTED***")
```

## Session / resume

- v0.1 **不支持续跑**（Mini-Agent 无外部 session id）
- `/minimax:rescue --resume-last` 等价于新建 session + 提示 "v0.1 no resumable session"

## Do NOT

- Do NOT 传 `--approval-mode`（Mini-Agent 无此概念）
- Do NOT 写入 `~/.mini-agent/`（唯二例外：`config/.lock` 和 `config/config.yaml::api_key`，都在 withLockAsync 保护下）
- Do NOT 依赖 `mini-agent log <filename>` fallback 作为主路径——它是 best-effort，失败只记录
- Do NOT 期望 invalid_model 和 invalid_key 在 fake key 环境下能区分
- Do NOT 假设 concurrent `mini-agent -t` spawn 能从 `Log file:` 行唯一定位（秒级 timestamp 会同名；Phase 4 必须串行）
