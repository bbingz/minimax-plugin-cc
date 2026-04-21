# Phase 5 — `/minimax:adversarial-review` + skills finalization + lessons.md + v0.1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `/minimax:adversarial-review`（红队 + 蓝队 双独立视角，复用 Phase 3 review 管道）+ 三个 skill 定稿 + `lessons.md` 收尾，过 T9 硬门，最后打 `v0.1.0` tag 收 v0.1。

**Architecture:**
adversarial-review 在 companion 内对**同一份 diff** 顺序调两次 `mini-agent`：第一次以红队（`{{STANCE_INSTRUCTION}}` = `RED_STANCE_INSTRUCTION`）寻 risk，第二次以蓝队（`BLUE_STANCE_INSTRUCTION`）做 mitigation 反驳。两次都走 Phase 3 已有的 `_callReviewLike` 单 spawn + 1-shot JSON retry 路径（Task 5.0 把 `callMiniAgentReview` 抽取为 `_callReviewLike` 再做薄包装，**零行为变化**）。两个 viewpoint 各自返回与 review 同 schema（`schemas/review-output.schema.json`，**不**新增 schema）的对象，companion 把两份 stitched 进 `{ok, red, blue, retry_used_red, retry_used_blue, logPath_red, logPath_blue}`。两次 spawn 复用同一个全局队列 slot（acquire 一次，跑完红再跑蓝再 release），保 P0.10 串行不变量；任一 viewpoint 失败 → 整体 exit 5（参考 review.parse-validate-failed 模式）。Skill 定稿不动业务代码，只补 references。`lessons.md` §A-§G 写 v0.1 全程经验。

**Tech Stack:** Node.js ≥ 18，复用 Phase 3 `buildReviewPrompt` 的 placeholder substitution + `extractReviewJson` brace-balanced 扫描 + `validateReviewOutput` 本地 schema validator + Phase 4 `acquireQueueSlot`/`releaseQueueSlot`，**不引任何新 npm 依赖**，**不新增 schema 文件**。

---

## Architectural decisions（5-way review 标记）

下面三个决策在 v1 plan 里显式登记，5-way review 重点对它们独立挑战：

**D5.1 — 双 spawn 而非单 spawn 双视角**
- 选 A：调两次 mini-agent，每次只灌一个 stance prompt，复用现有 review schema
- 拒 B：单 spawn，prompt 同时要求红+蓝两份 findings，扩 schema 加 `viewpoint` enum
- 理由：(1) T9 硬门要求"红蓝两视角均产出 findings"，双 spawn 让两份 findings 各自独立有 1-shot retry 预算，单 spawn 模式下模型容易偏向一边导致 T9 抖动。(2) review schema **零改动**（spec §6.6 只说 prompt 重写，未授权 schema 改）。(3) 复用 `_callReviewLike` 极小代码增量。
- 代价：~6s 额外冷启动 + queue slot 多持有 ~30s。adversarial-review 是用户主动深度审查命令，可接受。

**D5.2 — 单一 prompt 文件 + 模块常量切换 stance**
- 选 A：`prompts/adversarial-review.md` 一个文件，含 `{{STANCE_INSTRUCTION}}` placeholder；JS 模块定义 `RED_STANCE_INSTRUCTION` / `BLUE_STANCE_INSTRUCTION` 两条字符串常量，构建时替换
- 拒 B：两个独立 prompt 文件 `adversarial-review-red.md` + `adversarial-review-blue.md`
- 理由：spec §6.6 字面说"`prompts/adversarial-review.md`"（单数）；shell 部分（schema/focus/context/retry）大量重复，单文件 DRY；stance 差异是单段中文指令，本质是参数

**D5.3 — Queue slot 包整对（红+蓝）而非分别 acquire**
- 选 A：`runAdversarialReview` 在调 `callMiniAgentAdversarial` 前 acquire 一次，红跑完接着跑蓝，最后统一 release
- 拒 B：`callMiniAgentAdversarial` 内部各自 acquire/release
- 理由：(1) 选 B 可能导致红跑完 → 别的 `/minimax:ask` 抢到 slot → 蓝排队等更久，用户感知割裂。(2) 选 A 把"一对红蓝"作为原子工作单位，符合"adversarial-review 是一次审查"的语义。(3) acquire-once 简化错误路径（红失败也要 release）。
- 代价：v2 修正：单条 adversarial-review 持锁实测可达 ~60-90s（P0.1 实测冷启动 p50 10s + 双 spawn × (冷启动 + LLM ~15s + 可选 retry) ≈ 50-90s 主路径），期间其它命令排队；可接受（v0.1 整体串行）。Task 5.4 Step 2 在 stdout 显式提示 `Queue slot held for adversarial-review (~60s typical, up to ~120s with retries); other /minimax:* commands will wait` 提升 UX 透明度。

---

## v2 — 5-way review 修订索引（2026-04-21 Codex + Gemini + Claude-opus + Kimi + Qwen）

5-way review 收回 7 Critical + 21 Important + 14 Minor。下列修订**直接嵌入**对应 Task；本表仅 traceability。冲突点 (C2) 显式登记 dissent。

| # | 来源 | 严重度 | 修订 | 落在 Task |
|---|---|---|---|---|
| C1 | Codex / Claude-opus / Kimi 三家共识 | Critical | `RED_STANCE_INSTRUCTION` / `BLUE_STANCE_INSTRUCTION` 数组中所有内嵌的 ASCII `"` 改为中文「」（避免 JS SyntaxError；不用反斜杠转义保持可读性） | 5.2 |
| **C2** | **Codex 单方 vs Kimi 反对** | **Critical (DISSENT)** | **不采纳 Codex 收紧建议**。spec §8.1 "红蓝两视角均产出 findings" 解读为 "均产出 schema-valid `findings` 字段"，蓝队空数组合法（无 mitigation gap 时不应被强制编造）。Kimi 视角支持。Plan Task 5.10 verification 保持原文："至少一边 findings 非空" 是 T9 PASS 充分条件。在 lessons.md §G dissent 段登记此分歧 | 5.2 / 5.6 / 5.10 / 5.9 |
| C3 | Gemini | Critical | `buildAdversarialPrompt` / `buildReviewPrompt` 的 leftover placeholder 校验改为：在 `replace("{{CONTEXT}}", context)` **之前**先扫预期 placeholder 是否已全替换（用白名单 set 而非通配正则），避免误命中用户 diff 中的 `{{...}}` 文本（如 React/Vue 模板） | 5.0 / 5.2 |
| C4 | Gemini | Critical | retry hint block 全改中文："# 重试提示" + "你上一次的输出未通过校验：..."；与 stance 主体语境一致，避免 M2.7 双语切换跑偏 | 5.0 / 5.2 |
| C5 | Codex / Claude-opus | Critical | Task 5.7 三个 references 文件的内嵌 markdown 用 4-tick 外层 + 3-tick 内层（` ```` ` 包外，` ``` ` 包内），避免 fence 嵌套渲染断裂 | 5.7 |
| C6 | Kimi | Critical | Task 5.5 命令文件第 25 行 "Claude / MiniMax-review / red+blue" 改为 "Claude / Red Team / Blue Team"，与 Task 5.6 render reference 对齐 | 5.5 |
| C7 | Gemini | Critical | 删除 Task 5.8 在 `minimax-cli-runtime/SKILL.md` 末尾追加 "Phase 4-5 deltas" 整段（SKILL.md 是 LLM 上下文消费品，不放历史流水）；该段内容并入 lessons.md §D 的对应坑 | 5.8 / 5.9 |
| I1 | Codex / Claude-opus | Important | `_callReviewLike` 加可选 `errorPrefix` 参数（默认 `schema-load-failed`）；review 不传保持原行为，adversarial 传 `prompt-build-failed`。zero-behavior-change 名实相符 | 5.0 / 5.3 |
| I2 | Codex | Important | mock test 改造：`makeFakeBin` 把每次 spawn 的 stance 追加到一个 trace 文件，red-fail 测试断言"恰好 2 次 red 调用 + 0 次 blue 调用" | 5.3 |
| I3 | Codex / Qwen | Important | 删除 Task 5.2 第 5 个 "leftover placeholder triggers error" 占位测试；self-review 第 2071 行测试计数从 "新增四条" 改为 "新增三条" | 5.2 |
| I4 | Codex / Qwen | Important | mock fake-bin logFile 名加 `Math.random().toString(36).slice(2,8)` 后缀直接写在示例代码里，避免 retry 同秒 collision | 5.3 |
| I5 | Claude-opus | Important | `callMiniAgentAdversarial` 错误字符串去掉 "red-team failed:" / "blue-team failed (red succeeded):" 前缀，因 `side` 字段已说明哪方失败；避免 stderr 嵌套重复 | 5.3 |
| I6 | Claude-opus | Important | Task 5.3 Step 2 mock 改为参照 `minimax.ask.test.mjs::mkMockMiniAgent`（review test 实际只测 validateReviewOutput 不可参照）；fake-bin 用 sh 脚本与现有 mock 一致 | 5.3 |
| I7 | Claude-opus | Important | cwd 共享语义登记：(a) Task 5.1 prompt 加 "本任务是只读审查，不写任何文件、不执行修改型 bash"；(b) Task 5.4 Step 2 注释登记 "cwd shared across both spawns"；(c) Task 5.6 anti-patterns 加 "Do NOT recommend file-write actions in `recommendation`" | 5.1 / 5.4 / 5.6 |
| I8 | Codex / Kimi | Important | D5.1 文本修正："T9 硬门要求'红蓝两视角均产出 findings'" → "T9 要求两视角均产出 schema-valid 输出（findings 字段存在，蓝队空数组合法）"；与 C2 保持一致 | D5.1 |
| I9 | Kimi | Important | T9 smoke (Task 5.10) Step 3 加观察项："红队 critical/high finding 比例"，若 >70% 标 critical 则启动 stance 措辞降级预案（"击破" → "严格审视"），写入 lessons.md 坑 11 的延伸 | 5.10 / 5.9 |
| I10 | Kimi | Important | `BLUE_STANCE_INSTRUCTION` 任务重心从 "预判反驳" 改为 "评估现有防御层是否充分 + 找低成本 mitigation gap"（双 spawn 下蓝队看不到红队，预判反驳易产 straw-man） | 5.2 |
| I11 | Kimi | Important | Task 5.1 prompt 删除 "不要拷贝粘贴对方立场的论点"句（双 spawn 下模型看不到对方，该指令对空气说话） | 5.1 |
| I12 | Kimi | Important | Task 5.7 `references/minimax-prompt-recipes.md` red/blue stance recipe 展开实际 stance 文本片段（summary 反辩证修辞规则 / mitigation gap vs risk 区分），不再仅写 "由 plugin 自动注入" | 5.7 |
| I13 | Kimi / Gemini | Important | Task 5.6 render reference 对比表改为 4 bucket：Claude∩Red / Claude∩Blue / Red∩Blue / Unique-to-one；删去模糊的 "confirmed-by-2/3" 措辞 | 5.6 |
| I14 | Kimi | Important | D5.3 / D5.1 代价段按 P0.1 实测修正：冷启动 ~10s（不是 ~3s），双 spawn 总耗时 ~50-90s（不是 ~30-60s） | D5.1 / D5.3 / 5.4 |
| I15 | Gemini | Important | Task 5.4 Step 2 `runAdversarialReview` 在 stdout 显式打印 "Queue slot held for adversarial-review (~60s typical, up to ~120s with retries); other /minimax:* commands will wait" | 5.4 |
| I16 | Gemini | Important | Task 5.6 render reference 加段："MiniMax 独有红蓝双视角；横向对比 sibling 时不要将其与 Kimi 的单红队视角合并为同构数据" | 5.6 |
| I17 | Gemini | Important | Task 5.11 PROGRESS.md 修订改为：保留 "Phase 5 — remaining scope" 段但加 `~~删除线~~` + 上方加 "Phase 5 done — 下面是历史 scope 留 traceability" 注释，不物理删除 | 5.11 |
| I18 | Gemini | Important | Task 5.12 Step 4 echo 文本加 "请前往 GitHub 创建 v0.1.0 Release Notes（基于 CHANGELOG.md 内容）" 引导闭环 | 5.12 |
| I19 | Qwen | Important | Task 5.0 Step 2 行号锚点改为 "replace lines 1197-1332"（含 export 声明行），并附起止 marker：从 `export async function callMiniAgentReview({` 到该函数 `}` 闭合 | 5.0 |
| I20 | Qwen | Important | Task 5.4 Step 4 之前加 grep 验证 USAGE 锚点："`grep -n '^  review \\[--json\\]' plugins/minimax/scripts/minimax-companion.mjs`" 必须返回非空；否则 fallback 直接在 `rescue [--json]` 段之前插入 | 5.4 |
| I21 | Qwen | Important | Task 5.10 cleanup Step 5 在 `git switch main` 之前加 `git status --porcelain` 校验 + dirty 时 `git stash push -m "smoke-temp"` 兜底；切回 main 后再 `git stash drop` | 5.10 |
| M1 | Claude-opus | Minor | lessons.md §G Q6 行 "（略）" 改为明确表达："Q6 lessons.md 形态：A=滚更 / B=phase 后一次性 / C=不写 → **A** 滚更骨架便于 cross-AI handoff" | 5.9 |
| M2 | Claude-opus | Minor | Task 5.4 USAGE exit 4 行加 "(or queue-timeout)" 标注共用码 | 5.4 |
| M3 | Claude-opus | Minor | Task 5.10 smoke fixture 改为 `mktemp -d /tmp/minimax-smoke-XXXX` + `git -C` 跑，主仓库永远不脏；删除 `_smoke_t9` 目录路径 | 5.10 |
| M4 | Claude-opus | Minor | Task 5.7 SKILL universal rule 6 末尾改为 "（详见 `minimax-cli-runtime` SKILL §classifier）"，去掉 INCOMPLETE 字面引用，降低跨 skill 文档耦合 | 5.7 |
| M5 | Qwen | Minor | 不采纳：§B 第 4 项保持复合，subagent 实施可分子步骤 | — |
| M6 | Qwen | Minor | Task 5.11 PROGRESS.md 修订加子步骤 "Step 3b: 运行 `git rev-parse HEAD` 获取 hash，替换 `<hash>` 字面" | 5.11 |
| M7 | Qwen | Minor | Task 5.0 Step 1 注释加 "`_callReviewLike` 是 module-private（无 `export` 关键字）" | 5.0 |
| M8 | Kimi | Minor | lessons.md §D 坑 11 末尾补 "kimi-plugin-cc 通过单 stance 设计天然规避此坑；minimax 因双 stance 需求采用双 spawn" | 5.9 |
| M9 | Kimi | Minor | `BLUE_STANCE_INSTRUCTION` 末尾加 severity 校准段："蓝队 critical = 不补会出生产事故；high = 不补有显著运维风险；medium = 维护期 toil；low = 可选打磨" | 5.2 |
| M10 | Kimi | Minor | 不采纳：D5.2 单一 prompt 文件理由保留，但弱化 spec §6.6 "单数文件名" 字面理由，主因改为 "DRY shell + stance 是参数本质" | D5.2 |
| M11 | Gemini | Minor | Task 5.4 加内联 TODO 注释："// v0.2: consider --single-spawn / --fast flag for cold-start-sensitive use" | 5.4 |
| M12 | Gemini | Minor | Task 5.7 prompt-blocks workspace-constraint 段第 1 行末加 "(this is an isolated workdir, not a security sandbox)" 显式声明 | 5.7 |
| M13 | Gemini | Minor | lessons.md §G 加 "## 5-way review 核心修订" 子段，bullet 列 C1-C7 + I1-I8 摘要，便于 cross-AI 复用 | 5.9 |
| M14 | Gemini | Minor | Task 5.10 smoke fixture 换为更中性的 bug：在 auth.js 上加 "fetch 没有 timeout" 的 patch（红蓝都有发力空间），不用 hardcoded admin token | 5.10 |

不采纳（5-way 提过但拒）：
- Codex C2 收紧 T9：见 dissent 登记
- Qwen M5：§B 第 4 项不拆
- Kimi M10：D5.2 主因调整但决策保留

---

## Prerequisites

- Phase 0–4 完成（git tag `phase-4-rescue`，commit `3e74e2d`），79 tests pass / 0 fail
- 必读：
  - `docs/superpowers/specs/2026-04-20-minimax-plugin-cc-design.md` §6.1 命令总表、§6.2 `/minimax:adversarial-review` 段、§6.6 prompts 列表、§8.1 T9 硬门、§8.3 lessons.md 骨架
  - `plugins/minimax/skills/minimax-cli-runtime/SKILL.md`（**P0.10 串行 mandate**，**OpenAI-compat finish_reason 集合**）
  - `plugins/minimax/scripts/lib/minimax.mjs` 第 1066–1332 行：`buildReviewPrompt` / `extractReviewJson` / `validateReviewOutput` / `callMiniAgentReview` / `reviewError` / `reviewSuccess`
  - `plugins/minimax/scripts/minimax-companion.mjs` 第 284–488 行：`runReview`（adversarial 仿照其 collectDiff + queue + JSON / text 输出双模）
  - `plugins/minimax/prompts/review.md`（template 风格 + placeholder 命名）
  - `plugins/minimax/commands/review.md`（command frontmatter 风格）
  - `plugins/minimax/skills/minimax-result-handling/references/review-render.md`（render 规范风格）
- 对照（**读，不 cp 不 sed**；字节级通读后手写）：
  - `/Users/bing/-Code-/kimi-plugin-cc/plugins/kimi/prompts/adversarial-review.md`（单 stance 模板，可借鉴攻击面与 finding_bar 段落措辞）
  - `/Users/bing/-Code-/kimi-plugin-cc/plugins/kimi/commands/adversarial-review.md`（command 分派 + presentation 风格）
  - `/Users/bing/-Code-/gemini-plugin-cc/plugins/gemini/prompts/adversarial-review.md`（精简版参考）
- 不读 / 不抄：kimi 的 `callKimiAdversarialReview` 实现（minimax 走双 spawn，不同架构）

## Scope & 硬门

| # | 动作 | 通过标准 |
|---|---|---|
| **T9** | `/minimax:adversarial-review` 跑一个 3–5 行 diff | 红队 viewpoint 与蓝队 viewpoint **均**返回 schema-valid JSON（`verdict`/`summary`/`findings`/`next_steps` 齐全），且**至少一份 viewpoint 的 `findings` 非空** |

**不做**（v0.1 明确排除）：
- **不新增 schema**（复用 `review-output.schema.json`）
- **不**让红队和蓝队互看对方的 finding（独立两次 spawn，prompt 互不引用）
- **不**做超过 1-shot 的 retry（每个 viewpoint 各自 1-shot，与 review 同）
- **不**做 `--background` adversarial-review（v0.1 仅 foreground，避免与 rescue 后台模式混淆；`/minimax:rescue` 才是后台委派的入口）
- **不**做实时 stream 红蓝交替（双 spawn 自然顺序，stderr 按 stance 标注 `[red]`/`[blue]` 前缀即可）
- **不**改 review 的 schema 或 review 的 prompt
- **不**引第三方依赖

## File Structure

| 动作 | 路径 | 职责 |
|---|---|---|
| Modify | `plugins/minimax/scripts/lib/minimax.mjs` | Task 5.0 抽取 `_callReviewLike`；Task 5.2 加 `RED_STANCE_INSTRUCTION` / `BLUE_STANCE_INSTRUCTION` / `buildAdversarialPrompt`；Task 5.3 加 `callMiniAgentAdversarial` |
| Create | `plugins/minimax/prompts/adversarial-review.md` | M2.7 中文直给的 dual-stance template，含 `{{STANCE_INSTRUCTION}}` 等 placeholder |
| Modify | `plugins/minimax/scripts/lib/minimax.test.mjs` | 加 `buildAdversarialPrompt` / `RED_STANCE_INSTRUCTION` 注入正确性 / leftover guard 测试 |
| Create | `plugins/minimax/scripts/lib/minimax-adversarial.test.mjs` | `callMiniAgentAdversarial` 的 mock-spawn 集成测试（红蓝独立成功、红失败、蓝失败） |
| Modify | `plugins/minimax/scripts/minimax-companion.mjs` | Task 5.4-5.5：加 `runAdversarialReview`，`USAGE` 块加段，`main()` switch 加 case |
| Create | `plugins/minimax/commands/adversarial-review.md` | `/minimax:adversarial-review` 命令分派 + 渲染指引 |
| Create | `plugins/minimax/skills/minimax-result-handling/references/adversarial-review-render.md` | 红蓝独立两块、不可合并、retry 提示位置规则 |
| Modify | `plugins/minimax/skills/minimax-prompting/SKILL.md` | 去掉 "skeleton, finalized in Phase 5" 字样，加 stance-instruction 引导段 |
| Create | `plugins/minimax/skills/minimax-prompting/references/minimax-prompt-recipes.md` | Phase 1-4 实测 prompt recipes |
| Create | `plugins/minimax/skills/minimax-prompting/references/minimax-prompt-antipatterns.md` | Phase 1-4 踩坑后的 anti-pattern |
| Create | `plugins/minimax/skills/minimax-prompting/references/prompt-blocks.md` | 可复用块（output contract / workspace 约束 / Skills 调度） |
| Modify | `plugins/minimax/skills/minimax-cli-runtime/SKILL.md` | frontmatter 加 `version: 1.0`；底部加 "Phase 4-5 deltas" 段 |
| Modify | `plugins/minimax/skills/minimax-result-handling/SKILL.md` | 删 "What still needs Phase 3+ work" 段；命令-render 表加 `adversarial-review` 行（已有，复核） |
| Create | `lessons.md` | 仓库根，§A 命名替换 / §B 重写 9 项 / §C 复制 8 项 / §D 踩坑 / §E CLI 集成清单 / §F LLM 行为清单 / §G 决策留痕 |
| Create | `doc/smoke/phase-5-T9.md` | T9 smoke 报告（输入 diff + 红蓝 stdout + JSON 抽样） |
| Modify | `CHANGELOG.md` + `plugins/minimax/CHANGELOG.md` | 每个 Task 落地后追加条目 |
| Modify | `PROGRESS.md` | Task 5.12 收尾：Phase 5 done，v0.1.0 tagged |
| Modify | `~/.claude/projects/-Users-bing--Code--minimax-plugin-cc/memory/project-phase-status.md` | 同步 Phase 5 done |

---

## Task 5.0 — `_callReviewLike` 抽取（zero-behavior-change refactor）

把 `callMiniAgentReview` 的"单 spawn + 1-shot retry"骨架抽出为通用 helper `_callReviewLike`，供 Task 5.3 `callMiniAgentAdversarial` 复用。`callMiniAgentReview` 保留外部签名，内部委托 `_callReviewLike`。

**Files:**
- Modify: `plugins/minimax/scripts/lib/minimax.mjs:1197-1332`
- Test: `plugins/minimax/scripts/lib/minimax.test.mjs`（已有 review 测试不动；本任务确认全部仍 pass）

- [ ] **Step 1: 在 `minimax.mjs` 紧贴 `reviewSuccess` 之后（约 1226 行后）插入新的 `_callReviewLike` 函数**

> v2 (M7): `_callReviewLike` 是 module-private function（**无 `export` 关键字**），仅在 `minimax.mjs` 内部被 `callMiniAgentReview` (Task 5.0) 与 `callMiniAgentAdversarial` (Task 5.3) 调用。

> v2 (I1): 加可选 `errorPrefix` 参数。`callMiniAgentReview` 不传，沿用 `schema-load-failed`（与现有行为字节一致）；`callMiniAgentAdversarial` 传 `prompt-build-failed`。

```js
/**
 * Generic review-style call: one spawn + 1-shot retry on parse/validate failure.
 *
 * Both /minimax:review and /minimax:adversarial-review share this skeleton.
 * Differences are isolated to the `buildPrompt` callback and `errorPrefix`.
 *
 * @param {object} opts
 * @param {(args:{retryHint?:string,previousRaw?:string})=>string} opts.buildPrompt
 *        — pure function returning the full prompt string given optional retry args
 * @param {string} opts.schemaPath          — schema for validateReviewOutput
 * @param {string} opts.cwd
 * @param {number} [opts.timeout=120000]
 * @param {string} [opts.bin]
 * @param {string} [opts.logDir]
 * @param {boolean} [opts.truncated=false]
 * @param {(line:string)=>void} [opts.onProgressLine]
 * @param {string} [opts.retryWarning]      — stderr warning shown before retry; default mirrors review
 * @param {string} [opts.errorPrefix]       — v2 (I1): error string prefix for prompt-build failures.
 *                                            Defaults to "schema-load-failed" (review's historic value).
 * @returns {Promise<{ok:true,...,truncated,retry_used,retriedOnce,retry_notice,logPath} | {ok:false,error,...}>}
 */
async function _callReviewLike({
  buildPrompt,
  schemaPath,
  cwd,
  timeout = 120_000,
  bin,
  logDir,
  truncated = false,
  onProgressLine,
  retryWarning = "Warning: minimax review response failed parse/validation; retrying once with error hint...\n",
  errorPrefix = "schema-load-failed",
}) {
  let firstPrompt;
  try {
    firstPrompt = buildPrompt({});
  } catch (e) {
    return reviewError({ error: `${errorPrefix}: ${e.message}`, truncated, retry_used: false });
  }

  const firstCall = await callMiniAgent({ prompt: firstPrompt, cwd, timeout, bin, logDir, onProgressLine });
  const firstCls = classifyMiniAgentResult(firstCall);
  if (firstCls.status !== "success" && firstCls.status !== "success-but-truncated") {
    return reviewError({
      error: `mini-agent call failed: ${firstCls.status}${firstCls.detail ? " -- " + firstCls.detail : ""}`,
      truncated: truncated || firstCls.status === "success-but-truncated",
      retry_used: false,
      diagnostic: firstCls.diagnostic ?? null,
    });
  }

  const firstTruncated = truncated || firstCls.status === "success-but-truncated";

  const firstExtracted = extractReviewJson(firstCls.response);
  let firstValidation = null;
  if (firstExtracted.ok) {
    firstValidation = validateReviewOutput(firstExtracted.data, schemaPath);
    if (firstValidation.ok) {
      return reviewSuccess(firstExtracted.data, {
        truncated: firstTruncated,
        retry_used: false,
        retry_notice: null,
        logPath: firstCls.logPath,
      });
    }
  }

  const retryHint = firstExtracted.ok
    ? `schema validation errors: ${firstValidation.errors.slice(0, 3).join("; ")}`
    : `parse failure (${firstExtracted.error}${firstExtracted.parseError ? ": " + firstExtracted.parseError : ""})`;

  process.stderr.write(retryWarning);

  let retryPrompt;
  try {
    retryPrompt = buildPrompt({ retryHint, previousRaw: firstCls.response });
  } catch (e) {
    return reviewError({
      error: `Failed to rebuild retry prompt: ${e.message}`,
      firstRawText: firstCls.response,
      truncated: firstTruncated,
      retry_used: true,
    });
  }

  const retryCall = await callMiniAgent({ prompt: retryPrompt, cwd, timeout, bin, logDir, onProgressLine });
  const retryCls = classifyMiniAgentResult(retryCall);
  const retryTruncated = firstTruncated || retryCls.status === "success-but-truncated";

  if (retryCls.status !== "success" && retryCls.status !== "success-but-truncated") {
    return reviewError({
      error: `retry mini-agent call failed: ${retryCls.status}${retryCls.detail ? " -- " + retryCls.detail : ""}`,
      firstRawText: firstCls.response,
      truncated: retryTruncated,
      retry_used: true,
      diagnostic: retryCls.diagnostic ?? null,
    });
  }

  const retryExtracted = extractReviewJson(retryCls.response);
  if (!retryExtracted.ok) {
    return reviewError({
      error: `review failed after 1 retry: ${retryExtracted.error}`,
      parseError: retryExtracted.parseError ?? null,
      firstRawText: firstCls.response,
      rawText: retryCls.response,
      truncated: retryTruncated,
      retry_used: true,
    });
  }
  const retryValidation = validateReviewOutput(retryExtracted.data, schemaPath);
  if (!retryValidation.ok) {
    return reviewError({
      error: `review failed schema validation after 1 retry: ${retryValidation.errors.slice(0, 3).join("; ")}`,
      firstRawText: firstCls.response,
      rawText: retryCls.response,
      truncated: retryTruncated,
      retry_used: true,
    });
  }

  return reviewSuccess(retryExtracted.data, {
    truncated: retryTruncated,
    retry_used: true,
    retry_notice: `Initial response failed; retry succeeded (hint: ${retryHint})`,
    logPath: retryCls.logPath,
  });
}
```

- [ ] **Step 2: 把 `callMiniAgentReview` 改写为薄包装（保留 export 签名）**

> v2 (I19): 替换 `minimax.mjs` lines **1197-1332**（含 export 声明行 + 注释 block，到该函数 closing `}`）。Anchor 起始为：
>
> ```
> export async function callMiniAgentReview({
> ```
>
> Anchor 结束为：该函数最外层 `}` 后紧跟空行。删除整段后插入下面的薄包装：

```js
export async function callMiniAgentReview({
  context,
  focus = "",
  schemaPath,
  cwd,
  timeout = 120_000,
  bin,
  logDir,
  truncated = false,
  onProgressLine,
}) {
  const buildPrompt = ({ retryHint, previousRaw } = {}) =>
    buildReviewPrompt({ schemaPath, focus, context, retryHint, previousRaw });
  return _callReviewLike({
    buildPrompt,
    schemaPath,
    cwd,
    timeout,
    bin,
    logDir,
    truncated,
    onProgressLine,
    retryWarning: "Warning: minimax review response failed parse/validation; retrying once with error hint...\n",
    // errorPrefix omitted → defaults to "schema-load-failed" (preserves zero-behavior-change for review path)
  });
}
```

- [ ] **Step 3: 跑全部 lib 测试，确认 review 行为零变化**

Run: `cd /Users/bing/-Code-/minimax-plugin-cc && node --test plugins/minimax/scripts/lib/*.test.mjs 2>&1 | tail -25`
Expected: `# pass 79` `# fail 0` （Phase 4 收尾时的基线，refactor 不应改变测试结果）

- [ ] **Step 4: 提交**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
git add plugins/minimax/scripts/lib/minimax.mjs
git commit -m "refactor(Task 5.0): extract _callReviewLike from callMiniAgentReview (zero-behavior-change)"
```

---

## Task 5.1 — `prompts/adversarial-review.md` 模板

写一个 M2.7 中文直给的 dual-stance prompt 模板。结构：role + stance 段（由 `{{STANCE_INSTRUCTION}}` 决定红/蓝） + attack/defense surface + finding_bar + output contract（指向 `{{SCHEMA_JSON}}`，复用 review schema）+ focus + context + retry hint。**不**翻译已有 review prompt 字面，重写以体现 M2.7 中文 prose 风格。

**Files:**
- Create: `plugins/minimax/prompts/adversarial-review.md`

- [ ] **Step 1: 写模板**

完整文件内容：

````markdown
你是一名资深代码审查员，本次任务是从**一个固定立场**对下方 diff 做对抗性审查。

# 立场指令

{{STANCE_INSTRUCTION}}

# 输出契约

- 仅返回**单个 JSON 对象**，严格匹配下方 schema。
- 不写任何前言（"好的"/"以下是审查结果"），不写任何后记（"如有疑问"/"希望对你有帮助"）。
- 不要 markdown 代码栅栏（不要 ```json ... ```），直接给 JSON 文本。
- `severity` 必须是英文枚举之一：`critical` / `high` / `medium` / `low`。中文严重度（严重/高/中/低）会让 schema 校验失败。
- `verdict` 必须是英文枚举之一：`approve` / `needs-attention`。
- 每个 finding 都必须包含全部字段：`severity` / `title` / `body` / `file` / `line_start` / `line_end` / `confidence` / `recommendation`。字段缺一即整条 finding 被拒。
- 不要编造行号：若不确定具体行，整条 finding 删掉。
- 本任务是**只读审查**：不要写任何文件、不要执行修改型 bash 命令（`rm` / `mv` / `git commit` / `chmod` / `> file` 等）；只输出 JSON。

# Schema

```json
{{SCHEMA_JSON}}
```

# Verdict 准则

- `approve`：本立场视角下，没有 `critical` 或 `high` 级别的 finding；改动按本立场看是可以放行的。
- `needs-attention`：至少一条 `high`/`critical`，或多条 `medium` 命中不同关注点；犹豫时选 `needs-attention`。

# 严重度准则

- `critical`：安全漏洞、数据丢失、常见路径上必现 crash。
- `high`：现实输入下的正确性 bug，或破坏周围代码所依赖的不变量。
- `medium`：会影响后续维护的清晰度问题；逻辑分支上的测试空缺。
- `low`：纯 nit（命名、微样式、死代码注释），不改变行为。

挑能驱动修复的最低严重度。`critical` 留给真实安全问题，不留给个人偏好。

# Finding 形状

- `title`：一句话点出缺陷。
- `body`：1-3 句话解释**为什么**是缺陷。
- `file`：仓库根相对路径，按 diff header 出现的形态写。
- `line_start` / `line_end`：用 diff 新版那侧的行号。单行 issue 起止相同。
- `confidence`：0-1 之间的诚实自评。0.9 以上仅留给确信无疑的缺陷。
- `recommendation`：具体可执行的动作。"建议进一步审查"这种话不行；要"把第 X 行的 `xxx` 改成 `yyy`"或类似精度。

# Next steps

`next_steps` 是 0-5 条按优先级排列的下一步动作（如"补回归测试"/"跑 linter"/"更新 CHANGELOG"），与 `findings` 正交。diff 平淡时空数组合法。

# 用户关注点

{{FOCUS}}

# 待审 diff

```
{{CONTEXT}}
```

{{RETRY_HINT}}
````

- [ ] **Step 2: 提交**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
git add plugins/minimax/prompts/adversarial-review.md
git commit -m "feat(Task 5.1): adversarial-review prompt template (dual stance via {{STANCE_INSTRUCTION}})"
```

---

## Task 5.2 — `buildAdversarialPrompt` + stance constants

加 `RED_STANCE_INSTRUCTION` / `BLUE_STANCE_INSTRUCTION` 模块常量；加 `buildAdversarialPrompt({stance, schemaPath, focus, context, retryHint, previousRaw})`。

**Files:**
- Modify: `plugins/minimax/scripts/lib/minimax.mjs`（在 `buildReviewPrompt` 段之后追加）
- Test: `plugins/minimax/scripts/lib/minimax.test.mjs`（追加测试）

- [ ] **Step 1: 在 `minimax.mjs` 的 `extractReviewJson` 之前（约 1135 行）插入 stance 常量 + builder**

```js
// ── Adversarial review prompt builder (Phase 5 Task 5.2) ────────────────────

const ADVERSARIAL_PROMPT_PATH = path.resolve(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts", "adversarial-review.md")
);

let _adversarialTemplateCache = null;

function loadAdversarialTemplate() {
  if (_adversarialTemplateCache !== null) return _adversarialTemplateCache;
  _adversarialTemplateCache = fs.readFileSync(ADVERSARIAL_PROMPT_PATH, "utf8");
  return _adversarialTemplateCache;
}

export function _invalidateAdversarialTemplateCache() { _adversarialTemplateCache = null; }

// v2 (C1): 内嵌的人物引用统一用中文「」而非 ASCII " 嵌套，避免 JS SyntaxError
// v2 (I9): 措辞由 reviewer Kimi 标注为"激将"，T9 smoke (Task 5.10) 后视红队 severity 分布判断是否降级
// v2 (M9): 蓝队 severity 校准段补全
export const RED_STANCE_INSTRUCTION = [
  "你是红队（red team）。本次审查的唯一目标是**击破**这次改动的可发布性。",
  "默认怀疑。除非证据明示，否则假设它会以隐蔽、高代价、用户可见的方式失败。",
  "不要因「作者意图良好」或「看起来会有后续修复」给出妥协。只在 happy path 工作的代码即视为真问题。",
  "重点攻击面：",
  "- 鉴权、权限、租户隔离、信任边界",
  "- 数据丢失/损坏/重复/不可逆状态变更",
  "- 回滚安全、retry、部分失败、幂等性缺口",
  "- 竞态、顺序假设、stale 状态、re-entrancy",
  "- empty/null/timeout/降级依赖行为",
  "- 版本漂移、schema 漂移、迁移风险、兼容性回退",
  "- observability 缺口（出问题查不到）",
  "summary 字段写成简短的 ship/no-ship 判定。「不要发布」/「阻塞 release」/「高风险回退」这种开头是合法的；「本次改动既有改进也有顾虑」这种平衡修辞是不合法的。",
  "不要用「可能」/「或许」/「存在风险」软化 finding —— 要么有依据写实，要么删掉。",
  "本任务是只读审查：不要写文件、不执行修改型 bash 命令；只输出 JSON。",
].join("\n");

// v2 (I10): 蓝队任务重心从"预判反驳"改为"评估现有防御层 + 找低成本 mitigation gap"
// (双 spawn 下蓝队看不到红队，预判反驳易产 straw-man)
export const BLUE_STANCE_INSTRUCTION = [
  "你是蓝队（blue team）。本次审查的唯一目标是**辩护**这次改动的可发布性。",
  "默认相信。除非证据明示，否则假设它在合理输入下能正确工作。",
  "你的核心任务有两个：(1) **评估现有防御层是否充分**——已有的 schema 校验、类型系统、上游已 sanitize 的输入、测试覆盖、回滚机制、降级路径、容错设计——并指出这些防御为什么让看似危险的代码实际安全；(2) 找出现有改动里**真实存在的、值得修但低成本可修**的 mitigation gap（防御深度、可观测性、文档、retry 策略调优等）。",
  "重点关注：",
  "- 已有的防御层（schema 校验、类型系统、上游已 sanitize 的输入）让看似危险的代码实际安全",
  "- 测试覆盖、回滚机制、降级路径、容错设计的现有保护",
  "- 影响半径其实有限的场景（即使有 risk，blast radius 可控）",
  "- 低成本的 mitigation 增量（如加一行日志、补一个 metric、一个 assert）",
  "summary 字段写成简短的 ship-with-confidence 或 ship-with-mitigations 判定。「可以发布」/「现有防御足够」/「加 X 即可发布」这种开头是合法的；「本次改动有重大风险」这种向红队靠拢的修辞是不合法的（你不是仲裁，你是辩方）。",
  "蓝队的 finding 是 mitigation gap，不是 risk。每个 finding 的 recommendation 字段必须给出具体动作（不是「考虑增强」这种模糊话）。",
  "**蓝队 severity 校准**：critical = 不补会出生产事故；high = 不补有显著运维风险；medium = 维护期 toil；low = 可选打磨。不要把"加一行日志"标 critical。",
  "如果你确实找不到任何 mitigation gap，`findings` 为空数组合法（说明现有改动按蓝队视角已经足够好；这不影响 T9 通过）。",
  "本任务是只读审查：不要写文件、不执行修改型 bash 命令；只输出 JSON。",
].join("\n");

/**
 * Build the adversarial-review prompt for a given stance.
 *
 * @param {object} opts
 * @param {"red"|"blue"} opts.stance        — which viewpoint instruction to inject
 * @param {string} opts.schemaPath          — absolute path to review-output.schema.json
 * @param {string} opts.focus               — user-supplied focus hint (may be empty)
 * @param {string} opts.context             — full diff text
 * @param {string} [opts.retryHint]         — if non-empty, render a retry note block
 * @param {string} [opts.previousRaw]       — prior failed response (redacted, capped 1500)
 * @returns {string}
 */
export function buildAdversarialPrompt({ stance, schemaPath, focus, context, retryHint, previousRaw }) {
  if (stance !== "red" && stance !== "blue") {
    throw new Error(`buildAdversarialPrompt: stance must be 'red' or 'blue', got '${stance}'`);
  }
  const stanceInstruction = stance === "red" ? RED_STANCE_INSTRUCTION : BLUE_STANCE_INSTRUCTION;
  const schemaText = fs.readFileSync(schemaPath, "utf8");
  const template = loadAdversarialTemplate();
  const focusRendered = (focus && focus.trim()) ? focus : "(no additional focus provided)";

  // v2 (C4): retry hint 全中文，与 stance 主体语境一致；避免 M2.7 双语切换跑偏
  let retryBlock = "";
  if (retryHint && retryHint.trim()) {
    const lines = [
      "# 重试提示",
      "",
      `你上一次的输出未通过校验：${retryHint}。请只返回严格匹配上方 schema 的 RAW JSON，不要 markdown 代码栅栏，不要前言后记。`,
    ];
    if (previousRaw && previousRaw.trim()) {
      const redacted = redactSecrets(String(previousRaw)).slice(0, 1500);
      lines.push("");
      lines.push("## 上次响应原文（截前 1500 字符，已脱敏）");
      lines.push("");
      lines.push(redacted);
    }
    retryBlock = lines.join("\n");
  }

  // v2 (C3): leftover 校验改为白名单 set 在 {{CONTEXT}} 替换之前做，避免误命中用户 diff 中的 {{...}} 文本
  const EXPECTED_PLACEHOLDERS = ["{{STANCE_INSTRUCTION}}", "{{SCHEMA_JSON}}", "{{FOCUS}}", "{{RETRY_HINT}}", "{{CONTEXT}}"];
  let staged = template
    .replace("{{STANCE_INSTRUCTION}}", stanceInstruction)
    .replace("{{SCHEMA_JSON}}", schemaText)
    .replace("{{FOCUS}}", focusRendered)
    .replace("{{RETRY_HINT}}", retryBlock);
  // At this point all four non-CONTEXT placeholders should be substituted;
  // remaining {{X}} in `staged` (excluding {{CONTEXT}}) means the template is malformed.
  for (const p of EXPECTED_PLACEHOLDERS) {
    if (p === "{{CONTEXT}}") continue;
    if (staged.includes(p)) {
      throw new Error(`buildAdversarialPrompt: placeholder ${p} not substituted (template malformed?)`);
    }
  }
  // Now do the user-content substitution last, so any {{...}} inside `context` is treated as data.
  const result = staged.replace("{{CONTEXT}}", context);
  // Defensive: if {{CONTEXT}} itself somehow survived (template lacks that slot), fail loud.
  if (result.includes("{{CONTEXT}}")) {
    throw new Error("buildAdversarialPrompt: {{CONTEXT}} placeholder missing from template");
  }

  return result.trimEnd();
}
```

> v2 (C3 follow-on): 等价的 leftover 校验修订也要施加到 `buildReviewPrompt`（`minimax.mjs` 第 1116-1130 行），改用白名单 set 避免误命中 diff 内 `{{...}}` 文本。Task 5.0 Step 2 替换 `callMiniAgentReview` 时**同时** patch `buildReviewPrompt` 的 leftover guard 段落（这是 review 本身的 latent bug，5-way review 顺手发现）。具体改动：
>
> ```js
> // OLD (line 1127-1130):
> const leftover = result.match(/\{\{[A-Z_]+\}\}/);
> if (leftover) {
>   throw new Error(`buildReviewPrompt: unreplaced placeholder ${leftover[0]} remains after substitution`);
> }
>
> // NEW: 白名单 set + 在 {{CONTEXT}} 替换之前做（与上文 buildAdversarialPrompt 同结构）
> // 把 buildReviewPrompt 的 .replace 链拆开，先替换非 CONTEXT 的，校验 leftover，再替换 CONTEXT
> ```
>
> 这是 Task 5.0 的扩展（C3 → 5.0）；与 Task 5.0 Step 2 一并提交。

- [ ] **Step 2: 在 `minimax.test.mjs` 末尾追加测试**

```js
import {
  buildAdversarialPrompt,
  RED_STANCE_INSTRUCTION,
  BLUE_STANCE_INSTRUCTION,
  _invalidateAdversarialTemplateCache,
} from "./minimax.mjs";

const SCHEMA_PATH = path.resolve("plugins/minimax/schemas/review-output.schema.json");

test("buildAdversarialPrompt: red stance injects RED_STANCE_INSTRUCTION verbatim", () => {
  _invalidateAdversarialTemplateCache();
  const out = buildAdversarialPrompt({
    stance: "red",
    schemaPath: SCHEMA_PATH,
    focus: "auth path",
    context: "diff --git a/x.js b/x.js\n+let x = 1;\n",
  });
  assert.ok(out.includes(RED_STANCE_INSTRUCTION), "red stance text must appear");
  assert.ok(!out.includes("{{STANCE_INSTRUCTION}}"), "placeholder must be replaced");
  assert.ok(out.includes("auth path"), "focus must appear");
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(out), "no leftover placeholders");
});

test("buildAdversarialPrompt: blue stance injects BLUE_STANCE_INSTRUCTION verbatim", () => {
  _invalidateAdversarialTemplateCache();
  const out = buildAdversarialPrompt({
    stance: "blue",
    schemaPath: SCHEMA_PATH,
    focus: "",
    context: "diff --git a/x.js b/x.js\n+let x = 1;\n",
  });
  assert.ok(out.includes(BLUE_STANCE_INSTRUCTION), "blue stance text must appear");
  assert.ok(!out.includes(RED_STANCE_INSTRUCTION), "red stance text must NOT appear when stance=blue");
  assert.ok(out.includes("(no additional focus provided)"), "empty focus → placeholder default");
});

test("buildAdversarialPrompt: rejects unknown stance", () => {
  assert.throws(
    () => buildAdversarialPrompt({ stance: "purple", schemaPath: SCHEMA_PATH, focus: "", context: "x" }),
    /stance must be 'red' or 'blue'/
  );
});

test("buildAdversarialPrompt: retry hint and previousRaw are interpolated and redacted", () => {
  _invalidateAdversarialTemplateCache();
  const previous = "leak token sk-aaaaaaaaaaaaaaaaaaaa secret";
  const out = buildAdversarialPrompt({
    stance: "red",
    schemaPath: SCHEMA_PATH,
    focus: "",
    context: "x",
    retryHint: "schema validation errors: bad type",
    previousRaw: previous,
  });
  assert.ok(out.includes("# Retry note"), "retry block must render");
  assert.ok(out.includes("schema validation errors: bad type"));
  assert.ok(out.includes("sk-***REDACTED***"), "secret must be redacted");
  assert.ok(!out.includes("sk-aaaaaaaaaaaaaaaaaaaa"), "raw secret must not leak");
});

test("buildAdversarialPrompt: user diff containing {{X}} is NOT mistaken for leftover placeholder (C3 regression)", () => {
  _invalidateAdversarialTemplateCache();
  // Simulate a React/Vue diff where the user's code contains literal {{...}} interpolation
  const reactDiff = "diff --git a/x.jsx b/x.jsx\n+const Greeting = () => <div>{{userName}}</div>;\n";
  const out = buildAdversarialPrompt({
    stance: "red",
    schemaPath: SCHEMA_PATH,
    focus: "",
    context: reactDiff,
  });
  assert.ok(out.includes("{{userName}}"), "user content {{X}} must survive verbatim into final prompt");
  assert.ok(!out.includes("{{STANCE_INSTRUCTION}}"), "real placeholders still substituted");
  assert.ok(!out.includes("{{CONTEXT}}"), "real placeholders still substituted");
});
```

> v2 (I3): 删除原 v1 的 "leftover placeholder triggers error" 占位测试（无实际断言），换为 C3 回归测试（用户 diff 含 `{{X}}` 不应被误判为 leftover）。Task 5.2 新增测试数为 **4** 条（red / blue / unknown-stance / retry-redaction）+ **1** 条 C3 回归 = **5** 条。

- [ ] **Step 3: 跑测试**

Run: `cd /Users/bing/-Code-/minimax-plugin-cc && node --test plugins/minimax/scripts/lib/minimax.test.mjs 2>&1 | tail -15`
Expected: 新增 5 条 buildAdversarialPrompt 测试 PASS；review 已有测试均 PASS（包含 buildReviewPrompt 的 C3 回归如适用）。

- [ ] **Step 4: 提交**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
git add plugins/minimax/scripts/lib/minimax.mjs plugins/minimax/scripts/lib/minimax.test.mjs
git commit -m "feat(Task 5.2): RED/BLUE stance constants + buildAdversarialPrompt + tests"
```

---

## Task 5.3 — `callMiniAgentAdversarial` 包装器（双 spawn，红蓝独立）

调 `_callReviewLike` 两次：第一次 stance=red，第二次 stance=blue。两次都成功才整体 ok。两次都共享同一个 schemaPath / cwd / timeout / bin / logDir。queue slot 在外层（`runAdversarialReview`）已 acquire，本函数不动 queue。

**Files:**
- Modify: `plugins/minimax/scripts/lib/minimax.mjs`
- Test: `plugins/minimax/scripts/lib/minimax-adversarial.test.mjs`（新建，避免污染 minimax.test.mjs）

- [ ] **Step 1: 在 `minimax.mjs` 紧贴 `callMiniAgentReview` 之后追加 `callMiniAgentAdversarial`**

```js
/**
 * Adversarial review: spawn mini-agent twice, once with red stance, once with
 * blue stance. Both must succeed for ok=true. Each side gets its own 1-shot
 * retry budget independently.
 *
 * The caller is responsible for queue serialization (runAdversarialReview holds
 * a single queue slot across both spawns — see Plan §D5.3).
 *
 * v2 (I5): error string omits "red-team failed:" / "blue-team failed:" prefix
 *          since `side` field already conveys which viewpoint failed.
 *          Avoids stderr nesting like "Error: call-failed (red team) -- red-team failed: ...".
 *
 * @returns Promise<
 *   | { ok: true, red: <reviewSuccess>, blue: <reviewSuccess> }
 *   | { ok: false, side: "red"|"blue", red?: any, blue?: any, error: string }
 * >
 */
export async function callMiniAgentAdversarial({
  context,
  focus = "",
  schemaPath,
  cwd,
  timeout = 120_000,
  bin,
  logDir,
  truncated = false,
  onProgressLine,
}) {
  const wrapStance = (stance) => (line) => {
    if (typeof onProgressLine === "function") onProgressLine(`[${stance}] ${line}`);
  };

  const redResult = await _callReviewLike({
    buildPrompt: ({ retryHint, previousRaw } = {}) =>
      buildAdversarialPrompt({ stance: "red", schemaPath, focus, context, retryHint, previousRaw }),
    schemaPath,
    cwd,
    timeout,
    bin,
    logDir,
    truncated,
    onProgressLine: onProgressLine ? wrapStance("red") : undefined,
    retryWarning: "Warning: minimax adversarial-review (red) response failed parse/validation; retrying once with error hint...\n",
    errorPrefix: "prompt-build-failed", // v2 (I1): adversarial-review uses distinct prefix
  });

  if (!redResult.ok) {
    return {
      ok: false,
      side: "red",
      red: redResult,
      error: redResult.error, // v2 (I5): no extra prefix; `side` conveys which team
    };
  }

  const blueResult = await _callReviewLike({
    buildPrompt: ({ retryHint, previousRaw } = {}) =>
      buildAdversarialPrompt({ stance: "blue", schemaPath, focus, context, retryHint, previousRaw }),
    schemaPath,
    cwd,
    timeout,
    bin,
    logDir,
    truncated,
    onProgressLine: onProgressLine ? wrapStance("blue") : undefined,
    retryWarning: "Warning: minimax adversarial-review (blue) response failed parse/validation; retrying once with error hint...\n",
    errorPrefix: "prompt-build-failed", // v2 (I1)
  });

  if (!blueResult.ok) {
    return {
      ok: false,
      side: "blue",
      red: redResult,
      blue: blueResult,
      error: blueResult.error, // v2 (I5)
    };
  }

  return {
    ok: true,
    red: redResult,
    blue: blueResult,
  };
}
```

- [ ] **Step 2: 新建测试 `plugins/minimax/scripts/lib/minimax-adversarial.test.mjs`**

> v2 (I6): 参照 **`plugins/minimax/scripts/lib/minimax.ask.test.mjs::mkMockMiniAgent`**（成熟的 sh-based mock helper）。本任务的 mock 改为 sh 脚本与既有约定一致。
>
> v2 (I4): logFile 名直接含 `Math.random().toString(36).slice(2,8)` 后缀，retry 同秒不冲突。
>
> v2 (I2): mock 把每次 spawn 的 stance 追加到 trace 文件，红失败测试用 trace 断言"红 2 次（首+retry）/ 蓝 0 次"，证明 blue 真未 spawn。
>
> v2 (Qwen Critical): 响应字符串通过 **env 变量** 而非 template literal 插值传给子进程（避免 backtick / `$` 字符破坏外层 template literal）。

```sh
#!/bin/sh
# (Mock binary skeleton — actual file written by makeFakeBin below)
# Reads $MOCK_RED_RESPONSE / $MOCK_BLUE_RESPONSE / $MOCK_TRACE_FILE from env.
PROMPT=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-t" ]; then shift; PROMPT="$1"; break; fi
  shift
done
case "$PROMPT" in
  *"你是红队"*) STANCE=red; RESPONSE="$MOCK_RED_RESPONSE" ;;
  *"你是蓝队"*) STANCE=blue; RESPONSE="$MOCK_BLUE_RESPONSE" ;;
  *) STANCE=unknown; RESPONSE="" ;;
esac
echo "$STANCE" >> "$MOCK_TRACE_FILE"
TS=$(date +%Y%m%d_%H%M%S)
RAND=$(awk 'BEGIN{srand(); printf "%06x", int(rand()*16777216)}')
LOGFILE="$MOCK_LOG_DIR/agent_run_${TS}_${STANCE}_${RAND}.log"
printf "Log file: %s\n" "$LOGFILE"
{
  printf "[1] REQUEST\n"
  printf '%.0s-' $(seq 1 80); printf "\n{}\n"
  printf "[2] RESPONSE\n"
  printf '%.0s-' $(seq 1 80); printf "\n"
  # Inline RESPONSE JSON: content field carries the canned response
  printf '{"content":%s,"finish_reason":"stop"}\n' "$(printf '%s' "$RESPONSE" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))')"
} > "$LOGFILE"
printf "Session Statistics:\n"
exit 0
```

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { callMiniAgentAdversarial } from "./minimax.mjs";

const SCHEMA_PATH = path.resolve("plugins/minimax/schemas/review-output.schema.json");

// makeFakeBin writes a sh script (per Phase 1 mkMockMiniAgent convention) that
// reads RESPONSE strings from env. This avoids template-literal injection from
// backticks / $-chars in the canned responses.
function makeFakeBin({ redResponse, blueResponse }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-agent-fake-"));
  const binPath = path.join(tmpDir, "mini-agent");
  const logDir = path.join(tmpDir, "log");
  const traceFile = path.join(tmpDir, "trace.log");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(traceFile, "");

  const script = `#!/bin/sh
PROMPT=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-t" ]; then shift; PROMPT="$1"; break; fi
  shift
done
case "$PROMPT" in
  *"你是红队"*) STANCE=red; RESPONSE="$MOCK_RED_RESPONSE" ;;
  *"你是蓝队"*) STANCE=blue; RESPONSE="$MOCK_BLUE_RESPONSE" ;;
  *) STANCE=unknown; RESPONSE="" ;;
esac
echo "$STANCE" >> "$MOCK_TRACE_FILE"
TS=$(date +%Y%m%d_%H%M%S)
RAND=$(awk 'BEGIN{srand(); printf "%06x", int(rand()*16777216)}')
LOGFILE="$MOCK_LOG_DIR/agent_run_\${TS}_\${STANCE}_\${RAND}.log"
printf "Log file: %s\\n" "$LOGFILE"
{
  printf "[1] REQUEST\\n"
  printf '%.0s-' $(seq 1 80); printf "\\n{}\\n"
  printf "[2] RESPONSE\\n"
  printf '%.0s-' $(seq 1 80); printf "\\n"
  printf '{"content":%s,"finish_reason":"stop"}\\n' "$(printf '%s' "$RESPONSE" | node -e 'process.stdout.write(JSON.stringify(require(\\"fs\\").readFileSync(0,\\"utf8\\")))')"
} > "$LOGFILE"
printf "Session Statistics:\\n"
exit 0
`;
  fs.writeFileSync(binPath, script, { mode: 0o755 });

  // Caller passes responses via env so spawn picks them up. callMiniAgent inherits env.
  process.env.MOCK_RED_RESPONSE = redResponse;
  process.env.MOCK_BLUE_RESPONSE = blueResponse;
  process.env.MOCK_TRACE_FILE = traceFile;
  process.env.MOCK_LOG_DIR = logDir;

  return {
    binPath,
    logDir,
    traceFile,
    readTrace: () => fs.readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean),
    cleanup: () => {
      delete process.env.MOCK_RED_RESPONSE;
      delete process.env.MOCK_BLUE_RESPONSE;
      delete process.env.MOCK_TRACE_FILE;
      delete process.env.MOCK_LOG_DIR;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

const VALID_REVIEW = JSON.stringify({
  verdict: "needs-attention",
  summary: "test summary",
  findings: [{
    severity: "high",
    title: "t",
    body: "b",
    file: "x.js",
    line_start: 1,
    line_end: 1,
    confidence: 0.9,
    recommendation: "fix it",
  }],
  next_steps: ["s1"],
});

test("callMiniAgentAdversarial: both stances succeed → ok with red+blue", async () => {
  const fake = makeFakeBin({ redResponse: VALID_REVIEW, blueResponse: VALID_REVIEW });
  try {
    const r = await callMiniAgentAdversarial({
      context: "diff",
      focus: "",
      schemaPath: SCHEMA_PATH,
      cwd: process.cwd(),
      timeout: 30_000,
      bin: fake.binPath,
      logDir: fake.logDir,
    });
    assert.equal(r.ok, true);
    assert.equal(r.red.ok, true);
    assert.equal(r.blue.ok, true);
    assert.equal(r.red.verdict, "needs-attention");
    assert.equal(r.blue.verdict, "needs-attention");
    const trace = fake.readTrace();
    assert.deepEqual(trace, ["red", "blue"], "exactly one red then one blue spawn");
  } finally {
    fake.cleanup();
  }
});

test("callMiniAgentAdversarial: red parse fails → ok=false side=red, no blue spawn (trace asserts)", async () => {
  const fake = makeFakeBin({ redResponse: "not json at all", blueResponse: VALID_REVIEW });
  try {
    const r = await callMiniAgentAdversarial({
      context: "diff",
      focus: "",
      schemaPath: SCHEMA_PATH,
      cwd: process.cwd(),
      timeout: 30_000,
      bin: fake.binPath,
      logDir: fake.logDir,
    });
    assert.equal(r.ok, false);
    assert.equal(r.side, "red");
    assert.ok(r.red.retry_used, "red retry must have been attempted");
    assert.equal(r.blue, undefined, "blue field must be absent when red failed");
    // v2 (I2): true assertion that blue did NOT spawn
    const trace = fake.readTrace();
    const redCount = trace.filter(s => s === "red").length;
    const blueCount = trace.filter(s => s === "blue").length;
    assert.equal(redCount, 2, "red must have spawned exactly 2 times (first + retry)");
    assert.equal(blueCount, 0, "blue must NOT have spawned");
  } finally {
    fake.cleanup();
  }
});

test("callMiniAgentAdversarial: blue parse fails → ok=false side=blue, red still surfaced", async () => {
  const fake = makeFakeBin({ redResponse: VALID_REVIEW, blueResponse: "garbage" });
  try {
    const r = await callMiniAgentAdversarial({
      context: "diff",
      focus: "",
      schemaPath: SCHEMA_PATH,
      cwd: process.cwd(),
      timeout: 30_000,
      bin: fake.binPath,
      logDir: fake.logDir,
    });
    assert.equal(r.ok, false);
    assert.equal(r.side, "blue");
    assert.equal(r.red.ok, true);
    assert.equal(r.blue.ok, false);
    // v2 (I2): trace asserts red spawned 1x, blue spawned 2x (first + retry)
    const trace = fake.readTrace();
    const redCount = trace.filter(s => s === "red").length;
    const blueCount = trace.filter(s => s === "blue").length;
    assert.equal(redCount, 1, "red spawned once (success)");
    assert.equal(blueCount, 2, "blue spawned twice (first + retry)");
  } finally {
    fake.cleanup();
  }
});
```

- [ ] **Step 3: 跑测试**

Run: `cd /Users/bing/-Code-/minimax-plugin-cc && node --test plugins/minimax/scripts/lib/minimax-adversarial.test.mjs 2>&1 | tail -15`
Expected: 3 条 PASS（both-succeed / red-fail-no-blue-spawn / blue-fail-red-surfaced）。

若 mock 脚本写得有问题（很可能 retry 的第二次 spawn 也写同名 log 导致 race），加 `Math.random()` 后缀到 `logFile`。

- [ ] **Step 4: 跑全套测试确认无回归**

Run: `cd /Users/bing/-Code-/minimax-plugin-cc && node --test plugins/minimax/scripts/lib/*.test.mjs 2>&1 | tail -10`
Expected: 总数 = 79（基线）+ 4（Task 5.2）+ 3（Task 5.3）= 86 PASS / 0 fail。

- [ ] **Step 5: 提交**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
git add plugins/minimax/scripts/lib/minimax.mjs plugins/minimax/scripts/lib/minimax-adversarial.test.mjs
git commit -m "feat(Task 5.3): callMiniAgentAdversarial — dual-spawn red+blue both-required"
```

---

## Task 5.4 — `runAdversarialReview` companion subcommand

把 `runReview`（companion 第 339-488 行）作为模板，在它正下方加 `runAdversarialReview`。差异：
1. 不需要 `merge-conflict-present` 之外的扩字段（schema 同 review）
2. queue slot 时长 `timeout * 4 + 30_000`（红 1 + 红 retry 1 + 蓝 1 + 蓝 retry 1 = 4 个 timeout）
3. JSON 输出 shape：`{status, red:{...}, blue:{...}}` for ok；`{status, side, error, ...}` for fail
4. text 输出：先 `=== Red Team ===` 块（verdict/summary/findings/next_steps），再 `=== Blue Team ===` 块；不合并 findings；在两块之间输出空行

**Files:**
- Modify: `plugins/minimax/scripts/minimax-companion.mjs`

- [ ] **Step 1: 顶部 import 段（约 18 行）追加 `callMiniAgentAdversarial`**

把：
```js
import {
  ...
  callMiniAgentReview,
} from "./lib/minimax.mjs";
```
改为：
```js
import {
  ...
  callMiniAgentReview,
  callMiniAgentAdversarial,
} from "./lib/minimax.mjs";
```

- [ ] **Step 2: 在 `runReview` 后（约 488 行）插入 `runAdversarialReview`**

```js
// Task 5.4: runAdversarialReview subcommand

const ADVERSARIAL_STATUS_EXIT = {
  "no-diff": 2,
  "no-base": 2,
  "bad-scope": 2,
  "merge-conflict-present": 2,
  "git-diff-failed": 6,
  "call-failed": 4,
  "parse-validate-failed": 5,
};

async function runAdversarialReview(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, {
    booleanOptions: ["json"],
    valueOptions: ["timeout", "cwd", "base", "scope"],
  });

  const cwd = options.cwd || process.cwd();
  const base = options.base || null;
  const scope = options.scope || "auto";
  const focus = positionals.join(" ").trim();
  const timeout = options.timeout ? Number(options.timeout) : 120_000;

  if (!Number.isFinite(timeout) || timeout <= 0) {
    if (options.json) {
      process.stdout.write(JSON.stringify({ status: "bad-input", reason: `invalid --timeout '${options.timeout}'` }) + "\n");
    } else {
      process.stderr.write(`Error: invalid --timeout '${options.timeout}'\n`);
    }
    process.exit(1);
  }

  const diffResult = collectDiff({ base, scope, cwd });
  if (!diffResult.ok) {
    const exitCode = ADVERSARIAL_STATUS_EXIT[diffResult.reason] ?? 6;
    const payload = { status: diffResult.reason, detail: diffResult.detail };
    if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stderr.write(`Error: ${diffResult.reason} -- ${diffResult.detail}\n`);
    process.exit(exitCode);
  }
  if (!diffResult.diff.trim()) {
    const payload = { status: "no-diff", detail: `scope=${diffResult.scope} yielded empty diff` };
    if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stdout.write(`No changes under scope=${diffResult.scope}; nothing to adversarially review.\n`);
    process.exit(2);
  }

  if (!options.json) {
    process.stdout.write(`Adversarial review (scope=${diffResult.scope}${base ? ", base=" + base : ""}, focus="${focus || "(none)"}")...\n`);
    // v2 (I14): cold start实测 ~10s（不是 ~3s）；双 spawn 总 ~50-90s 主路径
    // v2 (I15): 显式 UX 提示 queue slot 持有窗口
    process.stdout.write("Starting MiniMax red team (cold start ~10s; full red+blue ~50-90s)...\n");
    process.stdout.write("Queue slot held for adversarial-review (~60s typical, up to ~120s with retries); other /minimax:* commands will wait.\n");
    // v0.2 TODO: consider --single-spawn / --fast flag for cold-start-sensitive use (M11)
  }

  const schemaPath = path.resolve(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas", "review-output.schema.json")
  );

  const onProgressLine = options.json ? undefined : (line) => {
    process.stderr.write(stripAnsiSgr(line) + "\n");
  };

  // D5.3: hold a single queue slot across both red and blue spawns + each
  // side's 1-shot retry. Worst case: 2 stances × 2 spawns each = 4 × timeout.
  //
  // v2 (I7): cwd is shared across both spawns. Adversarial-review prompts are
  // explicitly read-only (prompts/adversarial-review.md 末尾声明 "本任务是只读
  // 审查...只输出 JSON"), but Mini-Agent's file-write tool is not blocked at
  // the runtime level. If the model violates the prompt and writes a file,
  // blue stance's second spawn will read the polluted cwd. Acceptable for v0.1;
  // tripwire (minimax-result-handling SKILL §suspicious bash) catches obvious abuse.
  const workspaceRoot = defaultWorkspaceRoot();
  const slot = await acquireQueueSlot(workspaceRoot, { maxWaitMs: timeout * 4 + 30_000 });
  if (!slot.acquired) {
    const payload = { status: "queue-timeout", reason: slot.reason };
    if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stderr.write(`Error: queue-timeout (${slot.reason})\n`);
    process.exit(4);
  }

  let r;
  try {
    r = await callMiniAgentAdversarial({
      context: diffResult.diff,
      focus,
      schemaPath,
      cwd,
      timeout,
      onProgressLine,
    });
  } finally {
    releaseQueueSlot(workspaceRoot, slot.token);
  }

  if (r.ok) {
    if (options.json) {
      process.stdout.write(JSON.stringify({
        status: "ok",
        red: pickViewpointPayload(r.red),
        blue: pickViewpointPayload(r.blue),
      }, null, 2) + "\n");
    } else {
      renderViewpointText("Red Team", r.red);
      process.stdout.write("\n");
      renderViewpointText("Blue Team", r.blue);
      const cfg = readMiniAgentConfig();
      const footerParts = [];
      if (cfg.model) footerParts.push(`model: ${cfg.model}`);
      if (r.red.logPath) footerParts.push(`red-log: ${r.red.logPath}`);
      if (r.blue.logPath) footerParts.push(`blue-log: ${r.blue.logPath}`);
      if (r.red.retry_used) footerParts.push("red-retry-used");
      if (r.blue.retry_used) footerParts.push("blue-retry-used");
      if (footerParts.length) process.stdout.write(`(${footerParts.join(" · ")})\n`);
    }
    process.exit(0);
  } else {
    // r.ok === false; r.side ∈ {red, blue}
    // diagnostic-only side gets surfaced; partial success (red ok, blue fail)
    // still exits non-zero — adversarial-review is all-or-nothing per T9.
    const failedSide = r.side === "red" ? r.red : r.blue;
    const reason = failedSide.diagnostic ? "call-failed" : "parse-validate-failed";
    const exitCode = ADVERSARIAL_STATUS_EXIT[reason] ?? 5;
    if (options.json) {
      process.stdout.write(JSON.stringify({
        status: reason,
        side: r.side,
        error: r.error,
        red: r.red ? pickViewpointPayload(r.red) : null,
        blue: r.blue ? pickViewpointPayload(r.blue) : null,
        firstRawText: failedSide.firstRawText ?? null,
        rawText: failedSide.rawText ?? null,
        parseError: failedSide.parseError ?? null,
        diagnostic: failedSide.diagnostic ?? null,
      }, null, 2) + "\n");
    } else {
      process.stderr.write(`Error: ${reason} (${r.side} team) -- ${r.error}\n`);
      if (failedSide.diagnostic && failedSide.diagnostic.stderrHeadTail) {
        process.stderr.write(`\n--- diagnostic (${r.side} stderr head+tail) ---\n${failedSide.diagnostic.stderrHeadTail}\n`);
      }
      if (failedSide.firstRawText) process.stderr.write(`\n(${r.side} first raw response, redacted, truncated)\n${failedSide.firstRawText.slice(0, 1500)}\n`);
      if (failedSide.rawText) process.stderr.write(`\n(${r.side} retry raw response, redacted, truncated)\n${failedSide.rawText.slice(0, 1500)}\n`);
      if (r.side === "blue" && r.red?.ok) {
        process.stderr.write(`\n(red team succeeded; rerun for blue. Red verdict: ${r.red.verdict})\n`);
      }
    }
    process.exit(exitCode);
  }
}

// Helpers shared by runAdversarialReview text/JSON output

function pickViewpointPayload(v) {
  // v is a reviewSuccess or reviewError shape; pick the fields meaningful in JSON output
  if (!v.ok) {
    return {
      ok: false,
      error: v.error,
      retry_used: v.retry_used,
      retriedOnce: v.retriedOnce,
    };
  }
  return {
    ok: true,
    verdict: v.verdict,
    summary: v.summary,
    findings: v.findings,
    next_steps: v.next_steps,
    retry_used: v.retry_used,
    retriedOnce: v.retriedOnce,
    retry_notice: v.retry_notice,
    truncated: v.truncated,
    logPath: v.logPath,
  };
}

function renderViewpointText(label, v) {
  process.stdout.write(`=== ${label} ===\n`);
  if (!v.ok) {
    process.stdout.write(`(${label} failed: ${v.error})\n`);
    return;
  }
  process.stdout.write(`Verdict: ${v.verdict}\n`);
  process.stdout.write(`Summary: ${v.summary}\n`);
  const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const findings = [...v.findings].sort((a, b) => (sevOrder[a.severity] ?? 99) - (sevOrder[b.severity] ?? 99));
  if (findings.length === 0) {
    process.stdout.write("Findings: (none)\n");
  } else {
    process.stdout.write(`Findings (${findings.length}):\n`);
    for (const f of findings) {
      process.stdout.write(`  - [${f.severity}] ${f.title}\n`);
      process.stdout.write(`    ${f.file}:${f.line_start}${f.line_end !== f.line_start ? "-" + f.line_end : ""}  (confidence ${f.confidence})\n`);
      process.stdout.write(`    ${f.body}\n`);
      process.stdout.write(`    fix: ${f.recommendation}\n`);
    }
  }
  if (v.next_steps.length) {
    process.stdout.write("Next steps:\n");
    for (const s of v.next_steps) process.stdout.write(`  - ${s}\n`);
  }
  if (v.retry_used) {
    process.stdout.write(`(${label}: retry used -- ${v.retry_notice})\n`);
  }
}
```

- [ ] **Step 3: 在 `main()` switch（约 852-882 行）追加 case**

在 `case "task-resume-candidate":` 之前插入：
```js
    case "adversarial-review":
      return await runAdversarialReview(rest);
```

- [ ] **Step 4: 在 `USAGE` 块（约 34 行起）追加段**

> v2 (I20): 插入前先验证 anchor 存在：
>
> ```bash
> grep -n '^  review \[--json\]' plugins/minimax/scripts/minimax-companion.mjs  # 必须返回非空
> grep -n '^  rescue \[--json\]' plugins/minimax/scripts/minimax-companion.mjs  # 必须返回非空
> ```
>
> 若 review anchor 不存在则 fallback 直接在 `rescue [--json]` 段之前插入；若两个都不存在则报错停下，不插入。

在 `review` 段之后、`rescue` 段之前插入：
```
  adversarial-review [--json] [--base <ref>] [--scope <auto|working-tree|staged|branch>]
                     [--timeout <ms>] [--cwd <path>] [focus ...]
                    Two-pass adversarial review (red team then blue team) on the
                    current git diff. Both viewpoints must succeed (T9 hard gate).
                    Exit codes:
                      0 = both red and blue succeeded
                      2 = no diff / no base / bad scope / merge conflict present
                      4 = mini-agent call failed on either side (or queue-timeout)
                      5 = parse/validate failed on either side
                      6 = git command failed
```

- [ ] **Step 5: 跑 companion 的 `--help` 并目检**

Run: `cd /Users/bing/-Code-/minimax-plugin-cc && node plugins/minimax/scripts/minimax-companion.mjs --help 2>&1 | grep -A 8 "adversarial-review"`
Expected: 看到刚加入的 USAGE 段。

- [ ] **Step 6: 跑全套测试**

Run: `cd /Users/bing/-Code-/minimax-plugin-cc && node --test plugins/minimax/scripts/lib/*.test.mjs 2>&1 | tail -10`
Expected: 86 PASS / 0 fail（无 companion 端测试，但回归一遍确保 import 没崩）。

- [ ] **Step 7: 提交**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
git add plugins/minimax/scripts/minimax-companion.mjs
git commit -m "feat(Task 5.4): runAdversarialReview companion subcommand (dual-stance, single-queue-slot)"
```

---

## Task 5.5 — `/minimax:adversarial-review` 命令文件

**Files:**
- Create: `plugins/minimax/commands/adversarial-review.md`

- [ ] **Step 1: 写命令文件**

```markdown
---
description: Run a MiniMax adversarial code review (red team + blue team) on the current diff
argument-hint: '[--json] [--base <ref>] [--scope <auto|working-tree|staged|branch>] [--timeout <ms>] [--cwd <path>] [focus ...]'
allowed-tools: Bash(node:*)
---

Invoke the minimax companion to run an adversarial review:

```bash
MINIMAX_COMPANION_CALLER=claude node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" adversarial-review "$ARGUMENTS"
```

Present the output to the user.

**Follow `minimax-result-handling/references/adversarial-review-render.md` for presentation rules.** Key points:

**If the companion exits 0** (both red and blue succeeded):
1. Render the red team block first (verdict, summary, findings, next_steps), then blue team block.
2. Within each block, sort findings by severity (critical > high > medium > low).
3. Do NOT merge findings across teams. Do NOT rank one team above the other in commentary.
4. If either team's `retry_used` is true, surface the per-team note inside that team's block.
5. Footer parenthesized: `(model: X · red-log: Y · blue-log: Z [· red-retry-used] [· blue-retry-used])`.
6. Do NOT auto-fix anything. The user picks which team's findings to address (often both are useful).

**If the companion exits non-zero**:
- exit 2 (`status` in JSON tells which): same `no-diff` / `no-base` / `bad-scope` / `merge-conflict-present` mapping as `/minimax:review`.
- exit 4 (`call-failed`, `side` indicates which team): mini-agent invocation failed on red or blue. Present the diagnostic block as-is. If `side === "blue"` and `red` payload is ok, surface the red verdict so the work isn't wasted.
- exit 5 (`parse-validate-failed`, `side` indicates which team): same as `/minimax:review` exit 5 — present `firstRawText` + `rawText` for the failing side under labeled headings; do NOT paraphrase. If `side === "blue"`, surface the red verdict.
- exit 6: git command failed. Surface the error directly.

**Do NOT retry automatically** on any failure. The user decides whether to rerun.

### Comparing with Claude's own `/review` or prior `/minimax:review`

If `/review` or `/minimax:review` ran earlier in the same conversation, present a 4-bucket comparison (Claude∩Red / Claude∩Blue / Red∩Blue / Unique-to-one). Do not merge findings; do not collapse Red and Blue into "MiniMax" — they are deliberately independent viewpoints. See `references/adversarial-review-render.md` for the bucket definitions and overlap criteria.
```

- [ ] **Step 2: 提交**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
git add plugins/minimax/commands/adversarial-review.md
git commit -m "feat(Task 5.5): /minimax:adversarial-review command (dispatch + render rules)"
```

---

## Task 5.6 — `references/adversarial-review-render.md` skill 引用

**Files:**
- Create: `plugins/minimax/skills/minimax-result-handling/references/adversarial-review-render.md`

- [ ] **Step 1: 写 reference**

```markdown
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
- v2 (I13): Bucket into **4 explicit intersections**:
  - **Claude ∩ Red** — Claude and red team both flagged
  - **Claude ∩ Blue** — Claude and blue team both flagged (rare; usually means Claude noted a mitigation gap blue also caught)
  - **Red ∩ Blue** — Both teams flagged (high-confidence signal)
  - **Unique-to-one** — Each remaining finding tagged with its sole source (Claude / Red / Blue)
- DO NOT collapse Red and Blue into "MiniMax" — they are deliberately independent viewpoints
- v2 (I16): MiniMax's red+blue is a deliberate divergence from kimi/gemini (single red-team only). When the user has a /kimi:adversarial-review or /gemini:adversarial-review output also in conversation, do NOT merge it with MiniMax red+blue as if they were the same shape; treat the kimi/gemini result as a third independent voice (its own row in the comparison)

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
```

- [ ] **Step 2: 提交**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
git add plugins/minimax/skills/minimax-result-handling/references/adversarial-review-render.md
git commit -m "docs(Task 5.6): adversarial-review-render skill reference"
```

---

## Task 5.7 — `minimax-prompting` skill 定稿

去掉 v0.1 skeleton 痕迹，补三个 references。

**Files:**
- Modify: `plugins/minimax/skills/minimax-prompting/SKILL.md`
- Create: `plugins/minimax/skills/minimax-prompting/references/minimax-prompt-recipes.md`
- Create: `plugins/minimax/skills/minimax-prompting/references/minimax-prompt-antipatterns.md`
- Create: `plugins/minimax/skills/minimax-prompting/references/prompt-blocks.md`

- [ ] **Step 1: 改写 `SKILL.md`** — 完整内容替换为：

```markdown
---
name: minimax-prompting
description: Internal guidance for composing Mini-Agent prompts for coding, review, diagnosis, and adversarial-review tasks inside the minimax plugin. Emphasizes MiniMax-M2's Chinese prose strength and Mini-Agent's native file/bash/Skills/MCP tools.
---

# minimax-prompting (v1, Phase 5 finalization)

Guidance for Claude when composing a prompt to send to Mini-Agent via `minimax-companion.mjs`. Not user-facing.

## Scope

This skill guides prompt construction for `/minimax:ask`, `/minimax:review`, `/minimax:rescue`, `/minimax:adversarial-review`. v1 reflects what was actually validated through Phase 1-5 smoke tests against MiniMax-M2 7B/Coding-Plan endpoints.

## Universal rules

1. **Output contract first.** State the expected output format in the first paragraph. For JSON: explicitly say "Return ONLY a JSON object matching this schema. No prose before or after. No markdown code fence." Echo the schema as a fenced JSON block immediately after.

2. **Context in labeled blocks.** Wrap code/diff/docs in labeled blocks (`### Diff to review` / `### Files under investigation`). Do not interleave instructions and content.

3. **Language parity.** MiniMax-M2's Chinese reasoning is strong; keep instruction language aligned with user prompt language. Do not force English on Chinese prompts. The output schema enums (severity / verdict) MUST stay English even when surrounding prose is Chinese — explicitly call this out in the prompt (see `references/prompt-blocks.md` `output-contract-bilingual` block).

4. **Stance prompts are single-stance.** For `/minimax:adversarial-review`, do NOT mix red and blue stance instructions in one prompt — even if asked nicely, the model biases toward whichever stance appears last. Use two independent spawns (Phase 5 architecture), each with one stance constant from `minimax.mjs` (`RED_STANCE_INSTRUCTION` / `BLUE_STANCE_INSTRUCTION`).

5. **Leverage Mini-Agent native tools.** For `/minimax:rescue`, include the available Skills whitelist in the prompt:
   > "You have access to 15 Claude Skills (xlsx / pdf / pptx / docx / canvas-design / algorithmic-art / theme-factory / brand-guidelines / artifacts-builder / webapp-testing / mcp-builder / skill-creator / internal-comms / slack-gif-creator / template-skill). Invoke them via `get_skill(<name>)` when relevant."

6. **No tool-call loops on simple questions.** For `/minimax:ask`, prefer prompts that don't require bash/file tools. Mini-Agent's classifier treats unfinished tool-call sessions as incomplete (see `minimax-cli-runtime` SKILL §classifier).

7. **Suspicious bash interception.** `/minimax:rescue --sandbox` does not provide true isolation (spec §4.6). When passing prompts that may invoke bash, prefer explicit scopes: "Only modify files under the workspace directory. Do NOT use absolute paths outside it." This is best-effort; the actual tripwire lives in `minimax-result-handling`.

8. **Retry hint reuse.** When a JSON parse/validate fails, the second-shot retry prompt MUST include the schema validation error AND the previous response (redacted, capped 1500 chars) — this lets the model self-correct. See `buildReviewPrompt` and `buildAdversarialPrompt` for the canonical implementation.

## References

- `references/minimax-prompt-recipes.md` — recipes for Chinese coding reviews, multi-step agent tasks, Skills invocation (PDF / xlsx), MCP tool usage, both-stance adversarial setup
- `references/minimax-prompt-antipatterns.md` — prompts that empirically fail on MiniMax-M2 (collected from Phase 2-5 smoke runs)
- `references/prompt-blocks.md` — reusable blocks: tool-use guidance, workspace constraints, output contracts, stance instructions
```

- [ ] **Step 2: 写 `references/minimax-prompt-recipes.md`**

> v2 (C5): 外层 markdown 围栏用 4 反引号，内层代码块保持 3 反引号，避免 fence 嵌套渲染断裂。
> v2 (I12): red/blue stance recipe 展开实际 stance 文本片段。

````markdown
# minimax-prompt-recipes

Recipes pulled from Phase 1-5 smoke runs against MiniMax-M2 7B and Coding-Plan endpoints.

## Recipe: Chinese-language code review

```
你是一名资深代码审查员，请对下面的 diff 做一次审查。
返回严格匹配下面 schema 的 RAW JSON，不要 markdown 代码栅栏，不要前言后记。
severity 字段必须是英文枚举：critical / high / medium / low（中文严重度会让 schema 校验失败）。

# Schema
```json
{ ... }
```

# Diff
```
{ ... diff ... }
```
```

适用：M2.7 中文 prose 输出能力，比强迫英文版准确率更高。

## Recipe: Multi-step agent task with Skills

```
请帮我把 input.csv 转换成排序后的 Excel 文件，按 region 分 sheet。
你可以使用以下 Claude Skills：xlsx / pdf / pptx / docx / canvas-design / algorithmic-art / theme-factory / brand-guidelines / artifacts-builder / webapp-testing / mcp-builder / skill-creator / internal-comms / slack-gif-creator / template-skill。
通过 get_skill(<name>) 加载需要的 skill。
只在 workspace 目录下读写文件，不要使用绝对路径（this is an isolated workdir, not a security sandbox）。
```

适用：`/minimax:rescue --sandbox`。Skills 列表中文友好；声明 workspace 边界减小后续 tripwire 命中率。

## Recipe: Adversarial-review red stance (programmatic)

由 `buildAdversarialPrompt({stance: "red", ...})` 自动注入 `RED_STANCE_INSTRUCTION`。其核心要点（手写时勿迂回）：

- summary 写成 ship/no-ship 判定（"不要发布" / "阻塞 release"），不要平衡修辞（"既有改进也有顾虑"）
- 攻击面：鉴权 / 数据丢失 / 回滚 / 竞态 / empty-state / 版本漂移 / observability
- 不要用"可能" / "或许"软化 finding；要么有依据写实，要么删掉
- severity 用英文枚举 critical/high/medium/low
- 本任务只读：不写文件、不执行修改型 bash

完整文本见 `plugins/minimax/scripts/lib/minimax.mjs::RED_STANCE_INSTRUCTION`；手写禁忌另见 `minimax-prompt-antipatterns.md` "单 prompt 同时要求红+蓝 findings"。

## Recipe: Adversarial-review blue stance (programmatic)

由 `buildAdversarialPrompt({stance: "blue", ...})` 自动注入 `BLUE_STANCE_INSTRUCTION`。其核心要点（与红队措辞反向）：

- summary 写成 ship-with-confidence 或 ship-with-mitigations 判定，不要向红队靠拢
- 任务重心：(1) 评估现有防御层是否充分 (schema 校验/类型系统/上游 sanitize/测试覆盖等)；(2) 找低成本 mitigation gap
- finding 是 mitigation gap，不是 risk；recommendation 必须是具体动作
- severity 校准：critical = 不补会出生产事故；high = 显著运维风险；medium = 维护期 toil；low = 可选打磨
- 找不到 mitigation gap 时 `findings` 空数组合法（不影响 T9）
- 本任务只读

完整文本见 `plugins/minimax/scripts/lib/minimax.mjs::BLUE_STANCE_INSTRUCTION`。

## Recipe: ask question (no JSON)

```
（中文直接问，不需要 schema 块）
帮我用一句话解释什么是 Bloom filter？
```

适用：`/minimax:ask`。不要给 schema、不要给输出格式约束 —— 否则 M2.7 会输出空 JSON。

## Recipe: rescue 多文件改动 with constraint declaration

```
请在 plugins/foo/ 下加一个新模块 bar.js，导出 doBar() 函数。
约束：
1. 只在 plugins/foo/ 目录下读写文件，不动其他目录（this is an isolated workdir, not a security sandbox）
2. 不调用 git commit，让用户自己 review
3. 写完后跑 plugins/foo/test.js 验证
```

适用：`/minimax:rescue --sandbox`。约束写在编号列表里，比 prose 更稳定。
````

- [ ] **Step 3: 写 `references/minimax-prompt-antipatterns.md`**

> v2 (C5): 外层 4 反引号，内层保持 3 反引号。

````markdown
# minimax-prompt-antipatterns

Empirically failed prompts on MiniMax-M2 7B and Coding-Plan endpoints, collected during Phase 2-5 smoke runs.

## Anti-pattern: 让 M2.7 翻译已是中文的输入

```
请把下面的中文需求翻译成英文，再做 review：
（中文 diff）
```

失败：M2.7 拒绝翻译"已经是目标语言"的输入；返回原文或空 response。
修复：直接中文问，保留中文输入。

## Anti-pattern: severity 字段允许中文

```
schema 上写了 severity ∈ {critical, high, medium, low}，但用户用中文 prompt 时模型经常返回 severity: "高"。
```

失败：schema validator 报 enum 错。
修复：prompt 显式声明 "severity 必须是英文枚举之一：critical / high / medium / low；中文严重度会让 schema 校验失败"。

## Anti-pattern: 单 prompt 同时要求红+蓝 findings

```
请同时从红队和蓝队两个视角审查这次 diff，红队 findings 和蓝队 findings 各列一组。
```

失败：M2.7 偏向最后出现的 stance 指令，红队 findings 经常变成稀疏 placeholder；T9 抖动严重。
修复：双 spawn 架构（Phase 5）。每次只灌一个 stance。kimi-plugin-cc 通过单 stance 设计天然规避此坑；minimax 因双 stance 需求采用双 spawn。

## Anti-pattern: ask 命令带 schema

```
（/minimax:ask）请回答 X 问题，并按下面 schema 返回 JSON。
```

失败：classifier 判 success-but-empty；用户看到空字符串。
修复：ask 命令不传 schema 段；让模型自由输出 prose。

## Anti-pattern: prompt 末尾留 "thanks"/"如有疑问请告知"

M2.7 会把这种社交语句视为信号，附上 "好的，希望对你有帮助" 之类后记，破坏 RAW JSON 输出。
修复：prompt 严格收束于 schema 段，不留社交收尾。

## Anti-pattern: 在 retry hint 里责怪模型

```
你上次输出失败了，请这次写对。
```

失败：模型自我防御行为（输出"你说我错了，但其实我是对的，因为..."），retry 也失败。
修复：客观描述失败原因（"schema validation errors: ..."）+ 回灌前 1500 字脱敏原文，让模型自己定位错在哪。retry hint 与主体 prompt 用同一种语言（M2.7 中文 prompt 下 retry hint 也用中文，避免双语切换）。

## Anti-pattern: rescue 模式下问问题

```
（/minimax:rescue）请解释这段代码做什么。
```

失败：rescue 是 agent dispatch，模型会启动 bash 工具去探索文件系统；UX 不符合预期，且额外消耗 quota。
修复：解释类问题用 `/minimax:ask`；rescue 留给"做事"任务。

## Anti-pattern: prompt placeholder 用通配正则做 leftover guard

```js
// 错的写法（C3 bug）：
const leftover = result.match(/\{\{[A-Z_]+\}\}/);
if (leftover) throw new Error(...);
```

失败：用户的 diff 含 React/Vue 模板语法（`{{userName}}` 等）会误命中并抛错。
修复：用预期 placeholder 白名单 set，且在 `{{CONTEXT}}` 替换之前做校验（context 里的 `{{...}}` 是 user data，不是 placeholder）。
````

- [ ] **Step 4: 写 `references/prompt-blocks.md`**

> v2 (C5): 外层 4 反引号，内层保持 3 反引号。

````markdown
# prompt-blocks

Reusable prompt fragments. Copy-paste into prompt builders; do NOT reword (consistency matters for retry self-correction).

## Block: output-contract-bilingual

中文 prompt 上下文里强制 enum 字段保持英文：

```
# 输出契约

- 仅返回 RAW JSON 对象，严格匹配下方 schema。
- 不写前言后记，不要 markdown 代码栅栏。
- severity 字段必须是英文枚举之一：critical / high / medium / low。中文严重度（严重/高/中/低）会让 schema 校验失败。
- verdict 字段必须是英文枚举之一：approve / needs-attention。
- 每条 finding 必须包含全部字段；缺一即整条 finding 被拒。
- 不要编造行号；不确定时整条 finding 删掉。
```

## Block: workspace-constraint

`/minimax:rescue` 场景下声明 workspace 边界，降低 tripwire 命中（this is an isolated workdir, not a security sandbox）：

```
约束：
1. 只在 workspace 目录下读写文件，不要使用 / 开头的绝对路径（workspace 是隔离 workdir，不是安全 sandbox）
2. 不要执行 sudo / chmod 0777 / curl | sh / rm -rf / 这类危险命令
3. 不要 git commit；改完让用户自己 review
4. 找不到需要的工具时，先用 get_skill(<name>) 加载 Claude Skills，不要自己 pip install
```

## Block: skills-whitelist

`/minimax:rescue` 任务可能用到 Skills 时附上：

```
你可以使用以下 Claude Skills：
xlsx / pdf / pptx / docx / canvas-design / algorithmic-art / theme-factory / brand-guidelines / artifacts-builder / webapp-testing / mcp-builder / skill-creator / internal-comms / slack-gif-creator / template-skill。
通过 get_skill(<name>) 按需加载。
```

## Block: retry-hint

JSON parse / validate 失败时的 retry hint（programmatic，由 buildReviewPrompt / buildAdversarialPrompt 注入）：

```
# Retry note

Your previous response failed validation: <SPECIFIC ERROR>. Output RAW JSON ONLY matching the schema above — no code fences, no preamble.

## Previous response (verbatim, first 1500 chars, secrets redacted)

<REDACTED PREVIOUS RAW>
```

理由：客观描述错误 + 回灌原文，让模型自己定位。绝不写"你上次错了"这种判定型措辞。

## Block: red-team stance

由 `RED_STANCE_INSTRUCTION` 模块常量提供（`scripts/lib/minimax.mjs`）。手写禁忌见 antipatterns "单 prompt 同时要求红+蓝 findings"。

## Block: blue-team stance

由 `BLUE_STANCE_INSTRUCTION` 模块常量提供（`scripts/lib/minimax.mjs`）。**蓝队的 finding 是 mitigation gap，不是 risk** —— recommendation 字段必须给具体动作。
````

- [ ] **Step 5: 提交**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
git add plugins/minimax/skills/minimax-prompting/
git commit -m "docs(Task 5.7): minimax-prompting skill v1 finalized — recipes / antipatterns / prompt-blocks"
```

---

## Task 5.8 — `minimax-cli-runtime` v1 + `minimax-result-handling` v1 polish

**Files:**
- Modify: `plugins/minimax/skills/minimax-cli-runtime/SKILL.md`
- Modify: `plugins/minimax/skills/minimax-result-handling/SKILL.md`

- [ ] **Step 1: `minimax-cli-runtime/SKILL.md` 头部 frontmatter 改 description**

把第 3 行的 `v0.1` 改为 `v1`：

old:
```
description: Internal helper contract for calling the minimax-companion runtime from Claude Code. v0.1 — finalized after 13 Phase 0 probes against Mini-Agent 0.1.0.
```

new:
```
description: Internal helper contract for calling the minimax-companion runtime from Claude Code. v1 — finalized after Phase 0-5 (13 probes + ask/review/rescue/adversarial-review live wiring) against Mini-Agent 0.1.0.
```

把 `# minimax-cli-runtime` 之后第一行 "Internal contract for code invoking..." 段保持不变。

- [ ] **Step 2: ~~在 `minimax-cli-runtime/SKILL.md` 末尾追加段~~** **(v2 C7: 删除此 step)**

> v2 (C7, Gemini): SKILL.md 是 LLM 上下文消费品，不应放历史流水帐 token 浪费。Phase 4-5 deltas 内容并入 lessons.md §D 对应坑。本 Step 跳过；Step 1 frontmatter `v0.1` → `v1` 修改保留。
>
> 唯一保留的 SKILL.md 内容修订：frontmatter 的 description 行（Step 1）。除此之外不动 cli-runtime SKILL.md。

- [ ] **Step 3: `minimax-result-handling/SKILL.md` 改 "What still needs Phase 3+ work" 段**

把这段（约第 84-88 行）：
```markdown
## What still needs Phase 3+ work

- `references/review-render.md` -- severity-sorted findings, JSON schema validation story (Phase 3)
- `references/rescue-render.md` -- multi-step progress rendering + sandbox boundary reminder (Phase 4)
- Token-usage story -- Mini-Agent currently doesn't surface token counts; do not claim costs
```

替换为：
```markdown
## v1 status (Phase 5 complete)

All references in `references/` are populated and reflect Phase 1-5 actual behavior:

- `references/ask-render.md` (Phase 2)
- `references/review-render.md` (Phase 3)
- `references/rescue-render.md` (Phase 4)
- `references/adversarial-review-render.md` (Phase 5)

Token-usage story remains a v0.2 item — Mini-Agent currently doesn't surface token counts; do not claim costs.
```

- [ ] **Step 4: 提交**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
git add plugins/minimax/skills/minimax-cli-runtime/SKILL.md plugins/minimax/skills/minimax-result-handling/SKILL.md
git commit -m "docs(Task 5.8): minimax-cli-runtime + minimax-result-handling skills bumped to v1 with Phase 4-5 deltas"
```

---

## Task 5.9 — `lessons.md` 收尾

写仓库根 `lessons.md`，覆盖 spec §8.3 §A-§G。

**Files:**
- Create: `lessons.md`（仓库根）

- [ ] **Step 1: 写 lessons.md**

```markdown
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

### Phase 4 (3-way review): 6 Critical + 5 Important 在 plan v2 嵌入。Phase 5 (5-way review): 见 plan v2 修订索引（本文件）。

### Phase 5 — D5.1/D5.2/D5.3 architectural decisions

见本 plan 顶部 "Architectural decisions" 段，5-way review 重点挑战这三条；正式版决策在 plan v2 修订索引内 traceability。

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
```

- [ ] **Step 2: 提交**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
git add lessons.md
git commit -m "docs(Task 5.9): lessons.md — Phase 0-5 manual migration writeup (§A-§G)"
```

---

## Task 5.10 — T9 hard-gate smoke test

跑真实 `/minimax:adversarial-review` 命令（用 companion 直接调，不走 Claude Code 命令派发以隔离 LLM 因素）；输入是一个 3-5 行的真实 diff；验证：
1. exit code 0
2. JSON `red.ok === true && blue.ok === true`
3. 至少一边 `findings` 非空（不要求两边都非空 —— 蓝队空 findings 是合法的）
4. 红蓝两边都包含 `verdict`/`summary`/`findings`/`next_steps` 字段

把整个 run 写入 `doc/smoke/phase-5-T9.md`。

**Files:**
- Create: `doc/smoke/phase-5-T9.md`

- [ ] **Step 1: 准备 3-5 行测试 diff（在 /tmp 下独立 git repo，主仓库永远不脏）**

> v2 (M3): 用 `mktemp -d` 隔离 fixture 到 /tmp，不污染主仓库。
> v2 (M14): 改用更中性的 bug（fetch 没有 timeout）让红蓝双方都有发力空间，不偏向红队。

```bash
SMOKE_DIR=$(mktemp -d /tmp/minimax-smoke-XXXXXX)
git -C "$SMOKE_DIR" init -q
cat > "$SMOKE_DIR/fetch-user.js" <<'EOF'
async function fetchUser(id) {
  const res = await fetch(`https://api.example.com/users/${id}`);
  return res.json();
}
module.exports = { fetchUser };
EOF
git -C "$SMOKE_DIR" add fetch-user.js
git -C "$SMOKE_DIR" -c user.email=smoke@test -c user.name=smoke commit -q -m "init"
# Now stage a 3-line patch (no timeout / no error handling / no retry)
cat > "$SMOKE_DIR/fetch-user.js" <<'EOF'
async function fetchUser(id) {
  const res = await fetch(`https://api.example.com/users/${id}`);
  if (!res.ok) console.log("fetch failed");
  return res.json();
}
module.exports = { fetchUser };
EOF
git -C "$SMOKE_DIR" add fetch-user.js
echo "SMOKE_DIR=$SMOKE_DIR"
```

中性 bug：fetch 没有 timeout、错误只 log 不抛、JSON parse 可能崩。红队应攻击 silent-failure / no-timeout / no-retry；蓝队可指出 "JSON parse 错可由调用方 try/catch 兜底" 或建议 "加 metric 而非加 retry"——双方都有合理 finding。

- [ ] **Step 2: 跑 adversarial-review，捕获 JSON（用 SMOKE_DIR 作为 cwd）**

```bash
node /Users/bing/-Code-/minimax-plugin-cc/plugins/minimax/scripts/minimax-companion.mjs \
  adversarial-review --json --scope staged --cwd "$SMOKE_DIR" \
  2>/tmp/t9-stderr.log >/tmp/t9-stdout.json
echo "exit=$?"
```

Expected: `exit=0`. 若非 0：核对 stderr 找根因（auth 失败 → /minimax:setup；mini-agent 不在 PATH → 装；JSON parse 双失败 → 看 raw output 判 prompt 是否要调整）。

- [ ] **Step 3: 校验 JSON shape + 红队 severity 分布观察 (I9)**

```bash
node -e '
const fs = require("fs");
const r = JSON.parse(fs.readFileSync("/tmp/t9-stdout.json", "utf8"));
console.log("status:", r.status);
console.log("red.ok:", r.red?.ok, "blue.ok:", r.blue?.ok);
console.log("red.verdict:", r.red?.verdict, "blue.verdict:", r.blue?.verdict);
console.log("red.findings.len:", r.red?.findings?.length, "blue.findings.len:", r.blue?.findings?.length);
console.log("red has fields:", ["verdict","summary","findings","next_steps"].every(k => k in r.red));
console.log("blue has fields:", ["verdict","summary","findings","next_steps"].every(k => k in r.blue));
const totalFindings = (r.red?.findings?.length || 0) + (r.blue?.findings?.length || 0);
console.log("T9 PASS criterion: total findings >= 1 →", totalFindings >= 1 ? "PASS" : "FAIL");
// I9: 红队 severity 分布观察（>70% critical 触发措辞降级预案）
const redFindings = r.red?.findings || [];
if (redFindings.length > 0) {
  const criticalCount = redFindings.filter(f => f.severity === "critical").length;
  const ratio = (criticalCount / redFindings.length * 100).toFixed(0);
  console.log("red critical ratio:", ratio + "% (" + criticalCount + "/" + redFindings.length + ")");
  if (criticalCount / redFindings.length > 0.7) {
    console.log("WARN: 红队 critical 比例 >70%，stance 措辞可能过激；记入 lessons.md 坑 11 延伸");
  }
}
'
```

Expected: T9 PASS（red+blue 至少一边产出 findings；蓝队空数组合法 v2 C2）。红队 critical 比例 ≤70% 视为 stance 措辞 OK；若超出，把观察写入 lessons.md。

- [ ] **Step 4: 写 smoke 报告**

写入 `doc/smoke/phase-5-T9.md`：

```markdown
# Phase 5 T9 smoke — `/minimax:adversarial-review` hard gate

**Date:** 2026-04-21
**Branch:** `smoke/phase-5-T9`
**Mini-Agent version:** （from `mini-agent --version`）
**Model:** （from `~/.mini-agent/config/config.yaml::model`）

## Input diff

```js
// plugins/minimax/scripts/lib/_smoke_t9/auth.js
function authenticate(token) {
  if (token === "admin") return true;
  return false;
}
module.exports = { authenticate };
```

## Command

```bash
node plugins/minimax/scripts/minimax-companion.mjs adversarial-review --json --scope staged
```

## Output (key fields)

- exit code: 0
- status: ok
- red.ok: true / blue.ok: true
- red.verdict: needs-attention / blue.verdict: ...
- red.findings count: N
- blue.findings count: M
- red.retry_used: true/false / blue.retry_used: true/false

### Red Team summary

> （粘贴 r.red.summary 原文）

### Red Team findings (top 3)

1. ...
2. ...
3. ...

### Blue Team summary

> （粘贴 r.blue.summary 原文）

### Blue Team findings (top 3)

1. ...
2. ...
3. ...

## T9 verdict

**PASS** — 红蓝两 viewpoint 均产出 schema-valid JSON；总 findings >= 1。

（或 **FAIL** + 失败原因 + 修复路径）

## Notes

- Cold start 实测：~Xs（含 queue acquire + 红 + 蓝）
- Queue slot 持有时长：Ys
- 有无 retry：red=Y/N, blue=Y/N
```

- [ ] **Step 5: cleanup**

> v2 (M3): SMOKE_DIR 是 /tmp 隔离 repo，主仓库永远不脏；不需要切分支也不需要 stash。
> v2 (I21): 防御性 status check 仍保留，确保提交前 working tree 状态可控。

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
rm -rf "$SMOKE_DIR"
git status --porcelain  # 必须只显示 doc/smoke/phase-5-T9.md（无其他 dirty）
git add doc/smoke/phase-5-T9.md
git commit -m "test(Task 5.10): T9 smoke report — adversarial-review red+blue PASS"
```

---

## Task 5.11 — CHANGELOG / PROGRESS / MEMORY 同步

**Files:**
- Modify: `CHANGELOG.md`（仓库根）
- Modify: `plugins/minimax/CHANGELOG.md`
- Modify: `PROGRESS.md`
- Modify: `~/.claude/projects/-Users-bing--Code--minimax-plugin-cc/memory/project-phase-status.md`

- [ ] **Step 1: 仓库根 `CHANGELOG.md` 顶部追加 reverse-chrono 条目**

每个 Task 5.0-5.10 落地时本应已分别追加；本 Step 是兜底统一稿，写一条 Phase 5 完成的 summary entry：

```markdown
## 2026-04-21 [author: claude-opus-4-7]
- **status**: done
- **scope**: Phase 5 — `/minimax:adversarial-review` + 三 skill v1 + lessons.md + T9 PASS
- **summary**: 双 spawn 红蓝架构（D5.1）落地；prompt 单文件 + STANCE_INSTRUCTION 占位（D5.2）；queue slot 整对持有（D5.3）。`_callReviewLike` 抽取使 review 与 adversarial-review 共享单 spawn + 1-shot retry 骨架。三个 skill (cli-runtime / prompting / result-handling) bumped to v1。lessons.md §A-§G 收 v0.1 全程经验。T9 PASS（doc/smoke/phase-5-T9.md）。tests: 86 pass / 0 fail。
- **next**: tag v0.1.0 ship。v0.2 路线见 spec §8.5。
```

- [ ] **Step 2: `plugins/minimax/CHANGELOG.md` 追加同样 entry（删 redundant 的 next 字段）**

- [ ] **Step 3: 改 `PROGRESS.md` Phase 5 行**

把当前 phase 5 status 从 `**TODO**` 改为 `done`，tag 标 `v0.1.0`：

```markdown
| 5 | done | `v0.1.0` | `/minimax:adversarial-review` + skill v1 + lessons.md (T9 PASS) |
```

> v2 (I17): **不**物理删除 "Phase 5 — remaining scope" 与 "How to start Phase 5" 段（保留 traceability）。改为给两段顶部加一行 "> Historical: Phase 5 done as of <date> — section preserved for traceability." 然后整段套 `<details>`+`<summary>` 折叠（markdown 友好）：

```markdown
<details>
<summary>Phase 5 — remaining scope (historical, completed)</summary>

> Historical: Phase 5 done — section preserved for traceability.

Per spec §8.2:
- ... (原内容保留)

</details>

<details>
<summary>How to start Phase 5 (historical, completed)</summary>

> Historical: see git log + lessons.md for actual sequence.

1. ... (原内容保留)

</details>
```

末尾添：

```markdown
## v0.1.0 shipped

最后 commit: `<HASH_PLACEHOLDER>`. v0.2 路线见 `docs/superpowers/specs/2026-04-20-minimax-plugin-cc-design.md` §8.5。
```

- [ ] **Step 3b (v2 M6): 替换 `<HASH_PLACEHOLDER>` 为真 hash**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
HASH=$(git rev-parse HEAD)
sed -i.bak "s/<HASH_PLACEHOLDER>/${HASH:0:7}/" PROGRESS.md && rm PROGRESS.md.bak
grep "最后 commit" PROGRESS.md  # 验证替换
```

- [ ] **Step 4: 改 memory `project-phase-status.md`**

把：
```
| 5 | **remaining** | (target: `v0.1.0`) | T9 (adversarial-review) |
```

改为：
```
| 5 | done | `v0.1.0` | T9 PASS |
```

更新 `Why:` / `How to apply:` 段，把 "start Phase 5" 改成 "v0.1.0 shipped; v0.2 路线见 spec §8.5"。`Useful commit refs` 加 Phase 5 commit hash + v0.1.0 tag。

- [ ] **Step 5: 提交**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
git add CHANGELOG.md plugins/minimax/CHANGELOG.md PROGRESS.md
git commit -m "docs(Task 5.11): Phase 5 done — CHANGELOG + PROGRESS sync; memory updated externally"
```

memory 文件用 Write 工具更新（路径在 home dir，不入 git）。

---

## Task 5.12 — Tag v0.1.0

**Files:**
- Tag: `v0.1.0`

- [ ] **Step 1: 跑全套测试 + smoke 脚本，再次确认绿**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
node --test plugins/minimax/scripts/lib/*.test.mjs 2>&1 | tail -5
```

Expected: 86 pass / 0 fail。

- [ ] **Step 2: 确认 git status clean + 在 main**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
git status
git log --oneline -10
git branch --show-current
```

Expected: working tree clean, branch=main, 最后 commit 是 Task 5.11。

- [ ] **Step 3: tag**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
git tag -a v0.1.0 -m "v0.1.0 — full-parity 8 commands MiniMax plugin (T1/T2/T3/T5/T6/T8/T9/T10/T11/T12/T13 PASS)"
git tag --list 'v*' phase-*-*
```

Expected: `v0.1.0` 出现在 tag 列表中。

- [ ] **Step 4: 用户决定是否推远端 + Release Notes 引导**

```bash
cat <<'EOF'
v0.1.0 tagged locally.

To publish:
  1. git push origin main --tags
  2. 前往 GitHub 创建 v0.1.0 Release Notes（基于 CHANGELOG.md 内容）：
     gh release create v0.1.0 --title "v0.1.0 — full-parity 8-command MiniMax plugin" \
       --notes-file <(awk '/^## /{i++}i==1' CHANGELOG.md)
     (上一行用 awk 取 CHANGELOG 第一节作 release body；可手编)
  3. 验证 Release 出现在 https://github.com/<owner>/minimax-plugin-cc/releases

不要自动 push；用户审过 tag 后决定。
EOF
```
```

---

## Self-Review

按 writing-plans skill 指示，自己跑一遍 checklist：

**1. Spec coverage（spec §8.2 Phase 5 deliverables）**
- ✅ `/minimax:adversarial-review` command — Task 5.5
- ✅ `prompts/adversarial-review.md`（红蓝双视角中文直给）— Task 5.1
- ✅ `minimax-cli-runtime` v1 — Task 5.8
- ✅ `minimax-prompting` 内容定稿 — Task 5.7
- ✅ `minimax-result-handling` adversarial-render reference + 合并打磨 — Task 5.6 + 5.8
- ✅ `lessons.md` §A-§G 收尾 — Task 5.9
- ✅ T9 hard gate — Task 5.10
- ✅ tag v0.1.0 — Task 5.12
- ✅ CHANGELOG + PROGRESS + MEMORY 同步 — Task 5.11

**2. Placeholder scan**
- 全部 Task 都给出 verbatim code/text，无 "TBD"/"implement later"/"add appropriate error handling" 等占位
- Task 5.10 smoke report 模板里有 `（粘贴 r.red.summary 原文）` —— 这是 smoke runner 实跑时填的位置，非代码占位；保留

**3. Type consistency**
- `_callReviewLike` 签名：(`buildPrompt: ({retryHint, previousRaw}={}) => string`, ...）— 与 Task 5.0 / Task 5.3 调用点一致
- `callMiniAgentAdversarial` 返回 shape：`{ok: true, red, blue}` 或 `{ok: false, side, red?, blue?, error}` — 与 Task 5.4 `runAdversarialReview` 解构一致
- `pickViewpointPayload` 输出 fields 与 `references/adversarial-review-render.md` JSON shape 一致
- `RED_STANCE_INSTRUCTION` / `BLUE_STANCE_INSTRUCTION` export 名 — Task 5.2 定义、Task 5.3 调用一致
- 跨 stance 的 `verdict` enum 都是 `approve` / `needs-attention`（schema 没换）— spec compliance

**4. P0.10 invariant**
- `runAdversarialReview` 在 `callMiniAgentAdversarial` 之前 acquire 一次 queue slot（Task 5.4 Step 2），跑完 release（finally 块）— P0.10 串行不变量保留
- `callMiniAgentAdversarial` 内部不动 queue（D5.3）

**5. Schema reuse**
- 红蓝两边都用 `schemas/review-output.schema.json` —— 不新增 schema —— 符合 spec §6.6（spec 未授权 schema 改动）

**6. Frequent commits**
- 每个 Task 末尾都有 `git commit`，11 个独立 commits + 1 个 tag — 符合 writing-plans "frequent commits"

**7. Test sufficiency (v2)**
- 5.0 zero-behavior-change refactor + 现有 79 测试回归 = behavior 保护（errorPrefix 默认值保 review 行为字面一致）
- 5.2 加 5 条 buildAdversarialPrompt 单测（red / blue / unknown-stance / retry-redaction / **C3 回归**）
- 5.3 加 3 条 callMiniAgentAdversarial mock-spawn 集成测试（both-succeed / red-fail-no-blue / blue-fail-red-surfaced），**带 trace 文件断言真实 spawn 计数**
- 5.10 真实 LLM smoke = T9 端到端（中性 bug fixture，红蓝双方各有发力空间）
- 总 87 unit + 1 smoke = 充足

**8. v2 5-way review 修订完整性**

7 Critical 全部嵌入 / 21 Important 嵌入 18 条（I8 与 C2 同源已合并；I14 嵌 D5.1+D5.3+5.4 三处）/ 14 Minor 嵌入 12 条（M5 / M10 不采纳）。冲突 C2 (Codex 严格 vs Kimi lenient) 显式登记 dissent，倾向 lenient 解读。

无 v2 残余 issues。Plan v2 提交，等待执行模式选择。
