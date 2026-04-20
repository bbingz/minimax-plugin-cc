# minimax-plugin-cc 设计文档

**日期**：2026-04-20
**作者**：bing + Claude Code（Opus 4.7）
**状态**：草稿 v5，两轮 spec review + 三轮 plan review + Phase 0 probe 实测结果反向回炉 spec（见附录 B）
**仓库**：`/Users/bing/-Code-/minimax-plugin-cc/`（独立仓库）
**姊妹工程**：`gemini-plugin-cc`（已实装 v0.5.2）、`kimi-plugin-cc`（spec 已定 plan 未执行）

---

## 1. 目标与范围

### 1.1 做什么

把 `gemini-plugin-cc` / `kimi-plugin-cc` 的功能形态**完整手工移植**到 `minimax-plugin-cc`，底层 CLI 由 `gemini` / `kimi` 换成 **MiniMax-AI/Mini-Agent**（官方 Python agent CLI，`uv tool install` 安装，MIT 协议）。Claude Code 里的用户能用 `/minimax:ask`、`/minimax:review` 等命令调用 MiniMax-M2.7 模型，用法和对应的 `/gemini:*` / `/kimi:*` 命令一一对应。

这是 agent-plugin-cc 三件套之一——gemini / kimi / minimax。后续还要做 `qwen-plugin-cc` / `doubao-plugin-cc` 等。本次手工实现过程中的所有差异点写入 `lessons.md`，供下一个 agent plugin 起步时直接复用。

**底层 CLI 选型说明**：MiniMax 旗下有三条路径可选（见附录 C）。v0.1 选 **Mini-Agent**（MIT 协议 + 有 `--task` one-shot 模式 + 自带 file/bash/Skills/MCP + Anthropic 兼容 API），不选 mmx-cli（多模态生成 CLI，定位不同）也不选 M2.7 裸 API（无 agent 运行时）。mmx-cli 留 v0.2 单独做。

### 1.2 交付物（v0.1）

- **8 个命令**：`setup` / `ask` / `review` / `rescue` / `cancel` / `status` / `result` / `adversarial-review`
- **3 个 skill**：`minimax-cli-runtime`（内部合约）/ `minimax-prompting`（prompt 诀窍）/ `minimax-result-handling`（输出呈现）
- **1 个 agent**：`minimax-agent.md`（subagent_type=minimax-agent）
- **2 个 hook**：`session-lifecycle-hook.mjs` + `stop-review-gate-hook.mjs`
- **1 个 JSON schema**：`schemas/review-output.schema.json`（独立一份，创建时字节对齐 gemini 版）
- **独立 git 仓库**，自带 `marketplace.json`
- **`lessons.md`**：本次迁移差异点与"给下个项目"的前置调研清单
- **`CHANGELOG.md`**：跨 AI 协作日志（reverse-chrono，flat 格式，带 status 字段）

### 1.3 不做（v0.1 明确排除）

- 不做 mmx-cli 多模态命令（image/video/speech/music/vision/search）
- 不做 M2.7 直连 HTTPS fast path（轻任务绕 Mini-Agent 模式）
- 不支持续跑（Mini-Agent 无外部 session_id 概念；T4/T7 推 v0.2）
- 不做实时日志事件流 UX（**P0.3 已确认日志非增量 flush——永久关门，不再 v0.2 补**）
- 不做 per-command 切模型（P0.7 确认 `--workspace` flag 不改 config 搜索路径，只有 cd-into-workspace 才生效；v0.2 第五路径复杂度上修，要么等上游改 `find_config_file`）
- 不做 Engram sidecar（Mini-Agent 无对应路径映射）
- **`/minimax:review` / `/minimax:adversarial-review` 的 JSON parse 失败时做 1 次带强化 prompt 的 retry**（v0.2 再扩为自适应多次）

### 1.4 成功标准

- 装好 Mini-Agent（`uv tool install --with socksio git+https://github.com/MiniMax-AI/Mini-Agent.git`）并在 `~/.mini-agent/config/config.yaml` 配好 MiniMax API key 的机器上：
  `claude plugins add ./plugins/minimax` → `/minimax:setup` 通 → `/minimax:ask "hello"` 返回 → `/minimax:review` 对一个小 diff 产出符合 schema 的 JSON
- `lessons.md` 至少 5 条 gemini/kimi/minimax 差异点
- T-checklist 的 T1、T2、T3、T5、T6、T8、T9、T10、T11、T12、T13 通过（见 §6.1）

---

## 2. 仓库布局

### 2.1 根目录

```
minimax-plugin-cc/
├── .claude-plugin/marketplace.json
├── plugins/minimax/                      # 见 §2.2
├── docs/superpowers/
│   ├── specs/2026-04-20-minimax-plugin-cc-design.md    # 本文
│   └── plans/                            # writing-plans 阶段生成
│       └── 2026-04-20-phase-0-1-foundation.md
├── README.md
├── CLAUDE.md                             # 工作目录级指令
├── CHANGELOG.md                          # 跨 AI 协作日志
├── lessons.md                            # 迁移经验
└── .gitignore
```

### 2.2 `plugins/minimax/` 内部（与 `plugins/gemini` / `plugins/kimi` 一一对照）

```
plugins/minimax/
├── .claude-plugin/plugin.json
├── CHANGELOG.md
├── commands/
│   ├── setup.md
│   ├── ask.md
│   ├── review.md
│   ├── cancel.md
│   ├── status.md
│   ├── result.md
│   ├── rescue.md
│   └── adversarial-review.md
├── agents/
│   └── minimax-agent.md
├── skills/
│   ├── minimax-cli-runtime/SKILL.md
│   ├── minimax-prompting/
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── minimax-prompt-recipes.md
│   │       ├── minimax-prompt-antipatterns.md
│   │       └── prompt-blocks.md
│   └── minimax-result-handling/SKILL.md
├── hooks/hooks.json
├── prompts/
│   ├── stop-review-gate.md
│   └── adversarial-review.md
├── schemas/review-output.schema.json
└── scripts/
    ├── minimax-companion.mjs
    ├── session-lifecycle-hook.mjs
    ├── stop-review-gate-hook.mjs
    └── lib/
        ├── args.mjs            # 纯复制
        ├── git.mjs             # 纯复制
        ├── process.mjs         # 纯复制
        ├── render.mjs          # 改"MiniMax" 字样
        ├── state.mjs           # 改路径常量 + jobId 前缀
        ├── prompts.mjs         # 手工改 prompt 文本
        ├── job-control.mjs     # 改 env 名 + meta.json 加 miniAgentLogPath 字段 + workspace sandbox 支持
        └── minimax.mjs         # 完全从零写（含 YAML 读写 + Mini-Agent spawn + 日志解析）
```

### 2.3 手工改写 vs 几乎纯复制 的分界

| 类别 | 文件 |
|---|---|
| **完全从零写** | `minimax.mjs`、8 个 `commands/*.md`、2 个 prompt、3 个 skill 的内容 |
| **较大改动**（> 30%） | `job-control.mjs`（sandbox workspace 支持 + meta.json 新字段）、`setup.md`（AskUserQuestion 写 YAML 分支） |
| **几乎纯复制**（< 10% 改动） | `args.mjs`、`git.mjs`、`process.mjs`、`render.mjs`、`state.mjs`、两个 hook 脚本、schema |
| **结构照抄** | 目录树、`plugin.json`、`marketplace.json` |

P2 原则下即使"几乎纯复制"的文件也要通读再写，不做 sed 批量替换。

### 2.4 命名替换规则

| gemini/kimi | minimax |
|---|---|
| `gemini` / `kimi` | `minimax`（代码一律小写） |
| `Gemini` / `Kimi` | `MiniMax`（人面字符串） |
| `~/.gemini/` / `~/.kimi/` | `~/.mini-agent/` |
| `GEMINI_COMPANION_SESSION_ID` / `KIMI_COMPANION_SESSION_ID` | `MINIMAX_COMPANION_SESSION_ID` |
| `gemini-companion.mjs` / `kimi-companion.mjs` | `minimax-companion.mjs` |
| `gemini-agent` / `kimi-agent` | `minimax-agent` |
| `/gemini:*` / `/kimi:*` | `/minimax:*` |
| `~/.claude/plugins/gemini/` / `~/.claude/plugins/kimi/` | `~/.claude/plugins/minimax/` |
| `gemini -p` / `kimi -p --print` | `mini-agent -t` |
| `gemini -v` / `kimi -V` | `mini-agent --version` |
| `gj-` / `kj-` job id 前缀 | `mj-` |

### 2.5 与 `kimi-plugin-cc` 的 4 处仓库级差异

1. `minimax.mjs` 比 `kimi.mjs` 多两块：**YAML 读/写**（替代 kimi 的 TOML 顶层键扫描）+ **日志文件解析**（提取 REQUEST/RESPONSE JSON block）
2. 无对应 kimi 的"stream-json 事件流"代码路径——改为"stdout 原样透传 + 任务结束后日志文件解析"
3. `setup.md` 内置 **AskUserQuestion 写 `api_key`** 分支（kimi 是让用户自己 `! kimi login`）
4. `rescue.md` 新增 `--sandbox` flag + `job-control` 里的 workspace 隔离逻辑

---

## 3. CLI 集成（`minimax.mjs` 设计）

### 3.0 数据源优先级契约

`log file > stderr > stdout`。具体：
- **最终结果（assistant response / tool_calls / success-or-failure）以日志文件为 ground truth**
- **stdout 仅用于 UX**（实时彩字透传给用户看进度）和 `Log file:` 行的抓取，**不参与最终结果判定**
- **stderr 用于错误归类**（ANSI strip 后按源码常量匹配）
- 当 stdout 判定"疑似 success"但日志文件最后块无终态 → **信日志**，归 `success-but-truncated`

本契约解决 3-way review 中 gemini/codex 共同指出的"ANSI + 英文常量 sentinel 脆弱"问题——把脆弱面从判定层移到 UX 层。

### 3.1 调用形态映射

| 场景 | gemini/kimi 做法 | Mini-Agent 对应做法 | 备注 |
|---|---|---|---|
| 一次性提问 | `gemini -p ... -o json` / `kimi -p ... --print --output-format stream-json` | `mini-agent -t "<prompt>" -w <cwd>` | 原生 one-shot，`--task` 参数 |
| 流式 UX | 原生 stream-json | ❌ 无结构化事件 → **stdout 透传 + 结束后日志解析** | Section 3 数据流详述 |
| 续跑 session | `gemini --resume <id>` / `kimi -S <id>` | ❌ 无外部 session id | v0.1 不做，v0.2 若 Mini-Agent 暴露 session 再补 |
| 指定模型 | `-m <model>` | ❌ 只能从 `~/.mini-agent/config/config.yaml::model` 读 | v0.1 全局固定，v0.2 依赖 P0.7 probe |
| 大 prompt | `-p ""` + stdin | **P0.4 已确认：argv `-t "<prompt>"` 可达 210KB+；stdin 不支持**（进入交互模式） | v0.1 直接用 argv 传 |
| 版本检查 | `gemini -v` / `kimi -V` | `mini-agent --version` | 无大小写陷阱 |
| 认证探测 | credentials 目录 + ping | **YAML `api_key` 非 placeholder** + ping | §3.6 |

### 3.2 对外 API

```js
export async function callMiniAgent({ prompt, cwd, timeout, extraArgs }) { ... }
//   spawn → tee stdout → 等退出 → 从日志抽 final message + stats
//   返回 { response, sessionStats, logPath, success, rawStdout, toolCalls }

export async function callMiniAgentWithProgress({ prompt, cwd, onProgressLine }) { ... }
//   同上 + 实时回调 stdout 行给调用方（主 Claude 面前透传彩字）

export function getMiniAgentAvailability(cwd)       // mini-agent --version
export function getMiniAgentAuthStatus(cwd)         // YAML.api_key 非 placeholder + ping
export function readMiniAgentConfig()               // YAML → { api_key, api_base, model, provider }
export function writeMiniAgentApiKey(apiKey)        // 带锁，§4.2 详述
export function extractLogPathFromStdout(lines)     // regex /Log file:\s+(\S+\.log)/
export function parseFinalResponseFromLog(logPath)  // 提最后 RESPONSE block 的 JSON
```

参数去掉 `approvalMode`（Mini-Agent 无对应概念）。

### 3.3 核心调用流程（以 `/minimax:ask` 为例）

**Child-process 生命周期契约**（codex 提出）：
- 三事件分离：`error`（spawn 失败，如 ENOENT）/ `exit`（进程退出码）/ `close`（stdio 流关闭）
- **以 `close` 为完成点**，不以 `exit`——`close` 事件保证 stdout/stderr 全量 drain
- stdout/stderr 用 `StringDecoder('utf8')` 增量消费到**限长环形缓冲**（stdout 1MB / stderr 64KB，超限尾留）
- `timeout` 到期 → 先 `SIGTERM`，5s 后 `SIGKILL`；清理所有 listener
- Promise 以 `{ success, response, sessionStats, logPath, toolCalls, rawStdout, rawStderr, signal, exitCode }` resolve

```
0. 入参校验 + cwd 解析
1. readMiniAgentConfig() → 若 api_key 是 "YOUR_API_KEY_HERE" 或空 → 返回 "not-authenticated"
2. 记录 logSnapshotBefore = listDir("~/.mini-agent/log/")  // 副产物 3：日志归属快照
3. spawn('mini-agent', ['-t', prompt, '-w', cwd], { stdio: ['ignore','pipe','pipe'] })
   挂 'error' 监听：捕获 ENOENT 等 spawn 失败
4. stdout/stderr 并行：
   - stdout 增量解码 → a) onProgressLine 回调（UX 透传）；b) 累积到 rawStdout 环形缓冲；
     c) 每行 regex 搜 "Log file: <path>"，命中则存 logPath（只搜前 30 行内）
   - stderr 增量解码 → 累积到 rawStderr（64KB 环形缓冲）
5. 等 'close' 事件触发（不等 'exit'）：
   - 记录 exitCode / signal
6. 结果抽取（§3.5）：
   - 若 logPath 未抓到 → 用 logSnapshotAfter diff logSnapshotBefore，找新出现的 .log 文件
   - 若仍无 → 降级用 rawStdout tail + rawStderr tail 合并呈现（4.5 契约）
   - 若 logPath 抓到 → parseFinalResponseFromLog(logPath) 选"最后一个可解析且有终态"的 RESPONSE block
7. 成败判定（§4.1）→ 结果对象
8. 清理：关闭 stdio、移除 listener、记录 logPath 到 meta.json
```

**非阻塞 guarantee**：spawn 后所有 I/O 都在 pipe 上异步消费；stdin 永远 `'ignore'`，Mini-Agent 不接收 prompt via stdin（P0.4 未通过前维持 argv 传递）。

### 3.4 YAML 读写策略（替代 kimi 的 TOML 扫描器）

**源码事实**（附录 B codex 采纳）：Mini-Agent 用 `pydantic + yaml.safe_load` 严格解析，顶层字段白名单固定（`api_key / api_base / model / provider / retry / max_steps / workspace_dir / system_prompt_path / tools`）。我们的 YAML 操作**限定在 api_key 单键单行**，就能把 gemini 担心的"多行/流式/注释交错"全部规避。

**读**：不引 YAML 依赖。为 v0.1 需要读的四个字段（`api_key` / `api_base` / `model` / `provider`）实现**极简顶层键扫描器**：

```js
// minimax.mjs 内部
export function readYamlTopLevelKey(text, key) {
  // 逐行扫，跳过注释、空行、缩进行（子字段/数组项）和表头
  // 只匹配无缩进的 `key: "value"` / `key: value` / `key: 'value'`
  // 不处理多行字符串（| > +）、流式 ({}, []）、锚点 (&, *)
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    if (raw.length !== raw.trimStart().length) continue;  // 跳缩进行
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\w+)\s*:\s*(?:"([^"]*)"|'([^']*)'|([^#\s][^#]*?))\s*(?:#.*)?$/);
    if (m && m[1] === key) return m[2] ?? m[3] ?? m[4]?.trim() ?? null;
  }
  return null;
}
```

**写**（仅 `api_key` 一个字段，**fail-closed 硬化 v3**，codex 二轮 + plan review CRITICAL 补强）：

#### 3.4.1 合法 YAML 形态定义（YAML 1.2.2 §7.3 引用）

plugin **仅在** `api_key` 当前处于以下**两种受限形态**之一时才允许 regex 改写；任何偏离都 fail-closed：

- **Form D** — *single-line double-quoted*：`api_key: "..."`（引号内无未转义 `"`、无真实换行，允许 YAML 1.2.2 §5.7 的 `\"` / `\\` / `\/` / `\b` / `\f` / `\n` / `\r` / `\t` / `\uXXXX` 等转义序列作为字面文本；gate 不尝试语义解码，只检查 `"..."` 结构闭合）
- **Form S** — *single-line single-quoted*：`api_key: '...'`（引号内 `''` 为转义单引号；无真实换行）

**不接受**（任一命中即 fail-closed）：
- `api_key: unquoted-plain-scalar`（plain scalar 可能跨多行，无法稳定区分 "一整行值" vs "值加续行"；强制要求用户必须加引号后重跑）
- `api_key: |` / `api_key: >` / 其 `-` / `+` chomping 变体（block scalar，真值在续行）
- `api_key: { ... }` / `api_key: [ ... ]`（flow-style collection）
- `api_key: &anchor ...` / `api_key: *alias`（anchor/alias/merge）
- `api_key: !tag ...`（explicit tag）
- `api_key:` 后同行为空，下一行缩进开始（empty scalar + implicit block scalar）
- 同文件内多处顶层 `api_key:` 定义（YAML safe_load 会取最后一个；regex 改会撞第一个）
- 文件以 U+FEFF BOM 起手（我们不改 BOM 文件）

#### 3.4.2 预校验 gate 算法（状态机）

```
input: text (UTF-8)
output: { ok, reason, lineNumber, form? }

step 1: reject BOM
  if text.charCodeAt(0) === 0xFEFF → fail "BOM at file start"

step 2: scan top-level keys
  matches = []
  lines = text.split(/\r?\n/)
  for i, raw in enumerate(lines):
    // 跳过注释行和空行
    if raw.trim() === "" || raw.trimStart().startsWith("#") continue
    // 跳过缩进行（顶层键必须从第 0 列开始）
    if raw[0] === " " or raw[0] === "\t" continue
    // 匹配 "api_key:"（精确顶层键名）
    if raw matches /^api_key\s*:\s*(.*)$/:
      matches.push({ index: i, valuePart: captured group })

step 3: exactly one match
  if len(matches) === 0 → fail "no-api-key"
  if len(matches) > 1 → fail "duplicate-api-key" at matches[1].index

step 4: classify form of single match
  let v = matches[0].valuePart.rtrim()  // 去行尾空白但保留前导空白
  strip inline comment: if v contains " #", cut at first " #" (YAML 1.2.2 §6.6)
  v = v.trim()

  // (A) empty after trim → implicit block scalar / empty
  if v === "" → fail "empty-value-looks-like-block-scalar"

  // (B) block scalar indicator
  if v starts with "|" or ">" (possibly followed by +/- chomping, optional digit indent)
    → fail "block-scalar-indicator"

  // (C) flow-style
  if v starts with "{" or "[" → fail "flow-style"

  // (D) anchor / alias / tag
  if v starts with "&" or "*" or "!" → fail "anchor-alias-or-tag"

  // (E) double-quoted single-line
  if v starts with '"':
    // 找匹配的右 " —— 跳过 `\"` 转义
    // YAML double-quoted 允许 `\` 转义序列；`\` 在 double-quoted 串中仅表示转义
    // 状态机：遇 `\` 跳过下一字符，遇未转义 `"` 即闭合
    findClosingDoubleQuote(v) →
      若不闭合 → fail "form-D-unclosed"
      若闭合后有非空白非注释内容 → fail "form-D-trailing-content"
    → ok, form = "D", accept

  // (F) single-quoted single-line
  if v starts with "'":
    // YAML single-quoted 里 `''` 是转义单引号；否则遇到 `'` 即闭合
    findClosingSingleQuote(v) →
      若不闭合 → fail "form-S-unclosed"
      若闭合后有非空白非注释内容 → fail "form-S-trailing-content"
    → ok, form = "S", accept

  // (G) plain scalar — 强制拒绝，要求用户加引号
  → fail "plain-scalar-requires-quoting"

step 5: next-line continuation check
  // YAML plain scalar 可以是 multi-line（第二行以更深缩进续写），
  // 但因为 step 4 已拒绝 plain scalar，我们只需对 Form D/S 再做一次保险：
  nextLine = lines[matches[0].index + 1]
  if nextLine 存在 且 nextLine 以至少 1 个空格/tab 开头 且 nextLine.trim() 不是以 `#` 开头
    → fail "suspicious-continuation-after-api-key"

step 6: ok
  return { ok: true, lineNumber: matches[0].index + 1, form: "D" or "S" }
```

**关键改动（相对于 v2）**：
- 不再放过"plain scalar 单行"——因为无法可靠区分单行 plain scalar 和多行 plain scalar 的第一行
- Form D 和 Form S 用**真正的 quote 闭合扫描**判定，不用简单 regex（`"([^"]*)"` 会被 `\"` 欺骗）
- Step 5 的续行检测改为"任何缩进续行都拒绝"（原"仅当值为空或 block indicator 时拒绝"有漏洞）
- 增加 inline comment 识别（`api_key: "foo" # explanation` 是合法的）

#### 3.4.3 写入值的转义

写入 `newKey` 时使用 Form D 标准化：

```
sanitizedKey = newKey 先校验：不含控制字符（\u0000-\u001F 除 \t\n\r 以外）、不含未成对代理、长度 < 4096
  任一不满足 → 返回 { ok: false, reason: "invalid-key-content" }
escapedKey = newKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
output = `api_key: "${escapedKey}"`
```

**不写入** plain scalar 或 Form S（统一 Form D 产出，便于跨平台一致性）。
2. 原子写：
   - `tmpfile = config.yaml.tmp.<pid>.<random>`（**同目录**，原子 rename 要求）
   - 写入后 `fsync(tmpfileFd)` + `fsync(dirFd)`（macOS/Linux 保证 rename 崩溃后不留半文件）
   - `fs.rename(tmpfile, config.yaml)`
3. 文件锁（`lib/state.mjs::withLock`）：锁文件 `~/.mini-agent/config/.lock`
   - 锁内容：`{ pid: <pid>, mtime: <iso-ts> }` JSON
   - 获取锁时：若锁文件存在，读 pid → `process.kill(pid, 0)` 校验存活；不存活 或 mtime 超时 60s → **stale-lock 回收**，覆写锁
   - 释放锁：`fs.unlink` 删除锁文件（非清空）
4. **不做**完整 YAML parse/stringify（会丢注释 + 可能重排字段，破坏用户自定义）

**API key 脱敏纪律**（codex 次要）：
- 写完立刻从 process.env 和局部变量擦除（`delete obj.apiKey`）
- **严禁**进入 argv / state.json / jobs/*/meta.json / CHANGELOG.md / probe 报告
- 错误消息里若含 key，先 `redactSecrets(text)` 再传出（regex 替换 `sk-[A-Za-z0-9_-]{20,}` 为 `sk-***`）

**重要**：插件写入 `~/.mini-agent/` 的点有两处——`config/.lock`（锁文件）和 `config/config.yaml::api_key`（原地替换）。两者都违反 kimi spec §5.2 "插件绝不写 `~/.<tool>/`" 原则。理由是 Mini-Agent 的鉴权机制就是"YAML 字段"——要做 AskUserQuestion 引导体验就绕不开。此例外与 §5.2 描述一致，在 lessons.md 显式登记。

### 3.5 日志文件解析（`parseFinalResponseFromLog`）

Mini-Agent 启动时打印一行 `📝 Log file: /Users/<user>/.mini-agent/log/agent_run_<ts>.log`。文件结构（**P0.2 实测修订 v5**）：

```
================================================================================       ← 文件 header（= × 80）
Agent Run Log - 2026-04-20 10:44:30
================================================================================


--------------------------------------------------------------------------------       ← block separator（- × 80）
[1] REQUEST
Timestamp: 2026-04-20 10:44:37.236
--------------------------------------------------------------------------------
LLM Request:

{ ... 完整 LLM request JSON（messages[] + tools[]）... }


--------------------------------------------------------------------------------
[2] RESPONSE                                                                           ← log_index 跨 kind 连续递增
Timestamp: 2026-04-20 10:44:41.xxx
--------------------------------------------------------------------------------

{ ... assistant 响应 JSON，OpenAI 兼容规范化格式，见下 ... }


--------------------------------------------------------------------------------
[3] TOOL_RESULT                                                                        ← 第三种 block kind
--------------------------------------------------------------------------------

{ ... tool 执行结果 ... }
```

**P0.2 实测的关键事实**（和原 spec 假设**不同**）：

1. **Block kind 有 3 种**（非 2 种）：`REQUEST` / `RESPONSE` / `TOOL_RESULT`
2. **Log index 跨 kind 连续递增**：REQUEST/RESPONSE/TOOL_RESULT 共用编号池，N 不保证奇偶性（不能假设 `[1] REQUEST` 对应 `[2] RESPONSE`）
3. **RESPONSE JSON 是 OpenAI 兼容的规范化响应**（非 Anthropic 原始格式）：
   ```json
   {
     "content": "<string, assistant 的文字回复>",
     "thinking": "<optional string>",
     "tool_calls": [{ "id": "...", "name": "...", "arguments": {...} }],
     "finish_reason": "<stop|length|tool_calls|...>"
   }
   ```
4. **Separator 有 2 种、都是 80 字符**：文件 header `=` × 80；block 分隔 `-` × 80；parser 必须区分（不能用 `^[=-]{80}$`）
5. **401/SIGTERM 场景**：Mini-Agent 在 auth 失败时**根本不写 RESPONSE block**（源码 `agent.py:371` 抛 `RetryExhaustedError` 后 return，跳过 `log_response`），所以这些场景日志里只有 REQUEST block。这是**预期行为**，parser 的"无 RESPONSE block"路径已覆盖。

**解析策略 v4（P0.2 实测后再修订 + 字段 schema 同步）**：

真实日志结构（P0.2 实测确认）——**每个逻辑 block 内部还夹着一条分隔符**（在 header 和 JSON body 之间）：

```
--------------------------------------------------------------------------------     ← 分隔符 1（块开始）
[1] RESPONSE                                                                         ← header
Timestamp: 2026-04-20 10:44:41
--------------------------------------------------------------------------------     ← 分隔符 2（header 和 body 之间）
                                                                                     ← 空行
{                                                                                    ← JSON body 开始
  ... Anthropic message JSON ...
}
                                                                                     ← 空行
                                                                                     ← （下一个 block 开始前的空行）
```

若按 `/^-{80}$/m` split，header 和 body 会落到不同 part。**正确做法是线性状态机**：

```
input: log file text
output: array of { n, kind: "REQUEST"|"RESPONSE"|"TOOL_RESULT", json: parsed | null, raw }

state = SEEK_HEADER
accumulator = []
blocks = []
lines = text.split(/\r?\n/)

for line in lines:
  if state == SEEK_HEADER:
    // 注意：header 必须**不包含** = 号（否则是文件 banner），只接受 -×80 separator 语境的 header
    match /^\[(\d+)\] (REQUEST|RESPONSE|TOOL_RESULT)$/ → state = SKIP_TO_BODY; current = {n, kind}
  elif state == SKIP_TO_BODY:
    // 跳过 header 行后的 Timestamp 行 / 分隔符 / 空行
    if line.trimStart().startsWith("{"):
      state = COLLECT_BODY
      accumulator = [line]
      braceDepth = countOpenBraces(line) - countCloseBraces(line)
      inString = endsInString from scan
      if braceDepth <= 0 and not inString:
        current.raw = accumulator.join("\n")
        current.json = tryParse(current.raw)
        blocks.push(current); state = SEEK_HEADER
    // 否则继续 SKIP
  elif state == COLLECT_BODY:
    accumulator.push(line)
    braceDepth += scan(line)
    if braceDepth <= 0 and not inString:
      current.raw = accumulator.join("\n")
      current.json = tryParse(current.raw)
      blocks.push(current); state = SEEK_HEADER

if state == COLLECT_BODY:
  // 循环结束时仍在 body → 不完整
  current.raw = accumulator.join("\n")
  current.json = null
  current.truncated = true
  blocks.push(current)
```

**选终态 block**（schema 按 P0.2 修订）：

1. `responseBlocks = blocks.filter(b => b.kind === "RESPONSE")`（仅 RESPONSE，不含 TOOL_RESULT）
2. 从 `responseBlocks` 最后一个开始倒序扫，选第一个满足：
   - `b.json` 非 null（parse 成功）
   - **且** 满足以下任一：
     - `b.json.finish_reason` 是合法值 ∈ {`stop`, `length`, `tool_calls`, `tool_use`, `content_filter`, `function_call`, `max_tokens`}（**OpenAI 兼容值**；Mini-Agent 实际输出可能是 `stop` / `tool_use`）
     - `b.json.content` 是非空字符串
3. 命中 → 抽：
   - `response = b.json.content ?? ""`（**直接字符串**）
   - `toolCalls = b.json.tool_calls ?? []`（**顶层字段**，不是嵌在 content 里；OpenAI 格式 `[{id, name, arguments}]`，注意 key 是 `arguments` 而非 `input`）
   - `thinking = b.json.thinking ?? null`（Mini-Agent 有 reasoning/thinking trace 时此字段存在）
4. 未命中 → 返回 `{ ok: false, partial: true, lastPartialResponseRaw: responseBlocks.at(-1)?.raw ?? null }`

**auth 失败场景**（401/SIGTERM on retry）：`responseBlocks.length === 0` → 直接返回 `{ ok: false, partial: true, reason: "no-response-block" }`。不报错，交由 §4.1 三层 sentinel 决策最终状态。

**Fallback 二次源**（副产物 2，codex 二轮补强：**隔离异常**）：
- 若主解析抛异常或返回 `partial: true` → **在独立 try/catch 里**调 `mini-agent log <filename>`（官方 cli.py:145 `read_log_file`）
- fallback 本身失败（文件权限 / 子进程错误 / 输出格式异常）**只记录失败事实**，**不得抛出主路径**——主路径按"主解析结果 + partial 标记"继续返回
- 契约：fallback 是 **best-effort 信心提升**，不是主路径依赖；主路径必须在完全没有 fallback 的情况下也能返回有意义结果

**Phase 0 probe P0.2 升为硬门**：必须验证——(a) RESPONSE JSON 是 Anthropic message 格式（`role / content / stop_reason`）；(b) 块分隔符在多轮 tool_use / retry / 被 SIGTERM 场景下稳定；(c) 终态选择规则对这些场景真能拿到预期结果。任一条不通 → Phase 1 不启。

### 3.6 认证检查

`getMiniAgentAuthStatus(cwd)` **是 async** 的（plan review codex MEDIUM 修正：`runCommand` sync 版本对 30s timeout 无硬保证；Mini-Agent 若吞 SIGTERM 会一直卡住）：

1. `mini-agent --version` 成功 → 二进制 OK（否则返回 `not-installed`）
2. `readMiniAgentConfig().api_key` 非 placeholder（`"YOUR_API_KEY_HERE"` / 空 / null）→ 认为已配置
3. 发 `mini-agent -t "ping" -w <cwd>`，**硬超时** 实现（非单纯的 `spawnSync.timeout`）：
   - 用 async `spawn()` + 显式 setTimeout(30_000) → 到期 SIGTERM → 再 setTimeout(5_000) → SIGKILL → 强制 resolve
   - **任何分支都必须 resolve**（不能因子进程不响应而永久挂起）
   - Promise 以 `{ timedOut: boolean, stdout, stderr, exitCode, signal }` resolve
4. 解析 stdout + 日志，按 §4.1 三层 sentinel 判定
5. timedOut === true → 返回 `{ loggedIn: false, reason: "ping-timeout" }`

**不做 `--max-steps-per-turn` 探测**（Mini-Agent 没这个参数，用 config.yaml 的 `max_steps: 100` 全局控制）。

**所有长时 spawn 调用** 必须沿用本节的"setTimeout + SIGTERM + SIGKILL + 强制 resolve"三段式超时骨架——统一到 `lib/minimax.mjs` 的 `spawnWithHardTimeout(bin, args, options)` 辅助函数。v0.1 不允许在 companion 路径使用 `spawnSync` 等可能无限阻塞的 API。

### 3.7 默认模型读取

- `~/.mini-agent/config/config.yaml` 顶层 `model` 键（默认 `"MiniMax-M2.5"`）
- 通过 `readYamlTopLevelKey(text, "model")` 读
- v0.1 不传 `-m` 覆盖（Mini-Agent 无此参数）——model 选择是 setup 时一次性决定
- v0.2 依赖 P0.7 workspace-local config probe 结论

### 3.8 不做的事

- 不暴露 `mini-agent-acp`（ACP 协议 for Zed，v0.2+）
- 不写 Engram sidecar（留空函数 stub）
- 不支持续跑
- 不做自适应重试
- 不覆盖 Mini-Agent 的内置 3 次 API retry（`retry.max_retries: 3` 默认保留）

---

## 4. 错误处理与并发安全

### 4.1 Exit code 恒 0 的成败判定

Mini-Agent 即便 401 也返 0，`$?` 作废。判定分三层优先级（codex 要求，配合 §3.0 数据源契约）：

**第一层 · 源码常量**（Mini-Agent 源码字面值，最稳；副产物 4）：

| 源码位置 | 常量字符串 | 判定 |
|---|---|---|
| `config.py:111` | `"Please configure a valid API Key"` | `auth-not-configured`（stderr） |
| `config.py:78` | `"Configuration file not found"` | `config-missing` |
| `config.py:104` | `"Configuration file is empty"` | `config-empty` |
| spawn `error` 事件 ENOENT | — | `not-installed`（走 setup 引导） |
| stderr 含 `ImportError: Using SOCKS proxy` | `httpx` 库错误 | `needs-socksio` |

**第二层 · 日志结构**（strip ANSI 后解析；优先于 stdout sentinel；**P0.2 修订字段名**）：

| 日志状态 | 判定 |
|---|---|
| 有终态 RESPONSE block（§3.5），`finish_reason ∈ {stop, stop_sequence}` + 非空 `content` 字符串 | `success` |
| 有终态 RESPONSE block，`finish_reason = length` / `max_tokens` | `success-but-truncated` |
| 有终态 RESPONSE block，`finish_reason = tool_calls` / `tool_use`（agent 还要调工具但未闭环） | `incomplete`（§4.5 错误呈现） |
| 无任何 RESPONSE block（401 / SIGTERM 等；源码 agent.py:371 会跳过 log_response） | 回落到第三层 |

**第三层 · stdout sentinel**（最脆弱，仅作兜底；**先 ANSI strip 再匹配**）：

| stdout pattern（strip 后） | 判定 |
|---|---|
| `❌ Retry failed` / `LLM call failed after N retries` | `llm-call-failed` |
| `Session Statistics:` 有，但日志无 RESPONSE | `success-claimed-but-no-log`（警告） |
| `Session Statistics:` 无 + 日志无 RESPONSE | `unknown-crashed`（stderr 附给用户） |

**ANSI strip 实现**：`s.replace(/\x1b\[[0-9;]*m/g, '')`（只处理 SGR；CSI/OSC 等 Mini-Agent 未使用）

**Phase 0 probe P0.5 升级为**：对 4 种失败场景 × 4 种 locale 环境（en_US / zh_CN / C / POSIX）交叉采样，验证第一层和第二层的分类稳定；第三层 sentinel 仅作降级兜底，不入硬门。

### 4.2 YAML 写入并发安全

**策略**（详细实现见 §3.4 硬化后版本）：
- `writeMiniAgentApiKey` 仅在 `/minimax:setup` 路径触发——其他命令不写 YAML，从根上避免高频并发写
- **预校验 gate**：写前必须确认 "恰一个顶层 `api_key` 行 + 非多行起手 + 非流式"，否则 fail-closed 退用户手改
- **stale-lock 回收**：锁文件含 `{pid, mtime}`；获取锁时 `kill -0 pid` 校验存活 + mtime 超时 60s 判死锁；覆写后重试
- **原子写**：`tmpfile` 必须与 `config.yaml` **同目录**；写入后 `fsync(tmpfileFd)` + `fsync(dirFd)` 再 `rename`
- **API key 脱敏**：写完立即从内存擦除，严禁进 argv / 日志 / meta.json
- Phase 0 probe P0.6 验证：两个 setup 并发 / 进程崩溃留锁 / pydantic 风格异常 YAML 各跑 10 次，确认锁生效、YAML 不损坏、fail-closed 正确触发

### 4.3 Mini-Agent 自身故障恢复

- **SOCKS 撞包**：setup 首装时就 `--with socksio` 规避；已有安装出现 `ImportError` → 提示 `uv tool install --force --with socksio git+...`
- **model 不存在 / api_base 错**：Mini-Agent 内置 3 次 retry 消耗 → companion 看到 `Retry failed` → 归 `llm-call-failed`，`/minimax:result` 把 stderr 最后 500 字给用户
- **mid-stream kill**（`/minimax:cancel`）：SIGTERM → 5s 宽限 → SIGKILL。meta.json 打 `canceled=true`。日志可能不完整，`parseFinalResponseFromLog` 容错处理并返回 `partial: true`

### 4.4 冷启动 3–5s UX 契约

- `/minimax:setup` 输出明确标注 "⚠ Each `/minimax:ask` invocation has ~3-5s Python cold-start; prefer `/minimax:rescue --background` for long tasks"
- `/minimax:ask` companion 第一时间 `onProgressLine('⏳ Starting MiniMax (cold start ~3s)…')`，避免用户误以为 Claude Code 卡住
- 写进 `minimax-result-handling` skill，Claude 引用命令结果时不额外解释"为什么慢"

### 4.5 Retry 策略 + 错误呈现

**Retry 策略**（与 kimi 一致）：
- `/minimax:review` 和 `/minimax:adversarial-review` 的 JSON parse 失败 → **1 次 retry**，新 prompt 附加 "Your previous response could not be parsed as valid JSON. Return ONLY a raw JSON object..." + 失败原文
- Mini-Agent 自带 3 次 API retry → 不覆盖、不叠加
- **组合效果**：Mini-Agent 的 3 次 retry 吃掉网络抖动 + companion 的 1 次 retry 兜 JSON 格式

**错误呈现契约**（gemini 建议"自适应重试部分兜底"的回应；codex 二轮补强：去硬截 2KB）：
- 所有"非 success"结果一律附**诊断包**给 Claude（Claude 再决定怎么给用户看）：
  ```
  {
    status: "llm-call-failed" | "success-but-truncated" | "incomplete" | "unknown-crashed" | ...,
    reason: <第一层源码常量命中的字符串>,
    stderrHeadTail: <rawStderr 首 256 + 末 2048 字，ANSI strip；超限显示 "... <N bytes elided> ...">,
    lastCompleteResponseBlock: <JSON>,  // 日志里最后一个可解析 RESPONSE block 的完整 JSON（不截断）
    lastPartialResponseRaw: <string|null>,  // 最后一个不完整 RESPONSE block 的原始文本（诊断用）
    logPath: <绝对路径>,
    retriedOnce: <boolean>  // 仅 review/adversarial-review
  }
  ```
- 原则：诊断包**不做字节硬截**——保留最后一个完整 RESPONSE block 的全部 JSON + 可能的部分 RESPONSE 原文，把容量决策交给 `minimax-result-handling` skill 规约下的 Claude 呈现层
- `stderrHeadTail` 做 head+tail 保留是因为早期启动错误（Python import / config 加载失败）都在 stderr 首屏
- `minimax-result-handling` skill 规定 Claude 呈现诊断包的格式：失败场景提示用户检查 key/网络 + 给 `logPath`；不擅自重试。

### 4.6 Workspace 策略（`/minimax:rescue --sandbox`）

> **重要文案降级**（codex 纠正）：`--sandbox` **不是安全边界，只是隔离工作目录**（isolated workdir）。Mini-Agent 的 bash 工具可以 `cd /` / 绝对路径 / `../` 逃逸——"换 cwd ≠ 沙盒"。如果要真实安全隔离，需要 OS-level sandbox/container/权限裁剪，**非 v0.1 范围**。CLI 的 help 文本、skill 文档、lessons.md 必须都用"isolated workdir"措辞。

- **默认**：`workdir = 主 Claude cwd`（和 gemini/kimi 一致，让 agent 能改代码）
- **`--sandbox`（即"isolated workdir"）**：`workdir = ~/.claude/plugins/minimax/jobs/<jobId>/workspace/`

**Phase 4 job 调度必须串行化**（P0.10 条件硬门 FAIL，CHANGELOG warning 已留痕）：秒级 timestamp 精度下并发 spawn 会产生同名日志文件（`agent_run_YYYYMMDD_HHMMSS.log`），`job-control.mjs` 的"snapshot diff"归属不可靠。v0.1 约束：**一次只允许一个 `mini-agent` 在跑**，多个 `/minimax:rescue --background` 进队列排队。v0.2 等上游引入 job-id 注入到日志文件名后再改造。
  - 语义：**减少误操作主项目的概率**（agent 在陌生目录里默认操作自己的）
  - 语义：**不减少恶意或意外的越界**（agent 完全可能 `rm -rf /important/path`）
  - 用例：生成 PDF / 多模态实验 / 跑可疑 bash / 不想把 workspace 污染主项目的探索任务
- `job-control.mjs` 在 `--sandbox` 分支下：
  - `createJob` 时 `mkdir -p jobs/<jobId>/workspace/`
  - 启动命令 `mini-agent -t "<p>" -w jobs/<jobId>/workspace/`
  - `cancel` 时删 workspace（默认，`--keep-workspace` 保留用于 debug）
- **T11 验收标准修正**：不再验证"rm -rf 被阻止"（这是 OS sandbox 的事），改为验证"在 sandbox 模式下，主项目目录的 mtime 没被 agent 默认操作动过"（减少误操作的正面用例）
- 此决策是 kimi 经验**不适用**的差异点——kimi `--print` 基本只读，Mini-Agent 有 bash+file-write 工具，risk surface 显著更大；lessons.md 登记"full-parity 迁移必须做 workspace 策略重评估 + 安全边界语义澄清"

---

## 5. State、认证、持久化

### 5.1 插件状态目录

`~/.claude/plugins/minimax/`：
- `state.json` — 开关（如 `reviewGate.enabled`）
- `jobs/<jobId>/` — 后台任务 stdout.log / stderr.log / pid / meta.json / workspace/（sandbox 模式下）
- `meta.json` 相对 kimi 新增字段：`miniAgentLogPath`（指向 `~/.mini-agent/log/agent_run_<ts>.log`）、`sandbox: boolean`、`canceled: boolean`

### 5.2 Mini-Agent 自身数据目录

- `~/.mini-agent/config/config.yaml` — 读 `api_key` / `api_base` / `model` / `provider`，写 `api_key`（带锁，唯一写入点）
- `~/.mini-agent/config/.lock` — 我们的锁文件（唯一写入例外）
- `~/.mini-agent/config/mcp.json` — 首装时下发模板（`mcp-example.json`），之后只读
- `~/.mini-agent/config/system_prompt.md` — 首装时下发，之后只读
- `~/.mini-agent/log/agent_run_*.log` — 只读解析，不清理（用户自行管理）
- `~/.mini-agent/config.backup.*` — setup-config.sh 生成的历史备份，不碰

**原则（修订自 kimi §5.2）**：插件写 `~/.mini-agent/` 的**唯二例外**：`config/.lock` + `config/config.yaml::api_key` 原地替换。其他一律只读。

### 5.3 `/minimax:setup` 决策树

```
which mini-agent？
├── 无 → 探测 uv / pipx / shell → AskUserQuestion 三选项
│         ├── uv tool install --with socksio git+https://github.com/MiniMax-AI/Mini-Agent.git  (推荐)
│         ├── pipx install git+...  (fallback, 可能遇 socksio)
│         └── Skip
│         安装后 → 绝对路径复探测 → PATH 未生效则提示
└── 有
    mini-agent --version 成功？
    ├── 否
    │   └── stderr 含 ImportError: Using SOCKS proxy? → 提示 --with socksio
    └── 是
        ~/.mini-agent/config/config.yaml 存在？
        ├── 否 → 下发 setup-config.sh 三件套（config.yaml / mcp.json / system_prompt.md）→ 继续
        └── 是
            api_key 非 placeholder？
            ├── 否 → **MINIMAX_TEST_API_KEY env 存在？**（CI/自动化测试绕 AskUserQuestion；gemini 建议）
            │   ├── 是 → writeMiniAgentApiKey(env 值) → ping 验证
            │   └── 否 → AskUserQuestion：
            │       ├── 问 api_base 区域（"international: api.minimax.io" / "China: api.minimaxi.com"）
            │       ├── 问 API key（文本输入；Claude Code AskUserQuestion 本身支持隐藏输入则用，否则提示用户知悉）
            │       └── → 预校验 gate 通过？→ writeMiniAgentApiKey(key) + 更新 api_base → ping 验证
            │             预校验失败 → 输出精确指导（`nano ~/.mini-agent/config/config.yaml`）退给用户手改
            └── 是
                ping-call 成功？
                ├── 否 → 报认证问题（stderr 末 500 字）
                └── 是 → { installed, authenticated, model, version, apiBase }
```

### 5.4 环境变量

| env | 作用 |
|---|---|
| `MINIMAX_COMPANION_SESSION_ID` | Claude Code session id，由 session-lifecycle-hook 注入 |
| `CLAUDE_PLUGIN_ROOT` | Claude 注入 |
| `MINI_AGENT_BIN`（可选）| 覆盖 `mini-agent` 二进制路径（测试用） |

---

## 6. 命令、Agent、Skill、Hook

### 6.1 命令总表

| 命令 | 职责 | 与 kimi 同构 | **minimax 独有处理** |
|---|---|---|---|
| `/minimax:setup` | 检查可用性/鉴权/切 review-gate | 决策树骨架 | ① 三选一安装（uv/pipx/skip，带 `--with socksio`）；② AskUserQuestion 写 `api_key` + 选 `api_base`；③ 首装下发 config 三件套 |
| `/minimax:ask` | 一次性提问 | 透传形态 | spawn `mini-agent -t -w`；stdout 实时透传；结束后日志解析 |
| `/minimax:review` | 对 diff 做 review | prompt 强约束 + 1 次 JSON retry | 从**日志文件** RESPONSE block 取完整 JSON，比从 ANSI stdout 抠稳 |
| `/minimax:rescue` | 委派多步任务 | Agent dispatch | `--sandbox` flag；prompt 里提示可用 15 个 Claude Skills（`get_skill("pdf")` 等） |
| `/minimax:status` | 查后台任务 | 一致 | 改 job 目录名常量 |
| `/minimax:result` | 拉后台任务结果 | 一致 | 结果从 job stdout.log + 日志文件双抽 |
| `/minimax:cancel` | 取消后台任务 | 一致 | SIGTERM + 清 sandbox workspace |
| `/minimax:adversarial-review` | 对抗性 review | prompt 重写 | 红蓝双视角；M2.7 中文直给，prompt 不迂回 |

### 6.2 命令差异详解

**`/minimax:setup`**（差异最大）：
- 推荐安装方式：
  1. `uv tool install --with socksio git+https://github.com/MiniMax-AI/Mini-Agent.git`（推荐，SOCKS 用户友好）
  2. `pipx install git+https://github.com/MiniMax-AI/Mini-Agent.git`（fallback）
  3. Skip
- 实现：
  1. `which mini-agent` 有 → 跳过安装提问
  2. 无 → 探测 `uv` / `pipx` 可用性 → AskUserQuestion 三选项
  3. 安装完成后**必做 PATH 复探测**（用绝对路径 `~/.local/bin/mini-agent`）
  4. config 不存在 → 下发 setup-config.sh 三件套（`curl -fsSL ...config-example.yaml` 等）
  5. `api_key` placeholder → AskUserQuestion 收集 key + api_base 区域 → writeMiniAgentApiKey
  6. ping 验证 → 输出完整状态
  7. `--enable-review-gate` / `--disable-review-gate` 写 `~/.claude/plugins/minimax/state.json`

**`/minimax:ask`**：
- `node ${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs ask "$ARGUMENTS"`
- Claude 呈现规则：原文转述 + 分歧点标注 + 不自动执行建议 + **M2.7 中文 prose 时不擅自翻译**

**`/minimax:review`**：
- Prompt 比 gemini 版更啰嗦强约束
- schema 文件 `plugins/minimax/schemas/review-output.schema.json`（独立副本，字节对齐 gemini 创建，通读校对）
- **从日志文件 RESPONSE block 取 JSON**，比 ANSI stdout 稳
- parse 失败 → 1 次强化 retry → 再失败原文 + 告警

**`/minimax:rescue`**：
- 分发到 minimax-agent subagent
- `--sandbox` flag → workspace 隔离
- prompt 默认附一段"你有以下 15 个 Skills 可用：xlsx / pdf / pptx / docx / ... 通过 `get_skill(<name>)` 加载"
- `task-resume-candidate` 查 `~/.mini-agent/log/` 最近文件（v0.1 只列不实际 resume，因为 Mini-Agent 无外部 session_id）

**`/minimax:status` / `result` / `cancel`**：
- 走 `job-control.mjs`，与 LLM 无关
- `result` 做日志文件二次解析拿结构化结果

**`/minimax:adversarial-review`**：
- `prompts/adversarial-review.md` 重写；红蓝双视角

### 6.3 Agent：`minimax-agent.md`

完全复刻 gemini-agent / kimi-agent 的"薄转发器"契约，只改：
- `name: minimax-agent`
- `description`：**"agentic coding delegate with native file+bash+skills+MCP tools"**（明确区隔 kimi-agent 的 "long-context Chinese reasoning" 和 gemini-agent 的 "large-file / 1M window analysis"）
- `skills:` 改 `minimax-cli-runtime` + `minimax-prompting`
- Bash 命令 `minimax-companion.mjs`
- Routing flags 表不变

**护栏保留**："Do NOT solve problems yourself / No independent work / Return stdout exactly"

### 6.4 Skills

**`minimax-cli-runtime`**：
- `minimax-companion.mjs` 子命令约定 + `--json` 输出契约
- Mini-Agent 调用事实表（从 Phase 0 probe 结论填）：
  - `--task` / `-w` 使用规则
  - exit code 恒 0 的成败判定 sentinel 集合
  - `Log file:` 行的 regex
  - 日志 RESPONSE block 结构
  - YAML 写入 contract（仅 setup 触发、带锁）
- 去掉 gemini/kimi 特有 `--approval-mode` 段
- 加一段：**Mini-Agent 无结构化事件流，streaming UX 是 stdout 透传**
- 加一段：**冷启动 3-5s**，建议长任务走 `--background`

**`minimax-prompting`**：
- 保留通用原则（task framing / context blocks / output contract）
- references/ 下 3 个 md：
  - `minimax-prompt-recipes.md`：中文任务、代码审阅、多步骤 agent 任务、Skills 调度（`get_skill("pdf")` 等）
  - `minimax-prompt-antipatterns.md`：M2.7 易翻车的 prompt（v0.1 放框架，Phase 2-4 实测后补）
  - `prompt-blocks.md`：可复用块（tool use 引导、workspace 约束声明）

**`minimax-result-handling`**：
- 比 kimi 版多两条：
  - M2.7 中文 prose 输出概率更高，Claude 呈现时保持原文，不自作主张翻译
  - 冷启动延迟的 UX 契约：不为用户解释"为什么慢"
- 新增"**可疑 bash 拦截兜底**"条款（gemini 二轮补充 §4.6 降级后的兜底）：
  - Mini-Agent 的 bash 工具无真实沙箱，`--sandbox` 只是 isolated workdir
  - Claude 呈现 `/minimax:rescue` 结果时，若 `toolCalls[]` 含可疑 bash（正则匹配 `rm\s+-rf\s+/` / `> /dev/` / `curl .* | sh` / `sudo` 等）→ **强制向用户显式展示该 tool_use 并请求确认**，不自动静默转述
  - 该拦截是最后一道防线；不替代用户自身的 workspace 选择决策
- 其它规则照抄（分歧标注 / 不自动执行）

### 6.5 Hooks

- `hooks/hooks.json` 注册 `SessionEnd` + `Stop`
- `session-lifecycle-hook.mjs`：注入 `MINIMAX_COMPANION_SESSION_ID`
- `stop-review-gate-hook.mjs`：改 state 路径；引用 `prompts/stop-review-gate.md`；默认 disabled，`setup --enable-review-gate` 开

### 6.6 Prompts

- `prompts/stop-review-gate.md`：重写，体现 M2.7 的审查风格
- `prompts/adversarial-review.md`：重写，红蓝双视角中文直给

---

## 7. Phase 0 Probes

每项生 `doc/probe/NN-*.md`，probe 不过不进 Phase 1。

| # | 题目 | 触发自 | 关键问 |
|---|---|---|---|
| **P0.1** | `--task` 一次性模式的稳定性 | §6.1 / §3.3 | 多次调用都自然退出？`Log file:` 行必出、出现在 stdout 前 30 行？冷启动 p50/p95？ |
| **P0.2** | 日志文件 REQUEST/RESPONSE 块结构 | §3.5 | 分隔符稳定？RESPONSE JSON 是 Anthropic message 格式？"最后一个 RESPONSE = 最终结果"假设成立？tool_use 结构？ |
| **P0.3** | 日志文件写入时机 | §1.3 / v0.2 实时流备案 | **增量 flush** 还是**结束才 flush**？`fs.watch` 能看到 block-by-block 追加？ |
| **P0.4** | 大 prompt 传递 | §3.1 | `mini-agent -t "<20KB>"` argv 过长？有 stdin 替代？需要 tmpfile？ |
| **P0.5** | 失败模式 sentinel 稳定性 | §4.1 | 401/invalid-model/bad-cwd/SIGTERM 四种失败下 `❌` / `Retry failed` / `Session Statistics` 出现规律 |
| **P0.6** | YAML 并发写竞态 | §4.2 | 两个 setup 同时写 `api_key`，带锁/不带锁各 10 次，确认锁生效、YAML 不损坏 |
| **P0.7** | workspace-local config 覆盖 | §3.7 / v0.2 per-command 切模型备案 | `<workspace>/mini_agent/config/config.yaml` 能否被 `-w` 场景下优先读？ |
| **P0.8** | Anthropic 兼容端点 API key 格式 | §5.3 | MiniMax API key 是 `sk-...` 还是 JWT？写入前的格式校验规则 |
| **P0.9** | ~~env-auth 支持~~（**已完成，结论入正文**） | 3-way review | Mini-Agent 源码全局 0 次 `os.environ`；实证 `MINIMAX_API_KEY=xxx` 不起作用；**无 env 捷径**。Q2 必须走 YAML 路线；§3.4 fail-closed 硬化 + §4.2 stale-lock 回收兜底 |
| **P0.10** | 并发 spawn 下日志文件归属 | §3.3 / codex 独有 | 同秒内两次 spawn 会不会产生同名 log（秒级 timestamp）？spawn 前后 `ls ~/.mini-agent/log/` 快照 diff 是否能稳定识别新文件？ |
| **P0.11** | `mini-agent log <file>` 子命令行为 | §3.5 fallback 二次源 | 输出格式是否稳定？可否 pipe 解析？和我们自己读文件结果差异？ |
| **P0.12** | YAML 预校验 gate 的 anti-pattern 样本 | §3.4 | 收集 5+ 个"应该 fail-closed"的真实/构造 config.yaml（多行字符串 api_key / 流式 / 重复键 / 注释伪造），确认 gate 全部拒写 |

**硬门**（codex 二轮升级为三档）：
- **绝对硬门**：**P0.1、P0.2 任一不通**，停下告警用户，不硬上 Phase 1。P0.2 特别要验：多轮 tool_use / retry / SIGTERM 场景下"终态 RESPONSE 选择规则"真能拿到预期结果（§3.5）
- **条件硬门**：**P0.10**（并发 spawn 下日志归属）若不通 → 必须在 §3.3 和 `job-control.mjs` 里**禁用 snapshot-diff fallback**，高并发场景不保归属稳定性；v0.1 改为"串行化 job 调度"（一次只允许一个 mini-agent 在跑，多个 `/minimax:rescue --background` 排队），直到 v0.2 引入上游 job-id 注入
- **软门**：P0.3 / P0.7 / P0.11 不通 → 明确 v0.2 不做对应扩展，不阻挡 v0.1

**非 probe 但 Phase 0 一起做**：
- 读 `gemini-plugin-cc/plugins/gemini/scripts/lib/*.mjs` 7 个文件，P2 通读后手写到 minimax
- Q1–Q6 六个决策定稿到本 spec 附录 B 作"决策留痕"

---

## 8. 测试、Rollout、lessons.md

### 8.1 T-checklist（在 kimi T1–T9 基础上加 minimax 独有 T10–T13）

| # | 动作 | 通过标准 | v0.1 硬门 |
|---|---|---|---|
| T1 | `setup --json` 对已配置机器 | `{installed, authenticated, apiKey(masked), model, apiBase}` 齐全 | ✅ |
| T2 | `ask --json "hello"` | 非空 response；stdout 带彩字透传 | ✅ |
| T3 | `ask "讲个笑话"` 用户视角 | 实时进度字（非只等 3-5s 黑屏） | ✅ |
| T4 | ~~session-id~~ | v0.1 不做，跳过 | ❌ |
| T5 | `review` 对 3–5 行 diff | schema 齐全 verdict/findings/next_steps；retry 路径可选 | ✅ |
| T6 | `rescue --background` → `status` → `result` | 状态流转正确；日志二次解析结构化 | ✅ |
| T7 | `rescue --resume-last` | v0.1 不做，跳过 | ❌ |
| T8 | 干净环境 setup | 引导安装 + 下发 config + AskUserQuestion 拿 key 全流程通 | ✅ |
| T9 | `adversarial-review` | 红蓝两视角均产出 findings | ✅ |
| **T10** | 假 key 跑 ask | companion 识别为 `auth-failure`，不误报 success | ✅ |
| **T11** | `rescue --sandbox "rm -rf /"` | sandbox 目录被动到；主项目无改动 | ✅ |
| **T12** | setup 跑三次用不同 key | 最后一次 key 生效；其他字段完全保留 | ✅ |
| **T13** | SOCKS 环境干净 install | 安装命令自动加 `--with socksio`；version 通过 | ✅ |

### 8.2 Rollout 阶段

| Phase | 交付物 | 过 T |
|---|---|---|
| **Phase 0** | 8 个 probe 报告 → `minimax-cli-runtime` skill v0.1 落地 | — |
| **Phase 1** | 目录骨架 + 7 个近复制 lib + `minimax.mjs` (YAML/auth/availability) + `/minimax:setup` + `minimax-prompting` 骨架 | T1、T8、T12、T13 |
| **Phase 2** | `/minimax:ask` + stdout 透传 + 日志解析 + `minimax-result-handling` 初稿 | T2、T3、T10 |
| **Phase 3** | `/minimax:review` + schema + 1-shot JSON retry | T5 |
| **Phase 4** | `/minimax:rescue` + `--sandbox` + `job-control` + `minimax-agent.md` + 两个 hook | T6、T11 |
| **Phase 5** | `/minimax:adversarial-review` + 3 skill 打磨 + lessons.md 收尾 | T9 |

每 Phase 结束提 CHANGELOG.md + 跑对应 T。全部硬门 T 通过 → 打 v0.1.0 tag。

### 8.3 `lessons.md` 骨架

```markdown
# Lessons: gemini/kimi → minimax 手工迁移

## A. 命名替换规则表（见 spec §2.4）
## B. 必须重写的 9 项（不要抄）
## C. 可以几乎纯复制的 8 项
## D. 本次踩的坑（滚更）
### minimax 坑 1: exit code 恒 0，必须解析 stdout/日志判定成败
### minimax 坑 2: 模型切换只能改 YAML（Mini-Agent 无 `-m` 参数）
### minimax 坑 3: SOCKS 代理要 `uv tool install --with socksio`
### minimax 坑 4: Mini-Agent 有独立日志文件，结构化提取走这条比 stdout 稳
### minimax 坑 5: workspace 带 bash + file-write，安全面比 kimi 大，要区分 --sandbox
### minimax 坑 6: YAML 写入违反"不写 ~/.<tool>/"原则，此例外需显式登记
### minimax 坑 7: 冷启动 3-5s Python，要在 UX 层显式契约

## E. CLI 集成层前置调研清单（在 kimi 基础上加 minimax 发现）
- [ ] Exit code 是否区分成败？（gemini/kimi: yes; minimax: no）  ← **新增**
- [ ] **env 变量是否支持作 api_key 源？grep 源码 os.environ 全局一遍** ← **minimax 血教训**
- [ ] 模型切换：CLI 参数 vs 配置文件？  ← **新增**
- [ ] 是否有独立日志文件？结构化程度？文件名是否含时间戳？并发场景如何归属？  ← **新增**
- [ ] 官方是否暴露日志读取子命令作 fallback？  ← **新增**
- [ ] CLI 启动耗时？（影响 UX 契约）  ← **新增**
- [ ] 宿主语言依赖管理（Python uv/pipx，Node nvm，Go binary）——影响 setup 引导与 PATH 处理  ← **新增（gemini）**
- [ ] 代理环境兼容性？（SOCKS/HTTP_PROXY/系统代理；是否需要 extras 如 httpx[socks]）  ← **新增**
- [ ] 工具集：是否自带文件写/bash？（影响 workspace 策略 + 安全语义）  ← **新增**
- [ ] `--sandbox`/`-w` 是否是真隔离还是只换 cwd？有逃逸面吗？  ← **新增**
- [ ] 配置文件是否可 per-workspace 覆盖？  ← **新增**
- [ ] 源码里有哪些**字面常量错误消息**可以当 sentinel？（稳定性远高于运行时观察）  ← **新增**
- （原 kimi 清单 9 条全保留）

## F. LLM 行为层前置调研清单（继承 kimi，加 minimax 发现）
- [ ] M2.7 中文 prose 表达直白度（kimi 同维度，minimax 更甚）  ← **新增**
- [ ] Anthropic 兼容 API 的 tool_use 事件结构是否和原生 Anthropic 一致  ← **新增**
- （原 kimi 清单 7 条全保留）

## G. 决策分歧记录（本 spec Q1–Q6 + 3-way review 留痕）
```

### 8.4 CHANGELOG.md 规约

仓库根维护，reverse-chrono flat。每次 AI 写代码前读、写完追加。v0.1 第一条由本 spec 落盘触发。

**条目格式**：
```markdown
## YYYY-MM-DD HH:MM [author]
- **status**: draft | in-progress | done | handed-off-to-<X> | blocked
- **scope**: <files/areas touched>
- **summary**: <what changed and why>
- **next**: <what the next author should pick up>（可选）
```

**协作规则**（照 kimi §6.3 + plan review gemini 补充）：
1. 写前先读 CHANGELOG 最后 5 条；若最新条目 `status: in-progress` 且 author 不是自己 → 不动手，问用户
2. `handed-off-to-<X>` 是显式交棒信号
3. `blocked` 状态要附 `next` 说清楚卡在哪
4. **硬门失败契约**（plan review gemini blocker 响应）：Phase 0 任一**绝对硬门**（P0.1 / P0.2）或**条件硬门**（P0.10）失败时，executor 必须**立即**追加一条 CHANGELOG：
   ```markdown
   ## YYYY-MM-DD HH:MM [author]
   - **status**: blocked
   - **scope**: Phase 0 / probe <Pn.m>
   - **summary**: Hard gate <Pn.m> failed. Reason: <具体失败观察>. Probe report at doc/probe/<nn>-<name>.md.
   - **next**: <给用户的具体建议：Mini-Agent 升级 / 改用 v0.2 方案 / 调整 spec />
   ```
   不允许"静默停下"——下一个 AI/人接手时必须能从 CHANGELOG 最新条目立刻看到卡点
5. **Probe 批量条目约定**：Phase 0 的 12 个 probe 跑完后在 P0.13（SKILL consolidation）时统一写一条 CHANGELOG；**但若中途硬门失败则立即单独写 blocked**，不合并
6. v0.1 不做锁 / 回滚共识

### 8.5 非目标

**推 v0.2+**：
- mmx-cli 多模态命令（image/video/speech/music/vision/search）
- M2.7 直连 HTTPS fast path（附录 C 路径 3 的轻量版；gemini 建议的"第四条路线"）
- 续跑（T4/T7）—— 需 Mini-Agent 暴露外部 session id
- 实时事件流 UX（依赖 P0.3）
- per-command 切模型（依赖 P0.7）
- **"第五条路径" per-job 局部 config.yaml 替代全局 YAML 写入**（gemini 二轮提议）：P0.7 通过后，可为每个 job 在其 workspace 生成局部 `mini_agent/config/config.yaml`，彻底不改全局 `~/.mini-agent/config/config.yaml`，避免 §3.4 YAML 写入的整条风险链。v0.1 不做是因为依赖未验证的 P0.7 行为
- ACP 协议集成（`mini-agent-acp`，Zed 用）
- Engram sidecar
- 自适应多次重试 / schema-driven 字段补全（sentinel 稳定性由源码常量保证，暂不做）
- OS-level sandbox/container 真隔离（`--sandbox` 当前只是 isolated workdir）

**永久不做**（gemini review 采纳）：
- CHANGELOG 并发锁 / 回滚共识（单人本地开发伪需求）
- 替 Mini-Agent 维护 session id 映射（需上游支持；上游不给永远不做）

---

## 附录 A：Q1–Q6 决策留痕

brainstorming 阶段六个关键决策及其权衡：

**Q1 范围**：选 A = full-parity 8 命令，只包 Mini-Agent。
- 拒 B（+多模态）：独立方向，v0.2 单独 track
- 拒 C（MVP 3 命令）：和 kimi 定位不符
- 拒 D（+M2.7 直连 fast path）：背三张皮

**Q2 API key 配置**：选 B = AskUserQuestion 写 YAML。
- 拒 A（全托原生）：Mini-Agent 无交互式 login，用户体验差
- 拒 C（env 优先）：每次 spawn 覆写 YAML，并发写风险
- 拒 D（混合）：复杂度不值得
- **代价**：违反 kimi "不写 ~/.<tool>/" 原则，需显式登记例外

**Q3 模型切换**：选 D = v0.1 全局固定 + P0.7 probe 作 v0.2 路径。
- 拒 A（单一模型）：没留升级路径
- 拒 B（命令级默认 + flag）：并发写 YAML 风险叠加
- 拒 C（workspace-local config）：未验证路径不入 v0.1

**Q4 结构化数据源**：选 C = stdout 透传 + 日志文件后解析。
- 拒 A（纯 stdout）：忽略 Mini-Agent 独有利好
- 拒 B（纯日志）：无流式 UX，用户盯空屏
- 拒 D（实时 tail）：依赖 P0.3，未验证不入 v0.1

**Q5 非核心组件**：选 A = agent + 两个 hook 全保留。
- 拒 B/C/D（逐步减）：full-parity 定义就是照搬；agent 是 minimax 独特卖点（skills+MCP+bash）

**Q6 rescue workspace**：选 C = 默认主 cwd + `--sandbox` flag。
- 拒 A（总是主 cwd）：Mini-Agent 有 bash+file-write，risk surface 大
- 拒 B（总是 sandbox）：默认不能改代码没产品价值
- 拒 D（prompt 约束只读）：模型决策不能当安全边界

---

## 附录 B：3-way Review 留痕

本 spec v0.1 草稿后由 Claude Code（Opus 4.7）并行发起 codex:codex-rescue 和 gemini:gemini-agent 审读。review 反馈分类整合如下：

### 从 codex（技术风险视角）——全部采纳

- **§3.3 child-process 生命周期**：由"仅等 exit"改为"分离 error/exit/close + 以 close 为完成点 + stderr 全量 drain + timeout 清理"
- **§3.5 最后 RESPONSE 假设**：改为"遍历找最后一个可解析且有终态（stop_reason 或非空 text）的 block"，**升为 P0 硬门**
- **§4.6 --sandbox 文案降级**：从"隔离"降级为"isolated workdir / 减少误操作概率，不是安全边界"；T11 验收标准修正为"主项目 mtime 未被默认操作动过"
- **§3.4 YAML 写入原子性**：tmpfile 必须**同目录**；`fsync` 文件 + 父目录后再 rename
- **§4.2 锁崩溃恢复**：锁文件写 `{pid, mtime}`；获取锁时 `kill -0` 校验存活 + mtime 超时 60s
- **§5.3 API key 脱敏纪律**：写完擦内存；禁入 argv/state/meta/CHANGELOG/probe；错误消息先 redaction
- **§4.1 sentinel 三层优先级**：源码常量 > 日志结构 > stdout sentinel（strip ANSI 后匹配）
- **Phase 0 probe 新增**：P0.9（env-auth，已完成）、P0.10（并发日志归属）、P0.11（`mini-agent log <file>` fallback）、P0.12（YAML anti-pattern 样本）
- **日志归属防串 run**：spawn 前后 `ls` 快照 diff 找新文件；meta.json 记路径

### 从 gemini（战略 / 范围视角）——部分采纳 + 部分论证拒绝

**采纳**：
- **§3.0 新增数据源优先级契约**：log file > stderr > stdout；把脆弱面从判定层移到 UX 层
- **§5.3 MINIMAX_TEST_API_KEY env 嗅探**：CI/自动化测试绕 AskUserQuestion
- **§4.5 错误呈现诊断包**：log parse 失败时合并 stderrTail + logTail + logPath 给 Claude，`minimax-result-handling` skill 规定呈现格式
- **§8.3 lessons.md 新增维度**：宿主语言依赖管理 / env 变量前置调研 / 源码常量 sentinel 探索
- **§8.5 非目标清单修正**：`CHANGELOG 并发锁` 从"v0.2+"改为"永久不做"（单人本地开发伪需求）
- **Q2 决策守 B 但加硬化**：env-auth probe 结论堵死了 env 路径；守 B + 预校验 gate + fail-closed 退人工的组合吸收了 YAML 写入的主要风险

**论证拒绝**：
- **gemini "推翻 Q2 选 B"**：env-auth probe 后发现无 env 路径，且 §3.4 硬化后（预校验 gate + fsync + stale-lock）风险可控。YAML 写是 MiniMax agent 产品的唯一鉴权面，保留 B 是体验的底线
- **gemini "v0.1 砍到 MVP 4 命令"**：与 Q5 保留 agent + hooks 全组件的决策耦合。如果砍 rescue，等于丢掉 Mini-Agent 的 Skills/MCP/bash 独占价值——这些是选 Mini-Agent（而非薄 HTTPS wrapper）的**唯一 ROI**。讨论后确认 v0.1 维持 full-parity，但 Phase 0/1/2 的硬门足够密，爆雷面已显著收窄
- **gemini "第四条路线薄 HTTPS wrapper"**：写入附录 C，作为 v0.2 的显式备选路径。v0.1 不启动是因为会丢 rescue 的差异化
- **gemini "自适应多次重试回到 v0.1"**：部分采纳为"错误呈现诊断包"（§4.5）；自适应多次重试 v0.1 仍不做（sentinel 稳定性由源码常量保证，不必靠多次 retry 兜）

### env-auth Probe 结果留痕（副产物）

- `grep -R 'os\.environ|getenv' /Users/bing/.local/share/uv/tools/mini-agent/lib/python*/site-packages/mini_agent/` → **0 matches**
- 实证 `MINIMAX_API_KEY=env-test mini-agent --version` → 正常输出（env 未被读取）
- `config.py:107-124` 明示：`api_key` 是 YAML 必需字段，无 env 回退；placeholder/空 → 抛 `ValueError("Please configure a valid API Key")`
- 结论：**无 env 捷径**。Q2 决策方向锁定"守 B + 硬化"

### 第二轮 review（spec v2 → v3）

v1→v2 整合后再次并行发起 codex + gemini 审读。

**codex 第二轮**：5 条 v1 must-fix → ✅×4 ⚠️×1；新发现 2 高 3 中风险；结论 "先 revise 4 项再进"。全部采纳：

- **§3.4 预校验 gate 扩面**（高）：gate 检查"匹配行**自身**"的 block-scalar (`|` `>` 等)、流式标记、anchor/alias (`&` `*`)、tag (`!`)、BOM、dup-key；不只看"下一行"
- **§4.5 诊断包去硬截**（高）：原 `logTail: 2KB` 改为 `lastCompleteResponseBlock (完整 JSON) + lastPartialResponseRaw (部分原文) + stderrHeadTail (首 256 + 末 2048)`；容量决策交 skill 呈现层
- **§3.5 fallback 异常隔离**（中）：`mini-agent log <file>` fallback 失败只记录、不传染主路径；主路径必须在无 fallback 时也能返回结果
- **§7 P0.10 升条件硬门**（中）：P0.10 不通 → 禁 snapshot-diff fallback + v0.1 改串行化 job 调度

**codex 未列为 must-fix 的 ⚠️（已登记，defer 到 Phase 1 编码时再评估）**：
- stale-lock 的 PID 复用误判 / mtime 60s 阈值（活锁边界仍可能误回收）——v0.1 先用当前方案，压测中若出现假阳性再扩

**gemini 第二轮**：**Approved to proceed，无 blocker**。战略整改全部认可。补充点：

- **采纳（次要）**：§6.4 `minimax-result-handling` skill 增加"可疑 bash 拦截兜底"条款——`--sandbox` 不是真隔离，Claude 呈现 rescue 结果时对 `rm -rf /` / `curl | sh` / `sudo` 等命令强制显式确认
- **采纳（非 blocker）**：§8.5 新增"第五条路径 per-job 局部 config.yaml"作 P0.7 通过后的 v0.2 优选路径，彻底绕开 §3.4 YAML 写入风险链
- **明示认可**：Q2 守 B + P0 硬门的组合是"别无选择下已做到及格"；附录 C 三路径比较清晰；Fail-Fast 防御姿态"极度理智"；§4.5 诊断包架构"高明"（容错负担转移到 LLM 层符合 Agentic 趋势）

### 第二轮拒绝采纳

无。所有第二轮反馈（codex 4 项 must-fix + gemini 2 项补充 + 1 项 v0.2 备选）全部吸收。

### 第四轮 · Phase 0 probe 实测回炉（spec v4 → v5）

Phase 0 跑完 13 个 probe（`doc/probe/01` 至 `12-*.md` + P0.9 文档化）后，以下**新事实**强制修改 spec：

**P0.2（RESPONSE block 结构）→ §3.5 重写**：
- Mini-Agent 日志用 **OpenAI 兼容的规范化响应**（非 Anthropic 原始 JSON）
- 字段名：`stop_reason` → **`finish_reason`**（值域：`stop` / `length` / `tool_calls` / `tool_use` / `content_filter`）
- 字段类型：`content[]` 数组 → **`content` 字符串**（assistant text reply）；`tool_calls` 是顶层姐妹字段（数组，OpenAI 格式 `[{id, name, arguments}]`，注意是 `arguments` 而非 `input`）
- Block kind 多了第三种 **`TOOL_RESULT`**；log_index 跨 REQUEST/RESPONSE/TOOL_RESULT 连续递增，不能假设奇偶性
- Separator：文件 header `=` × 80 / block 分隔 `-` × 80，parser 必须区分（不能用 `^[=-]{80}$`）
- 401/SIGTERM：Mini-Agent 源码 `agent.py:371` 会跳过 `log_response()`，所以这些场景无 RESPONSE block —— **预期行为**，parser 的 "no-response-block" 路径已覆盖

**P0.3（日志 flush 时机）→ §1.3 非目标**：实时事件流 UX 从"依赖 P0.3 备案" → **永久关门**。日志一次性写入（非增量 flush），`fs.watch` 实时订阅无效。

**P0.4（大 prompt 传递）→ §3.1 确认**：argv 可达 210KB+（macOS ARG_MAX 1MB）；stdin 不支持（pipe 会进交互模式）。v0.1 `callMiniAgent` **直接 argv 传**，不做 tmpfile 备选。

**P0.5（sentinel × locale 矩阵）→ §4.1 补强**：Layer 1 常量（fake key 场景下不触发 `Please configure...`——实际只在 placeholder/空/SOCKS 下命中）；Layer 3 ASCII 硬编码 sentinel 跨 4 locale 完全稳定，**invalid_model 无有效 key 时与 invalid_key 行为一致**（需有效 key 环境才能区分，spec 注明不做）。

**P0.6（YAML 并发写）→ §4.2 确认**：无锁 20 并发在 macOS APFS 下**偶然未损坏**（单写原子副作用），但竞态窗口确认存在；`withLockAsync` 必要性确认。

**P0.7（workspace-local config）→ §8.5 非目标**：`--workspace` 不改 Mini-Agent 的 config 搜索路径；只有 `cd` 进 workspace 才读 `<cwd>/mini_agent/config/config.yaml`。"第五路径"（per-job 局部 config）复杂度上修，v0.2 要么等上游改 `find_config_file` 接受 workspace 注入，要么用 cd-into-workspace workaround。

**P0.8（API key 格式）→ §3.4.3 规则确认**：Mini-Agent 对 key 零格式校验（只拒 `YOUR_API_KEY_HERE`）；Bearer opaque string。v0.1 `validateKeyContent` 用极宽松 regex `^[A-Za-z0-9_\-\.+/=]{20,}$` 或仅检查长度+控制字符（当前 plan 是后者，OK）。

**P0.10（并发 spawn 日志归属）→ §4.6 Phase 4 串行化硬约束**：条件硬门 **FAIL**。秒级 timestamp 下并发会同名；3 轮 × 3 并发 = 9/9 `diff` 到同一个文件（假阳性）。CHANGELOG warning 条目已留痕；Phase 4 `job-control.mjs` **必须串行化**，v0.2 等上游支持。

**P0.11（`mini-agent log <file>` 子命令）→ §3.5 fallback 契约**：官方输出与 `cat` 原文件基本相同（仅头尾 ANSI 装饰），**直接读原日志文件更简单**——Phase 1 Task 1.9a 的 fallback 可省（或仅作 defensive，不是主路径依赖）。

**P0.12（YAML anti-pattern fixtures）→ §3.4.2 gate 测试验证集**：6 reject fixtures + 1 control (`upstream-placeholder.yaml`) 已建，Task 1.7 单元测试须跑通。特别确认 `duplicate-key` 在 raw-text 层检测（safe_load 静默取后者）。

**P0.13 consolidation 待做**：SKILL.md 汇总以上 probe 结论后进入 Phase 1。

### 第三轮 · plan review 反向回炉 spec（v3 → v4）

基于 v3 spec 写出 Phase 0+1 plan 后，codex 和 gemini 对 plan 做了 review。虽然 review 目标是 plan，但几条 CRITICAL 反映 **spec 自身的算法表述精度不足**，必须回炉修 spec 而非单纯补 plan：

**从 codex plan review（CRITICAL 级，回炉到 spec §3.4 / §3.5 / §3.6）**：
- **§3.4 预校验 gate 重写 v3**：原 v2 的 `trimmedValue.includes("\n")` 无效判断、"下一行缩进续行"判定不严，可能放过合法 YAML 的 multi-line plain scalar。v3 改为严格 YAML 1.2.2 术语，只接受 **Form D（single-line double-quoted）** 和 **Form S（single-line single-quoted）** 两种形态——**强制拒绝 plain scalar**（即便单行），因为无法可靠区分是否续行。escape 规则补齐控制字符 / 代理对 / 长度限制。
- **§3.5 日志分块算法重写 v3**：原 v2 按 `^-{80}$` split 后 `[N] RESPONSE` header 和 JSON body 会落到不同 part，规则根本不工作。v3 改为**线性扫描状态机**，显式 SEEK_HEADER / SKIP_TO_BODY / COLLECT_BODY 三态 + balanced-brace 扫 JSON body（含字符串内 `{`/`}` 跳过）。
- **§3.6 认证 async + 硬超时**：原 v2 的 `runCommand(...) timeout: 30_000` 依赖 `spawnSync.timeout`，无法保证子进程吞 SIGTERM 时强制退出。v3 改为 async `spawn` + `setTimeout → SIGTERM → setTimeout → SIGKILL → 强制 resolve` 三段式，抽出 `spawnWithHardTimeout` 辅助函数；v0.1 禁用 `spawnSync` 在 companion 路径。

**从 gemini plan review（blocker 级，回炉到 spec §8.4）**：
- **§8.4 CHANGELOG 硬门失败契约**：原 v2 只规约正常 hand-off，没说硬门失败怎么写。v3 新增"任一硬门失败 → 立即追加 `status: blocked` 条目"，不允许静默停下；probe 批量条目在 P0.13 合并，但硬门失败独立发条目不合并。

**从 gemini plan review（未回炉 spec，属于 plan 层问题，将在下一版 plan 修）**：
- T12 / P0.6 写用户真实 `~/.mini-agent/config/config.yaml`：需改为 `MINI_AGENT_CONFIG_PATH` env 注入到 `/tmp/mock-config.yaml`；`MINI_AGENT_CONFIG_PATH` 常量应改为 `process.env.MINI_AGENT_CONFIG_PATH || defaultPath`（属于 implementation detail，此 patch 在 spec 的 Task 1.6 不动但提醒写 plan 时处理）
- T1.9 漏 fallback：plan 层面的 code omission，下一版 plan 补
- T1.11 缺 `write-key` 子命令：下一版 plan 补

**从 codex plan review（未回炉 spec，属于 plan 层）**：
- P0.1 `$?` 拿 head exit code：plan step 脚本修正
- P0.5 实跑 4+2+1+1 < 矩阵：plan 里下修声明或补齐矩阵
- P0.8 浏览器步骤：plan 里改为 source-based 或明确标记"人工 probe"
- `acquireLock` EEXIST 无重试 / 锁方案分叉：plan 里统一到 `state.mjs::withLock`
- T8/T13 mock 不是真验收：plan 里降级 / 或推到 Phase 2 真验收

**决策**：本 spec 升为 v4（算法层精度修正）。Plan 回炉重写时把上述"未回炉 spec"的 11 条 plan 层问题一次性修，然后**再做一轮 plan review** 确认。

---

## 附录 C：MiniMax 产品线与选型

调研期间识别的三条路径（详见 engram 调研记录）：

1. **Mini-Agent**（github.com/MiniMax-AI/Mini-Agent）—— **本 spec 选用**
   - 定位：production-grade agent demo，含 file/bash/Skills/MCP/note 工具
   - 形态：Python CLI，`uv tool install`，`mini-agent -t "<prompt>" -w <cwd>`
   - 许可：MIT，2.5k star，维护中
   - 适合：作为 Claude Code 编码子 agent

2. **MMX-CLI**（github.com/MiniMax-AI/cli, npm `mmx-cli`）—— **v0.2 独立 track**
   - 定位：多模态生成 CLI（text/image/video/speech/music/vision/search）
   - 形态：Node CLI，`mmx image "A cat"` / `mmx speech synthesize ...`
   - 适合：扩展 Claude Code 的多模态能力（gemini/kimi 插件没有）

3. **M2.7 API 直连**（api.minimax.io/anthropic）—— **v0.2 fast path**
   - 定位：Anthropic 兼容 HTTPS 端点
   - 形态：改 `~/.claude/settings.json::ANTHROPIC_BASE_URL`
   - 适合：整个 Claude Code 后端替换为 MiniMax；或作为轻任务 fast path

---

## 附录 D：参考

- `gemini-plugin-cc` 仓库：`/Users/bing/-Code-/gemini-plugin-cc/`（v0.5.2，完整实装）
- `kimi-plugin-cc` 仓库：`/Users/bing/-Code-/kimi-plugin-cc/`（spec 已定 plan 未执行）
- Mini-Agent 源码：https://github.com/MiniMax-AI/Mini-Agent
- MiniMax-M2.7 模型：https://github.com/MiniMax-AI/MiniMax-M2
- MiniMax CLI（mmx）：https://github.com/MiniMax-AI/cli
- MiniMax Anthropic 兼容 API 接入：https://platform.minimax.io/docs/guides/text-ai-coding-tools
