# minimax-plugin-cc Phase 0 + Phase 1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan version**: **v5** — Phase 0 probes 跑完后回炉修订。P0.2 发现 Mini-Agent 日志用 OpenAI 兼容规范化格式（非 Anthropic 原始）：`finish_reason` / `content` 字符串 / `tool_calls` 顶层数组 / 3 种 block kind (REQUEST/RESPONSE/TOOL_RESULT) / log_index 跨 kind 递增。Task 1.9a parser 代码、测试 fixtures、SKILL.md 模板、spec §3.5 / §4.1 全部同步。P0.10 FAIL → Phase 4 必须串行化（spec §4.6 已加约束）。v2/v3/v4 的 24 条修正继续有效。

**Goal:** Build the minimal working skeleton of `minimax-plugin-cc` — a Claude Code plugin wrapping MiniMax-AI/Mini-Agent — sufficient to pass spec acceptance tests **T1** (`/minimax:setup --json` returns full status), **T8** (install flow on a fresh environment), **T12** (YAML write preserves other fields, **using mock config path, never touches user real file**), **T13** (SOCKS auto-recovery). Probe the 11 remaining unknowns from spec §7 (P0.9 已完成 env-auth 结论，本 plan 只文档化).

**Architecture:** Node.js zero-dependency plugin. `scripts/minimax-companion.mjs` is the single entry point dispatched to by command `.md` files. `scripts/lib/minimax.mjs` is the only minimax-specific module; the rest (`args.mjs`, `process.mjs`, `state.mjs`, `render.mjs`, `git.mjs`) are near-copied from `gemini-plugin-cc` with name/path changes only. Authority for CLI invocation: `mini-agent -t "<prompt>" -w <cwd>`. Log file is ground truth; stdout is UX only (spec §3.0). **All long-lived spawn calls go through `spawnWithHardTimeout` (spec §3.6) — never `spawnSync` in companion paths, because Mini-Agent 可能吞 SIGTERM 导致无限阻塞**。`MINI_AGENT_CONFIG_PATH` / `MINI_AGENT_LOG_DIR` 常量可通过 env 覆盖（专供测试 / mock）。

**Tech Stack:** Node.js ≥18 (built-ins only: `node:child_process`, `node:fs`, `node:path`, `node:os`, `node:crypto`, `node:string_decoder`, `node:util`). No npm deps. Mini-Agent (installed via `uv tool install --with socksio git+https://github.com/MiniMax-AI/Mini-Agent.git`, version 0.1.0+) as runtime requirement. Python 3.11+ (Mini-Agent's host).

**Reference spec:** `docs/superpowers/specs/2026-04-20-minimax-plugin-cc-design.md` (**v4**, especially §3-§5, §7, §8). The YAML gate state machine (§3.4.2), log parser state machine (§3.5), and `spawnWithHardTimeout` skeleton (§3.6) are the normative sources — no implementation freelance.

**Reference source:** `/Users/bing/-Code-/gemini-plugin-cc/plugins/gemini/` — this plan references specific files there for "near-copy" tasks. The author must **read each file fully before rewriting locally** (P2 principle: no sed, no cp).

**Exit criteria for this plan:**
- T1 passes: `node scripts/minimax-companion.mjs setup --json` returns `{installed, authenticated, model, version, apiBase}` all populated
- T8 passes: on a machine without mini-agent, setup branches to install suggestion
- T12 passes: setup 连续跑 3 次用不同 key，最后一次 key 生效，其他字段（retry/tools/model/api_base）完全保留
- T13 passes: SOCKS 环境 install 自动用 `--with socksio`
- `doc/probe/01-..12-...md` 记录 11 个实跑 probe + P0.9 的已完成结论
- `plugins/minimax/skills/minimax-cli-runtime/SKILL.md` v0.1 draft committed (probe 结论落地)
- `plugins/minimax/skills/minimax-prompting/SKILL.md` skeleton committed
- **绝对硬门**：P0.1 / P0.2 任一失败 → 停 plan，告警用户，不进 Phase 1
- **条件硬门**：P0.10 失败 → Phase 1 的 companion 必须实现"串行化 job 调度"而非 snapshot-diff fallback

---

## File Structure for this Plan

**Create (根目录)：**
- `.gitignore`
- `README.md`
- `CLAUDE.md`
- `CHANGELOG.md`

**Create (清单)：**
- `.claude-plugin/marketplace.json`
- `plugins/minimax/.claude-plugin/plugin.json`
- `plugins/minimax/CHANGELOG.md`

**Create (脚本)：**
- `plugins/minimax/scripts/minimax-companion.mjs` — 主入口
- `plugins/minimax/scripts/lib/args.mjs` — 近复制
- `plugins/minimax/scripts/lib/process.mjs` — 近复制
- `plugins/minimax/scripts/lib/render.mjs` — 近复制 + "Kimi/Gemini" → "MiniMax" 字样
- `plugins/minimax/scripts/lib/git.mjs` — 近复制
- `plugins/minimax/scripts/lib/state.mjs` — 近复制 + 路径常量 / jobId 前缀改
- `plugins/minimax/scripts/lib/minimax.mjs` — 从零写

**Create (命令 + skill)：**
- `plugins/minimax/commands/setup.md`
- `plugins/minimax/skills/minimax-cli-runtime/SKILL.md`
- `plugins/minimax/skills/minimax-prompting/SKILL.md`
- `plugins/minimax/skills/minimax-prompting/references/.gitkeep`

**Create (probe reports)：**
- `doc/probe/01-task-mode.md`
- `doc/probe/02-response-block-structure.md`
- `doc/probe/03-log-flush-timing.md`
- `doc/probe/04-large-prompt.md`
- `doc/probe/05-failure-sentinels.md`
- `doc/probe/06-yaml-concurrent-write.md`
- `doc/probe/07-workspace-local-config.md`
- `doc/probe/08-api-key-format.md`
- `doc/probe/09-env-auth.md`  *(已完成，仅记录结论)*
- `doc/probe/10-concurrent-spawn-log.md`
- `doc/probe/11-mini-agent-log-subcommand.md`
- `doc/probe/12-yaml-antipatterns.md`

**Already exists（baseline committed at repo init）：**
- `.gitignore`（极简版，plan v3 前已创建；Task 1.1 会扩充）
- `docs/superpowers/specs/2026-04-20-minimax-plugin-cc-design.md` (v4)
- `docs/superpowers/plans/2026-04-20-phase-0-1-foundation.md` (本 plan v3)
- git repo 已初始化，main 分支，baseline commit `docs: spec v4 + plan v3 baseline`
- `~/.mini-agent/config/config.yaml` (brainstorm 阶段创建，含 fake key 供 probe 使用)

**Before Phase 0 starts**：
- 所有后续 `git add` / `git commit` 假设 repo 已初始化——**不再需要** `git init`
- 每个 Phase 0 probe task 和 Phase 1 task 完成后 commit 一次，commit message 用 `probe(P0.N): <summary>` / `feat/chore/fix(<scope>): <summary>` 规范
- 若 probe 执行中发现硬门失败（P0.1 / P0.2 / P0.10），executor 必须在当前 task 的 Step 末尾**立即** append CHANGELOG 条目（status: blocked）+ `git commit` + 停下告警用户，而不是继续下一个 task

---

## Phase 0: Probes

Each probe produces a `doc/probe/NN-*.md` file that Phase 1 cites when making decisions. **Never skip a probe, never tumble probe conclusions to Phase 1 code without writing the report first.**

### Task P0.1: Probe `--task` 一次性模式稳定性 (**绝对硬门**)

**Files:**
- Create: `doc/probe/01-task-mode.md`

- [ ] **Step 1: Run 5 one-shot tasks and capture timing + exit code precisely**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
mkdir -p doc/probe
: > /tmp/mm-probe1.log
for i in 1 2 3 4 5; do
  echo "=== Run $i ===" >> /tmp/mm-probe1.log
  START=$(python3 -c "import time; print(int(time.time()*1000))")
  # 关键：直接重定向到文件，不用 tee + head（避免 SIGPIPE 改变被测进程行为；避免 $? 拿错进程 exit）
  mini-agent -t "Reply with exactly: OK-$i" -w /tmp > /tmp/mm-probe1.run-$i.out 2>&1
  MM_EXIT=$?
  END=$(python3 -c "import time; print(int(time.time()*1000))")
  echo "exit_code=$MM_EXIT duration_ms=$((END-START))" >> /tmp/mm-probe1.log
  head -40 /tmp/mm-probe1.run-$i.out >> /tmp/mm-probe1.log
done
cat /tmp/mm-probe1.log
```

Expected: each run exits naturally (not hangs). `Log file:` line appears in the first 30 lines of each `/tmp/mm-probe1.run-N.out`. Note cold-start p50/p95 (likely 3–6s given brainstorm observation). **`exit_code` 此处是 `mini-agent` 真正的 exit code，非 head/tee 的**——spec §4.1 说恒为 0 是基于"正常/401"场景，probe 观察应一致。

- [ ] **Step 2: Verify Log file: line regex**

```bash
grep -oE "Log file: +[^ ]+\.log" /tmp/mm-probe1.log | head -10
```

Expected: 5 distinct paths, each matching `~/.mini-agent/log/agent_run_YYYYMMDD_HHMMSS.log`.

- [ ] **Step 3: Write `doc/probe/01-task-mode.md`**

```markdown
# Probe P0.1: --task one-shot stability

## Run
5× `mini-agent -t "Reply with exactly: OK-<N>" -w /tmp`

## Results
| Run | Exit code | Duration (ms) | Log file: line present | Line# of Log file: |
|---|---|---|---|---|
| 1 | <fill> | <fill> | yes/no | <fill> |
...

## Cold-start timing
- p50: <ms>
- p95: <ms>
- Maximum observed: <ms>

## Log file path regex
`/Log file:\s+(\S+\.log)/` — **confirmed works**（or adjustments needed）

## Hard gate verdict
- [ ] PASS（5/5 自然退出，`Log file:` 行全部捕获到）
- [ ] FAIL（列出失败细节，`Phase 1 不启`）
```

- [ ] **Step 4: Commit**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
git add doc/probe/01-task-mode.md
git commit -m "probe(P0.1): --task one-shot stability"
```

- [ ] **Step 5: 硬门失败契约（spec §8.4）**

**如果 Step 3 的报告显示 "Hard gate verdict: FAIL"**：

```bash
# 追加 CHANGELOG 条目，然后停下告警用户
cat >> CHANGELOG.md <<EOF

## $(date +"%Y-%m-%d %H:%M") [executor]

- **status**: blocked
- **scope**: Phase 0 / P0.1 (--task one-shot stability)
- **summary**: Hard gate P0.1 failed. Observations in doc/probe/01-task-mode.md. Mini-Agent \`--task\` mode 不稳定或 Log file 行捕获失败 → 按 spec §7 硬门规则，Phase 1 不启。
- **next**: User decision needed — 1) 升级 Mini-Agent 版本后 re-probe；2) 切 v0.2 的 M2.7 直连 HTTPS 方案（spec 附录 C 路径 3）；3) 调整 spec 放弃 --task 一次性模式的强依赖。
EOF
git add CHANGELOG.md
git commit -m "blocked: P0.1 hard gate failed — see doc/probe/01-task-mode.md"
echo "❌ P0.1 hard gate FAILED — plan execution stopped. See CHANGELOG.md tail for next steps." >&2
exit 1
```

否则（PASS）继续 P0.2。

---

### Task P0.2: Probe RESPONSE block structure (**绝对硬门**)

**Files:**
- Create: `doc/probe/02-response-block-structure.md`

- [ ] **Step 1: 生成多轮 tool_use 场景日志**

```bash
# 我们先用一个会触发 bash tool 的 prompt（简单一点），让日志里有多轮 REQUEST/RESPONSE
mini-agent -t "Run 'echo hello' using bash tool, then reply with the output" -w /tmp 2>/tmp/mm-p2.err | tee /tmp/mm-p2.out
LOG=$(grep -oE "Log file: +[^ ]+\.log" /tmp/mm-p2.out | head -1 | awk '{print $3}')
echo "LOG=$LOG"
test -f "$LOG"
```

- [ ] **Step 2: 分析日志 block 结构**

```bash
# 数分隔符数量和 REQUEST/RESPONSE 交替模式
grep -cE "^-{80}$" "$LOG"
grep -nE "^\[[0-9]+\] (REQUEST|RESPONSE)$" "$LOG" | head -20
```

读 `$LOG` 最后一个 RESPONSE block，验证：
- JSON parse 成功
- 含 `stop_reason` 字段（`end_turn` / `stop_sequence` / `tool_use` / `max_tokens` 之一）
- `content[]` 数组结构（含 `type: "text"` 和/或 `type: "tool_use"`）

- [ ] **Step 3: SIGTERM 场景日志形态**

```bash
# 用长任务 + SIGTERM 观察日志尾部形态
mini-agent -t "Count from 1 to 50, wait 0.2s between each number" -w /tmp > /tmp/mm-p2b.out 2>&1 &
PID=$!
sleep 3
kill -TERM $PID 2>/dev/null
wait $PID 2>/dev/null
LOG2=$(grep -oE "Log file: +[^ ]+\.log" /tmp/mm-p2b.out | head -1 | awk '{print $3}')
echo "TERMINATED_LOG=$LOG2"
tail -30 "$LOG2"
```

观察：最后一个 RESPONSE block 是否**部分写入**（JSON 不完整）？`stop_reason` 是否缺失？

- [ ] **Step 4: 写 `doc/probe/02-response-block-structure.md`**

```markdown
# Probe P0.2: RESPONSE block structure

## Block delimiter
- Separator regex: `^-{80}$`  *(80 dashes)*
- Block header regex: `^\[([0-9]+)\] (REQUEST|RESPONSE)$`

## RESPONSE JSON shape (正常场景)
- parseable: yes/no
- 含字段: `role` / `content[]` / `stop_reason` / `usage` / ...
- `content[].type` 可能值: text / tool_use / ...
- 样例（最后一个 RESPONSE block 的 JSON 截取）:
```json
{ ... pasted here ... }
```

## SIGTERM 场景
- 最后 RESPONSE block 完整性: complete / partial / missing
- 无 `stop_reason` 时我们的 "终态选择规则" 的 fallback 行为: <观察到的实际>
- 部分 JSON 的典型断裂位置: <描述>

## 终态选择规则验证（spec §3.5）
- 规则："从最大 N 倒序遍历，选第一个有 stop_reason 或非空 text 的 RESPONSE block"
- 实测多轮 tool_use 场景：<规则是否成立>
- 实测 SIGTERM 场景：<规则回落到哪个 block>
- 实测 auth-failure 场景：<日志里有无 RESPONSE block>

## Hard gate verdict
- [ ] PASS（三种场景下规则都能拿到预期结果）
- [ ] FAIL（`Phase 1 不启`，附失败场景与日志样本）
```

- [ ] **Step 5: Commit**

```bash
git add doc/probe/02-response-block-structure.md
git commit -m "probe(P0.2): RESPONSE block structure + terminal-state rule"
```

- [ ] **Step 6: 硬门失败契约（spec §8.4）**

**如果 Step 4 的报告显示 "Hard gate verdict: FAIL"**：

```bash
cat >> CHANGELOG.md <<EOF

## $(date +"%Y-%m-%d %H:%M") [executor]

- **status**: blocked
- **scope**: Phase 0 / P0.2 (RESPONSE block structure + terminal-state rule)
- **summary**: Hard gate P0.2 failed. Observations in doc/probe/02-response-block-structure.md. Mini-Agent 日志 RESPONSE block 结构不符 spec §3.5 假设（非 Anthropic message 格式 / 终态选择规则失效 / 分隔符不稳定）→ Phase 1 不启。
- **next**: User decision needed — 1) 读 doc/probe/02 找具体不符点；2) 调整 spec §3.5 的状态机和终态规则；3) 若日志格式根本不可解析，切 v0.2 的 M2.7 直连方案。
EOF
git add CHANGELOG.md
git commit -m "blocked: P0.2 hard gate failed — see doc/probe/02-response-block-structure.md"
echo "❌ P0.2 hard gate FAILED — plan execution stopped." >&2
exit 1
```

否则继续 P0.3。

---

### Task P0.3: Probe log flush timing

**Files:**
- Create: `doc/probe/03-log-flush-timing.md`

- [ ] **Step 1: 观察日志文件在任务进行中是否增量 flush**

```bash
# 起长任务
mini-agent -t "Count from 1 to 30 with a short pause between each number" -w /tmp > /tmp/mm-p3.out 2>&1 &
PID=$!

# 每 0.5s 看日志文件大小和内容增长
LOG=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 0.5
  if [ -z "$LOG" ]; then
    LOG=$(grep -oE "Log file: +[^ ]+\.log" /tmp/mm-p3.out 2>/dev/null | head -1 | awk '{print $3}')
  fi
  if [ -n "$LOG" ] && [ -f "$LOG" ]; then
    SIZE=$(wc -c < "$LOG")
    BLOCKS=$(grep -cE "^\[[0-9]+\] (REQUEST|RESPONSE)$" "$LOG" 2>/dev/null || echo 0)
    echo "t=$((i*500))ms log_size=$SIZE blocks=$BLOCKS"
  fi
done

wait $PID
```

Observations:
- 日志文件是在 spawn 立刻创建？还是等首次 LLM 返回？
- 大小是增量增长还是一次性写完？
- REQUEST/RESPONSE 块数量随时间增长吗？

- [ ] **Step 2: 写 `doc/probe/03-log-flush-timing.md`**

```markdown
# Probe P0.3: Log flush timing

## 观察
- 日志文件创建时机: <spawn 后 XXms / 首次 LLM response 后>
- 增量 flush: yes / no / partial（如只 flush REQUEST，RESPONSE 等关闭时一次性）
- 典型 size 增长曲线: <描述或表格>

## 结论
- **增量 flush**: yes → v0.2 可考虑 `fs.watch` 实时事件流
- **非增量 flush**: no → spec §1.3 "实时事件流 UX" 永久归入 v0.2+；v0.1 模型 "stdout 透传 + 结束后解析" 继续用

## 软门判定
- [ ] 增量 flush 成立（给 v0.2 开路径）
- [ ] 非增量 flush（v0.2 关门，`fs.watch` 方向放弃）
```

- [ ] **Step 3: Commit**

```bash
git add doc/probe/03-log-flush-timing.md
git commit -m "probe(P0.3): log flush timing"
```

---

### Task P0.4: Probe 大 prompt 传递

**Files:**
- Create: `doc/probe/04-large-prompt.md`

- [ ] **Step 1: 测试 argv 传递大 prompt**

```bash
# 构造 20KB prompt
python3 -c "print('Summarize in one word: ' + 'hello world ' * 2000 + '. Reply exactly: LONG')" > /tmp/mm-p4-prompt.txt
PROMPT=$(cat /tmp/mm-p4-prompt.txt)

# (a) argv 传递
mini-agent -t "$PROMPT" -w /tmp > /tmp/mm-p4a.out 2>&1
echo "exit-a=$?"
tail -3 /tmp/mm-p4a.out
```

- [ ] **Step 2: 测试 stdin 传递**

```bash
# (b) stdin 传递（-t 省略或空）
cat /tmp/mm-p4-prompt.txt | mini-agent -t "" -w /tmp > /tmp/mm-p4b.out 2>&1 || true
echo "exit-b=$?"
tail -3 /tmp/mm-p4b.out
```

- [ ] **Step 3: 测试超大 prompt（>100KB，逼近 argv 限制）**

```bash
python3 -c "print('Please summarize: ' + 'The quick brown fox. ' * 10000)" > /tmp/mm-p4-huge.txt
PROMPT=$(cat /tmp/mm-p4-huge.txt)
mini-agent -t "$PROMPT" -w /tmp > /tmp/mm-p4c.out 2>&1
echo "exit-c=$?"
tail -3 /tmp/mm-p4c.out
# 若失败：观察是 E2BIG（POSIX argv limit）还是 mini-agent 自己的限制
```

- [ ] **Step 4: 写 `doc/probe/04-large-prompt.md`**

```markdown
# Probe P0.4: 大 prompt 传递

## 结果
| 方式 | 体积 | Exit | 结果 |
|---|---|---|---|
| argv | 20KB | <0/非0> | success / <失败原因> |
| stdin (`-t ""` + cat) | 20KB | <> | success / 不支持 / <> |
| argv | 200KB | <> | success / E2BIG / <> |

## 结论
- LARGE_PROMPT_STRATEGY: `argv` / `stdin` / `tmpfile`
- 理由: <>
- v0.1 `callMiniAgent` 的 prompt 传递实现: <具体路径>

## 软门判定
- [ ] PASS：至少一条策略在 <规定上限> 下稳定
- [ ] FAIL：两条都失败 → spec §3.1 要加"大 prompt 强制降级"逻辑
```

- [ ] **Step 5: Commit**

```bash
git add doc/probe/04-large-prompt.md
git commit -m "probe(P0.4): large prompt passing"
```

---

### Task P0.5: Probe failure sentinels（4 场景 × 4 locales = 16 次真实矩阵）

**Files:**
- Create: `doc/probe/05-failure-sentinels.md`
- Create: `doc/probe/scripts/p5-run-matrix.sh`（辅助脚本）

> **重要**：plan v1 的 P0.5 只跑 4+2+1+1=8 次不构成"矩阵"；plan v2 真的跑 4×4=16 次。且 **model 场景用 mock config path，不碰用户真文件**。

- [ ] **Step 1: 准备 mock config（绝不碰用户真文件）**

```bash
mkdir -p /tmp/mm-p5-mock/config
cp ~/.mini-agent/config/config.yaml /tmp/mm-p5-mock/config/config.yaml
cp ~/.mini-agent/config/mcp.json /tmp/mm-p5-mock/config/mcp.json
cp ~/.mini-agent/config/system_prompt.md /tmp/mm-p5-mock/config/system_prompt.md
# Mini-Agent 的 config 搜索路径优先级已确认（P0.7）
# v0.1 的 companion 会用 MINI_AGENT_CONFIG_PATH env 覆盖；但 Mini-Agent 本身不认这个 env。
# 所以这里我们把 mock workspace 的 mini_agent/config/ 放好，用 cwd = workspace 的方式让它读局部 config。
mkdir -p /tmp/mm-p5-mock/mini_agent/config
cp /tmp/mm-p5-mock/config/*.yaml /tmp/mm-p5-mock/config/*.json /tmp/mm-p5-mock/config/*.md /tmp/mm-p5-mock/mini_agent/config/ 2>/dev/null || true
```

若 P0.7 证实 workspace-local config 不被 Mini-Agent 优先读（即无法脱离 `~/.mini-agent/config/config.yaml`），P0.5 "invalid model" 场景需降级为"在 /tmp 的独立 HOME 环境下跑"（`HOME=/tmp/mm-p5-mock-home` 重定向），下面 Step 2 给出这种降级方案。

- [ ] **Step 2: 写矩阵脚本 `doc/probe/scripts/p5-run-matrix.sh`**

```bash
mkdir -p doc/probe/scripts
cat > doc/probe/scripts/p5-run-matrix.sh <<'EOF'
#!/bin/bash
# P0.5 — 4 failure scenarios × 4 locales = 16 samples
set -u

OUT_DIR=/tmp/mm-p5
rm -rf "$OUT_DIR"; mkdir -p "$OUT_DIR"

SCENARIOS=(
  "401:invalid_key"
  "model:invalid_model"
  "cwd:bad_cwd"
  "term:sigterm_midway"
)
LOCALES=(en_US.UTF-8 zh_CN.UTF-8 C POSIX)

# 为 "model" 场景准备一个独立的 HOME（避免碰用户真 config）
# plan v3 修正：Mini-Agent config 三级搜索（cwd → home → package dir）都要隔离
MOCK_HOME=/tmp/mm-p5-mock-home
MOCK_CWD=/tmp/mm-p5-mock-cwd  # 没有 mini_agent/config/ 子目录，避免命中第一级搜索
rm -rf "$MOCK_HOME" "$MOCK_CWD"
mkdir -p "$MOCK_HOME/.mini-agent/config" "$MOCK_CWD"
cp ~/.mini-agent/config/config.yaml "$MOCK_HOME/.mini-agent/config/"
cp ~/.mini-agent/config/mcp.json "$MOCK_HOME/.mini-agent/config/"
cp ~/.mini-agent/config/system_prompt.md "$MOCK_HOME/.mini-agent/config/"
# 在 mock HOME 的 config 里把 model 改成不存在的
python3 -c "
import re
p = '$MOCK_HOME/.mini-agent/config/config.yaml'
with open(p) as f: t = f.read()
t2 = re.sub(r'^model:.*\$', 'model: \"NonexistentModel-X9999\"', t, count=1, flags=re.M)
with open(p, 'w') as f: f.write(t2)
"

# 注意：Mini-Agent 的第三级搜索 <package>/mini_agent/config/config.yaml
# 位于 uv tool install 装的 site-packages 里，我们不能清除它——但假设其值为 YOUR_API_KEY_HERE
# 会先被 config.py:110 的 ValueError 拒绝（stderr 会出现 "Please configure a valid API Key"），
# 这不会污染 model 场景，因为我们的 sentinel 分类能区分"auth-not-configured" vs "invalid-model"。
# 若实跑发现 package 级命中并返回不同 stderr → 降级为"只测第二级 + 第一级"

for SCEN in "${SCENARIOS[@]}"; do
  KIND="${SCEN%%:*}"
  TAG="${SCEN#*:}"
  for LOC in "${LOCALES[@]}"; do
    FILE="$OUT_DIR/${TAG}_${LOC}.out"
    echo "=== scenario=$KIND locale=$LOC ===" > "$FILE"
    case "$KIND" in
      401)
        LC_ALL=$LOC mini-agent -t "hi" -w /tmp >> "$FILE" 2>&1
        echo "exit=$?" >> "$FILE"
        ;;
      model)
        # plan v4 修正：cwd 必须指到 MOCK_CWD（无 mini_agent/config/ 子目录）避开第一级搜索
        LC_ALL=$LOC HOME=$MOCK_HOME mini-agent -t "hi" -w "$MOCK_CWD" >> "$FILE" 2>&1
        echo "exit=$?" >> "$FILE"
        ;;
      cwd)
        LC_ALL=$LOC mini-agent -t "hi" -w /definitely/does/not/exist >> "$FILE" 2>&1
        echo "exit=$?" >> "$FILE"
        ;;
      term)
        (LC_ALL=$LOC mini-agent -t "Count slowly from 1 to 200" -w /tmp >> "$FILE" 2>&1) &
        PID=$!
        sleep 3
        kill -TERM $PID 2>/dev/null
        wait $PID 2>/dev/null
        echo "exit=$?" >> "$FILE"
        ;;
    esac
  done
done

# 汇总：每个 out 是否含三层 sentinel
echo ""
echo "# Sentinel audit (per sample)"
for f in "$OUT_DIR"/*.out; do
  L1=$(grep -c "Please configure a valid API Key" "$f")
  L3A=$(grep -c "Retry failed" "$f")
  L3B=$(grep -cE "Session Statistics:" "$f")
  LOG=$(grep -c "Log file:" "$f")
  echo "$(basename $f) L1=$L1 L3_retry=$L3A L3_stats=$L3B log_line=$LOG"
done

# 清理 mock home（保留 out_dir 供下一步分析）
rm -rf "$MOCK_HOME"
EOF
chmod +x doc/probe/scripts/p5-run-matrix.sh
bash doc/probe/scripts/p5-run-matrix.sh | tee /tmp/mm-p5-summary.log
```

- [ ] **Step 3: 写 `doc/probe/05-failure-sentinels.md`**

表格化整理（16 行）：

| 场景 | locale | Exit | 源码常量命中 | 日志末 RESPONSE 形态 | stdout sentinel | 归类建议 |
|---|---|---|---|---|---|---|
| 401 | en_US.UTF-8 | 0 | ✓ | ? | Retry failed ✓ | auth-failure |
| 401 | zh_CN.UTF-8 | ... | ... | ... | ... | ... |
| 401 | C | ... | ... | ... | ... | ... |
| 401 | POSIX | ... | ... | ... | ... | ... |
| model | en_US.UTF-8 | ... | ... | ... | ... | ... |
| ... (12 more) ... | | | | | | |

确认 §4.1 三层 sentinel 的映射真正工作；若某个 locale 破坏第一层或第三层 → 明确登记"locale 敏感 sentinel"以便 §4.1 代码实现时加 strip/normalize。

- [ ] **Step 4: Commit**

```bash
git add doc/probe/05-failure-sentinels.md doc/probe/scripts/p5-run-matrix.sh
git commit -m "probe(P0.5): full 4-scenario × 4-locale sentinel matrix (mock HOME for model scenario)"
```

---

### Task P0.6: Probe YAML 并发写竞态

**Files:**
- Create: `doc/probe/06-yaml-concurrent-write.md`
- Create: `doc/probe/scripts/p6-concurrent-write.mjs`（辅助脚本，probe 结束后保留 git 里）

- [ ] **Step 1: 写并发模拟脚本**

```bash
mkdir -p doc/probe/scripts
cat > doc/probe/scripts/p6-concurrent-write.mjs <<'EOF'
#!/usr/bin/env node
// 模拟两个 setup 并发写同一个 config.yaml 的 api_key
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const YAML = path.join(os.homedir(), ".mini-agent", "config", "config.yaml");

function readApiKey(text) {
  const m = text.match(/^api_key:\s*"?([^"#\n]*)"?\s*(?:#.*)?$/m);
  return m ? m[1].trim() : null;
}

async function naiveWrite(newKey, tag) {
  const text = fs.readFileSync(YAML, "utf8");
  const next = text.replace(/^api_key:\s*.*$/m, `api_key: "${newKey}"`);
  // 无锁：故意留窗口
  await new Promise(r => setTimeout(r, Math.random() * 50));
  fs.writeFileSync(YAML, next);
  console.log(`[${tag}] wrote ${newKey}`);
}

const runs = 20;
const keys = Array.from({ length: runs }, (_, i) => `sk-probe-${i}-${Date.now()}`);
await Promise.all(keys.map((k, i) => naiveWrite(k, i)));

const finalKey = readApiKey(fs.readFileSync(YAML, "utf8"));
console.log(`final api_key = ${finalKey}`);
console.log(`is one of the writes? ${keys.includes(finalKey)}`);
console.log(`file size = ${fs.statSync(YAML).size}`);
EOF
```

- [ ] **Step 2: 改脚本指向 mock path（**绝不碰用户真文件**）**

把 Step 1 的脚本里的 `YAML = path.join(os.homedir(), ".mini-agent", "config", "config.yaml")` 改为：
```js
const YAML = process.env.MINI_AGENT_CONFIG_PATH || "/tmp/mm-p6-mock.yaml";
```

然后创建 mock 文件并跑脚本：

```bash
# 从真 config 拷贝一份到 mock path（永远只操作 mock）
cp ~/.mini-agent/config/config.yaml /tmp/mm-p6-mock.yaml
# 跑并发
MINI_AGENT_CONFIG_PATH=/tmp/mm-p6-mock.yaml node doc/probe/scripts/p6-concurrent-write.mjs
# 观察 mock 是否损坏
cat /tmp/mm-p6-mock.yaml | head -20
# 清理
rm /tmp/mm-p6-mock.yaml
```

**绝不 `cp bak.yaml 用户真 config.yaml`**——中途任何异常都可能让 cp 恢复步骤跳过，导致用户 key 丢失。Plan v2 全程用 mock path，用户真 config 只读不写。

- [ ] **Step 3: 写 `doc/probe/06-yaml-concurrent-write.md`**

```markdown
# Probe P0.6: YAML 并发写竞态

## 无锁版本（20 并发）
- 最终 api_key 是某一个写入的值: yes/no
- 文件结构损坏: yes/no
- 其他字段（model, api_base, retry, tools）保留: yes/no
- 观察到的病态: <列举>

## 结论
- 无锁版本会损坏/丢失数据: yes → §4.2 stale-lock 方案必要
- v0.1 实现要点:
  1. withLock() 实现细节
  2. 原子 rename 同目录
  3. fsync 文件 + 父目录

## T12 验收预演
- 在 stale-lock + 同目录 + fsync 版本下，连跑 3 次 setup 用不同 key
- 最后一次 key 生效: yes/no
- 其他字段保留: yes/no
```

- [ ] **Step 4: Commit**

```bash
git add doc/probe/06-yaml-concurrent-write.md doc/probe/scripts/p6-concurrent-write.mjs
git commit -m "probe(P0.6): YAML concurrent write race + lock requirement"
```

---

### Task P0.7: Probe workspace-local config 覆盖

**Files:**
- Create: `doc/probe/07-workspace-local-config.md`

- [ ] **Step 1: 在 workspace 放局部 config**

```bash
mkdir -p /tmp/mm-p7/mini_agent/config
cp ~/.mini-agent/config/config.yaml /tmp/mm-p7/mini_agent/config/config.yaml
cp ~/.mini-agent/config/mcp.json /tmp/mm-p7/mini_agent/config/mcp.json
cp ~/.mini-agent/config/system_prompt.md /tmp/mm-p7/mini_agent/config/system_prompt.md

# 修改局部 config 的 model 或 api_base 作为"指纹"
python3 -c "
import re
p = '/tmp/mm-p7/mini_agent/config/config.yaml'
with open(p) as f: t = f.read()
t2 = re.sub(r'^api_base:.*$', 'api_base: \"https://LOCAL-FINGERPRINT-X/\"', t, count=1, flags=re.M)
with open(p, 'w') as f: f.write(t2)
"

# 用 -w /tmp/mm-p7 跑
mini-agent -t "hi" -w /tmp/mm-p7 > /tmp/mm-p7.out 2>&1
echo "exit=$?"
# 看它是否使用了局部 config（stderr/日志中找 LOCAL-FINGERPRINT-X）
grep -c "LOCAL-FINGERPRINT-X" /tmp/mm-p7.out
```

- [ ] **Step 2: 对照：cwd 切到 workspace 前**

```bash
cd /tmp/mm-p7
mini-agent -t "hi" > /tmp/mm-p7b.out 2>&1
# 看它是否用了 cwd 下的 config
grep -c "LOCAL-FINGERPRINT-X" /tmp/mm-p7b.out
```

- [ ] **Step 3: 写 `doc/probe/07-workspace-local-config.md`**

```markdown
# Probe P0.7: Workspace-local config 优先级

## 结果
- `-w /tmp/mm-p7` (当前 cwd ≠ workspace): 局部 config 生效 yes/no
- `cd /tmp/mm-p7` (cwd = workspace): 局部 config 生效 yes/no

## Config 搜索优先级（实测）
<填入观察到的优先级顺序>

## 软门判定
- [ ] 通过: v0.2 可做 per-job 局部 config（spec §8.5 第五路径打通）
- [ ] 不通过: v0.2 per-command 切模型和"第五路径"都放弃，走 v0.2 其他路径
```

- [ ] **Step 4: Commit**

```bash
git add doc/probe/07-workspace-local-config.md
git commit -m "probe(P0.7): workspace-local config override"
```

---

### Task P0.8: Probe API key 格式（source-based，无浏览器）

**Files:**
- Create: `doc/probe/08-api-key-format.md`

> **plan v2 修正**：原 v1 要"开浏览器看 UI"——fresh subagent 无法执行。改为从已索引的公开文档 + 示例推断，辅以实测。

- [ ] **Step 1: 源头取证**

```bash
# MiniMax 官方文档里对 API key 的描述已在前期调研入 spec 附录 C（api.minimax.io / api.minimaxi.com）
# 再从 anthropic_client.py 看 Mini-Agent 是怎么传的——纯 Bearer token 头
grep -n "Bearer" /Users/bing/.local/share/uv/tools/mini-agent/lib/python3.11/site-packages/mini_agent/llm/anthropic_client.py
# config.py 里对 api_key 字段类型的约束
grep -nA2 "api_key: str" /Users/bing/.local/share/uv/tools/mini-agent/lib/python3.11/site-packages/mini_agent/config.py
# 看 anthropic SDK 的鉴权头要求
python3 -c "import anthropic; print(anthropic.AsyncAnthropic.__init__.__doc__)" 2>&1 | head -20 || true
```

- [ ] **Step 2: 推断 + 实测**

基于 Mini-Agent 用 Anthropic-compatible 端点 + `Authorization: Bearer <api_key>`，key 本质是 opaque Bearer token——**Mini-Agent 对 key 格式不做任何限制**，格式约束来自 MiniMax 平台本身。保守假设：
- 常见形态：`sk-...` / JWT (`eyJ...`) / 其他 opaque token
- 长度推断：Bearer token 一般 ≥ 32 字符

- [ ] **Step 3: 写 `doc/probe/08-api-key-format.md`**

```markdown
# Probe P0.8: API key 格式

## MiniMax 平台 key 形态（来源：platform.minimax.io 文档 / UI 截图）
- 前缀: `sk-...` / JWT (`eyJ...`) / 其他
- 长度范围: <>
- 字符集: <>
- 是否会过期: <>

## 写入前校验 regex
建议 v0.1 写入 YAML 前的格式校验（极宽松，只防明显乱输入）:
- `^[A-Za-z0-9_\-\.]{20,}$` / `^(sk-|eyJ)[A-Za-z0-9_\-\.]{16,}$` / 不校验

## 结论
- 写入前校验正则: <>
- Redaction regex（spec §3.4 API key 脱敏）: <e.g. `sk-[A-Za-z0-9_\-\.]{20,}`>
```

- [ ] **Step 3: Commit**

```bash
git add doc/probe/08-api-key-format.md
git commit -m "probe(P0.8): API key format + redaction regex"
```

---

### Task P0.9: 文档化 env-auth 结论（已完成）

**Files:**
- Create: `doc/probe/09-env-auth.md`

- [ ] **Step 1: 写 `doc/probe/09-env-auth.md`**

```markdown
# Probe P0.9: env-auth 支持（已完成于 brainstorming 阶段）

## 方法
- 源码搜索: `grep -R 'os\.environ\|os\.getenv\|environ\.get\|getenv' /Users/bing/.local/share/uv/tools/mini-agent/lib/python3.11/site-packages/mini_agent/`
- 实证: `MINIMAX_API_KEY=env-test ANTHROPIC_API_KEY=env-test mini-agent --version`
- 源码审读: `/Users/bing/.local/share/uv/tools/mini-agent/lib/python3.11/site-packages/mini_agent/config.py:107-124`

## 结果
- grep: **0 matches**
- 实证: env 值未被读取（mini-agent --version 正常，但 config.yaml 里的假 key 仍是唯一有效值）
- 源码: `api_key` 是 YAML 必需字段；placeholder/空 → `raise ValueError("Please configure a valid API Key")`

## 结论
**Mini-Agent 完全不支持任何 env 变量作 api_key 源**。

## 对 spec 的影响
- Q2（spec 附录 A）选 B 守住，方案锁定"AskUserQuestion 写 YAML + §3.4 三层硬化"
- spec 第五路径（per-job 局部 config）仍是 v0.2 备选，前提是 P0.7 通过

## 硬门判定
- [x] 已完成（结论记录入 spec 附录 B "env-auth Probe 结果留痕"）
```

- [ ] **Step 2: Commit**

```bash
git add doc/probe/09-env-auth.md
git commit -m "probe(P0.9): env-auth probe conclusion (already completed in brainstorming)"
```

---

### Task P0.10: Probe 并发 spawn 下日志归属 (**条件硬门**)

**Files:**
- Create: `doc/probe/10-concurrent-spawn-log.md`
- Create: `doc/probe/scripts/p10-concurrent-spawn.mjs`

- [ ] **Step 1: 写并发 spawn 脚本**

```bash
cat > doc/probe/scripts/p10-concurrent-spawn.mjs <<'EOF'
#!/usr/bin/env node
// 同时 spawn 多个 mini-agent，观察日志文件归属
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_DIR = path.join(os.homedir(), ".mini-agent", "log");

function listLogs() {
  return fs.readdirSync(LOG_DIR).filter(f => f.endsWith(".log"));
}

async function runOne(tag) {
  const before = new Set(listLogs());
  const proc = spawn("mini-agent", ["-t", `tag=${tag} say OK`, "-w", "/tmp"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  proc.stdout.on("data", c => { stdout += c.toString("utf8"); });
  await new Promise(res => proc.once("close", res));
  const after = new Set(listLogs());
  const diff = [...after].filter(f => !before.has(f));
  // 从 stdout 里抓 log path
  const m = stdout.match(/Log file:\s+(\S+\.log)/);
  const stdoutLog = m ? path.basename(m[1]) : null;
  return { tag, diffLogs: diff, stdoutLog };
}

const results = await Promise.all([1, 2, 3].map(i => runOne(`T${i}`)));
console.log(JSON.stringify(results, null, 2));
// 统计：每个 spawn 的 diff 里有几个文件？stdout 里的 path 是否在自己的 diff 里？
results.forEach(r => {
  const match = r.stdoutLog && r.diffLogs.includes(r.stdoutLog);
  console.log(`${r.tag}: diff_count=${r.diffLogs.length} stdout_in_diff=${match}`);
});
EOF
chmod +x doc/probe/scripts/p10-concurrent-spawn.mjs
```

- [ ] **Step 2: 跑 3 次（各 3 并发）**

```bash
for i in 1 2 3; do
  echo "=== Round $i ==="
  node doc/probe/scripts/p10-concurrent-spawn.mjs
done
```

观察：
- 每轮 3 个 spawn 的 `diff_count` 是否都是 1？（理想情况）
- `stdout_in_diff` 是否都是 true？
- 有没有 spawn 拿到 0 个或 2+ 个 diff log？

- [ ] **Step 3: 写 `doc/probe/10-concurrent-spawn-log.md`**

```markdown
# Probe P0.10: 并发 spawn 日志归属 (**条件硬门**)

## 结果（3 轮 × 3 并发）
| Round | Tag | diff_count | stdout_in_diff |
|---|---|---|---|
| 1 | T1 | <> | <> |
| 1 | T2 | <> | <> |
| ... | ... | ... | ... |

## 失败模式
- 同秒 spawn 的文件同名冲突: yes / no
- 文件名精度 (秒 vs 毫秒): <>

## 条件硬门判定
- [ ] PASS：snapshot-diff + `Log file:` 交叉验证能稳定识别归属 → Phase 1 按 §3.3 实现
- [ ] FAIL：归属不可靠 → Phase 1 **必须**在 `job-control.mjs` 里实现串行化调度（一次只跑一个 mini-agent），直到 v0.2 引入上游 job-id 注入
```

- [ ] **Step 4: Commit**

```bash
git add doc/probe/10-concurrent-spawn-log.md doc/probe/scripts/p10-concurrent-spawn.mjs
git commit -m "probe(P0.10): concurrent spawn log attribution"
```

- [ ] **Step 5: 条件硬门契约（spec §8.4）**

**如果 Step 3 的报告显示 "条件硬门判定: FAIL"**：不停 plan，但**必须**在执行到 Phase 4 `job-control.mjs` 时采用"串行化 job 调度"fallback（spec §7）。在 CHANGELOG 追加一条 **warning 条目**，让后续 Phase 2/4 的 executor 有明确信号：

```bash
# 仅当 FAIL 时跑此 step
cat >> CHANGELOG.md <<EOF

## $(date +"%Y-%m-%d %H:%M") [executor]

- **status**: in-progress
- **scope**: Phase 0 / P0.10 (concurrent spawn log attribution) — **CONDITIONAL GATE FAILED**
- **summary**: snapshot-diff + \`Log file:\` 交叉验证在并发场景下不稳定（详见 doc/probe/10-concurrent-spawn-log.md）。Phase 1 继续，但 Phase 4 job-control.mjs 必须采用串行化 job 调度（一次只允许一个 mini-agent 在跑），v0.2 引入上游 job-id 注入后再改造。
- **next**: 本 Phase 0 其余 probe 继续；Phase 1 骨架不受影响；Phase 4 作者必须读本条目。
EOF
git add CHANGELOG.md
git commit -m "warn(P0.10): conditional gate failed, Phase 4 must use serial job scheduling"
```

若 PASS 则无此 step。

---

### Task P0.11: Probe `mini-agent log <file>` 子命令

**Files:**
- Create: `doc/probe/11-mini-agent-log-subcommand.md`

- [ ] **Step 1: 测试 log list 和 log read**

```bash
mini-agent log 2>&1 | head -20    # 列表视图
# 找一个已有的日志文件
LATEST=$(ls -t ~/.mini-agent/log/*.log 2>/dev/null | head -1)
echo "LATEST=$LATEST"
mini-agent log "$(basename $LATEST)" > /tmp/mm-p11-agent-read.out 2>&1
echo "exit=$?"
diff <(head -100 "$LATEST") <(head -100 /tmp/mm-p11-agent-read.out) | head -20
```

- [ ] **Step 2: 比较 `mini-agent log` vs 自己读**

- 文件内容是否一致？
- `mini-agent log` 是否有前缀/后缀/装饰（ANSI 色）？
- 是否能 pipe 解析？

- [ ] **Step 3: 写 `doc/probe/11-mini-agent-log-subcommand.md`**

```markdown
# Probe P0.11: mini-agent log 子命令

## log list
`mini-agent log`  → 输出格式: <彩字表格 / JSON / ...>

## log read
`mini-agent log <filename>` → 与直接 cat 文件的 diff:
- <相同 / 含装饰 / 截断 ...>

## fallback 适用性
- 能否作为 parseFinalResponseFromLog 的 fallback 二次源: yes / no / with-caveat
- caveat: <>

## 软门判定
- [ ] 通过: §3.5 fallback 实现照 spec
- [ ] 不通过: Phase 1 不实现 fallback（主路径必须不依赖此 fallback）
```

- [ ] **Step 4: Commit**

```bash
git add doc/probe/11-mini-agent-log-subcommand.md
git commit -m "probe(P0.11): mini-agent log subcommand behavior"
```

---

### Task P0.12: Probe YAML anti-pattern 样本

**Files:**
- Create: `doc/probe/12-yaml-antipatterns.md`
- Create: `doc/probe/fixtures/p12-antipatterns/*.yaml`（多个样本）

- [ ] **Step 1: 构造 5 个 anti-pattern 样本**

```bash
mkdir -p doc/probe/fixtures/p12-antipatterns

cat > doc/probe/fixtures/p12-antipatterns/multiline-block-scalar.yaml <<'EOF'
api_key: |
  this-is-a-multiline-key-starting-with-pipe
  second-line
api_base: "https://api.minimax.io"
model: "MiniMax-M2.5"
provider: "anthropic"
EOF

cat > doc/probe/fixtures/p12-antipatterns/duplicate-key.yaml <<'EOF'
api_key: "first-key"
api_key: "second-key-wins-in-safeload"
api_base: "https://api.minimax.io"
model: "MiniMax-M2.5"
provider: "anthropic"
EOF

cat > doc/probe/fixtures/p12-antipatterns/flow-style.yaml <<'EOF'
api_key: {nested: value}
api_base: "https://api.minimax.io"
model: "MiniMax-M2.5"
provider: "anthropic"
EOF

cat > doc/probe/fixtures/p12-antipatterns/anchor-alias.yaml <<'EOF'
defaults: &defaults
  k: "shared-key-via-anchor"
api_key: *defaults
api_base: "https://api.minimax.io"
model: "MiniMax-M2.5"
provider: "anthropic"
EOF

printf '\xEF\xBB\xBFapi_key: "normal-key"\napi_base: "https://api.minimax.io"\nmodel: "MiniMax-M2.5"\nprovider: "anthropic"\n' > doc/probe/fixtures/p12-antipatterns/bom.yaml
```

- [ ] **Step 2: 写 `doc/probe/12-yaml-antipatterns.md`**

```markdown
# Probe P0.12: YAML anti-pattern samples

## 样本清单（每个都应被 writeMiniAgentApiKey 的预校验 gate 拒绝写入）

1. `multiline-block-scalar.yaml` — `api_key: |` 块标量起首
2. `duplicate-key.yaml` — 两个顶层 `api_key:`
3. `flow-style.yaml` — `api_key: {...}` 流式值
4. `anchor-alias.yaml` — `api_key: *defaults` 锚点引用
5. `bom.yaml` — UTF-8 BOM 起首

## Phase 1 单元测试期望
在 `lib/minimax.mjs::validateYamlForApiKeyWrite(text)` 写好后，跑 5 个 fixture，期望结果：
| fixture | expected reason |
|---|---|
| multiline-block-scalar | "block-scalar indicator in value" |
| duplicate-key | "multiple api_key top-level keys" |
| flow-style | "flow-style value" |
| anchor-alias | "alias or anchor in value" |
| bom | "BOM at file start" |

## 结论
P0.12 的验收：Phase 1 Task 1.7 的单元测试必须跑通所有 5 个 fixture。
```

- [ ] **Step 3: Commit**

```bash
git add doc/probe/fixtures/p12-antipatterns/*.yaml doc/probe/12-yaml-antipatterns.md
git commit -m "probe(P0.12): YAML anti-pattern fixtures for gate tests"
```

---

### Task P0.13: Finalize `minimax-cli-runtime` SKILL (consolidation + final audit)

> **plan v3 重构**（gemini MEDIUM）：原 v2 让 single subagent 一次性读 12 份 probe 报告填 SKILL.md 容易幻觉。v3 改为**增量构建**：
> - 在 P0.1 Task 创建 SKILL.md 初始骨架（带明确占位符块）
> - 每个 Phase 0 probe task 在 Commit step 之后、硬门 step 之前加一个 "update SKILL.md" 可选子步骤：只改它自己那节的占位符
> - P0.13 只做最终核对、风格统一、commit v0.1 tag
>
> **本 task（P0.13）是纯 audit**：不生成内容，只验证前面 12 个 probe task 已把各自的 SKILL.md 段落填好。

**Files:**
- Modify: `plugins/minimax/skills/minimax-cli-runtime/SKILL.md`（前面 probe task 已渐进填写）

- [ ] **Step 0: 前置要求** — P0.1 到 P0.12 必须已全部提交，`plugins/minimax/skills/minimax-cli-runtime/SKILL.md` 必须已存在且所有占位符已填

```bash
test -f plugins/minimax/skills/minimax-cli-runtime/SKILL.md || { echo "SKILL.md missing — upstream probe tasks did not create it"; exit 1; }
# 检查占位符是否仍在
if grep -q '<probe-fill>' plugins/minimax/skills/minimax-cli-runtime/SKILL.md; then
  echo "ERROR: unresolved <probe-fill> markers remain:"
  grep -n '<probe-fill>' plugins/minimax/skills/minimax-cli-runtime/SKILL.md
  exit 1
fi
```

- [ ] **Step 1: 终版核对**

打开 `plugins/minimax/skills/minimax-cli-runtime/SKILL.md`，确认：
1. frontmatter `name: minimax-cli-runtime` / `description: ...`
2. 10 节内容都齐全（Runtime requirements / Companion subcommands / Mini-Agent CLI facts / Config write contract / Log attribution / API key redaction / Session & resume / Do NOT / 等）
3. 所有 probe 数据都是具体值（不是 `<probe-fill>` 或 `TBD`）
4. 风格一致（中英混用统一、列表缩进统一）

```bash
mkdir -p plugins/minimax/skills/minimax-cli-runtime
```

写入内容（把 `<probe-fill>` 占位符替换为 probe 报告里的实际值）：

````markdown
---
name: minimax-cli-runtime
description: Internal helper contract for calling the minimax-companion runtime from Claude Code
---

# minimax-cli-runtime

Internal contract for code invoking `scripts/minimax-companion.mjs`. This is not user-facing. Claude uses this skill when dispatched via `/minimax:*` commands or the `minimax-agent` subagent.

## Runtime requirements

- `mini-agent` CLI ≥ 0.1.0 on PATH (installed via `uv tool install --with socksio git+https://github.com/MiniMax-AI/Mini-Agent.git`)
- `~/.mini-agent/config/config.yaml` present with valid `api_key` (not placeholder)
- Node.js ≥ 18

## Companion script subcommands

All companion subcommands return JSON when `--json` is passed. Without `--json`, output is human-readable text.

| Subcommand | Purpose | JSON shape |
|---|---|---|
| `setup --json` | Check availability + auth | `{installed, version, authenticated, authDetail, model, apiBase, installers}` |
| `ask [options] "<prompt>"` | One-shot query (Phase 2) | `{response, logPath, toolCalls, success, ...}` |
| `review [options]` | Review current diff (Phase 3) | `{verdict, summary, findings[], next_steps[]}` |
| `task [options] "<prompt>"` | Background job (Phase 4) | `{jobId, status}` |
| `status` | List jobs (Phase 4) | `{jobs: [...]}` |
| `result <jobId>` | Get job result (Phase 4) | `{status, response, logPath}` |
| `cancel <jobId>` | Cancel job (Phase 4) | `{ok}` |
| `task-resume-candidate --json` | v0.1 stub (returns `{available: false, reason: "no session-id support"}`) | `{available}` |

## Mini-Agent CLI invocation facts (probe-confirmed)

These constants are the direct result of Phase 0 probes. Do not re-derive.

- **Version check**: `mini-agent --version` (also accepts `-v`)
- **One-shot task**: `mini-agent -t "<prompt>" -w <cwd>`
- **Exit code**: 恒为 0（即便 401）——不依赖 `$?` 判定成败
- **Log file path**: stdout 首屏一行 `Log file: <absolute path>`（regex `/Log file:\s+(\S+\.log)/`），出现在前 30 行内 (probe 01 实测 <probe-fill>)
- **Log file location**: `~/.mini-agent/log/agent_run_YYYYMMDD_HHMMSS.log`（秒级时间戳，**非增量 flush / 增量 flush** 见 probe 03）
- **RESPONSE block structure** (probe 02):
  - Separator: `^-{80}$`
  - Block header: `^\[([0-9]+)\] (REQUEST|RESPONSE)$`
  - RESPONSE JSON: **OpenAI 兼容规范化格式**（P0.2 实测；非 Anthropic 原始）
    `{ content: <string>, thinking?: <string>, tool_calls?: [{id,name,arguments}], finish_reason: "stop"|"length"|"tool_calls"|... }`
  - **3 种 block kind**: `REQUEST` / `RESPONSE` / `TOOL_RESULT`；log_index 跨 kind 连续递增
  - Separator: file header `=` × 80，block 分隔 `-` × 80（parser 必须区分）
  - 终态选择规则：从最大 N 倒序遍历 RESPONSE 块，选第一个有 `finish_reason` ∈ `{stop,length,tool_calls,tool_use,content_filter,max_tokens}` 或非空 `content` 字符串的 block
- **Large prompts** (probe 04): use `<stdin|argv|tmpfile>` strategy, limit `<N>` bytes for argv
- **Failure sentinels 三层优先级** (probe 05):
  - Layer 1 (source constants):
    - `config.py:111 "Please configure a valid API Key"` → auth-not-configured
    - `config.py:78 "Configuration file not found"` → config-missing
    - spawn ENOENT → not-installed
    - stderr `ImportError: Using SOCKS proxy` → needs-socksio
  - Layer 2 (log structure): 日志末尾终态 RESPONSE block 的 `finish_reason`（P0.2 修订；字符串 `content` 非空也算终态）
  - Layer 3 (stdout sentinels，ANSI strip 后):
    - `❌ Retry failed` / `LLM call failed after N retries` → llm-call-failed
    - `Session Statistics:` 无日志 → success-claimed-but-no-log
    - 三层全 fallthrough → unknown-crashed

## Config write contract (§3.4 spec)

- **Only** `api_key` is ever written by this plugin
- **Predicate gate** (writeApiKey fails closed if any):
  - BOM at file start
  - Not exactly one `^api_key:\s*.*$` top-level line
  - Value starts with block scalar indicator (`|` / `>` / `|-` / `|+` / `>-` / `>+`)
  - Value starts with flow-style (`{` / `[`)
  - Value starts with anchor/alias (`&` / `*`)
  - Value starts with tag (`!`)
  - Value contains newline
  - Next line looks like continuation indentation
- Atomic write: tmpfile in same dir, fsync file + fsync dir, then rename
- File lock: `~/.mini-agent/config/.lock` with `{pid, mtime}`; stale-lock recovery by `kill -0 pid` + mtime 60s threshold

## Log attribution (probe 10)

- **PASS 分支**: spawn 前后 `ls ~/.mini-agent/log/` 快照 diff + stdout `Log file:` 行交叉验证
- **FAIL 分支**: 串行化 job 调度（一次只允许一个 mini-agent 运行），v0.2 再改造

## API key redaction (spec §3.4)

Secrets must not appear in: argv, state.json, jobs/*/meta.json, CHANGELOG.md, probe reports, Claude-visible diagnostic bundles.

Regex before printing any text that may contain a key:
```js
text.replace(/sk-[A-Za-z0-9_\-\.]{20,}/g, "sk-***REDACTED***")
   .replace(/eyJ[A-Za-z0-9_\-\.]{20,}/g, "eyJ***REDACTED***")
```

## Session / resume

- v0.1: 不支持续跑（Mini-Agent 无外部 session id）
- `/minimax:rescue --resume-last` 等价于新建 session + 提示 "v0.1 no resumable session"
- 不使用 `kimi -C` / `gemini --resume` 的等价物

## Do NOT

- Do NOT pass `--approval-mode`（Mini-Agent 无此概念）
- Do NOT write anywhere under `~/.mini-agent/` 除了 `config/.lock` 和 `config/config.yaml::api_key`（spec §5.2 修订原则）
- Do NOT parse the mini-agent log file 装饰区域（Agent Run Log 头 / Session Statistics 段）—— 只取 `[N] RESPONSE` 块
- Do NOT batch multiple prompts into one call
- Do NOT 依赖 `mini-agent log <filename>` fallback 作为主路径——它是 best-effort，失败只记录
````

**注意**：上面的 `<probe-fill>` 位置需要在写入文件时替换为 probe 01-12 的实际数值。如果 probe 结论尚未填满，用 `TBD (probe pending)` 标记——但因为此 Task 在 P0.13，所有 probe 已完成，不应有 TBD。

> **note**：上面展示的完整 SKILL.md 模板是**增量构建产物**。下面给出的是**实际每个 probe task 应在末尾追加的"填 SKILL.md 占位符"子步骤模板**，由 P0.1 probe task 的 executor 创建骨架，后续 probe task 各自 fill。v0.1 plan 为简化，选择在 P0.13 一次性呈现完整模板 + 让 executor 按"前面 probe 的报告 + 自己的结论"最终化——这是 v3 的中间方案：不再一次性 12-way fill，但也不强制每 probe task 编辑 SKILL.md。Phase 2 plan 写 Phase 2 skill 时改为全增量模式。

- [ ] **Step 2: Verify file structure**

```bash
ls plugins/minimax/skills/minimax-cli-runtime/SKILL.md
head -5 plugins/minimax/skills/minimax-cli-runtime/SKILL.md
grep -c '<probe-fill>' plugins/minimax/skills/minimax-cli-runtime/SKILL.md  # 必须为 0
```

Expected: frontmatter with `name: minimax-cli-runtime`；grep 输出 `0`。

- [ ] **Step 3: Commit**

```bash
git add plugins/minimax/skills/minimax-cli-runtime/SKILL.md
git commit -m "feat(skill): minimax-cli-runtime v0.1 finalized from probe results (plan v3)"
```

---

## Phase 1: Skeleton + Setup

### Task 1.1: Initialize repo root files

**Files:**
- Modify: `.gitignore`（baseline 已有极简版，本 task 扩充）
- Create: `README.md`
- Create: `CLAUDE.md`
- Create: `CHANGELOG.md`（根）

- [ ] **Step 1: 扩充 `.gitignore`**

读当前 `.gitignore`，追加（保持已有）：

```
# plan v3 扩充项
coverage/
.env
.env.local
*.swp
.cache/
```

最终 `.gitignore` 完整内容：

```
node_modules/
*.log
.DS_Store
/tmp/
/plugins/minimax/scripts/*.tmp
/plugins/minimax/scripts/*.bak
**/.lock
coverage/
.env
.env.local
*.swp
.cache/
```

- [ ] **Step 2: Write `CLAUDE.md`**

```markdown
# minimax-plugin-cc working directory instructions

This repo is a Claude Code plugin that wraps MiniMax-AI/Mini-Agent. It mirrors the structure of `gemini-plugin-cc` at `/Users/bing/-Code-/gemini-plugin-cc/` and `kimi-plugin-cc` at `/Users/bing/-Code-/kimi-plugin-cc/`.

## Before coding

- Read `docs/superpowers/specs/2026-04-20-minimax-plugin-cc-design.md` (the spec)
- Read `doc/probe/*.md` (Phase 0 probe conclusions — decisions were locked here)
- Read the most recent 5 entries of `CHANGELOG.md` (cross-AI hand-off log)
- If touching a "near-copy" file, read its gemini counterpart first — no sed, no cp

## After coding

- Append CHANGELOG.md entry with `status`, `scope`, `summary`, `next`
- Run the T checklist entries that your change could affect
- Never commit API keys (spec §3.4 redaction rules apply to logs and diagnostics too)
```

- [ ] **Step 3: Write `README.md`**

```markdown
# minimax-plugin-cc

Claude Code plugin integrating MiniMax via Mini-Agent.

**Status:** v0.1 in development. Spec: `docs/superpowers/specs/2026-04-20-minimax-plugin-cc-design.md` (v3, passed two rounds of 3-way review).

## Prerequisites

- [Claude Code](https://claude.ai/code)
- [Mini-Agent](https://github.com/MiniMax-AI/Mini-Agent) ≥ 0.1.0:
  ```
  uv tool install --with socksio git+https://github.com/MiniMax-AI/Mini-Agent.git
  ```
- Configured `~/.mini-agent/config/config.yaml` with valid MiniMax API key

## Install (development)

```bash
claude plugins add ./plugins/minimax
```

## Commands (v0.1 incremental)

- `/minimax:setup` — verify Mini-Agent installation, auth state, and write API key (if needed)
- (more coming as phases complete)

## License

MIT
```

- [ ] **Step 4: Write `CHANGELOG.md`**

```markdown
# minimax-plugin-cc CHANGELOG

## 2026-04-20 [Claude Opus 4.7]

- **status**: draft
- **scope**: docs/specs + docs/plans
- **summary**: v0.1 spec and Phase 0+1 plan committed after brainstorming + two rounds of codex+gemini 3-way review. Spec at `docs/superpowers/specs/2026-04-20-minimax-plugin-cc-design.md` (897 lines, v3). Plan at `docs/superpowers/plans/2026-04-20-phase-0-1-foundation.md`. No code yet.
- **next**: execute Phase 0 probes; if P0.1 or P0.2 fail, stop plan and notify user.
```

- [ ] **Step 5: Commit**

```bash
git add .gitignore README.md CLAUDE.md CHANGELOG.md
git commit -m "chore: repo root files (Phase 1 kick-off)"
```

---

### Task 1.2: Marketplace + plugin manifests

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `plugins/minimax/.claude-plugin/plugin.json`
- Create: `plugins/minimax/CHANGELOG.md`

- [ ] **Step 1: Write `.claude-plugin/marketplace.json`**

```bash
mkdir -p .claude-plugin
```

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "minimax-plugin",
  "version": "0.1.0",
  "description": "MiniMax Mini-Agent plugin for Claude Code",
  "owner": { "name": "bing" },
  "plugins": [
    {
      "name": "minimax",
      "description": "Use MiniMax (via Mini-Agent) from Claude Code to review code, delegate multi-step agentic tasks, or leverage 15 built-in Claude Skills + MCP tools.",
      "version": "0.1.0",
      "author": { "name": "bing" },
      "source": "./plugins/minimax",
      "category": "development"
    }
  ]
}
```

- [ ] **Step 2: Write `plugins/minimax/.claude-plugin/plugin.json`**

```bash
mkdir -p plugins/minimax/.claude-plugin
```

```json
{
  "name": "minimax",
  "version": "0.1.0",
  "description": "Use MiniMax (via Mini-Agent) from Claude Code.",
  "author": { "name": "bing" }
}
```

- [ ] **Step 3: Write `plugins/minimax/CHANGELOG.md`**

```markdown
# minimax plugin CHANGELOG

## 0.1.0 (in progress)

- Initial scaffold
- `/minimax:setup` command (Phase 1)
- Near-copy of gemini-plugin-cc lib files (args/process/render/git/state)
- `minimax.mjs` core wrapper (YAML reader/writer with hardened gate + ping auth + log extraction)
- `minimax-cli-runtime` skill draft from Phase 0 probes
- `minimax-prompting` skill skeleton
```

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin plugins/minimax/.claude-plugin plugins/minimax/CHANGELOG.md
git commit -m "feat: marketplace and plugin manifests"
```

---

### Task 1.3: Near-copy `args.mjs` and `process.mjs` (zero minimax-specific logic)

**Files:**
- Create: `plugins/minimax/scripts/lib/args.mjs`
- Create: `plugins/minimax/scripts/lib/process.mjs`

- [ ] **Step 1: Read gemini's `args.mjs` fully**

Open `/Users/bing/-Code-/gemini-plugin-cc/plugins/gemini/scripts/lib/args.mjs`. It defines `parseArgs(argv, config)` and `splitRawArgumentString(raw)`. Zero references to gemini/minimax.

```bash
mkdir -p plugins/minimax/scripts/lib
```

Write byte-for-byte identical copy to `plugins/minimax/scripts/lib/args.mjs`. (P2 rule: read and understand, then write out — the fact that result is identical bytes is fine.)

- [ ] **Step 2: Verify**

```bash
node --check plugins/minimax/scripts/lib/args.mjs
```

Expected: no output (parse OK).

- [ ] **Step 3: Read gemini's `process.mjs` fully**

Open `/Users/bing/-Code-/gemini-plugin-cc/plugins/gemini/scripts/lib/process.mjs`. Exports `runCommand`, `runCommandChecked`, `binaryAvailable`, `formatCommandFailure`. Zero gemini/minimax references.

Write byte-for-byte identical copy to `plugins/minimax/scripts/lib/process.mjs`.

- [ ] **Step 4: Verify**

```bash
node --check plugins/minimax/scripts/lib/process.mjs
```

- [ ] **Step 5: Smoke test**

```bash
node -e 'import("./plugins/minimax/scripts/lib/process.mjs").then(m => { const r = m.binaryAvailable("node", ["-v"]); console.log(r); })'
```

Expected: `{ available: true, detail: "v<version>" }`.

- [ ] **Step 6: Commit**

```bash
git add plugins/minimax/scripts/lib/args.mjs plugins/minimax/scripts/lib/process.mjs
git commit -m "feat(lib): args and process (near-copy from gemini)"
```

---

### Task 1.4: Near-copy `render.mjs` and `git.mjs`

**Files:**
- Create: `plugins/minimax/scripts/lib/render.mjs`
- Create: `plugins/minimax/scripts/lib/git.mjs`

- [ ] **Step 1: Read and rewrite `render.mjs`**

Source: `/Users/bing/-Code-/gemini-plugin-cc/plugins/gemini/scripts/lib/render.mjs`.

Read fully. Rewrite locally at `plugins/minimax/scripts/lib/render.mjs` with:
- Every user-visible string literal `"Gemini"` → `"MiniMax"`, `"gemini"` → `"minimax"`
- Function names / variable names UNCHANGED
- Stats field null-safe branches preserved (stats may be `null` in v0.1 per spec §3.3 — we don't fill stats until Phase 2)

- [ ] **Step 2: Verify**

```bash
node --check plugins/minimax/scripts/lib/render.mjs
```

- [ ] **Step 3: Read and rewrite `git.mjs`**

Source: `/Users/bing/-Code-/gemini-plugin-cc/plugins/gemini/scripts/lib/git.mjs`. Responsibility: collect git diffs for review commands.

Zero gemini/minimax-specific strings. Rewrite byte-for-byte to `plugins/minimax/scripts/lib/git.mjs`.

- [ ] **Step 4: Verify**

```bash
node --check plugins/minimax/scripts/lib/git.mjs
```

- [ ] **Step 5: Commit**

```bash
git add plugins/minimax/scripts/lib/render.mjs plugins/minimax/scripts/lib/git.mjs
git commit -m "feat(lib): render and git (near-copy from gemini)"
```

---

### Task 1.5: Rewrite `state.mjs` with minimax paths + `mj-` job prefix

**Files:**
- Create: `plugins/minimax/scripts/lib/state.mjs`

- [ ] **Step 1: Read gemini's `state.mjs` fully**

Source: `/Users/bing/-Code-/gemini-plugin-cc/plugins/gemini/scripts/lib/state.mjs`.

**minimax changes (exhaustive list)**:
- `FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "gemini-companion")` → `path.join(os.tmpdir(), "minimax-companion")`
- `export function generateJobId(prefix = "gj")` → default `"mj"` (minimax job)
- Everything else unchanged (including `PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA"` — Claude-injected env var)

**NEW in minimax (spec §5.1 + plan v2 修正)**: `state.mjs` 必须 **export** `withLock` 且 signature 是 **async-friendly**：
```js
export async function withLock(lockPath, asyncFn) { ... }
```
若 gemini 原版是 `export function withLock(lockPath, fn)`（同步回调）→ 需要**改造成 async**（或增加 `withLockAsync` 姊妹函数）。读取 gemini 原实现时，若发现锁机制写死在某个 sync path 里、未 export，需要 **refactor**：把核心"acquire → try { await fn() } finally { release }"逻辑抽成 `withLockAsync` 导出。保留原 `withLock` 兼容 gemini 原有调用。

**stale-lock recovery**（spec §4.2 + plan v3 codex HIGH 补）：`withLockAsync` 内部获取锁时——
- 若锁文件已存在：
  - 读文件内容
  - **空文件 / 非 JSON / JSON 解析失败 / 缺 `pid` 字段** → 视为 stale（明显是损坏），`fs.unlinkSync` 后进 retry 路径
  - 正常 JSON `{pid, mtime}` → `process.kill(pid, 0)` 校验进程存活
  - `kill` 抛 ESRCH（进程不存在） 或 mtime 超过 60s → 视为 stale，unlink 后进 retry
- retry 路径：`writeFileSync(path, payload, { flag: "wx" })`，若 EEXIST → `await sleep(100ms)` 后再试；**最多 3 轮**，全失败抛 `new Error("LOCK_CONTENDED")`

- [ ] **Step 2: Write `state.mjs` locally**

Write the full file to `plugins/minimax/scripts/lib/state.mjs` with only the above changes.

- [ ] **Step 3: Verify**

```bash
node --check plugins/minimax/scripts/lib/state.mjs
```

- [ ] **Step 4: Smoke test `generateJobId`**

```bash
node -e 'import("./plugins/minimax/scripts/lib/state.mjs").then(m => { const id = m.generateJobId(); console.log("id=", id); console.assert(id.startsWith("mj-"), "prefix should be mj-"); })'
```

Expected: prints `id= mj-<ts>-<hex>` and no assertion error.

- [ ] **Step 5: Smoke test `withLockAsync` 全分支**

```bash
node -e '
import("./plugins/minimax/scripts/lib/state.mjs").then(async m => {
  const fs = await import("node:fs");
  console.assert(typeof m.withLockAsync === "function", "withLockAsync must be exported");

  // 基本功能
  const lockPath = "/tmp/mm-state-smoke.lock";
  try { fs.unlinkSync(lockPath); } catch {}
  const r1 = await m.withLockAsync(lockPath, async () => 42);
  console.assert(r1 === 42, "return value pass-through");

  // stale by pid not alive
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, mtime: new Date().toISOString() }));
  const r2 = await m.withLockAsync(lockPath, async () => "recovered-pid");
  console.assert(r2 === "recovered-pid", "stale lock (dead pid) recovered");

  // stale by age（mtime 超 60s）
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, mtime: new Date(Date.now() - 120_000).toISOString() }));
  const r3 = await m.withLockAsync(lockPath, async () => "recovered-age");
  console.assert(r3 === "recovered-age", "stale lock (old mtime) recovered");

  // 损坏锁（空文件 / 非 JSON / 缺字段）—— plan v3 补
  fs.writeFileSync(lockPath, "");
  const r4 = await m.withLockAsync(lockPath, async () => "recovered-empty");
  console.assert(r4 === "recovered-empty", "empty lock file recovered");

  fs.writeFileSync(lockPath, "{not json");
  const r5 = await m.withLockAsync(lockPath, async () => "recovered-malformed");
  console.assert(r5 === "recovered-malformed", "malformed JSON recovered");

  fs.writeFileSync(lockPath, JSON.stringify({ onlyMtime: "..." }));  // 缺 pid
  const r6 = await m.withLockAsync(lockPath, async () => "recovered-missing-field");
  console.assert(r6 === "recovered-missing-field", "missing pid field recovered");

  // Env override path（MINI_AGENT_LOCK_PATH）——plan v3 补
  // 这里不直接测试 MINI_AGENT_LOCK_PATH 是否被 withLockAsync 自动拾取
  // （因为 withLockAsync 接收 lockPath 参数，不自动读 env），
  // 但验证调用 side 传 env 派生的路径是 OK 的
  const envPath = "/tmp/mm-state-smoke-env.lock";
  try { fs.unlinkSync(envPath); } catch {}
  const r7 = await m.withLockAsync(envPath, async () => "env-path");
  console.assert(r7 === "env-path", "arbitrary lock path works");

  console.log("all smoke tests OK");
}).catch(e => { console.error(e); process.exit(1); });
'
```

Expected: `all smoke tests OK`，无 assertion 失败。

- [ ] **Step 6: Commit**

```bash
git add plugins/minimax/scripts/lib/state.mjs
git commit -m "feat(lib): state.mjs with minimax paths (mj- prefix) + exported withLockAsync with stale-lock recovery"
```

---

### Task 1.6: `minimax.mjs` — imports, constants, YAML scanner, availability

**Files:**
- Create: `plugins/minimax/scripts/lib/minimax.mjs`

- [ ] **Step 1: Write initial `minimax.mjs` skeleton with imports + TOP-LEVEL YAML scanner**

```bash
touch plugins/minimax/scripts/lib/minimax.mjs
```

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { binaryAvailable } from "./process.mjs";
import { withLockAsync } from "./state.mjs";

const DEFAULT_TIMEOUT_MS = 300_000;
const AUTH_CHECK_TIMEOUT_MS = 30_000;

export const PARENT_SESSION_ENV = "MINIMAX_COMPANION_SESSION_ID";
export const MINI_AGENT_BIN = process.env.MINI_AGENT_BIN || "mini-agent";

// plan v2 修正：路径常量都可通过 env 覆盖（测试 / mock / CI 场景）
const DEFAULT_MM_DIR = path.join(os.homedir(), ".mini-agent");
export const MINI_AGENT_CONFIG_PATH =
  process.env.MINI_AGENT_CONFIG_PATH ||
  path.join(DEFAULT_MM_DIR, "config", "config.yaml");
export const MINI_AGENT_LOG_DIR =
  process.env.MINI_AGENT_LOG_DIR ||
  path.join(DEFAULT_MM_DIR, "log");
export const MINI_AGENT_LOCK_PATH =
  process.env.MINI_AGENT_LOCK_PATH ||
  path.join(path.dirname(MINI_AGENT_CONFIG_PATH), ".lock");

// ── Top-level YAML key scanner (spec §3.4) ────────────────────
//
// Reads a single top-level string value for a given key.
// Does NOT support: multiline strings (| > literals), flow style ({}, []),
// anchors/aliases (& *), tags (! !!), or nested documents.
// v0.1 scope: enough for {api_key, api_base, model, provider}.

export function readYamlTopLevelKey(text, key) {
  if (!text) return null;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);  // strip BOM
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    // 跳过缩进行（子字段/数组项/延续行）
    if (raw.length !== raw.trimStart().length) continue;
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\w+)\s*:\s*(?:"([^"]*)"|'([^']*)'|([^#\s][^#]*?))\s*(?:#.*)?$/);
    if (m && m[1] === key) return m[2] ?? m[3] ?? (m[4] ? m[4].trim() : null);
  }
  return null;
}

let _configCache;

export function readMiniAgentConfig() {
  if (_configCache !== undefined) return _configCache;
  try {
    const text = fs.readFileSync(MINI_AGENT_CONFIG_PATH, "utf8");
    _configCache = {
      api_key: readYamlTopLevelKey(text, "api_key"),
      api_base: readYamlTopLevelKey(text, "api_base"),
      model: readYamlTopLevelKey(text, "model"),
      provider: readYamlTopLevelKey(text, "provider"),
      raw: text,
    };
  } catch (err) {
    _configCache = {
      api_key: null, api_base: null, model: null, provider: null, raw: null,
      readError: err.code === "ENOENT" ? "config-missing" : `read-error: ${err.message}`,
    };
  }
  return _configCache;
}

// 缓存失效（仅供测试使用）
export function _invalidateConfigCache() { _configCache = undefined; }

// ── Availability ──────────────────────────────────────────────

export function getMiniAgentAvailability(cwd) {
  return binaryAvailable(MINI_AGENT_BIN, ["--version"], { cwd });
}
```

- [ ] **Step 2: Verify parse**

```bash
node --check plugins/minimax/scripts/lib/minimax.mjs
```

- [ ] **Step 3: Smoke test scanner**

```bash
node -e '
import("./plugins/minimax/scripts/lib/minimax.mjs").then(m => {
  const sample = `
# comment
api_key: "sk-fake-xyz"
api_base: "https://api.minimax.io"
model: "MiniMax-M2.5"
provider: "anthropic"
retry:
  max_retries: 3
  initial_delay: 1.0
[should_be_ignored]
`;
  console.log("api_key =", m.readYamlTopLevelKey(sample, "api_key"));
  console.log("api_base =", m.readYamlTopLevelKey(sample, "api_base"));
  console.log("model =", m.readYamlTopLevelKey(sample, "model"));
  console.log("retry.max_retries =", m.readYamlTopLevelKey(sample, "max_retries"));
  console.assert(m.readYamlTopLevelKey(sample, "api_key") === "sk-fake-xyz", "api_key value");
  console.assert(m.readYamlTopLevelKey(sample, "max_retries") === null, "nested key should be null");
  console.log("availability =", m.getMiniAgentAvailability());
});
'
```

Expected:
- api_key = sk-fake-xyz
- max_retries = null
- availability: 若本机已装 mini-agent → `{available: true, detail: "mini-agent 0.1.0"}`

- [ ] **Step 4: Commit**

```bash
git add plugins/minimax/scripts/lib/minimax.mjs
git commit -m "feat(minimax): YAML top-level scanner + availability"
```

---

### Task 1.7: `minimax.mjs` — YAML gate (v3 state machine) + `writeMiniAgentApiKey` (via withLockAsync)

**Files:**
- Modify: `plugins/minimax/scripts/lib/minimax.mjs`
- Create: `plugins/minimax/scripts/lib/minimax.test.mjs`

> **plan v2 核心改动**：`validateYamlForApiKeyWrite` 完全重写为 spec §3.4.2 的状态机——只接受 **Form D（"..."）** 和 **Form S（'...'）** 两种单行形态；其他全 fail-closed。write 路径用 `withLockAsync` 统一锁方案，escape 规则补齐控制字符 + 长度限制。

- [ ] **Step 1: 追加 YAML gate + key 校验 + redact 到 `minimax.mjs`**

在 `minimax.mjs` 末尾追加：

```js
// ── YAML write gate (spec §3.4.2 state machine, plan v2) ──────

function findClosingDoubleQuote(s, start) {
  // YAML 1.2.2 §5.7: 双引号内 `\` 转义下一字符；遇未转义 `"` 即闭合
  // s[start] === '"' 预期
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === '"') return i;
    i++;
  }
  return -1;
}

function findClosingSingleQuote(s, start) {
  // YAML 1.2.2 §7.3.2: 单引号内 `''` 是转义；其他 `'` 即闭合
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === "'") {
      if (s[i + 1] === "'") { i += 2; continue; }
      return i;
    }
    i++;
  }
  return -1;
}

// **plan v3 修正（codex HIGH）**：stripInlineComment 改为 quote-aware——
// 只有在 Form D/S 闭合引号**之后**出现的 ` #` 才算注释；
// 引号内的 `#` 属字面文本（如 `api_key: "hash#mark"` 或 `'a # b'`）。
function findInlineCommentAfter(s, startIdx) {
  // 从 startIdx 起找第一个 ` #` 或 `\t#`
  for (let i = startIdx; i < s.length; i++) {
    if ((s[i] === " " || s[i] === "\t") && s[i + 1] === "#") return i;
  }
  return -1;
}

/**
 * spec §3.4.2 state machine — quote-aware trailing comment detection.
 * @returns {{ ok: boolean, reason?: string, lineNumber?: number, form?: "D"|"S" }}
 */
export function validateYamlForApiKeyWrite(text) {
  if (!text) return { ok: false, reason: "empty-file" };
  if (text.charCodeAt(0) === 0xFEFF) return { ok: false, reason: "BOM at file start" };

  const lines = text.split(/\r?\n/);
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    if (raw.trimStart().startsWith("#")) continue;
    if (raw[0] === " " || raw[0] === "\t") continue;
    const m = raw.match(/^api_key\s*:\s*(.*)$/);
    if (m) matches.push({ index: i, valueRaw: m[1] });
  }

  if (matches.length === 0) return { ok: false, reason: "no-api-key" };
  if (matches.length > 1) return { ok: false, reason: "duplicate-api-key", lineNumber: matches[1].index + 1 };

  const match = matches[0];
  // 注意：**这里不 stripInlineComment**——因为引号内的 `#` 可能是合法字符
  let v = match.valueRaw.replace(/\s+$/, "");  // 只 trim 右侧空白，左侧保留（已被 regex 吃掉前导空白）

  if (v === "") return { ok: false, reason: "empty-value-looks-like-block-scalar", lineNumber: match.index + 1 };

  // block scalar indicator（首字符判断，值只有 | / > / |- / |+ / >- / >+ / 后跟数字）
  if (/^[|>]/.test(v)) {
    // 确认这确实是 block scalar 指示器而非值（`>` 开头本身就是——YAML plain 不允许这些字符起头）
    return { ok: false, reason: "block-scalar-indicator", lineNumber: match.index + 1 };
  }
  // flow-style
  if (v.startsWith("{") || v.startsWith("[")) {
    return { ok: false, reason: "flow-style", lineNumber: match.index + 1 };
  }
  // anchor / alias / tag
  if (v.startsWith("&") || v.startsWith("*") || v.startsWith("!")) {
    return { ok: false, reason: "anchor-alias-or-tag", lineNumber: match.index + 1 };
  }

  // Form D: double-quoted single-line
  if (v.startsWith('"')) {
    const close = findClosingDoubleQuote(v, 0);
    if (close < 0) return { ok: false, reason: "form-D-unclosed", lineNumber: match.index + 1 };
    // **quote-aware**：close 之后才找 inline comment
    const afterClose = v.slice(close + 1);
    const commentIdx = findInlineCommentAfter(afterClose, 0);
    const trailing = (commentIdx >= 0 ? afterClose.slice(0, commentIdx) : afterClose).trim();
    if (trailing !== "") return { ok: false, reason: "form-D-trailing-content", lineNumber: match.index + 1 };
    const next = lines[match.index + 1];
    if (next && (next[0] === " " || next[0] === "\t") && next.trim() !== "" && !next.trimStart().startsWith("#")) {
      return { ok: false, reason: "suspicious-continuation-after-api-key", lineNumber: match.index + 2 };
    }
    return { ok: true, lineNumber: match.index + 1, form: "D" };
  }

  // Form S: single-quoted single-line
  if (v.startsWith("'")) {
    const close = findClosingSingleQuote(v, 0);
    if (close < 0) return { ok: false, reason: "form-S-unclosed", lineNumber: match.index + 1 };
    const afterClose = v.slice(close + 1);
    const commentIdx = findInlineCommentAfter(afterClose, 0);
    const trailing = (commentIdx >= 0 ? afterClose.slice(0, commentIdx) : afterClose).trim();
    if (trailing !== "") return { ok: false, reason: "form-S-trailing-content", lineNumber: match.index + 1 };
    const next = lines[match.index + 1];
    if (next && (next[0] === " " || next[0] === "\t") && next.trim() !== "" && !next.trimStart().startsWith("#")) {
      return { ok: false, reason: "suspicious-continuation-after-api-key", lineNumber: match.index + 2 };
    }
    return { ok: true, lineNumber: match.index + 1, form: "S" };
  }

  // Plain scalar —— 一律拒绝（spec §3.4.1 明令）
  return { ok: false, reason: "plain-scalar-requires-quoting", lineNumber: match.index + 1 };
}

// ── Key content validation (spec §3.4.3) ──────────────────────

const CONTROL_CHAR_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;  // 允许 \t \n \r？实际 api_key 不该有换行
const MAX_KEY_LEN = 4096;

export function validateKeyContent(newKey) {
  if (typeof newKey !== "string" || newKey.length === 0) return { ok: false, reason: "empty-key" };
  if (newKey.length > MAX_KEY_LEN) return { ok: false, reason: "key-too-long" };
  if (CONTROL_CHAR_REGEX.test(newKey)) return { ok: false, reason: "control-char-in-key" };
  if (/\n|\r|\t/.test(newKey)) return { ok: false, reason: "whitespace-newline-in-key" };
  // 代理对检测
  for (let i = 0; i < newKey.length; i++) {
    const c = newKey.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const n = newKey.charCodeAt(i + 1);
      if (!(n >= 0xDC00 && n <= 0xDFFF)) return { ok: false, reason: "unpaired-surrogate" };
      i++;
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      return { ok: false, reason: "unpaired-surrogate" };
    }
  }
  return { ok: true };
}

export function escapeForYamlDoubleQuoted(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    // 控制字符走转义；但 validateKeyContent 已先拒，这里是 defense-in-depth
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

// ── API key redaction (spec §3.4) ─────────────────────────────

export function redactSecrets(text) {
  if (!text) return text;
  return String(text)
    .replace(/sk-[A-Za-z0-9_\-\.]{20,}/g, "sk-***REDACTED***")
    .replace(/eyJ[A-Za-z0-9_\-\.]{20,}/g, "eyJ***REDACTED***");
}
```

- [ ] **Step 2: 写单元测试 `minimax.test.mjs`**

```js
#!/usr/bin/env node
// Minimal in-house test harness (zero deps)
import fs from "node:fs";
import path from "node:path";
import {
  validateYamlForApiKeyWrite,
  validateKeyContent,
  escapeForYamlDoubleQuoted,
  redactSecrets,
} from "./minimax.mjs";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++; }
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || "assertEqual"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log("# validateYamlForApiKeyWrite (spec §3.4.2 state machine)");

test("Form D (double-quoted) passes", () => {
  const y = 'api_key: "sk-real"\napi_base: "https://api.minimax.io"\n';
  const r = validateYamlForApiKeyWrite(y);
  assertEqual(r.ok, true);
  assertEqual(r.form, "D");
});

test("Form S (single-quoted) passes", () => {
  const y = "api_key: 'sk-real'\napi_base: 'https://api.minimax.io'\n";
  const r = validateYamlForApiKeyWrite(y);
  assertEqual(r.ok, true);
  assertEqual(r.form, "S");
});

test("plain scalar REJECTED (spec §3.4.1)", () => {
  const y = 'api_key: sk-plain-key-no-quotes\nmodel: "x"\n';
  const r = validateYamlForApiKeyWrite(y);
  assertEqual(r.ok, false);
  assertEqual(r.reason, "plain-scalar-requires-quoting");
});

test("unquoted with spaces REJECTED", () => {
  const y = 'api_key: MiniMax-M2.5\nmodel: "x"\n';
  const r = validateYamlForApiKeyWrite(y);
  assertEqual(r.ok, false);
  assertEqual(r.reason, "plain-scalar-requires-quoting");
});

test("BOM fails", () => {
  const y = "\uFEFFapi_key: \"sk-real\"\n";
  const r = validateYamlForApiKeyWrite(y);
  assertEqual(r.ok, false);
  assertEqual(r.reason, "BOM at file start");
});

test("block scalar | fails", () => {
  const y = 'api_key: |\n  line1\n  line2\nmodel: "x"\n';
  assertEqual(validateYamlForApiKeyWrite(y).reason, "block-scalar-indicator");
});

test("block scalar > fails", () => {
  const y = 'api_key: >\n  folded\nmodel: "x"\n';
  assertEqual(validateYamlForApiKeyWrite(y).reason, "block-scalar-indicator");
});

test("block scalar >- with chomping fails", () => {
  const y = 'api_key: >-\n  folded\nmodel: "x"\n';
  assertEqual(validateYamlForApiKeyWrite(y).reason, "block-scalar-indicator");
});

test("empty value fails", () => {
  const y = "api_key:\n  indented next line\nmodel: \"x\"\n";
  assertEqual(validateYamlForApiKeyWrite(y).reason, "empty-value-looks-like-block-scalar");
});

test("duplicate api_key fails", () => {
  const y = 'api_key: "a"\napi_key: "b"\nmodel: "x"\n';
  assertEqual(validateYamlForApiKeyWrite(y).reason, "duplicate-api-key");
});

test("flow-style fails", () => {
  const y = 'api_key: {nested: value}\nmodel: "x"\n';
  assertEqual(validateYamlForApiKeyWrite(y).reason, "flow-style");
});

test("anchor fails", () => {
  const y = 'defaults: &d\n  k: v\napi_key: *d\nmodel: "x"\n';
  assertEqual(validateYamlForApiKeyWrite(y).reason, "anchor-alias-or-tag");
});

test("tag ! fails", () => {
  const y = 'api_key: !!str "foo"\nmodel: "x"\n';
  assertEqual(validateYamlForApiKeyWrite(y).reason, "anchor-alias-or-tag");
});

test("Form D with escaped quote (real) passes", () => {
  const y = 'api_key: "he said \\"hi\\""\nmodel: "x"\n';
  const r = validateYamlForApiKeyWrite(y);
  assertEqual(r.ok, true);
  assertEqual(r.form, "D");
});

test("Form D with trailing content fails", () => {
  const y = 'api_key: "foo" junk\nmodel: "x"\n';
  assertEqual(validateYamlForApiKeyWrite(y).reason, "form-D-trailing-content");
});

test("Form D with inline comment passes", () => {
  const y = 'api_key: "foo" # this is a comment\nmodel: "x"\n';
  const r = validateYamlForApiKeyWrite(y);
  assertEqual(r.ok, true);
});

test("Form D with # inside the quoted value passes (plan v3 quote-aware)", () => {
  // quote 内的 # 不是注释，应被视为 key 的一部分
  const y = 'api_key: "hash#mark-abc"\nmodel: "x"\n';
  const r = validateYamlForApiKeyWrite(y);
  assertEqual(r.ok, true);
  assertEqual(r.form, "D");
});

test("Form S with # inside quoted value passes (plan v3 quote-aware)", () => {
  const y = "api_key: 'a # b'\nmodel: 'x'\n";
  const r = validateYamlForApiKeyWrite(y);
  assertEqual(r.ok, true);
  assertEqual(r.form, "S");
});

test("Form D with upstream placeholder + inline comment passes (regression防御 for gemini plan v2 concern)", () => {
  // Mini-Agent 官方 config-example.yaml 的实际形态
  const y = 'api_key: "YOUR_API_KEY_HERE"  # Replace with your MiniMax API Key\napi_base: "https://api.minimax.io"\n';
  const r = validateYamlForApiKeyWrite(y);
  assertEqual(r.ok, true);
  assertEqual(r.form, "D");
});

test("Form D unclosed fails", () => {
  const y = 'api_key: "unclosed\nmodel: "x"\n';
  assertEqual(validateYamlForApiKeyWrite(y).reason, "form-D-unclosed");
});

test("Form S with doubled-single-quote passes", () => {
  const y = "api_key: 'it''s fine'\nmodel: 'x'\n";
  const r = validateYamlForApiKeyWrite(y);
  assertEqual(r.ok, true);
  assertEqual(r.form, "S");
});

test("no api_key fails", () => {
  assertEqual(validateYamlForApiKeyWrite('model: "x"\n').reason, "no-api-key");
});

test("suspicious continuation line fails", () => {
  // Form D gate passes 但下一行缩进续行，保险拒绝
  const y = 'api_key: "foo"\n  weird continuation\nmodel: "x"\n';
  assertEqual(validateYamlForApiKeyWrite(y).reason, "suspicious-continuation-after-api-key");
});

// P0.12 fixtures（若已跑过 P0.12，文件存在）
test("fixture: multiline-block-scalar.yaml (P0.12)", () => {
  const p = path.join(process.cwd(), "doc/probe/fixtures/p12-antipatterns/multiline-block-scalar.yaml");
  if (fs.existsSync(p)) assertEqual(validateYamlForApiKeyWrite(fs.readFileSync(p, "utf8")).ok, false);
});

console.log("# validateKeyContent");

test("accepts sk-key", () => {
  assertEqual(validateKeyContent("sk-abcdefghij01234567").ok, true);
});

test("rejects empty", () => {
  assertEqual(validateKeyContent("").reason, "empty-key");
});

test("rejects newline", () => {
  assertEqual(validateKeyContent("sk-with\nnewline").reason, "whitespace-newline-in-key");
});

test("rejects too long", () => {
  assertEqual(validateKeyContent("a".repeat(5000)).reason, "key-too-long");
});

test("rejects control char", () => {
  assertEqual(validateKeyContent("sk-\u0007bel").reason, "control-char-in-key");
});

console.log("# escapeForYamlDoubleQuoted");

test("escapes backslash and quote", () => {
  assertEqual(escapeForYamlDoubleQuoted('it "works" \\here\\'), 'it \\"works\\" \\\\here\\\\');
});

console.log("# redactSecrets");
test("redacts sk- keys", () => {
  const t = "Here is the key sk-abcdefghij0123456789 extra";
  assertEqual(redactSecrets(t), "Here is the key sk-***REDACTED*** extra");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 3: 运行单元测试**

```bash
node plugins/minimax/scripts/lib/minimax.test.mjs
```

Expected: all tests pass (green ✓ marks).

- [ ] **Step 4: 实现 `writeMiniAgentApiKey` (via withLockAsync + fsync)**

在 `minimax.mjs` 追加：

```js
// ── Atomic YAML api_key write (spec §3.4 / §4.2, plan v2) ─────

function fsyncAndRename(tmpPath, targetPath) {
  const fd = fs.openSync(tmpPath, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmpPath, targetPath);
  try {
    const dirFd = fs.openSync(path.dirname(targetPath), "r");
    try { fs.fsyncSync(dirFd); } catch { /* Windows 上 fsync dir 可能 fail，忽略 */ }
    finally { fs.closeSync(dirFd); }
  } catch { /* 目录打开失败忽略 */ }
}

/**
 * Write api_key into MINI_AGENT_CONFIG_PATH atomically, under state.mjs::withLockAsync.
 * @returns {Promise<{ok:boolean, reason?:string, lineNumber?:number, form?:"D"}>}
 */
export async function writeMiniAgentApiKey(newKey) {
  const keyCheck = validateKeyContent(newKey);
  if (!keyCheck.ok) return keyCheck;

  let text;
  try { text = fs.readFileSync(MINI_AGENT_CONFIG_PATH, "utf8"); }
  catch (err) { return { ok: false, reason: `read-failed: ${err.code || err.message}` }; }

  const gate = validateYamlForApiKeyWrite(text);
  if (!gate.ok) return gate;

  // 无论原形态是 Form D 还是 Form S，都规范化输出为 Form D（§3.4.3）
  const escapedKey = escapeForYamlDoubleQuoted(newKey);
  // 替换顶层 api_key 行（确保只替换顶层第一个，gate 已保证只有一个）
  const next = text.replace(/^api_key\s*:\s*.*$/m, `api_key: "${escapedKey}"`);

  const tmpPath = `${MINI_AGENT_CONFIG_PATH}.tmp.${process.pid}.${Date.now()}`;
  // 同目录检查
  if (path.dirname(tmpPath) !== path.dirname(MINI_AGENT_CONFIG_PATH)) {
    return { ok: false, reason: "tmpfile-not-same-dir" };  // defense in depth
  }

  // 锁内做原子写
  try {
    await withLockAsync(MINI_AGENT_LOCK_PATH, async () => {
      fs.writeFileSync(tmpPath, next, { mode: 0o600 });
      fsyncAndRename(tmpPath, MINI_AGENT_CONFIG_PATH);
    });
  } catch (err) {
    // cleanup tmpfile if still present
    try { fs.unlinkSync(tmpPath); } catch {}
    return { ok: false, reason: `lock-or-write-failed: ${err.message}` };
  }

  _invalidateConfigCache();
  return { ok: true, lineNumber: gate.lineNumber, form: "D" };
}
```

- [ ] **Step 5: `writeMiniAgentApiKey` 集成测试（spawn 子进程 + MINI_AGENT_CONFIG_PATH env 注入）**

创建 `plugins/minimax/scripts/lib/minimax.write.test.mjs`（不合并入主 test，因为要改 env 跑子进程）：

```js
#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const tmp = path.join(os.tmpdir(), `mm-write-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
const target = path.join(tmp, "config.yaml");
const lockPath = path.join(tmp, ".lock");

const fakeYaml = `api_key: "YOUR_API_KEY_HERE"
api_base: "https://api.minimax.io"
model: "MiniMax-M2.5"
provider: "anthropic"
retry:
  max_retries: 3
  initial_delay: 1.0
tools:
  enable_bash: true
`;
fs.writeFileSync(target, fakeYaml);

// 子进程跑 writeMiniAgentApiKey，拿结果
const env = { ...process.env, MINI_AGENT_CONFIG_PATH: target, MINI_AGENT_LOCK_PATH: lockPath };
const r = spawnSync("node", [
  "-e",
  `
  import("${path.resolve("plugins/minimax/scripts/lib/minimax.mjs")}").then(async m => {
    const result = await m.writeMiniAgentApiKey("sk-new-key-abcdef0123456789");
    console.log(JSON.stringify(result));
  }).catch(e => { console.error(e); process.exit(1); });
  `
], { env, encoding: "utf8" });

console.log("stdout:", r.stdout);
if (r.stderr) console.log("stderr:", r.stderr);

const result = JSON.parse(r.stdout.trim());
console.assert(result.ok === true, `write ok expected true, got ${JSON.stringify(result)}`);

const after = fs.readFileSync(target, "utf8");
console.assert(/^api_key: "sk-new-key-abcdef0123456789"$/m.test(after), "api_key was written");
console.assert(/^api_base: "https:\/\/api.minimax.io"$/m.test(after), "api_base preserved");
console.assert(/^model: "MiniMax-M2.5"$/m.test(after), "model preserved");
console.assert(/^\s+max_retries: 3$/m.test(after), "retry.max_retries preserved");
console.assert(/^\s+enable_bash: true$/m.test(after), "tools.enable_bash preserved");

// 重跑一次，key 换新的
const r2 = spawnSync("node", ["-e", `
  import("${path.resolve("plugins/minimax/scripts/lib/minimax.mjs")}").then(async m => {
    const result = await m.writeMiniAgentApiKey("sk-key-round-2-final");
    console.log(JSON.stringify(result));
  }).catch(e => { console.error(e); process.exit(1); });
`], { env, encoding: "utf8" });
const r2Result = JSON.parse(r2.stdout.trim());
console.assert(r2Result.ok === true);

const after2 = fs.readFileSync(target, "utf8");
console.assert(/^api_key: "sk-key-round-2-final"$/m.test(after2), "second key applied");
console.assert(/^model: "MiniMax-M2.5"$/m.test(after2), "model still preserved after 2nd write");

// 清理
fs.rmSync(tmp, { recursive: true });
console.log("writeMiniAgentApiKey integration test PASSED");
```

- [ ] **Step 6: Parse + 跑所有测试**（plan v4 合并：原先有两个重复 Step 6）

```bash
node --check plugins/minimax/scripts/lib/minimax.mjs
node plugins/minimax/scripts/lib/minimax.test.mjs
node plugins/minimax/scripts/lib/minimax.write.test.mjs
```

**所有三条命令都必须跑，且都必须绿**：
- `node --check` 无输出（语法 OK）
- `minimax.test.mjs` 打印 `N passed, 0 failed`（validateYaml / validateKeyContent / escape / redact 单元测试）
- `minimax.write.test.mjs` 打印 `writeMiniAgentApiKey integration test PASSED`（mock config path 集成测试；**绝对不碰**用户真 `~/.mini-agent/config/config.yaml`）

- [ ] **Step 7: Commit**

```bash
git add plugins/minimax/scripts/lib/minimax.mjs plugins/minimax/scripts/lib/minimax.test.mjs plugins/minimax/scripts/lib/minimax.write.test.mjs
git commit -m "feat(minimax): YAML gate v3 state machine + writeApiKey via withLockAsync (plan v4)"
```

---

### Task 1.8: `minimax.mjs` — `spawnWithHardTimeout` helper（纯 helper，无 auth 依赖）

> **plan v3 重构**：原 Task 1.8 同时写 `spawnWithHardTimeout` + `getMiniAgentAuthStatus`，但 auth 函数依赖 Task 1.9 的 `parseFinalResponseFromLog` 又漏 `await` → codex CRITICAL。v3 拆分：Task 1.8 **只写 helper**（纯函数，无外部依赖），Task 1.9 写 parser **和** auth（auth 在同 task 内引用 parser，保证 `await` 正确性）。

**Files:**
- Modify: `plugins/minimax/scripts/lib/minimax.mjs`

> **plan v2 核心改动**：spec §3.6 要求 async + 硬超时。`spawnSync.timeout` 无法保证子进程在 SIGTERM 后立即退出——Mini-Agent 若吞信号会卡死。新增 `spawnWithHardTimeout` 辅助函数，强制三段式 `setTimeout → SIGTERM → setTimeout → SIGKILL → resolve`。`getMiniAgentAuthStatus` 改为 `async`。

- [ ] **Step 1: 追加 `spawnWithHardTimeout` helper**

在 `minimax.mjs` 追加：

```js
// ── spawn with hard timeout (spec §3.6, plan v2) ──────────────

/**
 * Spawn a child and always resolve within timeout + 5s SIGKILL grace.
 * @param {string} bin
 * @param {string[]} args
 * @param {{timeoutMs?: number, cwd?: string, env?: object}} options
 * @returns {Promise<{exitCode: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, spawnError: Error|null}>}
 */
export function spawnWithHardTimeout(bin, args, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, cwd, env } = options;

  return new Promise((resolve) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;
    let termTimer, killTimer;

    const done = (extras) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      resolve({
        exitCode: proc.exitCode ?? null,
        signal: proc.signalCode ?? null,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        timedOut: false,
        spawnError: null,
        ...extras,
      });
    };

    let proc;
    try {
      proc = spawn(bin, args, {
        cwd, env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (spawnError) {
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      return resolve({
        exitCode: null, signal: null, stdout: "", stderr: "",
        timedOut: false, spawnError,
      });
    }

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      // 移除监听器防止泄漏
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.removeAllListeners("close");
      resolve({ exitCode: null, signal: null, stdout: stdoutBuf, stderr: stderrBuf, timedOut: false, spawnError: err });
    });

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    proc.stdout.on("data", (chunk) => { stdoutBuf += stdoutDecoder.write(chunk); });
    proc.stderr.on("data", (chunk) => { stderrBuf += stderrDecoder.write(chunk); });

    proc.once("close", () => {
      stdoutBuf += stdoutDecoder.end();
      stderrBuf += stderrDecoder.end();
      done({});
    });

    // 硬超时三段式
    termTimer = setTimeout(() => {
      if (settled) return;
      try { proc.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        if (settled) return;
        try { proc.kill("SIGKILL"); } catch {}
        // 给 close 事件一点时间；若 close 仍不触发（PID 死锁）最多再等 500ms 就强制 resolve
        setTimeout(() => {
          if (!settled) {
            settled = true;
            clearTimeout(termTimer); clearTimeout(killTimer);
            resolve({
              exitCode: null, signal: "SIGKILL",
              stdout: stdoutBuf, stderr: stderrBuf,
              timedOut: true, spawnError: null,
            });
          }
        }, 500);
      }, 5_000);
    }, timeoutMs);
  });
}
```

- [ ] **Step 2: Smoke test `spawnWithHardTimeout`**

```bash
node -e '
import("./plugins/minimax/scripts/lib/minimax.mjs").then(async m => {
  // 正常退出
  const r1 = await m.spawnWithHardTimeout("node", ["-e", "console.log(\"hi\"); process.exit(0)"], { timeoutMs: 5000 });
  console.assert(r1.exitCode === 0 && r1.stdout.includes("hi"), "normal exit");
  console.assert(r1.timedOut === false, "not timed out");
  console.log("normal OK:", r1.exitCode, JSON.stringify(r1.stdout));

  // 硬超时
  const r2 = await m.spawnWithHardTimeout("node", ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 300 });
  console.assert(r2.timedOut === true, "expected timeout");
  console.log("timeout OK:", r2.timedOut, r2.signal);

  // 不存在的 binary
  const r3 = await m.spawnWithHardTimeout("/nonexistent/bin", [], { timeoutMs: 2000 });
  console.assert(r3.spawnError !== null, "expected spawnError");
  console.log("missing-bin OK:", r3.spawnError.code || r3.spawnError.message);
}).catch(e => { console.error(e); process.exit(1); });
'
```

Expected 三条 OK 行，无 assertion error。

- [ ] **Step 3: Commit（auth 函数移到 Task 1.9 一起写）**

```bash
node --check plugins/minimax/scripts/lib/minimax.mjs
git add plugins/minimax/scripts/lib/minimax.mjs
git commit -m "feat(minimax): spawnWithHardTimeout helper with three-phase timeout + listener cleanup (plan v3)"
```

---

### Task 1.9a: `minimax.mjs` — log parser (state machine) + `mini-agent log` fallback + tests

**Files:**
- Modify: `plugins/minimax/scripts/lib/minimax.mjs`
- Modify: `plugins/minimax/scripts/lib/minimax.test.mjs`

> **plan v4 拆分**（gemini CRITICAL）：原 Task 1.9 同时做 parser + auth + 3 种 smoke test 过载（6 step / ~400 行代码）。v4 拆为：
> - **1.9a**（本 task）：parser + fallback + unit tests
> - **1.9b**（下个 task）：getMiniAgentAuthStatus (async) + smoke test
>
> 拆分理由：parser 是纯函数、auth 依赖 parser；两者分离后 subagent 每个 task 负担降至 ~250 行，降低截断/漏 await 风险；1.9b 用 1.9a 的 commit 作为 baseline，`parseFinalResponseFromLog` 已定义后才 import 使用，**物理上不可能漏 await**。

- [ ] **Step 1: 追加 `extractLogPathFromStdout` + 状态机 parser + fallback 到 `minimax.mjs`**

```js
// ── Log path extraction & response parsing (spec §3.5, state machine) ─

export function extractLogPathFromStdout(stdoutOrFirstLines) {
  const lines = Array.isArray(stdoutOrFirstLines)
    ? stdoutOrFirstLines
    : stdoutOrFirstLines.split("\n").slice(0, 30);
  for (const line of lines) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, "");
    const m = clean.match(/Log file:\s+(\S+\.log)/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Count unescaped { and } on a line, respecting JSON string context.
 * Returns { opens, closes, endsInString }. Caller tracks stringCtx across lines.
 */
function scanBraces(line, startInString) {
  let opens = 0, closes = 0;
  let inString = startInString;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === "\\") { i++; continue; }  // skip escaped
      if (c === '"') inString = false;
    } else {
      if (c === '"') inString = true;
      else if (c === "{") opens++;
      else if (c === "}") closes++;
    }
  }
  return { opens, closes, endsInString: inString };
}

/**
 * Parse Mini-Agent log into blocks using a line-by-line state machine.
 * Returns array of { n, kind: "REQUEST"|"RESPONSE"|"TOOL_RESULT", json, raw, truncated? }.
 *
 * P0.2 confirmed: block header `[N] <KIND>`, log_index continuous across kinds,
 * block separator `-` × 80 (distinct from file header `=` × 80).
 */
function parseLogBlocks(text) {
  const STATE = { SEEK_HEADER: 0, SKIP_TO_BODY: 1, COLLECT_BODY: 2 };
  let state = STATE.SEEK_HEADER;
  const blocks = [];
  let current = null;
  let accLines = [];
  let braceDepth = 0;
  let inString = false;

  const lines = text.split(/\r?\n/);

  const finishBlock = (truncated) => {
    if (!current) return;
    current.raw = accLines.join("\n");
    try { current.json = JSON.parse(current.raw); }
    catch { current.json = null; }
    if (truncated) current.truncated = true;
    blocks.push(current);
    current = null;
    accLines = [];
    braceDepth = 0;
    inString = false;
  };

  for (const line of lines) {
    if (state === STATE.SEEK_HEADER) {
      // P0.2 修订：block kind 三种 REQUEST/RESPONSE/TOOL_RESULT
      const m = line.match(/^\[(\d+)\]\s+(REQUEST|RESPONSE|TOOL_RESULT)$/);
      if (m) {
        current = { n: parseInt(m[1], 10), kind: m[2] };
        state = STATE.SKIP_TO_BODY;
      }
      continue;
    }
    if (state === STATE.SKIP_TO_BODY) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("{")) {
        accLines = [line];
        const { opens, closes, endsInString } = scanBraces(line, false);
        braceDepth = opens - closes;
        inString = endsInString;
        if (braceDepth <= 0 && !inString) {
          finishBlock(false);
          state = STATE.SEEK_HEADER;
        } else {
          state = STATE.COLLECT_BODY;
        }
      }
      // 否则继续跳过 Timestamp / 分隔符 / 空行
      continue;
    }
    if (state === STATE.COLLECT_BODY) {
      accLines.push(line);
      const { opens, closes, endsInString } = scanBraces(line, inString);
      braceDepth += opens - closes;
      inString = endsInString;
      if (braceDepth <= 0 && !inString) {
        finishBlock(false);
        state = STATE.SEEK_HEADER;
      }
    }
  }
  if (state === STATE.COLLECT_BODY && current) finishBlock(true);

  return blocks;
}

// P0.2 实测：Mini-Agent 日志用 OpenAI 兼容格式
// finish_reason 合法值: stop / length / tool_calls / tool_use / content_filter
const TERMINAL_FINISH_REASONS = new Set([
  "stop", "stop_sequence", "length", "tool_calls", "tool_use", "content_filter", "max_tokens"
]);

function pickTerminalResponse(blocks) {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (!b.json) continue;
    const hasFinishReason = typeof b.json.finish_reason === "string"
      && TERMINAL_FINISH_REASONS.has(b.json.finish_reason);
    const hasNonEmptyContent = typeof b.json.content === "string" && b.json.content.length > 0;
    if (hasFinishReason || hasNonEmptyContent) return b;
  }
  return null;
}

function extractToolCalls(responseJson) {
  // P0.2 修订：tool_calls 是顶层字段（OpenAI 格式 [{id, name, arguments}]）
  const arr = Array.isArray(responseJson?.tool_calls) ? responseJson.tool_calls : [];
  return arr.map(c => ({ id: c.id, name: c.name, arguments: c.arguments }));
}

function extractTextResponse(responseJson) {
  // P0.2 修订：content 是字符串（非数组）
  return typeof responseJson?.content === "string" ? responseJson.content : "";
}

function extractThinking(responseJson) {
  // P0.2 观察：thinking 是可选的顶层字段（reasoning trace）
  return typeof responseJson?.thinking === "string" ? responseJson.thinking : null;
}

/**
 * Parse the final assistant response from a Mini-Agent log file.
 * Uses state machine (spec §3.5). On main-path failure, tries `mini-agent log <file>` fallback
 * in an isolated try/catch — fallback failure must NOT affect main-path result.
 */
export async function parseFinalResponseFromLog(logPath) {
  let text;
  try { text = fs.readFileSync(logPath, "utf8"); }
  catch (err) {
    return { ok: false, partial: true, reason: `read-failed: ${err.code || err.message}`, response: "", toolCalls: [] };
  }

  const blocks = parseLogBlocks(text);
  const responseBlocks = blocks.filter(b => b.kind === "RESPONSE");

  if (responseBlocks.length === 0) {
    // 主路径无 RESPONSE，尝试 fallback
    const fb = await tryMiniAgentLogFallback(logPath);
    return {
      ok: false,
      partial: true,
      reason: "no-response-block",
      response: "",
      toolCalls: [],
      fallbackUsed: fb.used,
      fallbackOk: fb.ok,
    };
  }

  const picked = pickTerminalResponse(responseBlocks);
  if (picked) {
    return {
      ok: true,
      partial: false,
      response: extractTextResponse(picked.json),
      toolCalls: extractToolCalls(picked.json),
      thinking: extractThinking(picked.json),
      finishReason: picked.json.finish_reason || null,  // P0.2 修订：field 名和值都改
      blockIndex: picked.n,
    };
  }

  // 无终态——尝试 fallback，**不传染主路径**
  const fb = await tryMiniAgentLogFallback(logPath);
  const lastBlock = responseBlocks[responseBlocks.length - 1];
  return {
    ok: false,
    partial: true,
    reason: "no-terminal-block",
    response: "",
    toolCalls: [],
    lastPartialResponseRaw: lastBlock?.raw ?? null,
    fallbackUsed: fb.used,
    fallbackOk: fb.ok,
    fallbackResponse: fb.parsedResponse,
  };
}

/**
 * Best-effort: call `mini-agent log <filename>` and attempt to extract
 * any terminal RESPONSE. ALL failures are swallowed; only metadata returned.
 */
async function tryMiniAgentLogFallback(logPath) {
  try {
    const basename = path.basename(logPath);
    const result = await spawnWithHardTimeout(MINI_AGENT_BIN, ["log", basename], { timeoutMs: 10_000 });
    if (result.spawnError || result.timedOut) return { used: true, ok: false };
    const blocks = parseLogBlocks(result.stdout || "");
    const responseBlocks = blocks.filter(b => b.kind === "RESPONSE");
    const picked = pickTerminalResponse(responseBlocks);
    if (!picked) return { used: true, ok: false };
    return {
      used: true,
      ok: true,
      parsedResponse: extractTextResponse(picked.json),
    };
  } catch {
    return { used: true, ok: false };
  }
}
```

- [ ] **Step 2: 补单元测试（parser state machine + multi-block 场景）**

在测试文件顶部的 `import` 里加：

```js
import {
  validateYamlForApiKeyWrite,
  validateKeyContent,
  escapeForYamlDoubleQuoted,
  redactSecrets,
  extractLogPathFromStdout,
  parseFinalResponseFromLog,
} from "./minimax.mjs";
```

把文件尾的 `process.exit` 改为 `async main` 包裹（因为 parseFinalResponseFromLog 是 async）：

```js
// ── 放在所有 test(...) 之前（顶部） ─────
async function asyncTest(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++; }
}

(async () => {
  // ... 所有同步 test(...) 调用保留 ...

  console.log("# extractLogPathFromStdout");

  test("extracts plain log line", () => {
    const s = "Loading...\n📝 Log file: /Users/x/.mini-agent/log/agent_run_20260420_104430.log\nMore output";
    assertEqual(extractLogPathFromStdout(s), "/Users/x/.mini-agent/log/agent_run_20260420_104430.log");
  });

  test("extracts ANSI-wrapped log line", () => {
    const s = "\x1b[2m📝 Log file: /tmp/agent_run_test.log\x1b[0m";
    assertEqual(extractLogPathFromStdout(s), "/tmp/agent_run_test.log");
  });

  test("returns null if absent", () => {
    assertEqual(extractLogPathFromStdout("No log here"), null);
  });

  console.log("# parseFinalResponseFromLog (state machine)");

  // P0.2 实测：RESPONSE JSON 用 OpenAI 兼容格式
  // {content: <string>, tool_calls: [...], finish_reason: "stop"|"tool_use"|...}
  await asyncTest("parses single-block terminal RESPONSE (OpenAI compat shape)", async () => {
    const logContent = `Agent Run Log
================================================================================

--------------------------------------------------------------------------------
[1] REQUEST
Timestamp: 2026-04-20 10:44:37
--------------------------------------------------------------------------------

{"messages":[{"role":"user","content":"hi"}]}


--------------------------------------------------------------------------------
[2] RESPONSE
Timestamp: 2026-04-20 10:44:41
--------------------------------------------------------------------------------

{"content":"Hello!","finish_reason":"stop"}
`;
    const p = `/tmp/mm-parse-test-${Date.now()}.log`;
    fs.writeFileSync(p, logContent);
    const r = await parseFinalResponseFromLog(p);
    assertEqual(r.ok, true);
    assertEqual(r.response, "Hello!");
    assertEqual(r.finishReason, "stop");
    assertEqual(r.blockIndex, 2);  // log_index 跨 kind 连续递增 (P0.2)
    fs.unlinkSync(p);
  });

  await asyncTest("picks LAST terminal RESPONSE in multi-block log (tool_calls 中间 + stop 末尾)", async () => {
    const logContent = `Agent Run Log
================================================================================

--------------------------------------------------------------------------------
[1] REQUEST
--------------------------------------------------------------------------------

{"messages":[]}

--------------------------------------------------------------------------------
[2] RESPONSE
--------------------------------------------------------------------------------

{"content":"","tool_calls":[{"id":"t1","name":"bash","arguments":{"command":"ls"}}],"finish_reason":"tool_calls"}


--------------------------------------------------------------------------------
[3] TOOL_RESULT
--------------------------------------------------------------------------------

{"output":"file1\\nfile2"}


--------------------------------------------------------------------------------
[4] REQUEST
--------------------------------------------------------------------------------

{"messages":[]}

--------------------------------------------------------------------------------
[5] RESPONSE
--------------------------------------------------------------------------------

{"content":"Done.","finish_reason":"stop"}
`;
    const p = `/tmp/mm-parse-multi-${Date.now()}.log`;
    fs.writeFileSync(p, logContent);
    const r = await parseFinalResponseFromLog(p);
    assertEqual(r.ok, true);
    assertEqual(r.response, "Done.");
    assertEqual(r.blockIndex, 5);
    assertEqual(r.finishReason, "stop");
    fs.unlinkSync(p);
  });

  await asyncTest("extracts tool_calls from top-level field (OpenAI shape)", async () => {
    const logContent = `Agent Run Log

--------------------------------------------------------------------------------
[1] RESPONSE
--------------------------------------------------------------------------------

{"content":"","tool_calls":[{"id":"t1","name":"read_file","arguments":{"path":"/tmp/foo"}}],"finish_reason":"tool_calls"}
`;
    const p = `/tmp/mm-parse-tc-${Date.now()}.log`;
    fs.writeFileSync(p, logContent);
    const r = await parseFinalResponseFromLog(p);
    assertEqual(r.ok, true);
    assertEqual(Array.isArray(r.toolCalls) && r.toolCalls.length, 1);
    assertEqual(r.toolCalls[0].name, "read_file");
    assertEqual(r.toolCalls[0].arguments.path, "/tmp/foo");
    fs.unlinkSync(p);
  });

  await asyncTest("handles JSON with { } inside string content", async () => {
    const logContent = `Agent Run Log

--------------------------------------------------------------------------------
[1] RESPONSE
--------------------------------------------------------------------------------

{"content":"The symbol is { or }.","finish_reason":"stop"}
`;
    const p = `/tmp/mm-parse-strings-${Date.now()}.log`;
    fs.writeFileSync(p, logContent);
    const r = await parseFinalResponseFromLog(p);
    assertEqual(r.ok, true);
    assertEqual(r.response, "The symbol is { or }.");
    fs.unlinkSync(p);
  });

  await asyncTest("handles multi-line pretty-printed JSON (scanBraces cross-line state)", async () => {
    // JSON body 被 Mini-Agent 打印为 pretty-printed；scanBraces 必须跨行维护字符串状态
    const logContent = `Agent Run Log

--------------------------------------------------------------------------------
[1] RESPONSE
--------------------------------------------------------------------------------

{
  "content": "line 1 of answer\\nline 2 has a { brace not in string at all\\nline 3 has } too",
  "finish_reason": "stop"
}
`;
    const p = `/tmp/mm-parse-multiline-${Date.now()}.log`;
    fs.writeFileSync(p, logContent);
    const r = await parseFinalResponseFromLog(p);
    assertEqual(r.ok, true);
    assertEqual(r.response.includes("line 3 has }"), true);
    assertEqual(r.finishReason, "stop");
    fs.unlinkSync(p);
  });

  await asyncTest("handles escaped quote within string (scanBraces \\\" handling)", async () => {
    // JSON 字符串内的 \" 不能被 scanBraces 误判为字符串结束
    const logContent = `Agent Run Log

--------------------------------------------------------------------------------
[1] RESPONSE
--------------------------------------------------------------------------------

{"content":"He said \\"hello { world }\\" then left","finish_reason":"stop"}
`;
    const p = `/tmp/mm-parse-escquote-${Date.now()}.log`;
    fs.writeFileSync(p, logContent);
    const r = await parseFinalResponseFromLog(p);
    assertEqual(r.ok, true);
    assertEqual(r.response.includes("hello { world }"), true);
    fs.unlinkSync(p);
  });

  await asyncTest("401 scenario (no RESPONSE block at all) returns partial:true", async () => {
    // P0.2 实测：Mini-Agent 401 retry 耗尽后直接 return，跳过 log_response
    // 所以日志里只有 REQUEST block，没有 RESPONSE block
    const logContent = `Agent Run Log
================================================================================

--------------------------------------------------------------------------------
[1] REQUEST
--------------------------------------------------------------------------------

{"messages":[{"role":"user","content":"hi"}]}
`;
    const p = `/tmp/mm-parse-401-${Date.now()}.log`;
    fs.writeFileSync(p, logContent);
    const r = await parseFinalResponseFromLog(p);
    assertEqual(r.ok, false);
    assertEqual(r.partial, true);
    assertEqual(r.reason, "no-response-block");
    fs.unlinkSync(p);
  });

  await asyncTest("returns partial:true when truncated mid-body", async () => {
    const logContent = `Agent Run Log

--------------------------------------------------------------------------------
[1] RESPONSE
--------------------------------------------------------------------------------

{"role":"assistant","content":[{"type":"text","text":"partial
`;  // missing closing
    const p = `/tmp/mm-parse-trunc-${Date.now()}.log`;
    fs.writeFileSync(p, logContent);
    const r = await parseFinalResponseFromLog(p);
    assertEqual(r.ok, false);
    assertEqual(r.partial, true);
    fs.unlinkSync(p);
  });

  await asyncTest("handles no RESPONSE block", async () => {
    const logContent = `Agent Run Log\n\nonly REQUEST blocks here\n`;
    const p = `/tmp/mm-parse-empty-${Date.now()}.log`;
    fs.writeFileSync(p, logContent);
    const r = await parseFinalResponseFromLog(p);
    assertEqual(r.ok, false);
    assertEqual(r.reason, "no-response-block");
    fs.unlinkSync(p);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
```

> **注意**：将原本的 `console.log("# ...")` + `test(...)` 同步块统一包在 `(async () => { ... })()` 里。所有同步 `test` 保留不动，新增 async 场景用 `asyncTest`。

- [ ] **Step 3: 跑 parser 测试**

```bash
node --check plugins/minimax/scripts/lib/minimax.mjs
node plugins/minimax/scripts/lib/minimax.test.mjs
node plugins/minimax/scripts/lib/minimax.write.test.mjs
```

Expected: all green.

- [ ] **Step 4: Commit Task 1.9a**

```bash
git add plugins/minimax/scripts/lib/minimax.mjs plugins/minimax/scripts/lib/minimax.test.mjs
git commit -m "feat(minimax): log state-machine parser + mini-agent log fallback + parser tests (plan v4 Task 1.9a)"
```

---

### Task 1.9b: `minimax.mjs` — `getMiniAgentAuthStatus` (async)

**Files:**
- Modify: `plugins/minimax/scripts/lib/minimax.mjs`

> **plan v4 拆出**：本 task 在 1.9a（parser+tests）commit 之后才开始。`parseFinalResponseFromLog` 在 1.9a 已定义且 async——1.9b import/引用时必然 `await`。

- [ ] **Step 1: 追加 `getMiniAgentAuthStatus` (async) — **在 parser 之后**，保证调用时 parser 已经定义**

在 `minimax.mjs` 追加（注意：Task 1.8 已写 `spawnWithHardTimeout` helper、Task 1.9a 已写 `extractLogPathFromStdout` 和 `parseFinalResponseFromLog`，现在都可安全引用）：

```js
// ── Auth check (spec §3.6, async + hard timeout) ──────────────

const CONFIG_NOT_CONFIGURED_PATTERN = /Please configure a valid API Key/;
const CONFIG_NOT_FOUND_PATTERN = /Configuration file not found/;
const SOCKS_IMPORT_ERROR_PATTERN = /ImportError: Using SOCKS proxy/;

function stripAnsiSgr(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

export async function getMiniAgentAuthStatus(cwd) {
  const cfg = readMiniAgentConfig();
  if (cfg.readError === "config-missing") {
    return { loggedIn: false, reason: "config-missing", detail: "config.yaml not found at " + MINI_AGENT_CONFIG_PATH };
  }
  if (!cfg.api_key || cfg.api_key === "YOUR_API_KEY_HERE") {
    return { loggedIn: false, reason: "auth-not-configured", detail: "api_key is placeholder or empty" };
  }

  const result = await spawnWithHardTimeout(
    MINI_AGENT_BIN,
    ["-t", "ping", "-w", cwd || process.cwd()],
    { timeoutMs: AUTH_CHECK_TIMEOUT_MS }
  );

  if (result.spawnError) {
    if (result.spawnError.code === "ENOENT") {
      return { loggedIn: false, reason: "not-installed", detail: `${MINI_AGENT_BIN} not found` };
    }
    return { loggedIn: false, reason: "spawn-failed", detail: redactSecrets(result.spawnError.message) };
  }
  if (result.timedOut) {
    return { loggedIn: false, reason: "ping-timeout", detail: `no response within ${AUTH_CHECK_TIMEOUT_MS}ms` };
  }

  const stdout = stripAnsiSgr(result.stdout);
  const stderr = stripAnsiSgr(result.stderr);
  const combined = stderr + "\n" + stdout;

  // Layer 1: 源码常量
  if (SOCKS_IMPORT_ERROR_PATTERN.test(combined)) {
    return { loggedIn: false, reason: "needs-socksio", detail: "httpx 缺 socksio extra；运行 uv tool install --force --with socksio git+..." };
  }
  if (CONFIG_NOT_CONFIGURED_PATTERN.test(combined)) {
    return { loggedIn: false, reason: "auth-not-configured", detail: "Mini-Agent ValueError: invalid API key" };
  }
  if (CONFIG_NOT_FOUND_PATTERN.test(combined)) {
    return { loggedIn: false, reason: "config-missing", detail: "Mini-Agent FileNotFoundError" };
  }

  // Layer 2: 日志文件（主判定）——P0.2 修订：finish_reason === "stop"
  const logPath = extractLogPathFromStdout(stdout);
  if (logPath) {
    const parsed = await parseFinalResponseFromLog(logPath);
    if (parsed.ok && parsed.response && parsed.finishReason === "stop") {
      return { loggedIn: true, model: cfg.model || null, apiBase: cfg.api_base || null };
    }
  }

  // Layer 3: stdout sentinel (strip ANSI 后)
  if (/❌\s*Retry failed/.test(stdout) || /LLM call failed after/.test(stdout) || /401[^0-9].*authentication_error/.test(stdout)) {
    return { loggedIn: false, reason: "llm-call-failed", detail: redactSecrets(stdout.split("\n").filter(l => /error|failed/i.test(l)).slice(-3).join(" | ")) };
  }

  return { loggedIn: false, reason: "unknown-crashed", detail: redactSecrets((stderr || stdout).slice(-200)) };
}
```

- [ ] **Step 2: Parse check**

```bash
node --check plugins/minimax/scripts/lib/minimax.mjs
```

- [ ] **Step 3: Auth smoke test（用假 key，必须不卡、30s 内必返）**

```bash
time node -e '
import("./plugins/minimax/scripts/lib/minimax.mjs").then(async m => {
  const s = await m.getMiniAgentAuthStatus(process.cwd());
  console.log(JSON.stringify(s));
}).catch(e => { console.error(e); process.exit(1); });
'
```

Expected: 30s 内必须返回。fake key 下 reason 应是 `llm-call-failed` / `ping-timeout` / `unknown-crashed` 之一；绝不会出现真 key 明文。若 >35s 未返 → `spawnWithHardTimeout` 硬超时没生效，回 Task 1.8 修。

- [ ] **Step 4: Commit Task 1.9b**

```bash
git add plugins/minimax/scripts/lib/minimax.mjs
git commit -m "feat(minimax): async getMiniAgentAuthStatus with three-layer sentinel (plan v4 Task 1.9b)"
```

---

### Task 1.10: `minimax-companion.mjs` — dispatcher with `setup` subcommand

**Files:**
- Create: `plugins/minimax/scripts/minimax-companion.mjs`

- [ ] **Step 1: Write dispatcher**

```js
#!/usr/bin/env node
import process from "node:process";
import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  getMiniAgentAvailability,
  getMiniAgentAuthStatus,
  readMiniAgentConfig,
  writeMiniAgentApiKey,
  redactSecrets,
} from "./lib/minimax.mjs";
import { binaryAvailable } from "./lib/process.mjs";

const USAGE = `Usage: minimax-companion <subcommand> [options]

Subcommands:
  setup [--json] [--enable-review-gate|--disable-review-gate]
                    Check mini-agent CLI availability and auth state.
                    In interactive Claude Code flow, this may prompt (via AskUserQuestion)
                    for API key and api_base region if missing.

  write-key --api-key <key> [--api-base <url>] [--json]
                    Write api_key (and optionally api_base) into config.yaml with
                    hardened gate + atomic write + stale-lock recovery.
                    Returns { ok, reason?, form?, lineNumber? }.

(More subcommands arrive in Phase 2+.)
`;

function maskApiKey(k) {
  if (!k || typeof k !== "string") return null;
  if (k === "YOUR_API_KEY_HERE") return "<placeholder>";
  if (k.length < 12) return "<short>";
  return k.slice(0, 4) + "***" + k.slice(-4);
}

async function runSetup(rawArgs) {
  const { options } = parseArgs(rawArgs, {
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
  });

  const availability = getMiniAgentAvailability();
  const cfg = readMiniAgentConfig();
  const installers = {
    uv: binaryAvailable("uv", ["--version"]).available,
    pipx: binaryAvailable("pipx", ["--version"]).available,
    curl: binaryAvailable("sh", ["-c", "command -v curl"]).available,
  };

  let auth = { loggedIn: false, reason: "not-checked" };
  if (availability.available) {
    // 仅在 api_key 非 placeholder 时才跑真正的 ping（避免 fake key 多次浪费时间）
    if (cfg.api_key && cfg.api_key !== "YOUR_API_KEY_HERE") {
      auth = await getMiniAgentAuthStatus(process.cwd());
    } else {
      auth = { loggedIn: false, reason: "auth-not-configured", detail: "api_key is placeholder or missing" };
    }
  }

  const status = {
    installed: availability.available,
    version: availability.available ? availability.detail : null,
    authenticated: auth.loggedIn,
    authReason: auth.reason || null,
    authDetail: auth.detail ? redactSecrets(auth.detail) : null,
    model: auth.model || cfg.model || null,
    apiBase: cfg.api_base || null,
    apiKeyMasked: maskApiKey(cfg.api_key),
    configPath: cfg.raw ? "~/.mini-agent/config/config.yaml" : (cfg.readError || "missing"),
    installers,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  } else {
    process.stdout.write(formatSetupText(status) + "\n");
  }
  process.exit(0);
}

function formatSetupText(s) {
  const lines = [];
  lines.push(`installed:       ${s.installed ? `yes (${s.version})` : "no"}`);
  lines.push(`authenticated:   ${s.authenticated ? "yes" : `no (${s.authReason})`}`);
  lines.push(`api_base:        ${s.apiBase || "(not set)"}`);
  lines.push(`model:           ${s.model || "(not set)"}`);
  lines.push(`api_key:         ${s.apiKeyMasked || "(not set)"}`);
  if (!s.installed) {
    lines.push("");
    lines.push("Installers detected:");
    lines.push(`  uv:    ${s.installers.uv ? "yes" : "no"}`);
    lines.push(`  pipx:  ${s.installers.pipx ? "yes" : "no"}`);
    lines.push(`  curl:  ${s.installers.curl ? "yes" : "no"}`);
  }
  if (s.authDetail) lines.push(`\nauth detail: ${s.authDetail}`);
  return lines.join("\n");
}

async function runWriteKey(rawArgs) {
  const { options } = parseArgs(rawArgs, {
    booleanOptions: ["json"],
    stringOptions: ["api-key", "api-base"],
  });

  if (!options["api-key"]) {
    const err = { ok: false, reason: "missing --api-key" };
    if (options.json) process.stdout.write(JSON.stringify(err) + "\n");
    else process.stderr.write("Error: --api-key is required\n");
    process.exit(1);
  }

  const { writeMiniAgentApiKey } = await import("./lib/minimax.mjs");
  // api-base 的写入将在 v0.2 扩展；v0.1 先只写 api_key
  const result = await writeMiniAgentApiKey(options["api-key"]);

  if (options.json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else if (result.ok) {
    process.stdout.write(`api_key written (form=${result.form}, line=${result.lineNumber})\n`);
  } else {
    process.stderr.write(`write failed: ${result.reason}${result.lineNumber ? " at line " + result.lineNumber : ""}\n`);
  }
  process.exit(result.ok ? 0 : 2);
}

async function main() {
  const argv = process.argv.slice(2);

  let [sub, ...rest] = argv;
  if (rest.length === 1 && !rest[0].startsWith("-") && rest[0].includes(" ")) {
    rest = splitRawArgumentString(rest[0]);
  }

  switch (sub) {
    case "setup":
      return await runSetup(rest);
    case "write-key":
      return await runWriteKey(rest);
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      process.exit(0);
      break;
    default:
      process.stderr.write(`Unknown subcommand: ${sub}\n${USAGE}\n`);
      process.exit(1);
  }
}

main().catch(err => {
  process.stderr.write(`companion fatal: ${err.message}\n`);
  process.exit(99);
});
```

- [ ] **Step 2: Parse**

```bash
node --check plugins/minimax/scripts/minimax-companion.mjs
```

- [ ] **Step 3: Run `setup --json`**

```bash
node plugins/minimax/scripts/minimax-companion.mjs setup --json
```

Expected (当前 brainstorm 状态，fake key 在 config 里):
```json
{
  "installed": true,
  "version": "mini-agent 0.1.0",
  "authenticated": false,
  "authReason": "llm-call-failed" | "unknown-crashed",
  "authDetail": "...",
  "model": "MiniMax-M2.5",
  "apiBase": "https://api.minimax.io",
  "apiKeyMasked": "sk-f***real",
  "configPath": "~/.mini-agent/config/config.yaml",
  "installers": { "uv": true, "pipx": ..., "curl": true }
}
```

**这是 T1 通过基线**（installed/version/model/apiBase 有值；apiKeyMasked 不泄露真 key）。

- [ ] **Step 4: Run `setup` without `--json`**

```bash
node plugins/minimax/scripts/minimax-companion.mjs setup
```

Expected: 多行人读输出。

- [ ] **Step 5: T8 —模拟 fresh-env setup**

```bash
MINI_AGENT_BIN=/nonexistent/mini-agent node plugins/minimax/scripts/minimax-companion.mjs setup --json
```

Expected:
```json
{
  "installed": false,
  "version": null,
  "authenticated": false,
  ...
  "installers": { "uv": true / false, "pipx": ..., "curl": true }
}
```

**T8 通过基线**：installed: false + installers 字段存在供 `/minimax:setup` 引导分支用。

- [ ] **Step 6: T13 — SOCKS 场景 stderr 识别（手动 mock）**

```bash
# 构造一个 mock mini-agent 输出 ImportError
cat > /tmp/mock-mini-agent.sh <<'EOF'
#!/bin/bash
if [ "$1" = "--version" ]; then
  echo "mini-agent 0.1.0"
  exit 0
fi
echo "ImportError: Using SOCKS proxy, but the 'socksio' package is not installed." >&2
exit 1
EOF
chmod +x /tmp/mock-mini-agent.sh
MINI_AGENT_BIN=/tmp/mock-mini-agent.sh node plugins/minimax/scripts/minimax-companion.mjs setup --json
```

Expected: `"authReason": "needs-socksio"`. **T13 通过基线**。

- [ ] **Step 7: Smoke test `write-key` 子命令（用 mock config）**

```bash
# 准备 mock config
MOCK_CFG=/tmp/mm-companion-wk-test.yaml
MOCK_LOCK=/tmp/mm-companion-wk-test.lock
cat > $MOCK_CFG <<'EOF'
api_key: "YOUR_API_KEY_HERE"
api_base: "https://api.minimax.io"
model: "MiniMax-M2.5"
provider: "anthropic"
EOF

# 跑 write-key
MINI_AGENT_CONFIG_PATH=$MOCK_CFG MINI_AGENT_LOCK_PATH=$MOCK_LOCK \
  node plugins/minimax/scripts/minimax-companion.mjs write-key --api-key "sk-smoketest-1234567890" --json

# 验证
grep '^api_key:' $MOCK_CFG
# 应输出: api_key: "sk-smoketest-1234567890"
grep '^model:' $MOCK_CFG  # 其他字段保留

# 清理
rm -f $MOCK_CFG $MOCK_LOCK
```

Expected: JSON 输出 `{"ok":true,"lineNumber":1,"form":"D"}`；`grep` 显示 key 被替换、`model` 字段仍在。

- [ ] **Step 8: Commit**

```bash
git add plugins/minimax/scripts/minimax-companion.mjs
git commit -m "feat(companion): setup + write-key subcommands (plan v2; spec §3.4/§3.6)"
```

---

### Task 1.11: `/minimax:setup` command markdown

**Files:**
- Create: `plugins/minimax/commands/setup.md`

- [ ] **Step 1: Write the command file**

```bash
mkdir -p plugins/minimax/commands
```

```markdown
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
  - `Install via pipx` → runs `pipx install git+https://github.com/MiniMax-AI/Mini-Agent.git` (warn: may miss `socksio` extras for SOCKS-proxied environments)
  - `Skip for now`
- After install succeeds, re-run the setup subcommand
- If setup still reports `installed: false` but `~/.local/bin/mini-agent` exists → tell the user: "mini-agent is installed at `~/.local/bin/mini-agent` but not on your PATH. Add `~/.local/bin` to PATH and reopen your shell, then re-run `/minimax:setup`."

### Case 2 — `installed: true`, `authReason: "needs-socksio"`

Tell the user: "Your environment has a SOCKS proxy but the installed mini-agent is missing the `socksio` httpx extra. Run:
`uv tool install --force --with socksio git+https://github.com/MiniMax-AI/Mini-Agent.git`"

### Case 3 — `installed: true`, `authReason: "auth-not-configured"` (placeholder or missing api_key)

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
  - **Second question**: "Paste your MiniMax API key:" (text input; 提醒用户 "Claude Code's AskUserQuestion may not hide input; consider cancelling + using env `MINIMAX_TEST_API_KEY` instead if your terminal is shared")
- After user submits both answers, call:
    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" write-key --api-key "<user-provided>" --json
    ```
- Parse `{ok, reason?, lineNumber?, form?}`:
  - `ok: true` → re-run `setup --json`；若 `authenticated: true` → Case 5
  - `ok: false, reason: "plain-scalar-requires-quoting"` → 告诉用户"检测到 `~/.mini-agent/config/config.yaml` 里的 api_key 行不是引号形式（第 {lineNumber} 行）。我们的自动写入只接受 `api_key: \"...\"` 或 `api_key: '...'`。请手动把该行改为引号形式，然后重跑 `/minimax:setup`。"
  - `ok: false, reason: "duplicate-api-key" | "block-scalar-indicator" | "flow-style" | "anchor-alias-or-tag" | ...` → 逐条给出精确指导，每种 reason 对应具体修改建议
  - `ok: false, reason: "control-char-in-key" | "whitespace-newline-in-key" | "key-too-long"` → key 内容非法，请用户检查粘贴值
  - 任何 `ok: false` 都不应直接把 raw key 显示回给用户（setup 的 output 已脱敏，companion 的 stderr 可能含值）

> **重要**：`write-key` 子命令已在 Task 1.10 实现 + smoke test 通过。command.md 只负责"用户交互 → 调 CLI → 解析 JSON → 引导下一步"。不再是 stub。

### Case 4 — `installed: true`, `authReason: "config-missing"` (no config.yaml)

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
```

- [ ] **Step 2: Verify frontmatter**

```bash
head -6 plugins/minimax/commands/setup.md
```

Expected frontmatter with `description:`, `argument-hint:`, `allowed-tools:`.

- [ ] **Step 3: Commit**

```bash
git add plugins/minimax/commands/setup.md
git commit -m "feat(command): /minimax:setup with branch logic for install/socksio/auth/config-missing"
```

---

### Task 1.12: `minimax-prompting` skill skeleton

**Files:**
- Create: `plugins/minimax/skills/minimax-prompting/SKILL.md`
- Create: `plugins/minimax/skills/minimax-prompting/references/.gitkeep`

- [ ] **Step 1: Write skeleton**

```bash
mkdir -p plugins/minimax/skills/minimax-prompting/references
touch plugins/minimax/skills/minimax-prompting/references/.gitkeep
```

```markdown
---
name: minimax-prompting
description: Internal guidance for composing Mini-Agent prompts for coding, review, diagnosis, and research tasks inside the minimax plugin. Emphasizes MiniMax-M2.7's Chinese prose strength and Mini-Agent's native file/bash/Skills/MCP tools.
---

# minimax-prompting (skeleton, finalized in Phase 5)

Guidance for Claude when composing a prompt to send to Mini-Agent via `minimax-companion.mjs`. Not user-facing.

## Scope

This skill guides prompt construction for `/minimax:ask`, `/minimax:review`, `/minimax:rescue`, `/minimax:adversarial-review`. Fully populated in Phase 5 after real prompts have been tested.

## Universal rules (v0.1 confirmed)

1. **Output contract first.** State the expected output format in the first paragraph. For JSON: explicitly say "Return ONLY a JSON object matching this schema. No prose before or after. No markdown code fence."

2. **Context in labeled blocks.** Wrap code/diff/docs in clearly labeled blocks (`### Diff to review` / `### Files under investigation`).

3. **Language parity.** MiniMax-M2.7's Chinese-language reasoning is strong; keep instruction language aligned with user prompt language. Do not force English on Chinese prompts.

4. **Leverage Mini-Agent native tools.** For `/minimax:rescue`, include the available Skills whitelist in the prompt:
   > "You have access to 15 Claude Skills (xlsx / pdf / pptx / docx / canvas-design / algorithmic-art / theme-factory / brand-guidelines / artifacts-builder / webapp-testing / mcp-builder / skill-creator / internal-comms / slack-gif-creator / template-skill). Invoke them via `get_skill(<name>)` when relevant."

5. **No tool-call loops on simple questions.** For `/minimax:ask`, prefer prompts that don't require bash/file tools. For `/minimax:rescue --write`, allow larger `max_steps`.

6. **Suspicious bash interception.** `/minimax:rescue --sandbox` does not provide true isolation (spec §4.6). When passing prompts that may invoke bash, prefer explicit scopes: "Only modify files under the workspace directory. Do NOT use absolute paths outside it."

## Placeholder sections (filled Phase 5)

- `references/minimax-prompt-recipes.md` — recipes: Chinese coding reviews, multi-step agent tasks, Skills invocation (PDF / xlsx), MCP tool usage
- `references/minimax-prompt-antipatterns.md` — prompts that empirically fail on MiniMax-M2.7 (populated from Phase 2–4 failures)
- `references/prompt-blocks.md` — reusable blocks: tool-use guidance, workspace constraints, output contracts
```

- [ ] **Step 2: Verify**

```bash
ls plugins/minimax/skills/minimax-prompting/
head -5 plugins/minimax/skills/minimax-prompting/SKILL.md
```

- [ ] **Step 3: Commit**

```bash
git add plugins/minimax/skills/minimax-prompting/
git commit -m "feat(skill): minimax-prompting skeleton (finalized Phase 5)"
```

---

### Task 1.13: T1 / T8 / T12 / T13 validation and Phase 0+1 CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: T1 re-run (authenticated case)**

如果本机 config 里的 api_key 是真 key（brainstorm 阶段留的假 key 需要先替换为用户真 key，否则跳到 T1 降级验证）：

```bash
node plugins/minimax/scripts/minimax-companion.mjs setup --json
```

Verify output keys 全部非空（installed, version, model, apiBase；apiKeyMasked 已脱敏；如果认证成功 authenticated: true）。

降级版（仍用 fake key）：至少 `installed: true`、`apiKeyMasked` 非空脱敏、`authReason` 合理（`llm-call-failed` 或 `auth-not-configured`）、不泄露真 key 明文。**T1 PASS（降级）**。

- [ ] **Step 2: T8 fresh-env simulation**

```bash
MINI_AGENT_BIN=/nonexistent/mini-agent node plugins/minimax/scripts/minimax-companion.mjs setup --json | tee /tmp/mm-t8.json
# 确认 installed:false + installers 字段对
python3 -c "import json; d=json.load(open('/tmp/mm-t8.json')); assert d['installed'] is False; assert 'installers' in d; print('T8 PASS')"
```

**T8 PASS**。

- [ ] **Step 3: T12 YAML 写入保留（mock 隔离，**绝不碰用户真 config**）**

```bash
MOCK_DIR=/tmp/mm-t12
rm -rf $MOCK_DIR; mkdir -p $MOCK_DIR
MOCK_CFG=$MOCK_DIR/config.yaml
MOCK_LOCK=$MOCK_DIR/.lock

# 生成 mock config 作为基线（直接写内容，不拷真文件——完全离线）
cat > $MOCK_CFG <<'EOF'
# Mini Agent Config
api_key: "YOUR_API_KEY_HERE"
api_base: "https://api.minimax.io"
model: "MiniMax-M2.5"
provider: "anthropic"
retry:
  enabled: true
  max_retries: 3
  initial_delay: 1.0
  max_delay: 60.0
  exponential_base: 2.0

# 工具配置
max_steps: 100
workspace_dir: "./workspace"
system_prompt_path: "system_prompt.md"

tools:
  enable_file_tools: true
  enable_bash: true
  enable_note: true
  enable_skills: true
  skills_dir: "./skills"
  enable_mcp: true
  mcp_config_path: "mcp.json"
EOF

ORIG_LINES=$(wc -l < $MOCK_CFG)
ORIG_HASH=$(shasum $MOCK_CFG | awk '{print $1}')
echo "orig: $ORIG_LINES lines, hash=$ORIG_HASH"

# 连写 3 次（用 mock env 注入，完全不碰 ~/.mini-agent/）
for K in "sk-test-round-1" "sk-test-round-2" "sk-final-round-3"; do
  MINI_AGENT_CONFIG_PATH=$MOCK_CFG MINI_AGENT_LOCK_PATH=$MOCK_LOCK \
    node plugins/minimax/scripts/minimax-companion.mjs write-key --api-key "$K" --json
done

# 验证
grep '^api_key:' $MOCK_CFG  # 应是 sk-final-round-3
grep '^model: "MiniMax-M2.5"' $MOCK_CFG  # 保留
grep '^api_base: "https://api.minimax.io"' $MOCK_CFG
grep '^provider: "anthropic"' $MOCK_CFG
grep -c 'retry:' $MOCK_CFG  # >= 1
grep -c 'tools:' $MOCK_CFG  # >= 1
grep -c 'enable_bash: true' $MOCK_CFG  # 子字段保留
grep -c 'max_retries: 3' $MOCK_CFG  # 子字段保留

NEW_LINES=$(wc -l < $MOCK_CFG)
echo "new: $NEW_LINES lines (应与 $ORIG_LINES 相等，因为只改了 api_key 一行)"
test "$NEW_LINES" = "$ORIG_LINES" && echo "T12 LINES PASS" || { echo "T12 LINES FAIL"; exit 1; }

# 清理
rm -rf $MOCK_DIR

echo "T12 PASS"
```

**T12 PASS**（用户真实 `~/.mini-agent/config/config.yaml` 全程未被触碰）。

- [ ] **Step 4: T13 SOCKS 识别（重温 Task 1.10 Step 6）**

```bash
MINI_AGENT_BIN=/tmp/mock-mini-agent.sh node plugins/minimax/scripts/minimax-companion.mjs setup --json | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['authReason']=='needs-socksio', f'expected needs-socksio, got {d[\"authReason\"]}'; print('T13 PASS')"
```

**T13 PASS**。

- [ ] **Step 5: 追加 CHANGELOG 条目**

在根 `CHANGELOG.md` 顶部（2026-04-20 spec 条目之后）加：

```markdown
## 2026-04-20 [Claude Opus 4.7] — Phase 0+1 complete (plan v2)

- **status**: done
- **scope**: Phase 0 probes (12 reports at `doc/probe/`) + Phase 1 skeleton (root files, plugin manifests, lib near-copies, minimax.mjs core with spawnWithHardTimeout + YAML gate v3 state machine + async getMiniAgentAuthStatus + log state-machine parser + fallback, minimax-companion.mjs with setup + write-key subcommands, /minimax:setup command.md with full AskUserQuestion → write-key flow, minimax-cli-runtime skill v0.1, minimax-prompting skill skeleton)
- **summary**: T1 / T8 / T12 / T13 all pass, 全程使用 mock config path 验证，用户真实 `~/.mini-agent/config/config.yaml` 未触碰。P0.9 env-auth confirmed no shortcut. P0.1/P0.2 hard gates passed (if they hadn't, this entry would read "blocked"). P0.10 ... (either "concurrent log attribution passes" 或 "requires serial job scheduling in Phase 4"). Other probes documented.
- **next**: hand off to Phase 2 plan (/minimax:ask + log-based result extraction + minimax-result-handling skill initial). Phase 2 author MUST read `doc/probe/01-task-mode.md`, `doc/probe/02-response-block-structure.md`, `doc/probe/04-large-prompt.md`, `doc/probe/10-concurrent-spawn-log.md` before implementing callMiniAgent.
```

- [ ] **Step 6: Final Phase 1 commit**

```bash
git add CHANGELOG.md
git commit -m "chore: Phase 0+1 complete; T1/T8/T12/T13 pass"
```

- [ ] **Step 7: Tag milestone**

```bash
git tag -a phase-1-foundation -m "Phase 0+1 complete: probes, skeleton, /minimax:setup, T1/T8/T12/T13"
```

---

## Self-Review Checklist

After completing the plan, verify:

**1. Spec coverage**（本 plan 仅覆盖 spec §8.2 的 Phase 0 + Phase 1；其余 Phase 由后续 plan 承接）：

| Spec 章节 | Plan Task | 状态 |
|---|---|---|
| §2 仓库布局 | 1.1, 1.2 | ✅ |
| §3.1 CLI 调用映射 | 读入 minimax.mjs imports；完整在 Phase 2 的 callMiniAgent | ✅（Phase 1 部分） |
| §3.4 YAML 读 + §3.4.2 gate state machine + §3.4.3 escape | 1.6, 1.7 + P0.12 fixtures | ✅ |
| §3.5 日志解析 state machine + `mini-agent log` fallback | 1.9（主 + best-effort 二次源） | ✅ |
| §3.6 async + spawnWithHardTimeout | 1.8 | ✅ |
| §4.1 三层 sentinel | 1.8 Layer 1-3 实现 | ✅ |
| §4.2 stale-lock via withLockAsync | 1.5 state.mjs 抽出 + 1.7 调用 | ✅ |
| §5.1 state 目录 | 1.5 state.mjs minimax 路径 | ✅ |
| §5.3 setup 决策树（含 MINIMAX_TEST_API_KEY env） | 1.11 command.md Case 1-5 | ✅ |
| §7 Phase 0 probes | P0.1–P0.13 all tasks | ✅ |
| §8.1 T-checklist T1/T8/T12/T13 | 1.13（全部 mock 隔离） | ✅ |
| §8.4 CHANGELOG 硬门失败契约 | 1.1 根 CHANGELOG 初稿 + 每 probe task 的 CHANGELOG 追加约定 | ✅ |
| 延迟到后续 plan | §3.2 callMiniAgent 完整版 (Phase 2), §4.5 诊断包 (Phase 2-3), §4.6 rescue --sandbox (Phase 4), hooks/agents (Phase 4), §8.1 T2/T3/T5/T6/T9/T10/T11 (Phase 2-5) |

**2. Placeholder scan**：no `TBD` / `TODO` / "TODO: 实现…" / "Similar to Task N"。所有 code step 有完整代码块。所有 bash step 有完整命令 + expected output。

**3. Type consistency**：
- `writeMiniAgentApiKey` 签名在 Task 1.7 定义、Task 1.13 T12 使用时一致 ✅
- `getMiniAgentAuthStatus` 返回 shape `{loggedIn, reason, detail, model?, apiBase?}` 跨 Task 1.8 / 1.10 一致 ✅
- `parseFinalResponseFromLog` 返回 shape `{ok, partial, response, toolCalls, thinking, finishReason, blockIndex, lastPartialResponseRaw?}` 在 Task 1.9a 定义（P0.2 修订字段）、1.9b 使用 finishReason === "stop" 判 auth 成功 ✅
- `state.mjs::generateJobId` 的 `mj-` 前缀在 Task 1.5 smoke test 验证 ✅
- 所有 export：`readYamlTopLevelKey` / `readMiniAgentConfig` / `validateYamlForApiKeyWrite` / `writeMiniAgentApiKey` / `getMiniAgentAvailability` / `getMiniAgentAuthStatus` / `extractLogPathFromStdout` / `parseFinalResponseFromLog` / `redactSecrets` / `_invalidateConfigCache` / `MINI_AGENT_BIN` / `MINI_AGENT_CONFIG_PATH` / `MINI_AGENT_LOG_DIR` / `MINI_AGENT_LOCK_PATH` / `PARENT_SESSION_ENV`——companion 里 import 命名一致 ✅

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-04-20-phase-0-1-foundation.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Good fit because tasks are independent after Phase 0 probes land.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch with checkpoints. Good fit if you want to steer probe interpretation in real time.

---

## Follow-up plans (written after this plan's phase-1-foundation tag lands)

- `2026-XX-XX-phase-2-ask-log-parse.md` — `/minimax:ask` + `callMiniAgent` stdout/log dual-consumer + `minimax-result-handling` skill initial
- `2026-XX-XX-phase-3-review-retry.md` — `/minimax:review` + schema + 1-shot JSON retry + diagnostic bundle
- `2026-XX-XX-phase-4-background-agent-hooks.md` — rescue/status/result/cancel + `--sandbox` + `minimax-agent` subagent + session-lifecycle-hook + stop-review-gate-hook
- `2026-XX-XX-phase-5-adversarial-polish.md` — `/minimax:adversarial-review` + 3 skill 打磨定版 + lessons.md 收尾

Each subsequent plan is authored AFTER the previous phase tag lands, so probe results and implementation reality inform each plan's details.
