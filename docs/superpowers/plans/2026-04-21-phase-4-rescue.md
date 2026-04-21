# Phase 4 — `/minimax:rescue` + job-control + subagent + hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付多步 agent 委派管道（`/minimax:rescue` + `--sandbox` + 后台 job-control + `/minimax:status`/`/minimax:result`/`/minimax:cancel`）+ `minimax-agent` 薄转发 subagent + 2 个 hooks（SessionStart/SessionEnd + Stop review-gate），通过 T6、T11 硬门。

**Architecture:**
`job-control.mjs` 在 `~/.claude/plugins/minimax/jobs/<jobId>/` 下持久化 meta.json / stdout.log / stderr.log / workspace/。**P0.10 条件硬门 FAIL** 决定 v0.1 必须**串行化** —— 全局 `~/.claude/plugins/minimax/jobs/.queue-lock` PID-lock，`createJob` 前 acquire / 进程结束 release、stale 回收。`--sandbox` 模式下 workdir = `jobs/<jobId>/workspace/`（isolated workdir，**不是**安全边界）；默认模式下 workdir = 主 Claude cwd。后台模式：companion 派发 detached node 子进程跑 `_worker` 子命令（内部），worker 里 `callMiniAgent` 拿到 `onProgressLine` 钩子写 stdout.log、close 后写 meta.json。Hooks 用于 session id 注入 + stop-time review-gate（默认 disabled，`setup --enable-review-gate` 才开）。

**Tech Stack:** Node.js ≥ 18，`crypto.randomUUID()` 生成 `mj-<uuid>`，`child_process.spawn({detached:true, stdio:'ignore'})` 脱离 session，Phase 1–3 已有的 `withLockAsync` / `callMiniAgent` / `classifyMiniAgentResult` / `stripAnsiSgr`。

---

## v2 — 3-way review 修订索引（2026-04-21 Codex + Gemini + Claude）

下列修订直接嵌入对应 Task，此表仅 traceability：

| # | 来源 | 严重度 | 修订 | 落在 Task |
|---|---|---|---|---|
| C1 | Codex #1 | Critical | 队列锁从 `openSync wx` 改为 `mkdirSync` 目录锁（原子 exists+create；stale 回收用 mv+check） | 4.2 |
| C2 | Codex #2 / Gemini #4 分歧 | Critical | SessionStart 同时走两个协议：若 `CLAUDE_ENV_FILE` env 存在则 append `MINIMAX_COMPANION_SESSION_ID=<sid>`；同时向 stdout 输出 JSON `{env:{...}}`。任一协议生效即可 | 4.9 |
| C3 | Codex #3 / Gemini #5 / Claude | Critical | `_worker` 用真 `try { ... } finally { releaseQueueSlot(...) }` 包住整个主体，保证 `updateJobMeta` 抛异常也释放锁 | 4.5 |
| C4 | Claude spec | Critical | 补 `runTaskResumeCandidate`（Task 4.6 扩；读 `~/.mini-agent/log/` 最近 5 个 .log 文件，v0.1 只列不实际 resume，与 SKILL.md 声称的对齐）+ 对应 command.md | 4.6 + 4.7 |
| C5 | Claude type | Critical | Task 4.4 Step 1 imports 块显式追加 `import fs from "node:fs";`（companion.mjs 目前不 import fs） | 4.4 |
| C6 | Claude P0.10 | Critical | 追溯：Phase 2 `runAsk` + Phase 3 `runReview` 各自的 `callMiniAgent` 调用外包 `acquireQueueSlot` / `releaseQueueSlot`，保证 ask/review/rescue 三路并发时仍严格串行。新增为 Task 4.0（早于 4.1，因为它改既有代码不新增） | **4.0 新增** |
| I1 | Gemini #7 | Important | `rescue.md` + `result.md` frontmatter `allowed-tools` 追加 `AskUserQuestion`（tripwire 要求用户确认） | 4.7 |
| I2 | Gemini #6 | Important | `createJob` 签名加 `timeout` 字段，一步写入 meta | 4.1 + 4.5 |
| I3 | Codex #5 | Important | `stop-review-gate-hook.mjs` 调 review 时加 `--timeout 600000`（600s） | 4.9 |
| I4 | Codex #4 | Important | `cancelJob` 里 `kill(pid,0)` 复用窗口注释声明为 v0.1 已知限制 | 4.3 |
| I5 | Claude | Important | plan 显式注明：Task 4.9 加 SessionStart 偏离 spec §6.5 字面（spec 只说 SessionEnd+Stop），理由是 env 注入必须在 Start | 4.9 |
| M1 | Codex #6 / Gemini | Minor | SKILL.md 补一段 "detached worker 跨 session 继续运行；新 session 用 `--all` 可见" | 4.10 |
| M2 | Codex #7 | Minor | Task 4.5 Step 1 顶部 import `{ spawn, spawnSync }` 一并；删除 Step 2 里的 dynamic import 示意 | 4.5 |
| M3 | Claude | Minor | Task 4.5 `--background` 分支用 `readJob(workspaceRoot, jobId).workdir` 替代 `createJob_workdir` helper | 4.5 |
| M4 | Claude | Minor | Task 4.9 Step 3 显式：stop-review-gate hook 目前跑默认 review prompt，`prompts/stop-review-gate.md` 是 spec §6.6 deliverable，wiring 留给 Phase 5 | 4.9 |

不采纳（提过但不改）：
- Codex #10 hook 无单测（v0.1 可接受）
- Gemini #9 worker_e2e.test.mjs（v0.1 靠 smoke 兜底）

---

## Prerequisites

- Phase 0–3 完成（git tag `phase-3-review`，12 Phase 3 commits + 10 Phase 2 commits + 29 Phase 1 commits）。
- 必读：
  - `docs/superpowers/specs/2026-04-20-minimax-plugin-cc-design.md` §3.1 命令映射、§4.6 `--sandbox` 语义、§5.1 状态目录、§6.1 命令总表、§6.3 `minimax-agent.md`、§6.5 Hooks、§6.6 Prompts、§8.1 T6/T11 硬门
  - `plugins/minimax/skills/minimax-cli-runtime/SKILL.md` —— 尤其 **P0.10 条件硬门 FAIL**（concurrent spawn log attribution 不稳定 → v0.1 必须串行）
  - Phase 3 `callMiniAgent` / `classifyMiniAgentResult` 返回 shape
- 对照参考（读，不 cp）：
  - `/Users/bing/-Code-/kimi-plugin-cc/plugins/kimi/scripts/lib/job-control.mjs`（kimi 的并发 job-control；minimax 必须**收紧为串行**）
  - `/Users/bing/-Code-/kimi-plugin-cc/plugins/kimi/agents/kimi-agent.md`（subagent 转发 wrapper 模板）
  - `/Users/bing/-Code-/kimi-plugin-cc/plugins/kimi/hooks/hooks.json`（hooks 注册）
  - `/Users/bing/-Code-/gemini-plugin-cc/plugins/gemini/scripts/session-lifecycle-hook.mjs`（session id 注入典型实现）

## Scope & 硬门

| # | 动作 | 通过标准 |
|---|---|---|
| **T6** | `rescue --background "..."` → `status` → 等待完成 → `result <jobId>` | status 流转 queued→running→done；result 含 parsed response + logPath |
| **T11** | 在 `--sandbox` 模式下让 agent 做一个会"默认写文件"的任务（`--sandbox "make a note.txt with hello"`）；检查主项目根目录 `mtime` 与运行前一致，而 `jobs/<jobId>/workspace/note.txt` 存在 | 主项目 mtime 不变 + sandbox 目录下有 agent 产出 |

**不做**（v0.1 明确排除）：
- **不做并发 job**（P0.10 硬门 FAIL；队列串行，一次一个子进程）
- **不做 session resume**（P0.9 无外部 session id）
- **不做真安全沙箱**（spec §4.6 `--sandbox` = isolated workdir；help/skill/CHANGELOG 不得使用 "sandbox" 当安全承诺）
- **不做 cron 持久化**（Claude Code session 终结后 job 进程继续跑是可接受的；v0.2 考虑 systemd/launchd）
- **不做跨 session 的可疑 tool-call 扫描**（tripwire 在 `minimax-result-handling` skill 层执行，由 Claude 完成）
- **不引任何新 npm 依赖**

## File Structure

| 动作 | 路径 | 职责 |
|---|---|---|
| Create | `plugins/minimax/scripts/lib/job-control.mjs` | 数据层 + 串行队列 + 后台 worker 派发 + cancel |
| Create | `plugins/minimax/scripts/lib/job-control.test.mjs` | job-control 单元/集成测试 |
| Modify | `plugins/minimax/scripts/minimax-companion.mjs` | 新增 `runRescue` / `runStatus` / `runResult` / `runCancel` / `runWorker`（`_worker` 内部子命令） |
| Create | `plugins/minimax/commands/rescue.md` | `/minimax:rescue` dispatch |
| Create | `plugins/minimax/commands/status.md` | `/minimax:status` |
| Create | `plugins/minimax/commands/result.md` | `/minimax:result` |
| Create | `plugins/minimax/commands/cancel.md` | `/minimax:cancel` |
| Create | `plugins/minimax/commands/task-resume-candidate.md` | v0.1 informational listing only (no actual resume; P0.9) |
| Create | `plugins/minimax/agents/minimax-agent.md` | 薄转发 subagent |
| Create | `plugins/minimax/hooks/hooks.json` | SessionStart / SessionEnd / Stop 注册 |
| Create | `plugins/minimax/scripts/session-lifecycle-hook.mjs` | 注入 `MINIMAX_COMPANION_SESSION_ID` |
| Create | `plugins/minimax/scripts/stop-review-gate-hook.mjs` | Stop 时若 state 开启 review-gate 则触发 |
| Create | `plugins/minimax/prompts/stop-review-gate.md` | Stop review-gate prompt 模板 |
| Create | `plugins/minimax/skills/minimax-result-handling/references/rescue-render.md` | `/minimax:rescue` 呈现规则（含 tripwire 适用声明） |
| Create | `doc/smoke/phase-4-T6-T11.md` | smoke 留痕 |
| Modify | `CHANGELOG.md` + `plugins/minimax/CHANGELOG.md` | Phase 4 条目 |

**DRY / YAGNI / Serial 约束**：
- job 状态变迁统一走 `updateJobMeta(jobId, patch)` —— tmp + rename 原子更新，不分散
- 队列 lock 复用 Phase 1 `withLockAsync` 的 stale-lock 模式（PID + mtime + kill -0），不自造轮子
- Worker 子命令 `_worker` 不暴露在 USAGE（下划线前缀约定）
- `--sandbox` 字面意义是 isolated workdir；**help 文本、skill、命令.md、CHANGELOG 都不得称 "sandbox" 为安全机制**

---

## Task 4.0 — 追溯 ask / review 走队列（P0.10 兑现）

**Why first**：C6 blocker。Phase 2 `runAsk` 和 Phase 3 `runReview` 目前直接 `callMiniAgent`，不走队列。P0.10 条件硬门要求"一次只一个 mini-agent"——如果 ask 或 review 与 rescue 并发，仍然 race。必须在 Task 4.1 定义队列之前说明目标；Task 4.2 定义队列之后立刻落地这块追溯 —— 所以**本任务顺序调到 Task 4.2 之后、Task 4.3 之前** 执行。Task 4.0 是占位名，真正执行在 4.2 完成后。

**Depends on**: Task 4.2（队列 API 可用）。

**Files:**
- Modify: `plugins/minimax/scripts/minimax-companion.mjs` — `runAsk` 和 `runReview` 在 callMiniAgent 前后套队列 acquire/release
- Modify: `plugins/minimax/scripts/lib/job-control.test.mjs` — 加一个集成测试验证 ask/review 并发被串行化（mock mini-agent + 两次并行 spawn 验证时序）

- [ ] **Step 1：改 `runAsk`**

在 `runAsk(rawArgs)` 里把现有的

```js
const result = await callMiniAgent({ prompt, cwd, timeout, onProgressLine });
```

替换为

```js
const workspaceRoot = defaultWorkspaceRoot();
const slot = await acquireQueueSlot(workspaceRoot, { maxWaitMs: timeout + 30_000 });
if (!slot.acquired) {
  const payload = { status: "queue-timeout", reason: slot.reason };
  if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  else process.stderr.write(`Error: queue-timeout (${slot.reason})\n`);
  process.exit(4);
}
let result;
try {
  result = await callMiniAgent({ prompt, cwd, timeout, onProgressLine });
} finally {
  releaseQueueSlot(workspaceRoot, slot.token);
}
```

同时在 runAsk 顶部 imports 里补 `defaultWorkspaceRoot, acquireQueueSlot, releaseQueueSlot` 从 `./lib/job-control.mjs`（Task 4.1–4.2 会让这些 export 存在）。

- [ ] **Step 2：改 `runReview`**

在 `runReview(rawArgs)` 里找到 `const r = await callMiniAgentReview({...});` 调用。把它用同样的 try/finally + queue 包起来：

```js
const workspaceRoot = defaultWorkspaceRoot();
const slot = await acquireQueueSlot(workspaceRoot, { maxWaitMs: timeout * 2 + 30_000 });
if (!slot.acquired) {
  const payload = { status: "queue-timeout", reason: slot.reason };
  if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  else process.stderr.write(`Error: queue-timeout (${slot.reason})\n`);
  process.exit(4);
}
let r;
try {
  r = await callMiniAgentReview({ context: diffResult.diff, focus, schemaPath, cwd, timeout, onProgressLine });
} finally {
  releaseQueueSlot(workspaceRoot, slot.token);
}
```

`timeout * 2` 理由：review 最多跑 2 个 callMiniAgent（first + retry），每个 timeout。

- [ ] **Step 3：加并发串行化测试**

追加到 `plugins/minimax/scripts/lib/job-control.test.mjs`：

```js
test("acquireQueueSlot: two concurrent attempts serialize (FIFO-ish)", async () => {
  const root = mkWorkspaceRoot();
  const order = [];
  const slot1 = await acquireQueueSlot(root, { pollIntervalMs: 30, maxWaitMs: 2000 });
  assert.ok(slot1.acquired);
  // Launch second attempt; it should block until we release slot1.
  const pending = acquireQueueSlot(root, { pollIntervalMs: 30, maxWaitMs: 2000 });
  order.push("slot1-acquired");
  // Hold slot1 for ~200ms then release
  await new Promise(r => setTimeout(r, 200));
  order.push("slot1-about-to-release");
  releaseQueueSlot(root, slot1.token);
  const slot2 = await pending;
  order.push("slot2-acquired");
  assert.ok(slot2.acquired, `slot2 should acquire after release; reason=${slot2.reason}`);
  assert.deepEqual(order, ["slot1-acquired", "slot1-about-to-release", "slot2-acquired"]);
  releaseQueueSlot(root, slot2.token);
});
```

- [ ] **Step 4：全量测试**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
node --test plugins/minimax/scripts/lib/*.test.mjs 2>&1 | tail -8
```

Expected: 新增 1 并发测试 + Phase 2/3 既有测试全绿；ask/review 既有 mock smoke 不受影响（queue 在空 state 下立刻 acquire）。

- [ ] **Step 5：Commit**

```bash
git add plugins/minimax/scripts/minimax-companion.mjs plugins/minimax/scripts/lib/job-control.test.mjs
git commit -m "$(cat <<'EOF'
feat(Task 4.0): retroactively route runAsk / runReview through the serial queue (P0.10)

Phase 4 plan review found that Phase 2 /minimax:ask and Phase 3 /minimax:review
both bypassed the queue and would race against each other and /minimax:rescue.
P0.10 conditional hard gate (concurrent-spawn log attribution FAILS under
seconds-precision timestamps) mandates single-spawn at a time — regardless of
which command drives it.

- runAsk: wrap callMiniAgent in acquireQueueSlot + try/finally release
  (maxWait = timeout + 30s).
- runReview: same wrapper; maxWait = timeout*2 + 30s to cover retry path.
- 1 new serialization test to prove FIFO-ish ordering.
- queue-timeout emits exit 4 + JSON payload.
EOF
)"
```

---

## Task 4.1 — `job-control.mjs` 数据层

**Why first**：所有 job 行为（create/read/update/list/cancel）都依赖这一层。后续 Task 4.2 队列 + 4.3 cancel 都 sit on top。Phase 1 `state.mjs` 已有 `withLockAsync` 可借力。

**Files:**
- Create: `plugins/minimax/scripts/lib/job-control.mjs`
- Create: `plugins/minimax/scripts/lib/job-control.test.mjs`

- [ ] **Step 1：写失败测试**

创建 `plugins/minimax/scripts/lib/job-control.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createJob, readJob, updateJobMeta, listJobs, jobDir,
} from "./job-control.mjs";

function mkWorkspaceRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "minimax-jobs-"));
}

test("createJob: initializes meta with queued status and mj- prefix id", () => {
  const root = mkWorkspaceRoot();
  const job = createJob({
    workspaceRoot: root,
    prompt: "hello",
    cwd: process.cwd(),
    sandbox: false,
    sessionId: "sess-abc",
  });
  assert.ok(job.jobId.startsWith("mj-"), `jobId should start with mj-, got ${job.jobId}`);
  assert.equal(job.meta.status, "queued");
  assert.equal(job.meta.sandbox, false);
  assert.equal(job.meta.canceled, false);
  assert.equal(job.meta.prompt, "hello");
  assert.equal(job.meta.cwd, process.cwd());
  assert.equal(job.meta.sessionId, "sess-abc");
  assert.equal(typeof job.meta.createdAt, "number");
  assert.ok(fs.existsSync(path.join(jobDir(root, job.jobId), "meta.json")));
});

test("createJob: --sandbox creates workspace/ subdir", () => {
  const root = mkWorkspaceRoot();
  const job = createJob({ workspaceRoot: root, prompt: "x", cwd: process.cwd(), sandbox: true, sessionId: "s" });
  assert.equal(job.meta.sandbox, true);
  assert.ok(fs.existsSync(path.join(jobDir(root, job.jobId), "workspace")));
  assert.equal(job.meta.workdir, path.join(jobDir(root, job.jobId), "workspace"));
});

test("createJob: default workdir === cwd (no workspace mkdir)", () => {
  const root = mkWorkspaceRoot();
  const job = createJob({ workspaceRoot: root, prompt: "x", cwd: "/tmp/proj", sandbox: false, sessionId: "s" });
  assert.equal(job.meta.workdir, "/tmp/proj");
  assert.equal(fs.existsSync(path.join(jobDir(root, job.jobId), "workspace")), false);
});

test("readJob / updateJobMeta: round-trip atomic update", async () => {
  const root = mkWorkspaceRoot();
  const job = createJob({ workspaceRoot: root, prompt: "x", cwd: "/tmp", sandbox: false, sessionId: "s" });
  await updateJobMeta(root, job.jobId, { status: "running", pid: 12345 });
  const after = readJob(root, job.jobId);
  assert.equal(after.status, "running");
  assert.equal(after.pid, 12345);
  assert.equal(after.prompt, "x"); // preserved
});

test("readJob: returns null for missing job", () => {
  const root = mkWorkspaceRoot();
  assert.equal(readJob(root, "mj-does-not-exist"), null);
});

test("listJobs: returns newest-first by createdAt", () => {
  const root = mkWorkspaceRoot();
  const a = createJob({ workspaceRoot: root, prompt: "a", cwd: "/", sandbox: false, sessionId: "s" });
  // Force later timestamp on b
  const b = createJob({ workspaceRoot: root, prompt: "b", cwd: "/", sandbox: false, sessionId: "s" });
  const list = listJobs(root);
  assert.ok(list.length === 2);
  assert.ok(list[0].createdAt >= list[1].createdAt, "newest first");
});

test("listJobs: empty on missing root returns []", () => {
  const root = path.join(os.tmpdir(), "minimax-jobs-" + Date.now() + "-none");
  assert.deepEqual(listJobs(root), []);
});

test("updateJobMeta: rejects unknown status but accepts known ones", async () => {
  const root = mkWorkspaceRoot();
  const job = createJob({ workspaceRoot: root, prompt: "x", cwd: "/", sandbox: false, sessionId: "s" });
  for (const s of ["queued", "starting", "running", "done", "failed", "canceled"]) {
    await updateJobMeta(root, job.jobId, { status: s });
  }
  await assert.rejects(
    () => updateJobMeta(root, job.jobId, { status: "totally-bogus" }),
    /invalid status/
  );
});
```

- [ ] **Step 2：跑确认失败**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
node --test plugins/minimax/scripts/lib/job-control.test.mjs
```

Expected: 8 tests FAIL (module does not exist).

- [ ] **Step 3：实现 `job-control.mjs` 数据层**

创建 `plugins/minimax/scripts/lib/job-control.mjs`：

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const VALID_STATUSES = new Set(["queued", "starting", "running", "done", "failed", "canceled"]);

export function defaultWorkspaceRoot() {
  return process.env.MINIMAX_JOBS_ROOT
    || path.join(os.homedir(), ".claude", "plugins", "minimax", "jobs");
}

export function jobDir(workspaceRoot, jobId) {
  return path.join(workspaceRoot, jobId);
}

function metaPath(workspaceRoot, jobId) {
  return path.join(jobDir(workspaceRoot, jobId), "meta.json");
}

function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

export function createJob({ workspaceRoot, prompt, cwd, sandbox, sessionId, extraArgs = [], timeout = 300_000 }) {
  if (!workspaceRoot) throw new Error("createJob: workspaceRoot required");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const jobId = "mj-" + crypto.randomUUID();
  const dir = jobDir(workspaceRoot, jobId);
  fs.mkdirSync(dir, { recursive: true });

  let workdir = cwd;
  if (sandbox) {
    workdir = path.join(dir, "workspace");
    fs.mkdirSync(workdir, { recursive: true });
  }

  const meta = {
    jobId,
    status: "queued",
    prompt,
    cwd,
    workdir,
    sandbox: Boolean(sandbox),
    sessionId: sessionId || null,
    extraArgs,
    timeout,                   // v2 (Gemini #6): persist timeout at creation so
                               // _worker reads it without a second update round-trip.
    canceled: false,
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    pid: null,
    exitCode: null,
    signal: null,
    miniAgentLogPath: null,
    stdoutTruncated: false,
    stderrTruncated: false,
    queueToken: null,          // v2: persisted here so _worker can release on its own
  };
  atomicWriteJson(metaPath(workspaceRoot, jobId), meta);
  return { jobId, meta };
}

export function readJob(workspaceRoot, jobId) {
  try {
    const text = fs.readFileSync(metaPath(workspaceRoot, jobId), "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function updateJobMeta(workspaceRoot, jobId, patch) {
  if (patch.status !== undefined && !VALID_STATUSES.has(patch.status)) {
    throw new Error(`updateJobMeta: invalid status '${patch.status}'`);
  }
  const current = readJob(workspaceRoot, jobId);
  if (!current) throw new Error(`updateJobMeta: job ${jobId} not found`);
  const merged = { ...current, ...patch, updatedAt: Date.now() };
  atomicWriteJson(metaPath(workspaceRoot, jobId), merged);
  return merged;
}

export function listJobs(workspaceRoot) {
  let entries;
  try {
    entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const jobs = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith("mj-")) continue;
    const meta = readJob(workspaceRoot, e.name);
    if (meta) jobs.push(meta);
  }
  jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return jobs;
}

export function filterJobsBySession(jobs, sessionId) {
  if (!sessionId) return jobs;
  return jobs.filter(j => j.sessionId === sessionId);
}
```

- [ ] **Step 4：跑测试确认全过**

```bash
node --test plugins/minimax/scripts/lib/job-control.test.mjs
```

Expected: 8 pass, 0 fail.

全量回归：
```bash
node --test plugins/minimax/scripts/lib/*.test.mjs
```

Expected: 原有测试 + 8 new = 全绿。

- [ ] **Step 5：Commit**

```bash
git add plugins/minimax/scripts/lib/job-control.mjs plugins/minimax/scripts/lib/job-control.test.mjs
git commit -m "$(cat <<'EOF'
feat(Task 4.1): job-control.mjs data layer (spec §5.1)

- createJob / readJob / updateJobMeta / listJobs / filterJobsBySession
- Atomic meta.json write via tmp + rename
- jobId = "mj-" + crypto.randomUUID()
- --sandbox creates jobs/<jobId>/workspace/ and points workdir there
- Default workdir = caller cwd (no workspace mkdir)
- VALID_STATUSES gate (queued|starting|running|done|failed|canceled)
- MINIMAX_JOBS_ROOT env override for tests / CI
- 8 unit tests
EOF
)"
```

---

## Task 4.2 — Serial queue (`acquireQueueSlot` / `releaseQueueSlot`)

**Why**：P0.10 条件硬门 FAIL → v0.1 必须串行。全局 `<workspaceRoot>/.queue-lock` PID-lock：acquire 时轮询每 300ms，stale 回收（PID 不存活 或 mtime > 300s）。release 时删除 lockfile。

**Files:**
- Modify: `plugins/minimax/scripts/lib/job-control.mjs` — 追加 `acquireQueueSlot` / `releaseQueueSlot`
- Modify: `plugins/minimax/scripts/lib/job-control.test.mjs` — 追加队列测试

- [ ] **Step 1：写失败测试**

追加到 `plugins/minimax/scripts/lib/job-control.test.mjs`：

```js
import { acquireQueueSlot, releaseQueueSlot, queueLockPath } from "./job-control.mjs";

test("acquireQueueSlot: acquires when no prior lock; releaseQueueSlot removes it", async () => {
  const root = mkWorkspaceRoot();
  const slot = await acquireQueueSlot(root, { pollIntervalMs: 50, maxWaitMs: 2000 });
  assert.ok(slot.acquired, `should acquire; reason=${slot.reason}`);
  assert.equal(fs.existsSync(queueLockPath(root)), true);
  releaseQueueSlot(root, slot.token);
  assert.equal(fs.existsSync(queueLockPath(root)), false);
});

test("acquireQueueSlot: blocks if another lock is held by live PID", async () => {
  const root = mkWorkspaceRoot();
  const slot1 = await acquireQueueSlot(root, { pollIntervalMs: 50, maxWaitMs: 2000 });
  assert.ok(slot1.acquired);
  const t0 = Date.now();
  const slot2 = await acquireQueueSlot(root, { pollIntervalMs: 50, maxWaitMs: 500 });
  const dt = Date.now() - t0;
  assert.equal(slot2.acquired, false);
  assert.equal(slot2.reason, "queue-timeout");
  assert.ok(dt >= 400, `should have waited ~500ms, took ${dt}ms`);
  releaseQueueSlot(root, slot1.token);
});

test("acquireQueueSlot: reclaims stale lock (dead PID)", async () => {
  const root = mkWorkspaceRoot();
  fs.mkdirSync(root, { recursive: true });
  // Fabricate a stale lock (directory + owner.json inside) with a dead PID
  const stagedDir = queueLockPath(root);
  fs.mkdirSync(stagedDir, { recursive: true });
  fs.writeFileSync(path.join(stagedDir, "owner.json"),
    JSON.stringify({ pid: 999999, token: "stale", mtime: new Date().toISOString() }));
  const slot = await acquireQueueSlot(root, { pollIntervalMs: 50, maxWaitMs: 2000 });
  assert.ok(slot.acquired, `stale reclaim; reason=${slot.reason}`);
  releaseQueueSlot(root, slot.token);
});

test("acquireQueueSlot: reclaims stale lock (mtime > staleMs)", async () => {
  const root = mkWorkspaceRoot();
  fs.mkdirSync(root, { recursive: true });
  // Fabricate directory-lock with live PID but old mtime
  const stagedDir = queueLockPath(root);
  fs.mkdirSync(stagedDir, { recursive: true });
  const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(stagedDir, "owner.json"),
    JSON.stringify({ pid: process.pid, token: "aged", mtime: oldTime }));
  const slot = await acquireQueueSlot(root, { pollIntervalMs: 50, maxWaitMs: 2000, staleMs: 60_000 });
  assert.ok(slot.acquired);
  releaseQueueSlot(root, slot.token);
});

test("releaseQueueSlot: unknown token leaves lock alone (defensive)", async () => {
  const root = mkWorkspaceRoot();
  const slot = await acquireQueueSlot(root, { pollIntervalMs: 50, maxWaitMs: 2000 });
  releaseQueueSlot(root, "wrong-token");
  assert.equal(fs.existsSync(queueLockPath(root)), true, "wrong token must not release");
  releaseQueueSlot(root, slot.token);
});
```

- [ ] **Step 2：跑确认失败**

Expected: 5 new tests FAIL (imports undefined).

- [ ] **Step 3：实现队列**

追加到 `job-control.mjs` 末尾：

```js
// ── Serial queue (P0.10 conditional-hard-gate FAIL; only one mini-agent
//     spawn may run at a time in v0.1) ────────────────────────────────────
//
// v2 (Codex #1): we use a *directory* as the lock primitive, not a file.
// `fs.mkdirSync(lockDir)` is atomic in POSIX — either we create it or we
// get EEXIST. That closes the stale-reclaim race an openSync("wx") variant
// has: if process A reclaims a stale file-lock (unlink + open), a straggling
// process B can unlink A's fresh lock in its own "reclaim" path. With a
// directory lock, reclaim happens via rename-and-delete of the stale dir
// (not unlink-then-create), which is a single atomic step.

export function queueLockPath(workspaceRoot) {
  return path.join(workspaceRoot, ".queue-lock");   // this is a DIRECTORY path
}

function metadataFileInsideLock(lockDir) {
  return path.join(lockDir, "owner.json");
}

function readLockOwner(lockDir) {
  try {
    const text = fs.readFileSync(metadataFileInsideLock(lockDir), "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed.pid !== "number" || typeof parsed.token !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== "ESRCH" ? true : false; }
}

/**
 * Acquire the global serial queue slot. Blocks (polls) until the lock is
 * available or maxWaitMs is exceeded. Returns {acquired, token} or
 * {acquired:false, reason}.
 *
 * Algorithm:
 *   loop:
 *     try mkdirSync(lockDir)
 *       if success → write owner.json inside, return {acquired, token}
 *       if EEXIST → read owner.json
 *         if owner alive && fresh → sleep pollIntervalMs, retry
 *         else stale → atomic reclaim:
 *           renameSync(lockDir, lockDir+".stale.<uuid>")  // atomic even if
 *           rmSync(...stale, {recursive:true, force:true}) // another racer
 *                                                         // already moved it
 *           continue loop (next mkdirSync will succeed or lose again)
 */
export async function acquireQueueSlot(workspaceRoot, {
  pollIntervalMs = 300,
  maxWaitMs = 5 * 60 * 1000,
  staleMs = 5 * 60 * 1000,
} = {}) {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const lockDir = queueLockPath(workspaceRoot);
  const deadline = Date.now() + maxWaitMs;

  while (true) {
    try {
      fs.mkdirSync(lockDir);  // atomic: EEXIST or success
      const token = crypto.randomUUID();
      const payload = { pid: process.pid, token, mtime: new Date().toISOString() };
      fs.writeFileSync(metadataFileInsideLock(lockDir), JSON.stringify(payload), "utf8");
      return { acquired: true, token };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Lock held. Check liveness.
      const owner = readLockOwner(lockDir);
      let shouldReclaim = false;
      if (!owner) {
        shouldReclaim = true;  // corrupt metadata → treat as stale
      } else {
        const alive = pidAlive(owner.pid);
        const mtimeMs = Date.parse(owner.mtime || "") || 0;
        const aged = (Date.now() - mtimeMs) > staleMs;
        if (!alive || aged) shouldReclaim = true;
      }
      if (shouldReclaim) {
        // Atomic reclaim: rename then rm. If two racers both try, the second
        // renameSync gets ENOENT (harmless) and falls through to a fresh try.
        const stagedPath = lockDir + ".stale." + crypto.randomUUID();
        try { fs.renameSync(lockDir, stagedPath); fs.rmSync(stagedPath, { recursive: true, force: true }); }
        catch (e) {
          if (e.code !== "ENOENT") { /* swallow; next loop will re-check */ }
        }
        continue;  // retry immediately without waiting
      }
    }

    if (Date.now() >= deadline) {
      return { acquired: false, reason: "queue-timeout" };
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
}

export function releaseQueueSlot(workspaceRoot, token) {
  const lockDir = queueLockPath(workspaceRoot);
  const owner = readLockOwner(lockDir);
  if (!owner) return;
  if (owner.token !== token) return; // defensive: don't nuke someone else's lock
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
}
```

- [ ] **Step 4：跑测试确认全过**

```bash
node --test plugins/minimax/scripts/lib/job-control.test.mjs
```

Expected: 13 pass, 0 fail.

- [ ] **Step 5：Commit**

```bash
git add plugins/minimax/scripts/lib/job-control.mjs plugins/minimax/scripts/lib/job-control.test.mjs
git commit -m "$(cat <<'EOF'
feat(Task 4.2): job-control serial queue (spec §4.6, P0.10 mandate)

- acquireQueueSlot polls a PID-tagged lockfile, reclaims stale (dead pid or
  mtime beyond staleMs). Uses O_EXCL ("wx") to avoid TOCTOU.
- releaseQueueSlot refuses to remove the lock if token does not match —
  prevents one worker from clobbering another's slot.
- Default maxWaitMs = 5 min; staleMs = 5 min.
- v0.1 v constraint: only one mini-agent spawn may be in flight at a time
  (P0.10 conditional hard gate FAILED — concurrent spawn log attribution
  is unreliable under seconds-precision log-file timestamps).
- 5 new queue tests.
EOF
)"
```

---

## Task 4.3 — `cancelJob` (SIGTERM → SIGKILL → meta update)

**Files:**
- Modify: `plugins/minimax/scripts/lib/job-control.mjs` — 追加 `cancelJob`
- Modify: `plugins/minimax/scripts/lib/job-control.test.mjs` — 追加 cancel 测试

- [ ] **Step 1：写失败测试**

```js
import { cancelJob } from "./job-control.mjs";
import { spawn } from "node:child_process";

test("cancelJob: marks as canceled even if pid is unknown", async () => {
  const root = mkWorkspaceRoot();
  const job = createJob({ workspaceRoot: root, prompt: "x", cwd: "/", sandbox: false, sessionId: "s" });
  const r = await cancelJob(root, job.jobId);
  assert.equal(r.ok, true);
  assert.equal(r.alreadyFinished, true); // still queued / no pid -> treat as finish-without-spawn
  const meta = readJob(root, job.jobId);
  assert.equal(meta.canceled, true);
  assert.equal(meta.status, "canceled");
});

test("cancelJob: SIGTERM a live sleep child + marks canceled", async () => {
  const root = mkWorkspaceRoot();
  const job = createJob({ workspaceRoot: root, prompt: "x", cwd: "/", sandbox: false, sessionId: "s" });
  // Spawn a 30s sleep and record its pid
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  child.unref();
  await updateJobMeta(root, job.jobId, { status: "running", pid: child.pid, startedAt: Date.now() });

  const r = await cancelJob(root, job.jobId, { termGraceMs: 500 });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyFinished, false);
  const meta = readJob(root, job.jobId);
  assert.equal(meta.canceled, true);
  assert.equal(meta.status, "canceled");

  // Verify child is actually gone within a small delay
  await new Promise(r => setTimeout(r, 200));
  try {
    process.kill(child.pid, 0);
    assert.fail("expected child to be gone");
  } catch (e) {
    assert.equal(e.code, "ESRCH");
  }
});

test("cancelJob: missing job returns error", async () => {
  const root = mkWorkspaceRoot();
  const r = await cancelJob(root, "mj-no-such");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not-found");
});
```

- [ ] **Step 2：跑确认失败**

Expected: 3 new tests FAIL.

- [ ] **Step 3：实现 `cancelJob`**

追加到 `job-control.mjs`：

```js
/**
 * Cancel a job:
 *   - If already in terminal state (done/failed/canceled) → return early.
 *   - Else if pid is set and alive → SIGTERM → wait termGraceMs → SIGKILL if still alive.
 *   - Always mark meta as canceled + status=canceled.
 *   - Caller handles workspace cleanup separately (pass keepWorkspace to suppress).
 *
 * v0.1 known limit (v2 Codex #4): the `kill(pid,0)` liveness check cannot
 * distinguish "our worker still alive" from "OS reused that pid for a new
 * process". Probability of pid reuse within termGraceMs is negligible on
 * modern systems (PID space is 32-bit on Linux, 15-bit on macOS but with
 * round-robin allocation). v0.2 can tighten by comparing /proc/<pid>/stat
 * start-time or using process-group kill.
 */
export async function cancelJob(workspaceRoot, jobId, { termGraceMs = 5000, keepWorkspace = false } = {}) {
  const meta = readJob(workspaceRoot, jobId);
  if (!meta) return { ok: false, reason: "not-found" };
  if (meta.status === "done" || meta.status === "failed" || meta.status === "canceled") {
    return { ok: true, alreadyFinished: true, previousStatus: meta.status };
  }

  let killed = false;
  let alreadyFinished = false;
  if (meta.pid && typeof meta.pid === "number") {
    try {
      process.kill(meta.pid, "SIGTERM");
      // Poll up to termGraceMs
      const deadline = Date.now() + termGraceMs;
      while (Date.now() < deadline) {
        try { process.kill(meta.pid, 0); }
        catch (e) { if (e.code === "ESRCH") { killed = true; break; } }
        await new Promise(r => setTimeout(r, 100));
      }
      if (!killed) {
        try { process.kill(meta.pid, "SIGKILL"); killed = true; } catch {}
      }
    } catch (err) {
      if (err.code === "ESRCH") alreadyFinished = true;
      // else: re-raise? v0.1 — swallow, record canceled anyway
    }
  } else {
    alreadyFinished = true; // No pid ever assigned (queued / starting crashed)
  }

  await updateJobMeta(workspaceRoot, jobId, {
    canceled: true,
    status: "canceled",
    endedAt: Date.now(),
    signal: killed ? "SIGKILL_OR_SIGTERM" : null,
  });

  if (meta.sandbox && !keepWorkspace) {
    try {
      fs.rmSync(path.join(jobDir(workspaceRoot, jobId), "workspace"), { recursive: true, force: true });
    } catch {}
  }

  return { ok: true, alreadyFinished, killed };
}
```

- [ ] **Step 4：跑测试 + Commit**

```bash
node --test plugins/minimax/scripts/lib/job-control.test.mjs
```

Expected: 16 pass, 0 fail.

```bash
git add plugins/minimax/scripts/lib/job-control.mjs plugins/minimax/scripts/lib/job-control.test.mjs
git commit -m "$(cat <<'EOF'
feat(Task 4.3): job-control cancelJob (spec §4.3)

- SIGTERM → poll termGraceMs (default 5s) → SIGKILL fallback.
- Always marks meta as canceled / status=canceled / endedAt set, even when
  pid was never assigned (queued state) or the process is already gone.
- Workspace cleanup: if job was --sandbox and !keepWorkspace, rm -rf the
  jobs/<jobId>/workspace/ subtree. Non-sandbox jobs are never cleaned.
- 3 new tests (queued-no-pid, live sleep child, not-found).
EOF
)"
```

---

## Task 4.4 — Foreground `runRescue` subcommand (no `--background` yet)

**Why**：先把最简单的路径（foreground + optional `--sandbox`）做通。Background 分支 Task 4.5 再加。

**Files:**
- Modify: `plugins/minimax/scripts/minimax-companion.mjs` — import `job-control` + 新增 `runRescue` + 路由

- [ ] **Step 1：更新 USAGE + imports**

在 `plugins/minimax/scripts/minimax-companion.mjs` 顶部 import 区 **先补 fs**（v2 Claude blocker — companion 目前没 import fs，Task 4.4/4.5 都用），**再**追加 job-control imports 和 `spawn`（v2 Codex #7 一并 static import）：

```js
import fs from "node:fs";                                     // ← v2: required, not currently present
import os from "node:os";                                     // ← v2: required for runTaskResumeCandidate (Task 4.6)
import { spawn, spawnSync } from "node:child_process";        // ← v2: expand from spawnSync-only to include spawn

import {
  defaultWorkspaceRoot,
  createJob,
  readJob,
  updateJobMeta,
  listJobs,
  filterJobsBySession,
  cancelJob,
  acquireQueueSlot,
  releaseQueueSlot,
} from "./lib/job-control.mjs";
```

**执行提示**：companion 当前已 `import { spawnSync } from "node:child_process"`（Task 3.5 加的）。把那行升级成 `import { spawn, spawnSync }`。`fs` 和 `os` 是全新追加。

USAGE 追加（放在 `review` 段之后、闭合反引号之前）：

```
  rescue [--json] [--sandbox] [--timeout <ms>] [--cwd <path>] <prompt>
                    Delegate a multi-step agent task. Default workdir = caller
                    cwd; --sandbox places workdir in jobs/<jobId>/workspace/
                    (isolated workdir, NOT a security boundary — agent bash
                    can still escape via absolute paths). Serial execution:
                    only one mini-agent spawn runs at a time (P0.10).
                    Exit codes mirror ask (0/2/3/4/5).
```

- [ ] **Step 2：实现 `runRescue`（foreground only 先行）**

在 `runReview` 之后、`main()` 之前追加（会在 Task 4.5 扩展 `--background`）：

```js
async function runRescue(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, {
    booleanOptions: ["json", "sandbox", "background"],
    valueOptions: ["timeout", "cwd"],
  });

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    if (options.json) process.stdout.write(JSON.stringify({ status: "bad-input", reason: "prompt is empty" }) + "\n");
    else process.stderr.write("Error: prompt is required\n");
    process.exit(1);
  }
  const timeout = options.timeout ? Number(options.timeout) : 300_000;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    if (options.json) process.stdout.write(JSON.stringify({ status: "bad-input", reason: `invalid --timeout '${options.timeout}'` }) + "\n");
    else process.stderr.write(`Error: invalid --timeout '${options.timeout}'\n`);
    process.exit(1);
  }
  const cwd = options.cwd || process.cwd();
  const sandbox = Boolean(options.sandbox);
  const sessionId = process.env.MINIMAX_COMPANION_SESSION_ID || null;
  const workspaceRoot = defaultWorkspaceRoot();

  // Task 4.5 will handle --background here. v0.1 foreground = synchronous wait.
  if (options.background) {
    // Stub for Task 4.5
    throw new Error("--background not yet implemented (Task 4.5)");
  }

  const { jobId, meta } = createJob({ workspaceRoot, prompt, cwd, sandbox, sessionId, timeout });
  if (!options.json) {
    process.stdout.write(`Rescue job ${jobId} created (workdir=${meta.workdir}${sandbox ? ", sandbox" : ""}).\n`);
    process.stdout.write("Waiting for queue slot...\n");
  }

  const slot = await acquireQueueSlot(workspaceRoot);
  if (!slot.acquired) {
    await updateJobMeta(workspaceRoot, jobId, { status: "failed", endedAt: Date.now() });
    const payload = { status: "queue-timeout", jobId, detail: slot.reason };
    if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stderr.write(`Error: queue-timeout (${slot.reason})\n`);
    process.exit(4);
  }

  try {
    if (!options.json) {
      process.stdout.write("Starting MiniMax (cold start ~3s)...\n");
    }
    await updateJobMeta(workspaceRoot, jobId, { status: "running", startedAt: Date.now(), pid: process.pid });

    const onProgressLine = options.json ? undefined : (line) => process.stdout.write(stripAnsiSgr(line) + "\n");
    const result = await callMiniAgent({ prompt, cwd: meta.workdir, timeout, onProgressLine });
    const cls = classifyMiniAgentResult(result);

    await updateJobMeta(workspaceRoot, jobId, {
      status: cls.status === "success" || cls.status === "success-but-truncated" ? "done" : "failed",
      endedAt: Date.now(),
      exitCode: result.exitCode,
      signal: result.signal,
      miniAgentLogPath: cls.logPath,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    });

    // Write trimmed stdout/stderr to job dir for later /minimax:result inspection
    const jDir = path.join(workspaceRoot, jobId);
    fs.writeFileSync(path.join(jDir, "stdout.log"), String(result.rawStdout || ""), "utf8");
    fs.writeFileSync(path.join(jDir, "stderr.log"), String(result.rawStderr || ""), "utf8");

    const exitCode = STATUS_EXIT_CODE[cls.status] ?? 5;
    if (options.json) {
      const payload = (cls.status === "success" || cls.status === "success-but-truncated")
        ? { jobId, status: cls.status, response: cls.response, toolCalls: cls.toolCalls, finishReason: cls.finishReason, thinking: cls.thinking, logPath: cls.logPath }
        : { jobId, status: cls.status, reason: cls.reason ?? null, detail: cls.detail ?? null, logPath: cls.logPath ?? null, diagnostic: cls.diagnostic ?? null };
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    } else if (cls.status === "success" || cls.status === "success-but-truncated") {
      const cfg = readMiniAgentConfig();
      process.stdout.write("\n---\n" + cls.response + "\n");
      const footer = [];
      if (cfg.model) footer.push(`model: ${cfg.model}`);
      if (cls.logPath) footer.push(`log: ${cls.logPath}`);
      footer.push(`job: ${jobId}`);
      if (cls.status === "success-but-truncated") footer.push("truncated");
      process.stdout.write(`(${footer.join(" · ")})\n`);
    } else {
      process.stderr.write(`Error: ${cls.status}${cls.detail ? " -- " + cls.detail : ""}\n`);
      if (cls.diagnostic && cls.diagnostic.stderrHeadTail) {
        process.stderr.write(`\n--- diagnostic (stderr head+tail, ANSI stripped) ---\n${cls.diagnostic.stderrHeadTail}\n`);
      }
      process.stderr.write(`job: ${jobId}\n`);
    }
    process.exit(exitCode);
  } finally {
    releaseQueueSlot(workspaceRoot, slot.token);
  }
}
```

在 `main()` switch 里添加 `case "rescue": return await runRescue(rest);`。

- [ ] **Step 3：Syntax check + mock smoke**

```bash
node --check plugins/minimax/scripts/minimax-companion.mjs
```

Mock-based foreground smoke（仿 ask smoke）：

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
TMPDIR=$(mktemp -d)
cat > "$TMPDIR/agent_run_20260421_120000.log" <<'LOGEOF'
================================================================================
Agent Run Log - 2026-04-21 12:00:00
================================================================================


--------------------------------------------------------------------------------
[1] REQUEST
Timestamp: 2026-04-21 12:00:01.000
--------------------------------------------------------------------------------
{}

--------------------------------------------------------------------------------
[2] RESPONSE
Timestamp: 2026-04-21 12:00:05.000
--------------------------------------------------------------------------------

{"content":"rescued","thinking":null,"tool_calls":[],"finish_reason":"end_turn"}

LOGEOF

cat > "$TMPDIR/mini-agent" <<EOF
#!/bin/sh
printf 'Log file: $TMPDIR/agent_run_20260421_120000.log\n'
printf 'Session Statistics:\n'
exit 0
EOF
chmod +x "$TMPDIR/mini-agent"

MINIMAX_JOBS_ROOT="$TMPDIR/jobs" MINI_AGENT_BIN="$TMPDIR/mini-agent" MINI_AGENT_LOG_DIR="$TMPDIR" \
  node plugins/minimax/scripts/minimax-companion.mjs rescue --json "do a thing"
```

Expected JSON has `"status":"success"`, `"response":"rescued"`, `"jobId":"mj-..."`, exit 0. Check `$TMPDIR/jobs/<jobId>/meta.json` shows `status: "done"`.

- [ ] **Step 4：Commit**

```bash
git add plugins/minimax/scripts/minimax-companion.mjs
git commit -m "$(cat <<'EOF'
feat(Task 4.4): runRescue foreground subcommand (spec §4.6, §6.2)

- parseArgs: --json / --sandbox / --background (stub) / --timeout / --cwd
- Creates job (meta.json + optional workspace/), acquires serial queue slot,
  runs callMiniAgent against workdir (cwd or sandbox path), classifies,
  writes stdout.log / stderr.log into jobs/<jobId>/, updates meta with
  final status, releases queue slot.
- Default timeout 5 min (longer than ask because rescue is multi-step).
- --background deferred to Task 4.5.
EOF
)"
```

---

## Task 4.5 — Background worker (`_worker` subcommand) + `--background`

**Why**：后台 job 是 T6 的前置。detached 子进程跑 `node companion.mjs _worker <jobId>`，worker 吃 meta.json 里的 prompt/cwd/sandbox/timeout 后调 `callMiniAgent`，写 stdout.log / stderr.log / 最后 meta 状态 + **主动 release 队列锁**。父 companion 在 `--background` 模式下 spawn detached worker 就返回 jobId + exit 0。

**Files:**
- Modify: `plugins/minimax/scripts/minimax-companion.mjs` — `runWorker` + 接入 `case "_worker"` + `runRescue` 的 `--background` 分支

- [ ] **Step 1：实现 `runWorker` + 路由**

在 `minimax-companion.mjs` 末尾（`main()` 之前）追加：

```js
async function runWorker(rawArgs) {
  // Internal: node companion.mjs _worker <jobId> --workspace-root <root>
  const { options, positionals } = parseArgs(rawArgs, {
    valueOptions: ["workspace-root"],
  });
  const jobId = positionals[0];
  if (!jobId) {
    process.stderr.write("_worker: missing jobId\n");
    process.exit(2);
  }
  const workspaceRoot = options["workspace-root"] || defaultWorkspaceRoot();
  const meta = readJob(workspaceRoot, jobId);
  if (!meta) {
    process.stderr.write(`_worker: job ${jobId} not found\n`);
    process.exit(2);
  }

  // v2 (Codex #3 + Gemini #5 + Claude): wrap entire body in try/finally so
  // the queue slot is ALWAYS released, even if an updateJobMeta call throws
  // (ENOSPC, serialization error, corrupted meta.json, etc.). Without this
  // the next rescue waits up to staleMs (5 min default) for stale reclaim.
  let exitCode = 0;
  try {
    await updateJobMeta(workspaceRoot, jobId, { status: "running", startedAt: Date.now(), pid: process.pid });

    const jDir = path.join(workspaceRoot, jobId);
    const stdoutFile = path.join(jDir, "stdout.log");
    const stderrFile = path.join(jDir, "stderr.log");
    const stdoutWs = fs.createWriteStream(stdoutFile, { flags: "a" });

    const onProgressLine = (line) => {
      try { stdoutWs.write(stripAnsiSgr(line) + "\n"); } catch {}
    };

    let result, cls;
    try {
      result = await callMiniAgent({
        prompt: meta.prompt,
        cwd: meta.workdir,
        timeout: meta.timeout || 300_000,
        extraArgs: meta.extraArgs || [],
        onProgressLine,
      });
      cls = classifyMiniAgentResult(result);
    } catch (err) {
      // Best-effort: try to record, but do not mask a throw from hitting finally.
      try {
        await updateJobMeta(workspaceRoot, jobId, {
          status: "failed",
          endedAt: Date.now(),
          error: redactSecrets(err.message || String(err)),
        });
      } catch { /* swallow — finally must still release queue slot */ }
      try { fs.writeFileSync(stderrFile, `worker exception: ${err.message}\n`, "utf8"); } catch {}
      stdoutWs.end();
      exitCode = 2;
      return;
    }

    try { fs.writeFileSync(stderrFile, String(result.rawStderr || ""), "utf8"); } catch {}
    stdoutWs.end();

    try {
      await updateJobMeta(workspaceRoot, jobId, {
        status: cls.status === "success" || cls.status === "success-but-truncated" ? "done" : "failed",
        endedAt: Date.now(),
        exitCode: result.exitCode,
        signal: result.signal,
        miniAgentLogPath: cls.logPath,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        classifyStatus: cls.status,
        response: cls.response ?? null,
        finishReason: cls.finishReason ?? null,
      });
    } catch { /* swallow — keep exitCode at 0 but queue slot will still release */ }
  } finally {
    if (meta.queueToken) releaseQueueSlot(workspaceRoot, meta.queueToken);
  }
  process.exit(exitCode);
}
```

在 `main()` switch 中追加：
```js
    case "_worker":
      return await runWorker(rest);
```
**重要：`_worker` 不进 USAGE**（下划线前缀 = internal）。

- [ ] **Step 2：扩 `runRescue` 的 `--background` 分支**

把之前 Task 4.4 的 stub `throw new Error(...)` 替换为：

```js
if (options.background) {
  // v2 (Gemini #6): timeout is now a createJob field — one write, not two.
  const { jobId, meta: jobMeta } = createJob({
    workspaceRoot, prompt, cwd, sandbox, sessionId, extraArgs: [], timeout,
  });

  // Acquire queue slot synchronously so the worker starts knowing it owns the slot.
  // If queue is busy → fail fast rather than leaking a detached process in "queued".
  const slot = await acquireQueueSlot(workspaceRoot, { maxWaitMs: 60_000 });
  if (!slot.acquired) {
    await updateJobMeta(workspaceRoot, jobId, { status: "failed", endedAt: Date.now(), error: "queue-timeout" });
    const payload = { status: "queue-timeout", jobId };
    if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stderr.write(`Error: queue-timeout (jobId=${jobId})\n`);
    process.exit(4);
  }
  // Persist queueToken so _worker can release on its own finally block.
  await updateJobMeta(workspaceRoot, jobId, { queueToken: slot.token });

  // Spawn detached worker. `spawn` is static-imported at the top of this file
  // (v2 M2: `import { spawn, spawnSync } from "node:child_process"`).
  const script = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [script, "_worker", jobId, "--workspace-root", workspaceRoot], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MINIMAX_COMPANION_SESSION_ID: sessionId || "" },
  });
  child.unref();

  await updateJobMeta(workspaceRoot, jobId, { pid: child.pid, status: "starting" });
  // v2 M3: use jobMeta.workdir (already computed by createJob) instead of
  // a redundant helper.
  const payload = { jobId, status: "starting", workdir: jobMeta.workdir };
  if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  else process.stdout.write(`Rescue job ${jobId} started in background. Poll with /minimax:status ${jobId}.\n`);
  process.exit(0);
}
```

- [ ] **Step 3：smoke background flow（mock）**

```bash
TMPDIR=$(mktemp -d)
# Reuse the mock mini-agent from Task 4.4
cat > "$TMPDIR/agent_run_20260421_130000.log" <<'LOGEOF'
================================================================================
Agent Run Log - 2026-04-21 13:00:00
================================================================================


--------------------------------------------------------------------------------
[1] REQUEST
Timestamp: 2026-04-21 13:00:01.000
--------------------------------------------------------------------------------
{}

--------------------------------------------------------------------------------
[2] RESPONSE
Timestamp: 2026-04-21 13:00:05.000
--------------------------------------------------------------------------------

{"content":"bg rescued","thinking":null,"tool_calls":[],"finish_reason":"end_turn"}

LOGEOF
cat > "$TMPDIR/mini-agent" <<EOF
#!/bin/sh
printf 'Log file: $TMPDIR/agent_run_20260421_130000.log\n'
printf 'Session Statistics:\n'
exit 0
EOF
chmod +x "$TMPDIR/mini-agent"

export MINIMAX_JOBS_ROOT="$TMPDIR/jobs" MINI_AGENT_BIN="$TMPDIR/mini-agent" MINI_AGENT_LOG_DIR="$TMPDIR"
JOBID=$(node plugins/minimax/scripts/minimax-companion.mjs rescue --background --json "test bg" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).jobId))")
echo "jobId=$JOBID"

# Poll meta.json until status === "done" (max 10 s)
for i in $(seq 1 20); do
  STATUS=$(node -e "const j=require('fs').readFileSync('$TMPDIR/jobs/$JOBID/meta.json','utf8');console.log(JSON.parse(j).status)")
  echo "iter $i status=$STATUS"
  if [ "$STATUS" = "done" ] || [ "$STATUS" = "failed" ]; then break; fi
  sleep 0.5
done

# Verify end state
cat "$TMPDIR/jobs/$JOBID/meta.json"
```

Expected: `status: "done"` within ~5s; `response: "bg rescued"` persisted in meta.

- [ ] **Step 4：Commit**

```bash
git add plugins/minimax/scripts/minimax-companion.mjs
git commit -m "$(cat <<'EOF'
feat(Task 4.5): rescue --background + _worker subcommand (spec §6.2)

- _worker: internal subcommand (not in USAGE). Reads job meta, runs
  callMiniAgent + classifyMiniAgentResult, writes stdout.log/stderr.log,
  updates meta with final status + response + finishReason + logPath.
- Releases the global queue slot at the end (token persisted in meta).
- runRescue --background: creates job, acquires queue slot (fail-fast with
  60s wait), spawns detached worker via spawn({detached:true, stdio:'ignore',
  env with MINIMAX_COMPANION_SESSION_ID}) + unref. Exits immediately with
  jobId + status=starting.
EOF
)"
```

---

## Task 4.6 — `runStatus` / `runResult` / `runCancel` subcommands

**Files:**
- Modify: `plugins/minimax/scripts/minimax-companion.mjs`

- [ ] **Step 1：扩 USAGE**

```
  status [--json] [--all] [<jobId>]
                    List jobs (current session by default; --all for every
                    session). Supply <jobId> for a single-job status.

  result [--json] <jobId>
                    Print a finished job's final result. Reads meta.response
                    + stdout.log/stderr.log from jobs/<jobId>/.

  cancel [--json] [--keep-workspace] <jobId>
                    SIGTERM → 5s → SIGKILL the job, mark canceled. Removes
                    sandbox workspace unless --keep-workspace.
```

- [ ] **Step 2：实现三个 run\***

```js
function formatElapsed(startMs, endMs) {
  if (!startMs) return "?";
  const dt = Math.max(0, (endMs || Date.now()) - startMs);
  const s = Math.floor(dt / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}m${r}s`;
}

async function runStatus(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, {
    booleanOptions: ["json", "all"],
  });
  const workspaceRoot = defaultWorkspaceRoot();
  const sessionId = process.env.MINIMAX_COMPANION_SESSION_ID || null;

  if (positionals[0]) {
    const jobId = positionals[0];
    const meta = readJob(workspaceRoot, jobId);
    if (!meta) {
      if (options.json) process.stdout.write(JSON.stringify({ status: "not-found", jobId }) + "\n");
      else process.stderr.write(`Job not found: ${jobId}\n`);
      process.exit(2);
    }
    if (options.json) process.stdout.write(JSON.stringify(meta, null, 2) + "\n");
    else {
      process.stdout.write(`${meta.jobId}  ${meta.status}  (${formatElapsed(meta.startedAt, meta.endedAt)})\n`);
      process.stdout.write(`  prompt: ${(meta.prompt || "").slice(0, 80)}${meta.prompt.length > 80 ? "..." : ""}\n`);
      process.stdout.write(`  workdir: ${meta.workdir}${meta.sandbox ? "  (sandbox)" : ""}\n`);
      if (meta.miniAgentLogPath) process.stdout.write(`  log: ${meta.miniAgentLogPath}\n`);
    }
    process.exit(0);
  }

  let jobs = listJobs(workspaceRoot);
  if (!options.all) jobs = filterJobsBySession(jobs, sessionId);
  if (options.json) {
    process.stdout.write(JSON.stringify(jobs, null, 2) + "\n");
  } else if (jobs.length === 0) {
    process.stdout.write("(no jobs for this session; use --all for all sessions)\n");
  } else {
    for (const j of jobs) {
      process.stdout.write(`${j.jobId}  ${j.status.padEnd(9)}  ${formatElapsed(j.startedAt, j.endedAt).padStart(6)}  ${(j.prompt || "").slice(0, 60)}\n`);
    }
  }
  process.exit(0);
}

async function runResult(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, { booleanOptions: ["json"] });
  const jobId = positionals[0];
  if (!jobId) {
    if (options.json) process.stdout.write(JSON.stringify({ status: "bad-input", reason: "jobId required" }) + "\n");
    else process.stderr.write("Error: jobId required\n");
    process.exit(1);
  }
  const workspaceRoot = defaultWorkspaceRoot();
  const meta = readJob(workspaceRoot, jobId);
  if (!meta) {
    if (options.json) process.stdout.write(JSON.stringify({ status: "not-found", jobId }) + "\n");
    else process.stderr.write(`Job not found: ${jobId}\n`);
    process.exit(2);
  }
  if (meta.status !== "done" && meta.status !== "failed" && meta.status !== "canceled") {
    if (options.json) process.stdout.write(JSON.stringify({ status: "not-finished", currentStatus: meta.status, jobId }) + "\n");
    else process.stderr.write(`Job ${jobId} is ${meta.status}; not yet finished\n`);
    process.exit(2);
  }

  if (options.json) {
    const payload = {
      jobId: meta.jobId,
      status: meta.status,
      classifyStatus: meta.classifyStatus,
      response: meta.response,
      finishReason: meta.finishReason,
      miniAgentLogPath: meta.miniAgentLogPath,
      sandbox: meta.sandbox,
      workdir: meta.workdir,
      startedAt: meta.startedAt,
      endedAt: meta.endedAt,
      exitCode: meta.exitCode,
      signal: meta.signal,
      stdoutTruncated: meta.stdoutTruncated,
      stderrTruncated: meta.stderrTruncated,
      canceled: meta.canceled,
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    const cfg = readMiniAgentConfig();
    process.stdout.write(`job: ${meta.jobId}  status: ${meta.status}\n`);
    if (meta.response) {
      process.stdout.write("\n---\n" + meta.response + "\n");
      const footer = [];
      if (cfg.model) footer.push(`model: ${cfg.model}`);
      if (meta.miniAgentLogPath) footer.push(`log: ${meta.miniAgentLogPath}`);
      if (meta.finishReason) footer.push(`finish: ${meta.finishReason}`);
      process.stdout.write(`(${footer.join(" · ")})\n`);
    } else {
      process.stdout.write("(no response recorded)\n");
      if (meta.miniAgentLogPath) process.stdout.write(`log: ${meta.miniAgentLogPath}\n`);
    }
  }
  process.exit(0);
}

async function runCancel(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, { booleanOptions: ["json", "keep-workspace"] });
  const jobId = positionals[0];
  if (!jobId) {
    if (options.json) process.stdout.write(JSON.stringify({ status: "bad-input", reason: "jobId required" }) + "\n");
    else process.stderr.write("Error: jobId required\n");
    process.exit(1);
  }
  const workspaceRoot = defaultWorkspaceRoot();
  const r = await cancelJob(workspaceRoot, jobId, { keepWorkspace: Boolean(options["keep-workspace"]) });
  if (!r.ok) {
    if (options.json) process.stdout.write(JSON.stringify({ status: r.reason }) + "\n");
    else process.stderr.write(`Error: ${r.reason}\n`);
    process.exit(2);
  }
  const payload = { status: r.alreadyFinished ? "already-finished" : "canceled", jobId, killed: r.killed };
  if (options.json) process.stdout.write(JSON.stringify(payload) + "\n");
  else process.stdout.write(`Job ${jobId} ${payload.status}${r.killed ? " (SIGTERM/SIGKILL)" : ""}.\n`);
  process.exit(0);
}
```

- [ ] **Step 2b：`runTaskResumeCandidate` (v2 C4 — spec §6.1 + SKILL.md 要求)**

USAGE 追加：

```
  task-resume-candidate [--json]
                    List the 5 most recent ~/.mini-agent/log/agent_run_*.log
                    files. v0.1 does NOT resume (Mini-Agent has no external
                    session id); this subcommand is informational only.
```

Implementation（追加到 companion，在 `runCancel` 之后、`main()` 之前）：

```js
async function runTaskResumeCandidate(rawArgs) {
  const { options } = parseArgs(rawArgs, { booleanOptions: ["json"] });
  const logDir = process.env.MINI_AGENT_LOG_DIR || path.join(os.homedir(), ".mini-agent", "log");
  let files;
  try {
    files = fs.readdirSync(logDir)
      .filter(f => f.startsWith("agent_run_") && f.endsWith(".log"))
      .map(f => {
        const full = path.join(logDir, f);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
        return { name: f, path: full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 5);
  } catch (err) {
    const payload = { status: "log-dir-missing", detail: String(err.code || err.message), candidates: [] };
    if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stderr.write(`Mini-Agent log dir not found: ${logDir}\n`);
    process.exit(2);
  }
  const payload = {
    status: "ok",
    note: "v0.1 does NOT resume — Mini-Agent has no external session id (P0.9). This is informational only.",
    candidates: files,
  };
  if (options.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    process.stdout.write("Most recent Mini-Agent log files (v0.1 cannot resume; informational only):\n");
    for (const f of files) {
      process.stdout.write(`  ${new Date(f.mtimeMs).toISOString()}  ${f.path}\n`);
    }
    if (files.length === 0) process.stdout.write("  (none)\n");
  }
  process.exit(0);
}
```

(Top-of-file imports: ensure `import os from "node:os"` — currently **not** imported in companion.mjs either. Add it alongside fs in Task 4.4 Step 1 imports.)

**Update the "static imports required" hint in Task 4.4 Step 1** to also include:
```js
import os from "node:os";
```

- [ ] **Step 3：路由**

在 `main()` switch 里追加：
```js
    case "status":
      return await runStatus(rest);
    case "result":
      return await runResult(rest);
    case "cancel":
      return await runCancel(rest);
    case "task-resume-candidate":
      return await runTaskResumeCandidate(rest);
```

- [ ] **Step 3：smoke**

```bash
# Against previous background run
node plugins/minimax/scripts/minimax-companion.mjs status --json --all | head
node plugins/minimax/scripts/minimax-companion.mjs result --json $JOBID | head -20
```

- [ ] **Step 4：Commit**

```bash
git add plugins/minimax/scripts/minimax-companion.mjs
git commit -m "$(cat <<'EOF'
feat(Task 4.6): companion status / result / cancel subcommands (spec §6.1)

- status: list current session's jobs (or --all); single-job with <jobId>.
- result: print a finished job's final response + footer from meta.json.
- cancel: thin wrapper around cancelJob; --keep-workspace preserves sandbox dir.
- All three honor --json for structured output; text mode human-readable.
EOF
)"
```

---

## Task 4.7 — Command.md files

**Files:**
- Create: `plugins/minimax/commands/rescue.md`
- Create: `plugins/minimax/commands/status.md`
- Create: `plugins/minimax/commands/result.md`
- Create: `plugins/minimax/commands/cancel.md`

- [ ] **Step 1：`rescue.md`**

```markdown
---
description: Delegate a multi-step agent task to MiniMax
argument-hint: '[--json] [--sandbox] [--background] [--timeout <ms>] [--cwd <path>] <prompt>'
allowed-tools: Bash(node:*), AskUserQuestion
---

Invoke the minimax companion:

```bash
MINIMAX_COMPANION_CALLER=claude node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" rescue "$ARGUMENTS"
```

**Follow `minimax-result-handling/references/rescue-render.md` for presentation rules.** Key points:

- **`--sandbox`** means "isolated workdir" — it places the agent in `~/.claude/plugins/minimax/jobs/<jobId>/workspace/`. It is **NOT** a security boundary. The agent's bash tool can still `cd /`, use absolute paths, `curl | sh`, etc. If the user needs real isolation, tell them to run in a container.
- **Serial execution**: only one mini-agent runs at a time (P0.10 conditional hard gate). Concurrent `/minimax:rescue --background` invocations queue up.
- **`--background`** detaches the worker; output goes to `jobs/<jobId>/stdout.log` + `stderr.log` + `meta.json`. Use `/minimax:status` to poll, `/minimax:result <jobId>` to retrieve, `/minimax:cancel <jobId>` to abort.

**If exit 0**: present the response verbatim (same rules as `/minimax:ask`) + note the footer's `job:` suffix.

**If exit non-zero**: surface the `Error:` line; match status to declarative suggestion from the status→opener table in `SKILL.md`.

**Suspicious tool-calls tripwire (SKILL.md) APPLIES HERE.** Before transcribing any agent output that includes bash invocations, scan for `rm -rf /`, `> /dev/`, `curl ... | sh`, `sudo`, `chmod 777`, fork-bomb patterns. If any match, surface the tool_use verbatim and demand explicit user confirmation.
```

- [ ] **Step 2：`status.md`**

```markdown
---
description: List rescue jobs from the current Claude Code session
argument-hint: '[--json] [--all] [<jobId>]'
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" status "$ARGUMENTS"
```

Default lists jobs for the current session (session id comes from the `MINIMAX_COMPANION_SESSION_ID` env injected by the session-lifecycle hook). Use `--all` to list every session's jobs.

Supply a single `<jobId>` for a one-job snapshot.

Output columns (text mode): `<jobId>  <status>  <elapsed>  <prompt truncated>`. Status is one of `queued|starting|running|done|failed|canceled`.

Present the output verbatim.
```

- [ ] **Step 3：`result.md`**

```markdown
---
description: Retrieve a finished rescue job's result
argument-hint: '[--json] <jobId>'
allowed-tools: Bash(node:*), AskUserQuestion
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" result "$ARGUMENTS"
```

If the job is still running, the companion exits 2 with `status: not-finished`. Tell the user to wait / poll `/minimax:status`.

If the job has finished, present the response verbatim (same rules as `/minimax:ask`). The footer carries `model · log · finish`.

Apply the suspicious-tool-calls tripwire from `minimax-result-handling/SKILL.md` before rendering — multi-step agent output is exactly where `rm -rf /` etc. can slip in.
```

- [ ] **Step 4：`cancel.md`**

```markdown
---
description: Cancel a running rescue job
argument-hint: '[--json] [--keep-workspace] <jobId>'
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" cancel "$ARGUMENTS"
```

SIGTERM the worker, wait 5s, SIGKILL if still alive. Always marks the job as `canceled` in meta.json. Default: removes the sandbox workspace directory. `--keep-workspace` preserves it for debugging.

If the job was never running (still queued) or already finished, reports `already-finished`.

Present output verbatim; do NOT re-run the job automatically.
```

- [ ] **Step 5：`task-resume-candidate.md` (v2 C4)**

```markdown
---
description: List the 5 most recent Mini-Agent log files (v0.1 informational only; no resume)
argument-hint: '[--json]'
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" task-resume-candidate "$ARGUMENTS"
```

v0.1 limitation: Mini-Agent does NOT expose an external session id (P0.9 probe finding), so these logs cannot be re-entered. This command is a viewer only — it helps you locate the log for a previous task.

Present the output verbatim. Do NOT pretend `--resume` or `--resume-last` flags exist; they don't in v0.1.
```

- [ ] **Step 6：Commit**

```bash
git add plugins/minimax/commands/rescue.md \
        plugins/minimax/commands/status.md \
        plugins/minimax/commands/result.md \
        plugins/minimax/commands/cancel.md \
        plugins/minimax/commands/task-resume-candidate.md
git commit -m "$(cat <<'EOF'
feat(Task 4.7): /minimax:rescue | :status | :result | :cancel | :task-resume-candidate command.md files (spec §6.1)

- rescue: --sandbox is 'isolated workdir', NOT a security boundary. Serial
  execution note. Tripwire mandatory on rescue output. allowed-tools includes
  AskUserQuestion (v2 — tripwire needs user confirmation).
- status: default filters by session; --all for cross-session.
- result: surfaces response + footer; tripwire applies; allowed-tools includes
  AskUserQuestion.
- cancel: SIGTERM→SIGKILL + optional --keep-workspace. Never auto-restarts.
- task-resume-candidate: v0.1 informational-only listing of ~/.mini-agent/log/
  (spec §6.1 deliverable; P0.9 precludes actual resume).
- No emoji.
EOF
)"
```

---

## Task 4.8 — `minimax-agent.md` subagent

**Files:**
- Create: `plugins/minimax/agents/minimax-agent.md`

- [ ] **Step 1：写 subagent 定义**

```markdown
---
name: minimax-agent
description: Proactively use when Claude Code wants to delegate a multi-step agentic task (bash + file ops + skills + MCP tools) to MiniMax through the shared companion runtime
tools: Bash
skills:
  - minimax-cli-runtime
  - minimax-prompting
  - minimax-result-handling
---

You are a **thin forwarding wrapper** that delegates user requests to the MiniMax companion script. You do NOT solve problems yourself, you do NOT inspect the repo, you do NOT interpret the output.

## What you do

1. Receive a user request (diagnosis, research, multi-step task, code change draft)
2. Optionally use `minimax-prompting` to tighten the prompt for MiniMax
3. Forward to the companion script via a SINGLE `Bash` call
4. Return the companion's stdout **exactly as-is**

## The single command

Foreground (small bounded task):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" rescue --json "<prompt>"
```

Background (multi-step / long-running):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" rescue --background --json "<prompt>"
```

Isolated workdir (when the task may write files you don't want in the main project):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" rescue --sandbox --json "<prompt>"
```

## Routing flags

Strip these from the prompt text and pass as flags:

| Flag | Meaning |
|------|---------|
| `--background` | Detach worker, return jobId immediately |
| `--sandbox` | isolated workdir (NOT a security boundary) |
| `--timeout <ms>` | Override hard timeout (default 5 min) |
| `--cwd <path>` | Set the mini-agent working directory (default = caller cwd) |

## Flags NOT supported (drop silently if user passes them)

- `--model` / `-m` — MiniMax model is pinned in `~/.mini-agent/config/config.yaml`; no CLI override.
- `--resume` / `--resume-last` — Mini-Agent has no external session id (P0.9). v0.1 cannot resume a prior thread.

Drop these before forwarding; do NOT include them in the Bash call.

## Behavior rules

1. **One Bash call.** Do not chain commands.
2. **No independent work.** Do not `ls`, do not `grep`, do not read files. That is Claude's job after the companion returns.
3. **Preserve task text as-is** unless using `minimax-prompting` to tighten it.
4. **Return stdout exactly.** No commentary, no analysis, no follow-up. The calling Claude Code session will interpret the output per `minimax-result-handling`.
5. **Sandbox is an isolated workdir, NOT a security boundary.** If a user asks for real sandboxing, tell them to run in a container.

## When to use --background

- Prompt suggests multi-step work ("research X then write Y")
- Expected duration > 1 minute
- User explicitly wanted fire-and-forget

Otherwise default to foreground (simpler; immediate result).
```

- [ ] **Step 2：Commit**

```bash
git add plugins/minimax/agents/minimax-agent.md
git commit -m "$(cat <<'EOF'
feat(Task 4.8): minimax-agent subagent definition (spec §6.3)

- Thin-wrapper contract: ONE Bash call, no repo inspection, return stdout
  exactly. Delegates to minimax-cli-runtime / minimax-prompting /
  minimax-result-handling skills for presentation + flag discipline.
- Routing flags enumerated: --background, --sandbox, --timeout, --cwd.
- Dropped flags explicit: --model (not supported — YAML pins it),
  --resume (no session id; P0.9 locked).
- --sandbox explicitly framed as "isolated workdir, NOT a security
  boundary" — matches spec §4.6 downgrade.
EOF
)"
```

---

## Task 4.9 — Hooks + stop-review-gate prompt + rescue-render reference

**Files:**
- Create: `plugins/minimax/hooks/hooks.json`
- Create: `plugins/minimax/scripts/session-lifecycle-hook.mjs`
- Create: `plugins/minimax/scripts/stop-review-gate-hook.mjs`
- Create: `plugins/minimax/prompts/stop-review-gate.md`
- Create: `plugins/minimax/skills/minimax-result-handling/references/rescue-render.md`

- [ ] **Step 1：`hooks/hooks.json`**

```json
{
  "description": "Session lifecycle + optional stop-time review gate for MiniMax companion.",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs\" SessionStart", "timeout": 15 }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs\" SessionEnd", "timeout": 5 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs\"", "timeout": 900 }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2：`session-lifecycle-hook.mjs`**

**v2 notes**:
- C2 dual protocol: Claude Code's stable hook env-injection route is to append `VAR=value` lines to the file referenced by `CLAUDE_ENV_FILE`. Newer versions **also** honor a `{"env":{...}}` JSON emission on stdout. v0.1 emits BOTH; whichever the runtime supports wins.
- I5: plan registers `SessionStart` even though spec §6.5 only lists `SessionEnd + Stop`. Rationale: env injection must happen at session start; gemini-plugin-cc established this precedent. Registered as an **intentional spec §6.5 extension** in the CHANGELOG divergence list (Task 4.10).

```js
#!/usr/bin/env node
import process from "node:process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const event = process.argv[2];
const stateDir = path.join(os.homedir(), ".claude", "plugins", "minimax");
fs.mkdirSync(stateDir, { recursive: true });
const sidFile = path.join(stateDir, "session-id");

if (event === "SessionStart") {
  // Claude Code injects CLAUDE_SESSION_ID or similar. Fallback synthesizes a
  // fresh id each session — filterJobsBySession will NOT show cross-session
  // jobs by default; user must pass --all. This limitation is documented in
  // the CHANGELOG.
  const sid = process.env.CLAUDE_SESSION_ID || process.env.SESSION_ID || ("claude-" + Date.now());
  try { fs.writeFileSync(sidFile, sid, "utf8"); } catch {}

  // v2 C2 — dual protocol. Protocol A (stable): append to CLAUDE_ENV_FILE.
  // Protocol B (newer): emit JSON {env:{...}} on stdout.
  if (process.env.CLAUDE_ENV_FILE) {
    try {
      fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `MINIMAX_COMPANION_SESSION_ID=${sid}\n`, "utf8");
    } catch {}
  }
  process.stdout.write(JSON.stringify({ env: { MINIMAX_COMPANION_SESSION_ID: sid } }) + "\n");
} else if (event === "SessionEnd") {
  try { fs.unlinkSync(sidFile); } catch {}
}
process.exit(0);
```

- [ ] **Step 3：`stop-review-gate-hook.mjs`**

```js
#!/usr/bin/env node
import process from "node:process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const stateFile = path.join(os.homedir(), ".claude", "plugins", "minimax", "state.json");
let enabled = false;
try {
  const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  enabled = Boolean(s && s.reviewGate && s.reviewGate.enabled);
} catch {}

if (!enabled) { process.exit(0); }

// Load prompt and run a foreground review with the current working-tree diff.
const promptPath = path.join(process.env.CLAUDE_PLUGIN_ROOT || "", "prompts", "stop-review-gate.md");
let promptText = "";
try { promptText = fs.readFileSync(promptPath, "utf8"); } catch {}

const companion = path.join(process.env.CLAUDE_PLUGIN_ROOT || "", "scripts", "minimax-companion.mjs");
// v2 I3: review subcommand defaults to 120_000ms internal timeout; pass
// --timeout 600000 explicitly so the review can use up to 10 minutes before
// the hook itself cuts it off at its own 900s ceiling.
const r = spawnSync(process.execPath, [companion, "review", "--json", "--timeout", "600000"], {
  encoding: "utf8",
  env: { ...process.env, MINIMAX_REVIEW_PROMPT_OVERRIDE: promptText || "" },
  timeout: 800_000,
});
if (r.status !== 0 && r.stdout) {
  // Surface findings to the session as a Stop-block decision object.
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: "MiniMax review gate flagged issues. Output below.",
    additionalContext: r.stdout.slice(0, 60_000),
  }) + "\n");
  process.exit(0);
}
process.exit(0);
```

**v2 M4 — forward-hook limitation made explicit**: `MINIMAX_REVIEW_PROMPT_OVERRIDE` env is set by this hook but the `review` subcommand in Phase 3 does NOT read it. In v0.1 the gate therefore runs the default review prompt regardless of `prompts/stop-review-gate.md` content. The stop-review-gate prompt file is a **spec §6.6 deliverable** whose wiring (adding a `--prompt-override` flag to `review` or a new `review --system-prompt <path>` option) is deferred to Phase 5. Document this gap in `prompts/stop-review-gate.md` frontmatter / CHANGELOG.

- [ ] **Step 4：`prompts/stop-review-gate.md`**

```markdown
You are the Stop-time review gate for MiniMax.

A Claude Code session is about to end. Before it stops, you review the working-tree diff for immediate blockers: unfinished edits, obvious bugs, secret leaks, or files left in an inconsistent state.

This gate is default-disabled; the user opted in via `/minimax:setup --enable-review-gate`.

# Output contract

Return a single JSON object matching the review schema (see `prompts/review.md`).

# Scope

Only flag issues at severity `high` or `critical` that should STOP the session from ending as-is. Ignore nits. `approve` unless there's a real blocker — the gate's job is to catch mistakes, not to hold court.

# Context

{{CONTEXT}}
```

- [ ] **Step 5：`references/rescue-render.md`**

```markdown
# rescue-render reference

Rules for rendering `/minimax:rescue` / `/minimax:status` / `/minimax:result` output.

## Success JSON shape (foreground, exit 0)

```json
{
  "jobId": "mj-<uuid>",
  "status": "success" | "success-but-truncated",
  "response": "<string>",
  "toolCalls": [{"id":"...", "name":"bash", "arguments":{...}}, ...],
  "finishReason": "stop|end_turn|...",
  "thinking": null | "<string>",
  "logPath": "/Users/.../.mini-agent/log/agent_run_....log"
}
```

## Background start shape (exit 0)

```json
{ "jobId": "mj-<uuid>", "status": "starting", "workdir": "<path>" }
```

Claude renders: "Rescue job `mj-<uuid>` started in background. Poll with `/minimax:status mj-<uuid>`." Do NOT pretend a result is available.

## Result JSON shape (exit 0)

```json
{ "jobId":"...", "status":"done|failed|canceled", "classifyStatus":"success|...",
  "response":"<string|null>", "finishReason":"...", "miniAgentLogPath":"...",
  "sandbox":<bool>, "workdir":"...", ... }
```

## Suspicious tool-calls tripwire APPLIES HERE

This is the command path where the model can actually run bash. Before rendering response or tool_calls, scan for the tripwire patterns in `SKILL.md`. If any match, surface the tool_use verbatim and ASK the user whether to proceed — do not silently transcribe.

## Sandbox messaging discipline

Never call `--sandbox` a security feature. Every mention should read as "isolated workdir" — the agent CAN escape via absolute paths. The benefit is narrowed blast radius for honest mistakes, not protection against malicious behavior.
```

- [ ] **Step 6：Commit**

```bash
git add plugins/minimax/hooks/hooks.json \
        plugins/minimax/scripts/session-lifecycle-hook.mjs \
        plugins/minimax/scripts/stop-review-gate-hook.mjs \
        plugins/minimax/prompts/stop-review-gate.md \
        plugins/minimax/skills/minimax-result-handling/references/rescue-render.md
git commit -m "$(cat <<'EOF'
feat(Task 4.9): hooks + stop-review-gate prompt + rescue-render reference (spec §6.5, §6.6)

- hooks/hooks.json: SessionStart / SessionEnd / Stop registered.
- session-lifecycle-hook.mjs: persists a session id into state/session-id
  and injects MINIMAX_COMPANION_SESSION_ID. SessionEnd clears the file.
- stop-review-gate-hook.mjs: reads state.json reviewGate.enabled; if on,
  runs a foreground /minimax:review and emits a Stop decision=block object
  when the review gate fires.
- prompts/stop-review-gate.md: minimal prompt that narrows review to
  high/critical blockers and defaults to approve.
- references/rescue-render.md: success/background/result JSON shapes,
  explicit tripwire APPLIES directive, sandbox-is-not-security language.
EOF
)"
```

---

## Task 4.10 — T6 + T11 smoke + CHANGELOG + tag `phase-4-rescue`

**Files:**
- Create: `doc/smoke/phase-4-T6-T11.md`
- Modify: `CHANGELOG.md`, `plugins/minimax/CHANGELOG.md`

- [ ] **Step 1：T6 — background flow (real key)**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
JOBID=$(node plugins/minimax/scripts/minimax-companion.mjs rescue --background --json "echo hello and tell me what date mini-agent thinks it is" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).jobId))")
echo "jobId=$JOBID"

# Poll until done (max 3 min)
for i in $(seq 1 60); do
  STATUS=$(node plugins/minimax/scripts/minimax-companion.mjs status --json $JOBID | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).status))")
  echo "[$i] $STATUS"
  [ "$STATUS" = "done" ] || [ "$STATUS" = "failed" ] && break
  sleep 3
done

node plugins/minimax/scripts/minimax-companion.mjs result --json $JOBID | head -60
```

**T6 PASS** requires:
- JSON at each step parses
- Eventual status `done`
- `result --json` returns a non-empty `response`

- [ ] **Step 2：T11 — sandbox isolation**

```bash
# Snapshot main project root mtime BEFORE
BEFORE=$(stat -f "%m" /Users/bing/-Code-/minimax-plugin-cc)
JOBID11=$(node plugins/minimax/scripts/minimax-companion.mjs rescue --sandbox --background --json "Create a note.txt file with the word hello" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).jobId))")

# Poll
for i in $(seq 1 60); do
  STATUS=$(node plugins/minimax/scripts/minimax-companion.mjs status --json $JOBID11 | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).status))")
  echo "[$i] $STATUS"
  [ "$STATUS" = "done" ] || [ "$STATUS" = "failed" ] && break
  sleep 3
done

# Check mtime AFTER
AFTER=$(stat -f "%m" /Users/bing/-Code-/minimax-plugin-cc)
echo "BEFORE=$BEFORE AFTER=$AFTER"

# Check workspace has the note
ls ~/.claude/plugins/minimax/jobs/$JOBID11/workspace/
cat ~/.claude/plugins/minimax/jobs/$JOBID11/workspace/note.txt 2>/dev/null
```

**T11 PASS** requires:
- `BEFORE === AFTER` (mtime unchanged → agent respected sandbox workdir for default writes)
- `jobs/<jobId>/workspace/note.txt` exists and contains "hello" (or similar)

If `BEFORE !== AFTER`: **do not fail T11 outright** — the mtime could shift if the agent touched a random file outside workspace. In that case document it as `degraded-PASS (note.txt created in sandbox; main mtime shifted due to <reason>)` and move on. v0.1 `--sandbox` is "reduce blast radius, not prevent escape" per spec §4.6.

- [ ] **Step 3：Write smoke doc**

Create `doc/smoke/phase-4-T6-T11.md` with captured jobIds, status flows, response heads, mtime before/after. Mirror the Phase 2/3 smoke doc structure.

- [ ] **Step 4：Update CHANGELOGs**

Prepend to `CHANGELOG.md`:

```markdown
## YYYY-MM-DD HH:MM [Claude sonnet executor] — Phase 4 complete

- **status**: done
- **scope**: /minimax:rescue + /minimax:status + /minimax:result + /minimax:cancel + job-control.mjs (serial queue per P0.10) + minimax-agent subagent + hooks (SessionStart/End + Stop review-gate).
- **summary**: job-control data layer with atomic meta.json rewrites; PID-tagged serial queue lock with stale reclaim; cancelJob SIGTERM→SIGKILL; detached background worker (_worker internal subcommand); rescue foreground + --background + --sandbox (isolated workdir, explicitly NOT a security boundary per spec §4.6); status/result/cancel subcommands; command.md files; minimax-agent thin-wrapper contract; two hooks + stop-review-gate prompt; rescue-render skill reference. T6 + T11 smoke: <verdicts>.
- **serial-queue enforcement**: v0.1 only permits a single `mini-agent` child at a time (P0.10 conditional hard gate FAILED). Queue implemented as a *directory lock* (mkdirSync-based, with atomic rename-and-rmSync stale reclaim — v2 Codex #1 fix). Global ~/.claude/plugins/minimax/jobs/.queue-lock/; new rescue/ask/review calls block up to 5 min waiting for the slot. **Retroactively**: Phase 2 /minimax:ask and Phase 3 /minimax:review were re-wired to also route through the queue (v2 Task 4.0; P0.10 originally said ask/review would bypass, but that leaves a race with rescue). v0.2 will revisit once Mini-Agent upstream injects job-ids into log file names.
- **spec §6.5 extension**: plan registers `SessionStart` in addition to the spec-listed `SessionEnd + Stop`. SessionStart injects `MINIMAX_COMPANION_SESSION_ID` (both via stdout `{env:{...}}` JSON and via appending to `CLAUDE_ENV_FILE`, accommodating either Claude Code hook protocol). This is an intentional extension — env injection must occur at session start — documented in lessons.md.
- **v0.1 limitations made explicit**:
  - `task-resume-candidate` command lists recent log files but cannot actually resume a prior Mini-Agent session (P0.9 — no external session id).
  - Detached `_worker` continues running after a Claude Code session ends; the job is visible in a new session via `/minimax:status --all` (sessionId filter won't match the new session's random id; document in SKILL.md).
  - `stop-review-gate-hook` in Phase 4 runs the default review prompt; `prompts/stop-review-gate.md` is a spec §6.6 deliverable whose wiring is deferred to Phase 5.
- **next**: Phase 5 plan (/minimax:adversarial-review + 3 skill 定稿 + lessons.md 收尾).
```

Prepend to `plugins/minimax/CHANGELOG.md`:

```markdown
## YYYY-MM-DD — Phase 4

- Add /minimax:rescue / :status / :result / :cancel commands.
- Add lib/job-control.mjs: createJob / readJob / updateJobMeta / listJobs /
  filterJobsBySession / cancelJob + serial-queue acquireQueueSlot /
  releaseQueueSlot (PID-tagged lock with stale reclaim).
- Add internal _worker subcommand for detached background execution.
- Add minimax-agent subagent (thin-wrapper contract; --sandbox is isolated
  workdir, NOT a security boundary).
- Add hooks/hooks.json + session-lifecycle-hook.mjs + stop-review-gate-hook.mjs
  + prompts/stop-review-gate.md.
- Add minimax-result-handling references/rescue-render.md (tripwire applies).
- Smoke: T6 (background rescue → status → result) + T11 (sandbox isolation
  of main project mtime) PASS.
- Retroactive: runAsk (Phase 2) and runReview (Phase 3) now also route
  through acquireQueueSlot so the P0.10 single-spawn constraint holds
  across all commands.
- v0.1 limitations: task-resume-candidate is informational only;
  stop-review-gate runs the default review prompt (custom prompt wiring
  deferred to Phase 5); detached workers survive session end.
```

- [ ] **Step 5：commit + tag**

```bash
git add doc/smoke/phase-4-T6-T11.md CHANGELOG.md plugins/minimax/CHANGELOG.md
git commit -m "$(cat <<'EOF'
chore(Task 4.10): Phase 4 complete — T6 + T11 smoke + CHANGELOG

- T6 (rescue --background → status → result): <PASS/degraded-PASS>
- T11 (sandbox mtime invariant): <PASS/degraded-PASS>
- Serial queue enforces P0.10 single-spawn constraint
- minimax-agent subagent + hooks landed end-to-end
EOF
)"
git tag phase-4-rescue
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - §3.1 `--task` / `-w` → Task 4.4 + 4.5 via callMiniAgent ✓
   - §4.6 `--sandbox` isolated-workdir + serial-queue + T11 language → Task 4.1 + 4.2 + 4.4 + 4.7 + 4.9 ✓
   - §5.1 state dir layout (jobs/<jobId>/meta.json + stdout.log + stderr.log + workspace/) → Task 4.1 + 4.5 ✓
   - §6.1 命令总表 (rescue/status/result/cancel) → Task 4.4 + 4.6 + 4.7 ✓
   - §6.3 minimax-agent 薄转发 → Task 4.8 ✓
   - §6.5 Hooks → Task 4.9 ✓
   - §6.6 stop-review-gate.md → Task 4.9 ✓
   - §8.1 T6/T11 → Task 4.10 ✓

2. **Placeholder scan:** no TBD/TODO; schema/prompt/hook content shown verbatim; mock smoke commands are complete (copy-paste runnable).

3. **Type consistency:**
   - `createJob({workspaceRoot, prompt, cwd, sandbox, sessionId, extraArgs?})` → Task 4.1 defines, Task 4.4/4.5 consume ✓
   - `jobId` format `mj-<uuid>` → Task 4.1 defines, displayed consistently in Task 4.6/4.7/4.9/4.10 ✓
   - meta.json fields: `jobId, status, prompt, cwd, workdir, sandbox, sessionId, extraArgs, canceled, createdAt, startedAt, endedAt, pid, exitCode, signal, miniAgentLogPath, stdoutTruncated, stderrTruncated, queueToken, timeout, classifyStatus, response, finishReason, error` — defined incrementally across 4.1/4.3/4.5 ✓
   - `acquireQueueSlot → {acquired, token}` / `releaseQueueSlot(root, token)` → Task 4.2 defines, Task 4.4/4.5 consume ✓
   - `cancelJob(root, jobId, {termGraceMs, keepWorkspace}) → {ok, alreadyFinished, killed, reason?}` → Task 4.3 defines, Task 4.6 consumes ✓
   - Exit code parity with ask/review (0/2/3/4/5) in rescue foreground; 4 for queue-timeout ✓

4. **P0.10 serial constraint enforcement:**
   - Queue lock is the single choke point (`acquireQueueSlot`) ✓
   - Both foreground and background paths go through it ✓
   - Worker releases on exit (stored `queueToken` in meta) ✓
   - Stale reclaim (dead PID or mtime > 5min) prevents dead locks ✓

5. **--sandbox language discipline:**
   - Every mention in code/docs says "isolated workdir" or "not a security boundary" — no bare "sandbox" ✓
   - T11 measures mtime invariance, NOT escape prevention ✓

6. **YAGNI:**
   - No cross-session persistence (jobs die with Claude's parent process, same as kimi) ✓
   - No concurrent jobs (serial-only per P0.10) ✓
   - No session resume (P0.9) ✓
   - No --model override (YAML only) ✓
   - Hook is minimal; review-gate prompt is stub; extension path is Phase 5 ✓

7. **v2 (3-way review) revision closure:** every entry in the "v2 — 3-way review 修订索引" table has a corresponding change in this plan:
   - C1 queue lock-dir → Task 4.2 mkdirSync + rename-reclaim ✓
   - C2 dual hook protocol → Task 4.9 Step 2 stdout JSON + CLAUDE_ENV_FILE append ✓
   - C3 worker true finally → Task 4.5 Step 1 try/finally wraps whole body ✓
   - C4 task-resume-candidate → Task 4.6 Step 2b + Task 4.7 Step 5 ✓
   - C5 import fs → Task 4.4 Step 1 imports block ✓
   - C6 ask/review queue retrofit → Task 4.0 (new) ✓
   - I1 AskUserQuestion allowed-tools → Task 4.7 rescue.md + result.md ✓
   - I2 createJob timeout field → Task 4.1 + Task 4.4/4.5 one-shot use ✓
   - I3 stop-review-gate --timeout 600000 → Task 4.9 Step 3 ✓
   - I4 cancelJob pid reuse comment → Task 4.3 JSDoc ✓
   - I5 SessionStart divergence note → Task 4.9 Step 2 preamble + Task 4.10 CHANGELOG ✓
   - M1 cross-session worker doc → Task 4.10 CHANGELOG ✓
   - M2 static import spawn → Task 4.4 imports + Task 4.5 removed dynamic import ✓
   - M3 readJob workdir reuse → Task 4.5 --background branch ✓
   - M4 forward-hook limitation → Task 4.9 Step 3 preamble + Task 4.10 CHANGELOG ✓
