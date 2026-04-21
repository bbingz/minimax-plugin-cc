# Lessons: gemini/kimi → minimax 手工迁移

本文档记录 minimax-plugin-cc v0.1 全程（Phase 0-5）从 sibling plugin（gemini-plugin-cc / kimi-plugin-cc）派生的真实经验。

## §A 命名替换规则表（spec §2.4）

| sibling | minimax | 备注 |
|---|---|---|
| `gemini` / `kimi` （目录、命名空间） | `minimax` | 全部 commands / agents / skills / hooks |
| `Gemini CLI` / `Kimi CLI` | `Mini-Agent` | 二进制名 |
| `~/.gemini/` / `~/.kimi/` | `~/.mini-agent/` | 用户配置目录 |
| `gemini-companion.mjs` / `kimi-companion.mjs` | `minimax-companion.mjs` | companion 入口 |
| `GEMINI_COMPANION_*` / `KIMI_COMPANION_*` env 前缀 | `MINIMAX_COMPANION_*` | env 命名空间 |
| `--approval-mode` (gemini) | （删除） | Mini-Agent 无此概念 |
| `MAX_CONTEXT_FOR_MODEL` 类硬编码 | （删除） | Mini-Agent 不暴露 token 上下文 |

## §B 必须重写的 9 项（不要抄）

1. **`minimax-cli-runtime/SKILL.md`** — gemini/kimi 的 SKILL 假设 CLI 暴露 `--approval-mode` / 结构化事件流；Mini-Agent 都没有，必须重写为 OpenAI-compat finish_reason 集合 + 日志文件 RESPONSE block 解析契约。
2. **`callMiniAgent` / `classifyMiniAgentResult`** — gemini/kimi 的 classifier 用 exit code 区分成败；Mini-Agent exit code 恒 0，必须改用三层 sentinel（源码常量 → 日志解析 → stdout 兜底）。
3. **`writeMiniAgentApiKey`** — Q2 决策：必须改 `~/.mini-agent/config/config.yaml::api_key`（违反 sibling "不写 ~/.<tool>/" 原则；显式登记例外）。yaml 写入需要 predicate gate（fail-closed 13 种 reason）+ atomic rename + fsync + directory lock。
4. **`/minimax:setup`** — sibling 用 native CLI login；minimax 必须三选一安装（uv/pipx/skip，含 `--with socksio`）+ AskUserQuestion 写 api_key + 首装下发 config 三件套。
5. **`prompts/review.md`** — M2.7 中文 prose 倾向重，prompt 需要显式声明 enum 保持英文；retry prompt 需要回灌前 1500 字脱敏原文（gemini/kimi 不需要）。
6. **`prompts/adversarial-review.md`** — gemini/kimi 是单 stance（红队），minimax 是双 stance（红+蓝独立 spawn）；prompt 改为 `{{STANCE_INSTRUCTION}}` 单 placeholder + 模块常量。
7. **`job-control.mjs`** — kimi 是并发 job；minimax 因 P0.10 失败必须串行（全局 directory-lock queue）。
8. **`session-lifecycle-hook.mjs`** — gemini 用 env file 协议；minimax dual-protocol（env file + JSON stdout 任一生效）。
9. **`stop-review-gate-hook.mjs`** — review timeout 改 600s（M2.7 冷启动 + 双 spawn 红蓝可能要 60s）。

## §C 可以几乎纯复制的 8 项

1. `args.mjs` — argv parser
2. `process.mjs` — `binaryAvailable` / `withTimeout` 等 lib
3. `withLockAsync` — directory-lock primitive（kimi 已成熟）
4. `redactSecrets` regex — sk- 和 eyJ- 格式（gemini 已覆盖 MiniMax 实测两种 key 形态）
5. `extractReviewJson` brace-balanced 扫描（kimi 验证过的算法）
6. `validateReviewOutput` 本地 draft 2020-12 子集 validator（kimi 设计）
7. `review-output.schema.json` 字节级 align（gemini 创建，通读校对后字节复制）
8. `minimax-agent.md` subagent thin-forwarder 契约（kimi/gemini 同结构，仅改三处：name / description / skills 列表 / Bash 命令名）

## §D 本次踩的坑

### 坑 1: exit code 恒 0，必须解析 stdout/日志判定成败
P0.5 实测：Mini-Agent 在 401/invalid-model/SIGTERM/bad-cwd 全部场景 exit 0（最后一种 exit 1）。classifier 必须三层 sentinel 兜底：
- L1 源码常量 sentinel（"Please configure a valid API Key" / "Configuration file not found" / "ImportError: Using SOCKS proxy"）
- L2 日志 RESPONSE block 解析（OpenAI-compat finish_reason）
- L3 stdout sentinel（"Retry failed" / "Session Statistics:" / "Log file:"）— ANSI strip 后匹配

### 坑 2: 模型切换只能改 YAML（Mini-Agent 无 `-m` 参数）
spec §3.1：v0.1 全局固定模型；用户手改 `~/.mini-agent/config/config.yaml::model`。v0.2 看 P0.7 workspace-local config 路径。

### 坑 3: SOCKS 代理要 `uv tool install --with socksio`
P0.5 sentinel：`"ImportError: Using SOCKS proxy"`。setup 命令必须自动加 extras。

### 坑 4: Mini-Agent 有独立日志文件，结构化提取走这条比 stdout 稳
P0.2：`~/.mini-agent/log/agent_run_YYYYMMDD_HHMMSS.log`，秒级 timestamp。3 种 block kind（REQUEST/RESPONSE/TOOL_RESULT），分隔符两种（文件 header `=`×80 / block 间 `-`×80）。终态选择规则：倒序遍历 RESPONSE blocks，选第一个 `finish_reason ∈ SUCCESS∪TRUNCATED∪INCOMPLETE` 的 block。

### 坑 5: workspace 带 bash + file-write，安全面比 kimi 大，要区分 --sandbox
spec §4.6：`--sandbox` = isolated workdir，**NOT 安全边界**。help / skill / CHANGELOG / 命令文件文字均不得使用"sandbox"暗示安全。Phase 4 T11 验证的是"主项目 mtime 不变"，不是"rm -rf 被拦"。

### 坑 6: YAML 写入违反"不写 ~/.<tool>/"原则，此例外需显式登记
spec §3.4：登记两个例外文件：`config/config.yaml::api_key`（atomic rename + fsync + 目录锁）和 `config/.lock`（lock file 本身）。其它字段（model / api_base / max_tokens 等）一律 read-only。

### 坑 7: 冷启动 3-5s Python，要在 UX 层显式契约
P0.1：p50 10543ms / p95 11466ms（含 401 retry 约 10-11s；真实 key 下 <3s）。companion 写 stdout `Starting MiniMax (cold start ~3s)...`；result-handling skill **禁止** Claude 解释"为什么慢"。

### 坑 8: classifier 必须同时认 OpenAI 和 Anthropic 的 finish_reason
Phase 2 smoke 中发现：MiniMax Coding-Plan 走 Anthropic 兼容端点，finish_reason 是 `end_turn`，不是 `stop`。classifier SUCCESS 集合扩为 `{stop, stop_sequence, end_turn}`；TRUNCATED 扩为 `{length, max_tokens}`；INCOMPLETE 扩为 `{tool_calls, tool_use, content_filter, function_call}`。

### 坑 9: P0.10 并发 spawn 下日志归属不可靠 → v0.1 强制串行
P0.10 实测：秒级 timestamp 精度下 3 轮 × 3 并发 spawn 全部产生同名日志文件。snapshot-diff 归属不工作。job-control 必须串行（全局 directory-lock queue），所有用户面 spawn（ask/review/rescue/adversarial-review）都走 `acquireQueueSlot`。v0.2 等 Mini-Agent 上游引入 job-id 注入。

### 坑 10: pid-reuse 导致 cancelJob 偶发误杀
Phase 4 review 提到的已知限制：cancelJob 用 `kill(pid, 0)` 检活，OS 级别 pid 复用窗口存在；v0.1 已知不修，文档登记。

### 坑 11: 单 prompt 同时要求红+蓝 findings → 模型偏向最后 stance
Phase 5 早期实验：单 spawn 让模型同时产 red+blue findings，60% 概率红队 findings 极稀疏；T9 抖动严重。改为双 spawn 架构（同 queue slot 内顺序跑），红蓝各自独立 1-shot retry 预算，T9 稳定。kimi-plugin-cc 通过单 stance 设计（仅红队）天然规避此坑；minimax 因双 stance 需求采用双 spawn。Phase 5 5-way review (Kimi I9) 进一步指出：中文 stance 措辞若过于"激将"（"击破"等情绪词），M2.7 可能产生过度对抗性幻觉；T9 smoke 后需观察红队 critical 比例，若 >70% 标 critical 则启动措辞降级预案（"击破" → "严格审视"）。

**坑 11 延伸（T9 smoke 实测，2026-04-21）**：T9 fixture（fetch-no-error-handling）红队产出 100% critical（2/2），触发 I9 观察阈值。但两个 finding 都是实质技术 bug（"network failure → TypeError crash" / "HTTP error → silent JSON"），confidence 0.95，有具体 line + 具体 recommendation，**不是**激将语言诱发的过度对抗性幻觉。结论：本次样本不触发措辞降级预案；样本量太小（n=2）不构成统计依据；保留 I9 监测，多 fixture 样本积累后再判（详见 `doc/smoke/phase-5-T9.md`）。

### 坑 12: skill SKILL.md 不应放历史流水帐
Phase 5 5-way review (Gemini C7)：原计划在 `minimax-cli-runtime/SKILL.md` 末尾追加 "Phase 4-5 deltas" 段，被 review 否决。SKILL.md 是 LLM 上下文消费品，每次 spawn 都加载到 prompt 里，加历史段是无谓 token 浪费。规则：SKILL.md 只描述当前事实契约；版本演进史和阶段交付清单写在 CHANGELOG.md / lessons.md。

### Phase 4-5 实现要点（合并自原 cli-runtime deltas，C7 后并入此处）

- **All spawn paths route through queue**：`acquireQueueSlot(workspaceRoot)` + `releaseQueueSlot(...)`，`/minimax:ask` / `review` / `rescue` / `adversarial-review` 全走。Queue 是 `~/.claude/plugins/minimax/jobs/.queue-lock/` 全局目录锁（P0.10 mandate）。
- **`/minimax:rescue --background`** 写 `jobs/<jobId>/{meta.json, stdout.log, stderr.log, workspace/}`；detached `_worker` 子进程跨 session 存活，新 session 用 `/minimax:status --all` 列出。
- **Hooks**：`SessionStart` 注入 `MINIMAX_COMPANION_SESSION_ID`（双协议 env file + JSON stdout 任一生效）；`SessionEnd` v0.1 no-op；`Stop` review-gate 默认 disabled（`setup --enable-review-gate` 才开）。
- **`--sandbox` 语义**：isolated workdir under `jobs/<jobId>/workspace/`；**NOT a security boundary**——Mini-Agent bash tool 可 `cd /` / `curl|sh` 等。surface text 一律 "isolated workdir" 不用 "sandbox protection"。
- **`/minimax:adversarial-review`**：单 queue slot 内顺序双 spawn（红 → 蓝），两边 schema-valid 才 ok=true，部分失败 exit 非零；reuses `_callReviewLike` helper（Task 5.0 refactor）；stance 文本来自 `RED_STANCE_INSTRUCTION` / `BLUE_STANCE_INSTRUCTION` 模块常量；prompt template `prompts/adversarial-review.md` 经 `{{STANCE_INSTRUCTION}}` placeholder 切换；不新增 schema，复用 `review-output.schema.json`。

## §E CLI 集成层前置调研清单（在 kimi 基础上加 minimax 发现）

新调研第三方 CLI 时，按此 checklist 先过一遍：

- [ ] **Exit code 是否区分成败？**（minimax: 否；gemini/kimi: 是）
- [ ] **env 变量是否支持作 api_key 源？grep 源码 `os.environ` / `getenv` 全局一遍**（minimax 血教训：源码 0 次 `os.environ`，env 路径无效，必须 YAML 写入）
- [ ] **模型切换：CLI 参数 vs 配置文件？**（minimax: 仅 YAML）
- [ ] **是否有独立日志文件？结构化程度？文件名是否含时间戳？并发场景如何归属？**（minimax: 有 + OpenAI-compat 结构 + 秒级时间戳 + 并发归属不稳）
- [ ] **官方是否暴露日志读取子命令作 fallback？**（minimax: `mini-agent log <file>` 与 `cat` 几乎相同，best-effort fallback）
- [ ] **CLI 启动耗时？**（minimax: 3-5s Python，UX 契约必须显式）
- [ ] **宿主语言依赖管理（Python uv/pipx，Node nvm，Go binary）—— 影响 setup 引导与 PATH 处理**（minimax: uv/pipx 三选一）
- [ ] **代理环境兼容性？SOCKS/HTTP_PROXY/系统代理；是否需要 extras 如 httpx[socks]**（minimax: 需 `--with socksio`）
- [ ] **工具集：是否自带文件写/bash？**（minimax: 是 → workspace 策略 + tripwire 必要）
- [ ] **`--sandbox`/`-w` 是真隔离还是只换 cwd？有逃逸面吗？**（minimax: 仅换 cwd；逃逸面 = 全部）
- [ ] **配置文件是否可 per-workspace 覆盖？**（minimax: 部分 — 需 `cd <path>` 触发 cwd 命中）
- [ ] **源码里有哪些字面常量错误消息可以当 sentinel？**（minimax: "Please configure..." / "Configuration file not found" / "ImportError: Using SOCKS proxy"）
- [ ] **API key 格式约束？是否 fail-closed？**（minimax: 零格式校验，仅拒 placeholder；plugin 自管 length 1-4096 + 控制字符过滤）
- [ ] **finish_reason 集合？OpenAI 还是 Anthropic 兼容？还是混合？**（minimax: 端点决定 — Coding-Plan 走 Anthropic，公开端点走 OpenAI；classifier 认全部）

## §F LLM 行为层前置调研清单（继承 kimi，加 minimax 发现）

- [ ] **目标模型的中文 prose 表达直白度**（M2.7 比 Kimi 更甚，提示需显式约束 enum 保英文）
- [ ] **Anthropic 兼容 API 的 tool_use 事件结构是否和原生 Anthropic 一致**（minimax: Coding-Plan 走 Anthropic 兼容；要求 classifier 双协议覆盖）
- [ ] **JSON parse 失败时的 retry 策略：客观描述 vs 责备型措辞**（M2.7：客观 + 回灌原文 → 命中；责备型 → 模型自我防御）
- [ ] **多 stance 单 prompt 的偏向行为**（M2.7：偏向最后 stance；红+蓝必须双 spawn）
- [ ] **prompt 末尾社交语言（thanks / 如有疑问）的污染**（M2.7：会附后记，破坏 RAW JSON 输出）
- [ ] **schema enum 中文化倾向**（M2.7：中文 prompt 下 severity 容易写中文；prompt 必须强约束）
- [ ] **冷启动期间用户视感**（M2.7：冷启动 ~3s；必须 stdout `Starting MiniMax...` 提示）

## §G 决策留痕（spec Q1-Q6 + 5-way review）

### spec Q1-Q6（设计阶段）

| Q | 选项 | 选择 | 拒因 |
|---|---|---|---|
| Q1 范围 | A=8 命令仅 Mini-Agent / B=+多模态 / C=MVP 3 命令 / D=+M2.7 fast path | **A** | B=独立方向 v0.2; C=与 kimi 不符; D=三张皮 |
| Q2 API key | A=全托原生 / B=AskUserQuestion 写 YAML / C=env 优先 / D=混合 | **B** | A=Mini-Agent 无 login; C=并发写风险; D=复杂度不值 |
| Q3 模型切换 | A=单一模型 / B=命令级 flag / C=workspace-local config / D=v0.1 全局 + P0.7 v0.2 | **D** | A=无升级路径; B/C=未验证或并发风险 |
| Q4 结构化数据源 | A=纯 stdout / B=纯日志 / C=stdout + 后解析日志 / D=实时 tail | **C** | A=忽略利好; B=无流式 UX; D=依赖 P0.3 未通 |
| Q5 非核心组件 | A=agent + 双 hook / B-D=逐步减 | **A** | full-parity 定义 + minimax 卖点 |
| Q6 lessons.md 形态 | A=滚更骨架 / B=phase 后一次性 / C=不写 | **A** | 滚更骨架便于 cross-AI handoff |

### Phase 4 (3-way review): 6 Critical + 5 Important 在 plan v2 嵌入。Phase 5 (5-way review): 见 plan v2 修订索引（`docs/superpowers/plans/2026-04-21-phase-5-adversarial.md`）

### Phase 5 — D5.1/D5.2/D5.3 architectural decisions

见 Phase 5 plan 顶部 "Architectural decisions" 段；5-way review 重点挑战这三条；正式版决策在 plan v2 修订索引内 traceability。

### Phase 5 — 5-way review 核心修订（M13 显式登记）

| 编号 | 修订 |
|---|---|
| C1 | stance 常量内嵌引号统一中文「」避免 JS SyntaxError |
| C2 (DISSENT) | T9 lenient 解读保留——蓝队空 findings 是合法 PASS 状态 |
| C3 | placeholder leftover 校验改白名单 set + 在 {{CONTEXT}} 之前做 |
| C4 | retry hint 全中文，避免 M2.7 双语切换跑偏 |
| C5 | reference markdown 4-tick 外层 + 3-tick 内层避免 fence 嵌套 |
| C6 | render 列名统一 "Claude / Red Team / Blue Team" |
| C7 | SKILL.md 不放历史流水帐 |
| I1 | `_callReviewLike` errorPrefix 参数化保 zero-behavior-change |
| I2 | 双 spawn mock 用 trace 文件实证调用次数 |
| I7 | cwd 共享语义登记 + 红蓝 prompt 加只读约束 |
| I13 | 对比表 4-bucket 而非模糊 "confirmed-by-N" |

### v0.1 不做（推 v0.2+）

- mmx-cli 多模态命令、M2.7 直连 fast path、续跑（T4/T7 — Mini-Agent 无外部 session id）、实时事件流、per-command 切模型、per-job 局部 config.yaml、ACP 协议、Engram sidecar、自适应多次重试、OS-level 真沙箱

### 永久不做

- CHANGELOG 并发锁 / 回滚共识（单人本地伪需求）
- 替 Mini-Agent 维护 session id 映射（需上游支持，上游不给永远不做）
