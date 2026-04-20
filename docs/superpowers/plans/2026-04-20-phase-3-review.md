# Phase 3 — `/minimax:review` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `/minimax:review` 全链路（schema + 强约束 prompt + `callMiniAgentReview` 包装器 + 1-shot JSON retry + 诊断包 + review-render 呈现规则），通过 T5 硬门。

**Architecture:**
`/minimax:review` 在 companion 里自取 `git diff`（默认 working-tree，可 `--base <ref>` / `--scope`） → 用 `prompts/review.md` 模板 + inline schema 构建强约束 prompt → `callMiniAgent` 拿 response → `extractReviewJson` 剥 code-fence + brace-balanced 扫描抠出首个完整 JSON 对象 → `validateReviewOutput` 按 schema（draft 2020-12，本地 validator，无第三方依赖）校验 → parse 或 validate 失败 → 1 次强化 retry（prompt 含错误提示 **+ 上一轮失败原文（脱敏后前 1500 字）**；**不**传 session id —— P0.9 Mini-Agent 无外部 session） → 最后失败就走诊断包（保留 `firstRawText` + `rawText` + stderrHeadTail，**所有原文字段入 bundle 前过 `redactSecrets`**）。

**Tech Stack:** Node.js ≥ 18，内置 `node:child_process.spawn`，Phase 2 已落地的 `callMiniAgent` + `classifyMiniAgentResult`，**不引 ajv/json-schema 依赖**（写极简的 draft 2020-12 子集 validator；kimi 也是这个做法）。

---

## v2 — 3-way review 修订索引

本 plan 经 Codex / Gemini / Claude 三家独立 review（2026-04-20）。下列条目是 v2 相对 v1 的改动，已**直接嵌入**下文对应 Task 的代码/步骤；此索引仅作 traceability：

| 来源 | 严重度 | 修订内容 | 落在 Task |
|---|---|---|---|
| Codex #1 | Critical | `reviewError.firstRawText/rawText` + companion text 输出的 raw-dump 全部经 `redactSecrets` | 3.4 + 3.5 |
| Codex #2 | Critical | `extractReviewJson` 改 brace-balanced 扫描（不是 `indexOf("{")..lastIndexOf("}")`） | 3.3 |
| Codex #3 | Critical | retry prompt 的 `{{RETRY_HINT}}` 块**回灌上次失败原文前 1500 字**（脱敏后），符合 spec §4.5 | 3.2 + 3.4 |
| Claude (spec) | Critical | 字段名：成功返回 `retry_used`（保留可读）但 **诊断包 JSON 字段名用 `retriedOnce`**（对齐 spec §4.5） | 3.4 + 3.5 |
| Codex #5 | Important | `collectDiff` staged 分支补 `status !== 0` 检查 | 3.5 |
| Codex #8 | Important | 所有 `new URL(import.meta.url).pathname` 改 `fileURLToPath(import.meta.url)`（Windows 不炸） | 3.3 + 3.5 |
| Gemini #5 | Important | `collectDiff` 先跑 `git ls-files --unmerged`，发现冲突即报错 `merge-conflict-present` | 3.5 |
| Codex #4 | Important | `callMiniAgentReview` 的 `truncated` 从 `classifyMiniAgentResult.status === "success-but-truncated"` 派生；补对应测试 | 3.4 |
| Gemini #2/#10 + Claude | Important | companion text 模式显示 `model` 字段（从 `readMiniAgentConfig`）；失败时额外打 `diagnostic.lastPartialResponseRaw` 前 1500 字；review 调 `callMiniAgent` 带 `onProgressLine` 到 stderr | 3.5 |
| Codex #6/#7 | Minor | 补测：`findings[].severity` enum 反例；空 fence（`` ```json\n\n``` ``） | 3.1 + 3.3 |
| Codex #9 | Minor | `buildReviewPrompt` 返回前 `trimEnd()` | 3.3 |
| Claude | Minor | 删掉 `REVIEW_STATUS_EXIT["ok"]: 0`（success 路径直接 `process.exit(0)`，不走映射） | 3.5 |
| Gemini #3 | Minor | `review-render.md` 加一句 "review 响应不携带 tool_calls —— 不适用 suspicious-bash tripwire" | 3.7 |
| Gemini #9 | Minor | Task 3.7 CHANGELOG 条目显式登记 schema 两处 minLength 收紧 + 提醒 Phase 5 作者 | 3.7 |

不采纳（3-way review 提过但不改的）：
- Gemini #4 prompt 强制 English — 保持 spec §6.2 + Phase 2 skill 的"保留原语言"纪律
- `disable-model-invocation: true` — 无功能影响，skip
- Codex #8 HTML fence 分支 — M2.7 实测无 HTML fence 倾向，YAGNI
- Extract raw dump 扩到 3000 字 — 1500 字 + JSON 模式全量足够；避免 stderr 噪声

## Prerequisites

- Phase 0/1/2 已完成（git tag `phase-2-ask`，12 Phase 2 commits）
- 必读：
  - `docs/superpowers/specs/2026-04-20-minimax-plugin-cc-design.md` §3.2（callMiniAgent API）、§4.5（诊断包契约）、§6.2（/minimax:review 要求）、§8.1（T5 硬门）
  - `plugins/minimax/skills/minimax-cli-runtime/SKILL.md` v0.1（尤其 "OpenAI 兼容 vs Anthropic 原生 finish_reason" —— 分类器已把两家 SUCCESS / TRUNCATED / INCOMPLETE 值都纳入）
- 对照参考（读，不 sed 不 cp；字节级通读后手写）：
  - `/Users/bing/-Code-/gemini-plugin-cc/plugins/gemini/schemas/review-output.schema.json`
  - `/Users/bing/-Code-/kimi-plugin-cc/plugins/kimi/scripts/lib/kimi.mjs`（`buildReviewPrompt` / `extractReviewJson` / `validateReviewOutput` / `callKimiReview` / `reviewError`）
  - `/Users/bing/-Code-/kimi-plugin-cc/plugins/kimi/commands/review.md`（命令分派风格）

## Scope & 硬门

本 Phase 通过：

| # | 动作 | 通过标准 |
|---|---|---|
| **T5** | `review --json` 对一段 3–5 行真实 diff（`plugins/minimax/scripts/lib/minimax.mjs` 新加一个简单函数变更即可作为 diff 源） | 输出是合法 JSON，schema 必填字段齐全：`verdict ∈ {approve, needs-attention}`、`summary` 非空、`findings` 数组（每项必填字段齐）、`next_steps` 数组。exit 0。第一次 parse 失败触发 1 次 retry 后仍成功也算 PASS（`retry_used: true`） |

**不做**（v0.1 明确排除）：
- 不做 GitHub PR 拉取 / 远端 diff 抓取（Phase 4+ 若需要）
- 不做多文件切分上下文管理（一次性 argv 传整个 diff；P0.4 argv 已确认可达 210KB+）
- 不引 ajv / any-json-schema-validator 依赖（手写极简 draft 2020-12 子集够本 schema 用）
- 不把 `--model` 暴露给 review 子命令（与 kimi/gemini 不同；Mini-Agent 不支持 CLI 换模型；v0.1 统一靠 YAML `model` 字段）
- 不做对抗性 review（Phase 5）
- 不做 retry session resumption（P0.9 无外部 session id；retry prompt 内联错误提示即可）

## File Structure

| 动作 | 路径 | 职责 |
|---|---|---|
| Create | `plugins/minimax/schemas/review-output.schema.json` | 手写 schema（draft 2020-12），通读 gemini 版本后字节级对齐 |
| Create | `plugins/minimax/prompts/review.md` | 基础 review prompt 模板（可插入 `{{SCHEMA_JSON}}` / `{{CONTEXT}}` / `{{FOCUS}}` / `{{RETRY_HINT}}` 占位） |
| Modify | `plugins/minimax/scripts/lib/minimax.mjs` | 新增 `buildReviewPrompt`、`extractReviewJson`、`validateReviewOutput`、`callMiniAgentReview`（导出） |
| Create | `plugins/minimax/scripts/lib/minimax.review.test.mjs` | review helper + 1-shot retry 单元测试；mock mini-agent 覆盖 success / malformed-JSON-then-recover / 双挂 |
| Modify | `plugins/minimax/scripts/minimax-companion.mjs` | 新增 `runReview` 子命令：自取 diff → 调 `callMiniAgentReview` → JSON/text 渲染 |
| Create | `plugins/minimax/commands/review.md` | Claude Code 斜杠命令（薄分派，呈现由 skill 主导） |
| Create | `plugins/minimax/skills/minimax-result-handling/references/review-render.md` | review 结果 Claude 呈现细则（严重性排序、verbatim、不自动修） |
| Create | `doc/smoke/phase-3-T5.md` | T5 smoke 留痕 |
| Modify | `CHANGELOG.md` 顶部 | Phase 3 完结条目 |
| Modify | `plugins/minimax/CHANGELOG.md` | 同上 |

**DRY**：
- Git diff 采集在 companion 内做（match kimi 模式），不让 Claude 在命令里跑 Bash(git:*) 再 pipe（降低 Claude 上下文负担 + 让命令自包含）
- Schema 校验用手写 validator，**不**重复 kimi.mjs 的实现 —— 写一个最小可用版本覆盖本 schema 用到的关键字（`type`/`required`/`enum`/`items`/`properties`/`minLength`/`minimum`/`maximum`）

**YAGNI**：
- 不做 `--resume` / session 续跑
- 不做异步并发 review 调度
- 不做 `--model` / `--temperature` 调参
- 不暴露 `--retry-max N`（恒为 1，spec §4.5）

---

## Task 3.1 — schemas/review-output.schema.json + `validateReviewOutput`

**Why first**：后续所有 review helper 都依赖 schema 存在 + 能加载。先定义契约，写完测试，再让 helper 依赖它。

**Files:**
- Create: `plugins/minimax/schemas/review-output.schema.json`
- Modify: `plugins/minimax/scripts/lib/minimax.mjs` — 新增 `validateReviewOutput(obj)` 及内部辅助函数
- Create: `plugins/minimax/scripts/lib/minimax.review.test.mjs`（本任务只填 validator 部分的 tests）

- [ ] **Step 1：创建 schemas 目录 + schema 文件**

```bash
mkdir -p /Users/bing/-Code-/minimax-plugin-cc/plugins/minimax/schemas
```

写 `plugins/minimax/schemas/review-output.schema.json`：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/minimax/review-output.schema.json",
  "type": "object",
  "required": ["verdict", "summary", "findings", "next_steps"],
  "properties": {
    "verdict": {
      "type": "string",
      "enum": ["approve", "needs-attention"],
      "description": "Overall review verdict"
    },
    "summary": {
      "type": "string",
      "minLength": 1,
      "description": "One-paragraph summary of the review"
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["severity", "title", "body", "file", "line_start", "line_end", "confidence", "recommendation"],
        "properties": {
          "severity": {
            "type": "string",
            "enum": ["critical", "high", "medium", "low"]
          },
          "title": { "type": "string", "minLength": 1 },
          "body":  { "type": "string", "minLength": 1 },
          "file":  { "type": "string", "minLength": 1 },
          "line_start": { "type": "integer", "minimum": 1 },
          "line_end":   { "type": "integer", "minimum": 1 },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
          "recommendation": { "type": "string", "minLength": 1 }
        }
      }
    },
    "next_steps": {
      "type": "array",
      "items": { "type": "string", "minLength": 1 }
    }
  }
}
```

与 gemini 版对齐的两处收紧（通读差异）：`findings.items.file` / `findings.items.recommendation` 均加了 `minLength: 1`（gemini 原版没限，但空串没诊断价值；手工放严符合 "prompt 更啰嗦强约束" 的 spec 总方向）。

- [ ] **Step 2：写 validator 失败测试**

新建 `plugins/minimax/scripts/lib/minimax.review.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateReviewOutput } from "./minimax.mjs";

const SCHEMA_PATH = path.resolve("plugins/minimax/schemas/review-output.schema.json");

function validOutput() {
  return {
    verdict: "approve",
    summary: "Looks fine.",
    findings: [
      {
        severity: "low",
        title: "minor nit",
        body: "trailing whitespace",
        file: "src/a.js",
        line_start: 10,
        line_end: 10,
        confidence: 0.7,
        recommendation: "trim it",
      },
    ],
    next_steps: ["ship it"],
  };
}

test("validateReviewOutput: happy path passes", () => {
  const r = validateReviewOutput(validOutput(), SCHEMA_PATH);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("validateReviewOutput: missing top-level required key", () => {
  const o = validOutput();
  delete o.verdict;
  const r = validateReviewOutput(o, SCHEMA_PATH);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("verdict")), `errors=${JSON.stringify(r.errors)}`);
});

test("validateReviewOutput: enum violation on verdict", () => {
  const o = validOutput();
  o.verdict = "maybe";
  const r = validateReviewOutput(o, SCHEMA_PATH);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /verdict/.test(e) && /enum/.test(e)));
});

test("validateReviewOutput: nested finding missing body", () => {
  const o = validOutput();
  delete o.findings[0].body;
  const r = validateReviewOutput(o, SCHEMA_PATH);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("findings") && e.includes("body")));
});

test("validateReviewOutput: confidence out of range", () => {
  const o = validOutput();
  o.findings[0].confidence = 1.5;
  const r = validateReviewOutput(o, SCHEMA_PATH);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /confidence/.test(e)));
});

test("validateReviewOutput: line_start < 1", () => {
  const o = validOutput();
  o.findings[0].line_start = 0;
  const r = validateReviewOutput(o, SCHEMA_PATH);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /line_start/.test(e)));
});

test("validateReviewOutput: next_steps must be array of non-empty strings", () => {
  const o = validOutput();
  o.next_steps = [""];
  const r = validateReviewOutput(o, SCHEMA_PATH);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /next_steps/.test(e) && /minLength/.test(e)));
});

test("validateReviewOutput: empty findings array is OK", () => {
  const o = validOutput();
  o.findings = [];
  const r = validateReviewOutput(o, SCHEMA_PATH);
  assert.equal(r.ok, true);
});

test("validateReviewOutput: verdict wrong type", () => {
  const o = validOutput();
  o.verdict = 42;
  const r = validateReviewOutput(o, SCHEMA_PATH);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /verdict/.test(e) && /type/.test(e)));
});

test("validateReviewOutput: nested finding.severity enum violation (v2 — Codex #6)", () => {
  const o = validOutput();
  o.findings[0].severity = "catastrophic"; // not in enum
  const r = validateReviewOutput(o, SCHEMA_PATH);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /severity/.test(e) && /enum/.test(e)));
});
```

Total validator tests: **10** (was 9). Adjust any downstream counts accordingly.

- [ ] **Step 3：跑测试确认失败**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
node --test plugins/minimax/scripts/lib/minimax.review.test.mjs
```

Expected: 10 tests FAIL (`validateReviewOutput is not exported`).

- [ ] **Step 4：实现 validator**

在 `plugins/minimax/scripts/lib/minimax.mjs` 的文件末尾（所有现有 export 之后）插入：

```js
// ── Review output validator (Phase 3 Task 3.1) ──────────────────────────────
// Hand-rolled draft 2020-12 subset — covers only the keywords used by
// plugins/minimax/schemas/review-output.schema.json:
//   type / required / enum / items / properties / minLength / minimum / maximum
// Intentionally NOT a general-purpose validator. Adding deps (ajv etc.) would
// inflate install footprint for a single schema.

let _schemaCache = new Map();

function loadSchema(schemaPath) {
  if (_schemaCache.has(schemaPath)) return _schemaCache.get(schemaPath);
  const text = fs.readFileSync(schemaPath, "utf8");
  const schema = JSON.parse(text);
  _schemaCache.set(schemaPath, schema);
  return schema;
}

export function _invalidateSchemaCache() { _schemaCache = new Map(); }

function typeMatches(value, expected) {
  if (expected === "integer") return Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && !Number.isNaN(value);
  if (expected === "string") return typeof value === "string";
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return value && typeof value === "object" && !Array.isArray(value);
  if (expected === "boolean") return typeof value === "boolean";
  if (expected === "null") return value === null;
  return false;
}

function validateNode(value, node, pathParts, errors) {
  const pathStr = pathParts.length === 0 ? "(root)" : pathParts.join(".");

  if (node.type) {
    if (!typeMatches(value, node.type)) {
      errors.push(`${pathStr}: type expected ${node.type}, got ${Array.isArray(value) ? "array" : typeof value}`);
      return; // type failure cascades; further checks meaningless
    }
  }

  if (node.enum && !node.enum.includes(value)) {
    errors.push(`${pathStr}: enum violation (got ${JSON.stringify(value)}; allowed ${JSON.stringify(node.enum)})`);
  }

  if (node.type === "string") {
    if (typeof node.minLength === "number" && value.length < node.minLength) {
      errors.push(`${pathStr}: minLength ${node.minLength} not met (got length ${value.length})`);
    }
  }

  if (node.type === "integer" || node.type === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) {
      errors.push(`${pathStr}: minimum ${node.minimum} not met (got ${value})`);
    }
    if (typeof node.maximum === "number" && value > node.maximum) {
      errors.push(`${pathStr}: maximum ${node.maximum} exceeded (got ${value})`);
    }
  }

  if (node.type === "object") {
    if (Array.isArray(node.required)) {
      for (const key of node.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push(`${pathStr === "(root)" ? key : pathStr + "." + key}: required key missing`);
        }
      }
    }
    if (node.properties) {
      for (const [key, sub] of Object.entries(node.properties)) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          validateNode(value[key], sub, [...pathParts, key], errors);
        }
      }
    }
  }

  if (node.type === "array" && node.items) {
    for (let i = 0; i < value.length; i++) {
      validateNode(value[i], node.items, [...pathParts, `[${i}]`], errors);
    }
  }
}

export function validateReviewOutput(data, schemaPath) {
  const errors = [];
  let schema;
  try {
    schema = loadSchema(schemaPath);
  } catch (err) {
    return { ok: false, errors: [`schema-load: ${err.code || err.message}`] };
  }
  validateNode(data, schema, [], errors);
  return { ok: errors.length === 0, errors };
}
```

Note: `fs` 已在 minimax.mjs 顶部 import；无需新增。

- [ ] **Step 5：跑测试确认全通过**

```bash
node --test plugins/minimax/scripts/lib/minimax.review.test.mjs
```

Expected: 10 tests PASS.

跑完整套件确认无回归：
```bash
node --test plugins/minimax/scripts/lib/*.test.mjs
```
Expected: 已有 73 + 10 新增，共 83 pass，0 fail.

- [ ] **Step 6：Commit**

```bash
git add plugins/minimax/schemas/review-output.schema.json plugins/minimax/scripts/lib/minimax.mjs plugins/minimax/scripts/lib/minimax.review.test.mjs
git commit -m "$(cat <<'EOF'
feat(Task 3.1): review-output schema + validateReviewOutput (spec §6.2)

- schemas/review-output.schema.json (draft 2020-12, aligned with gemini version
  with two minLength tightenings on file / recommendation)
- validateReviewOutput(data, schemaPath): hand-rolled subset validator
  covering type/required/enum/items/properties/minLength/minimum/maximum
  — no ajv dependency (YAGNI for single-schema use)
- Module-level schema cache + _invalidateSchemaCache test helper
- 9 validator tests covering happy path + 8 failure modes
EOF
)"
```

---

## Task 3.2 — prompts/review.md

**Why**：prompt 模板独立成文件，让 `buildReviewPrompt` 只做占位符替换，方便迭代措辞而不改 JS。

**Files:**
- Create: `plugins/minimax/prompts/review.md`

- [ ] **Step 1：创建 prompts 目录 + 文件**

```bash
mkdir -p /Users/bing/-Code-/minimax-plugin-cc/plugins/minimax/prompts
```

写 `plugins/minimax/prompts/review.md` —— 完整内容如下（**不要**加任何 emoji，项目约定）：

```markdown
You are a senior code reviewer. Review the supplied diff and produce a review as a single JSON object that conforms exactly to the schema below.

# Output contract

- Respond with RAW JSON ONLY. No prose before or after. No markdown code fences. No apologies. No thinking out loud.
- The JSON must be a single object matching the schema.
- If you need to express uncertainty, use the `confidence` field on individual findings (range 0..1). Do NOT wrap the object in extra keys.
- Do NOT invent file paths or line numbers. Only cite lines that appear in the supplied diff context.

# Schema

```json
{{SCHEMA_JSON}}
```

# Verdict rubric

- `approve` — no critical or high-severity findings; changes are safe to merge.
- `needs-attention` — at least one finding at severity `high` or `critical`, OR multiple `medium` findings on unrelated concerns. When in doubt between `approve` and `needs-attention`, choose `needs-attention`.

# Severity rubric

- `critical` — security vulnerability, data loss risk, or a crash on common paths.
- `high` — correctness bug under realistic inputs, or breaks an invariant the surrounding code relies on.
- `medium` — maintainability / clarity problems that will bite future changes; test gap on a logic branch.
- `low` — nits (naming, micro-style, dead comments) that don't change behavior.

Pick the lowest severity that still motivates a fix. Reserve `critical` for real safety issues, not style preferences.

# Finding shape

Each `findings[]` entry MUST include all of: `severity`, `title`, `body`, `file`, `line_start`, `line_end`, `confidence`, `recommendation`.

- `title` — one short sentence stating the defect.
- `body` — 1–3 sentences explaining WHY it is a defect.
- `file` — repo-root-relative path as it appears in the diff header.
- `line_start` / `line_end` — line numbers from the NEW side of the hunk. Single-line issue uses equal start and end.
- `confidence` — 0..1, honest self-assessment. Use 0.9+ only for defects you're sure about.
- `recommendation` — concrete action the author should take. No "consider reviewing this further". Be specific.

# Next steps

`next_steps` is a list of 0–5 concrete actions ordered by priority. These are orthogonal to `findings` (e.g. "add a regression test", "run the linter", "update the CHANGELOG"). Empty list is allowed when the diff is trivial.

# Focus

{{FOCUS}}

# Diff to review

```
{{CONTEXT}}
```

{{RETRY_HINT}}
```

**Note on retry hint placement (v2 — Codex #3, §4.5 compliance)**: The final `{{RETRY_HINT}}` placeholder is empty on first-shot and, on retry, expands to a block like:

```
# Retry note

Your previous response failed validation: <error string>. Output RAW JSON ONLY matching the schema above — no code fences, no preamble.

## Previous response (verbatim, first 1500 chars, secrets redacted)

<redacted raw text from the failed first shot>
```

`buildReviewPrompt` handles the expansion/emptying. It accepts a second optional string `previousRaw` that (a) runs through `redactSecrets`, (b) is truncated to 1500 chars, (c) is embedded under the "## Previous response" heading. **If `previousRaw` is empty or absent, the "Previous response" heading is omitted entirely** (don't leave a dangling heading).

After substitution, `buildReviewPrompt` calls `trimEnd()` on the final string to avoid trailing whitespace noise (Codex suggestion #9).

- [ ] **Step 2：sanity check + commit**

```bash
wc -l /Users/bing/-Code-/minimax-plugin-cc/plugins/minimax/prompts/review.md
head -10 /Users/bing/-Code-/minimax-plugin-cc/plugins/minimax/prompts/review.md
# scan for emoji
rg -n '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' /Users/bing/-Code-/minimax-plugin-cc/plugins/minimax/prompts/review.md || echo "clean"
```

Expected: ~55+ lines; `clean`.

```bash
git add plugins/minimax/prompts/review.md
git commit -m "$(cat <<'EOF'
feat(Task 3.2): prompts/review.md — strict JSON-only review template (spec §6.2)

- Output contract: raw JSON only, no prose, no code fences
- Verdict + severity rubrics with explicit "when in doubt" guidance
- Finding shape spells out all 8 required keys with semantic hints
- Placeholders: {{SCHEMA_JSON}}, {{FOCUS}}, {{CONTEXT}}, {{RETRY_HINT}}
- No emoji (project convention)
EOF
)"
```

---

## Task 3.3 — `buildReviewPrompt` + `extractReviewJson` + tests

**Why**：两个纯函数负责把模板 + schema + 上下文拼成 prompt，以及从模型回复里稳健地抽出 JSON 对象（去 code fence / 容忍前后 prose）。这两个 sit 在 `callMiniAgentReview` 下面，测试隔离。

**Files:**
- Modify: `plugins/minimax/scripts/lib/minimax.mjs` — 新增两个 exported helper
- Modify: `plugins/minimax/scripts/lib/minimax.review.test.mjs` — 追加 tests

- [ ] **Step 1：写失败测试**

在 `plugins/minimax/scripts/lib/minimax.review.test.mjs` 末尾追加：

```js
import { buildReviewPrompt, extractReviewJson } from "./minimax.mjs";

test("buildReviewPrompt: inlines schema + focus + context, no retry hint first-shot", () => {
  const prompt = buildReviewPrompt({
    schemaPath: SCHEMA_PATH,
    focus: "Check for auth leaks.",
    context: "diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n",
  });
  assert.ok(prompt.includes('"type": "object"'), "schema inlined");
  assert.ok(prompt.includes("Check for auth leaks."), "focus inlined");
  assert.ok(prompt.includes("+new"), "context inlined");
  assert.ok(!prompt.includes("Retry note"), "no retry hint on first shot");
  assert.ok(!prompt.includes("{{SCHEMA_JSON}}"), "no unreplaced placeholders");
  assert.ok(!prompt.includes("{{FOCUS}}"));
  assert.ok(!prompt.includes("{{CONTEXT}}"));
  assert.ok(!prompt.includes("{{RETRY_HINT}}"));
});

test("buildReviewPrompt: retry hint expands when retryHint provided", () => {
  const prompt = buildReviewPrompt({
    schemaPath: SCHEMA_PATH,
    focus: "x",
    context: "y",
    retryHint: "missing key: verdict",
  });
  assert.ok(prompt.includes("# Retry note"));
  assert.ok(prompt.includes("missing key: verdict"));
});

test("buildReviewPrompt: empty focus renders as literal '(no additional focus provided)'", () => {
  const prompt = buildReviewPrompt({
    schemaPath: SCHEMA_PATH,
    focus: "",
    context: "x",
  });
  assert.ok(prompt.includes("(no additional focus provided)"));
});

test("buildReviewPrompt: throws on unreadable schema path", () => {
  assert.throws(
    () => buildReviewPrompt({ schemaPath: "/no/such/file.json", focus: "", context: "" }),
    /schema-load|ENOENT/
  );
});

test("extractReviewJson: raw JSON object", () => {
  const raw = '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}';
  const r = extractReviewJson(raw);
  assert.equal(r.ok, true);
  assert.equal(r.data.verdict, "approve");
});

test("extractReviewJson: fenced with ```json", () => {
  const raw = "```json\n{\"verdict\":\"approve\",\"summary\":\"ok\",\"findings\":[],\"next_steps\":[]}\n```";
  const r = extractReviewJson(raw);
  assert.equal(r.ok, true);
  assert.equal(r.data.verdict, "approve");
});

test("extractReviewJson: fenced without language tag", () => {
  const raw = "```\n{\"verdict\":\"needs-attention\",\"summary\":\"x\",\"findings\":[],\"next_steps\":[]}\n```";
  const r = extractReviewJson(raw);
  assert.equal(r.ok, true);
  assert.equal(r.data.verdict, "needs-attention");
});

test("extractReviewJson: prose before + raw object after", () => {
  const raw = 'Here is the review:\n{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}';
  const r = extractReviewJson(raw);
  assert.equal(r.ok, true);
  assert.equal(r.data.verdict, "approve");
});

test("extractReviewJson: malformed JSON returns parse error", () => {
  const raw = '{"verdict":"approve", invalid}';
  const r = extractReviewJson(raw);
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.ok(r.parseError);
});

test("extractReviewJson: no JSON at all", () => {
  const r = extractReviewJson("I'm not going to answer that.");
  assert.equal(r.ok, false);
  assert.match(r.error, /no-json-found/);
});

test("extractReviewJson: empty fence yields parse error (v2 — Codex #7)", () => {
  const raw = "```json\n\n```";
  const r = extractReviewJson(raw);
  assert.equal(r.ok, false);
});

test("extractReviewJson: two JSON objects in a row — returns the first complete one (v2 — Codex #2)", () => {
  // Model sometimes emits reasoning JSON before the answer JSON.
  const raw = '{"thinking":"let me review"}\n\n{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}';
  const r = extractReviewJson(raw);
  assert.equal(r.ok, true);
  assert.equal(r.data.thinking, "let me review", "brace-balanced scan returns FIRST complete object");
});

test("buildReviewPrompt: previousRaw injected under heading, redacted, capped at 1500 chars (v2 — Codex #3)", () => {
  const prompt = buildReviewPrompt({
    schemaPath: SCHEMA_PATH,
    focus: "x",
    context: "y",
    retryHint: "schema error: verdict missing",
    previousRaw: "Before my real answer, here's the key: sk-abc12345678901234567890 — then I gave up.",
  });
  assert.ok(prompt.includes("# Retry note"));
  assert.ok(prompt.includes("schema error: verdict missing"));
  assert.ok(prompt.includes("## Previous response"));
  assert.ok(prompt.includes("sk-***REDACTED***"), "api key redacted");
  assert.ok(!prompt.includes("sk-abc12345678901234567890"), "raw key not present");
});

test("buildReviewPrompt: no previousRaw means no 'Previous response' heading (v2)", () => {
  const prompt = buildReviewPrompt({
    schemaPath: SCHEMA_PATH, focus: "x", context: "y",
    retryHint: "some hint",
  });
  assert.ok(prompt.includes("# Retry note"));
  assert.ok(!prompt.includes("## Previous response"));
});
```

Total Task 3.3 tests: **15** (10 originals + 5 v2 additions).

- [ ] **Step 2：跑确认失败**

```bash
node --test plugins/minimax/scripts/lib/minimax.review.test.mjs
```

Expected: 15 new tests FAIL (imports missing; v2 added 5 extra coverage cases).

- [ ] **Step 3：实现两个 helper**

在 `plugins/minimax/scripts/lib/minimax.mjs` 末尾（`validateReviewOutput` 之后）追加：

```js
// ── Review prompt builder + JSON extractor (Phase 3 Task 3.3; v2 revised) ───

import { fileURLToPath } from "node:url";

const REVIEW_PROMPT_PATH = path.resolve(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts", "review.md")
);

let _reviewTemplateCache = null;

function loadReviewTemplate() {
  if (_reviewTemplateCache !== null) return _reviewTemplateCache;
  _reviewTemplateCache = fs.readFileSync(REVIEW_PROMPT_PATH, "utf8");
  return _reviewTemplateCache;
}

export function _invalidateReviewTemplateCache() { _reviewTemplateCache = null; }

/**
 * Build the review prompt by substituting placeholders in prompts/review.md.
 *
 * @param {object} opts
 * @param {string} opts.schemaPath   — absolute path to the review schema JSON
 * @param {string} opts.focus        — user-provided focus hint (may be empty)
 * @param {string} opts.context      — full diff text
 * @param {string} [opts.retryHint]  — if non-empty, render a "# Retry note" block
 * @param {string} [opts.previousRaw]— v2 (Codex #3): prior failed response to echo
 *                                     back into the retry prompt (redacted, capped 1500)
 * @returns {string}
 */
export function buildReviewPrompt({ schemaPath, focus, context, retryHint, previousRaw }) {
  const schemaText = fs.readFileSync(schemaPath, "utf8");
  const template = loadReviewTemplate();
  const focusRendered = (focus && focus.trim()) ? focus : "(no additional focus provided)";

  let retryBlock = "";
  if (retryHint && retryHint.trim()) {
    const lines = [
      "# Retry note",
      "",
      `Your previous response failed validation: ${retryHint}. Output RAW JSON ONLY matching the schema above — no code fences, no preamble.`,
    ];
    if (previousRaw && previousRaw.trim()) {
      const redacted = redactSecrets(String(previousRaw)).slice(0, 1500);
      lines.push("");
      lines.push("## Previous response (verbatim, first 1500 chars, secrets redacted)");
      lines.push("");
      lines.push(redacted);
    }
    retryBlock = lines.join("\n");
  }

  const result = template
    .replace("{{SCHEMA_JSON}}", schemaText)
    .replace("{{FOCUS}}", focusRendered)
    .replace("{{CONTEXT}}", context)
    .replace("{{RETRY_HINT}}", retryBlock);
  return result.trimEnd();  // v2 — Codex #9
}

/**
 * Pull a JSON object out of an assistant response that may include code fences
 * or surrounding prose. Returns `{ok, data}` or `{ok:false, error, parseError?}`.
 *
 * v2 (Codex #2): the raw-slice branch now uses a brace-balanced scanner that
 * returns the FIRST COMPLETE JSON object, not the span from first `{` to last `}`
 * (which would fuse separate objects if the model emitted reasoning then answer).
 */
export function extractReviewJson(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "empty-response" };
  }

  const trimmed = raw.trim();

  // Case 1: fenced block ```[json]? ... ```
  const fenceMatch = trimmed.match(/```(?:json|JSON)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    if (!inner) return { ok: false, error: "fenced-empty", parseError: null };
    try {
      return { ok: true, data: JSON.parse(inner) };
    } catch (e) {
      return { ok: false, error: "fenced-parse-failed", parseError: e.message };
    }
  }

  // Case 2: brace-balanced scan — find FIRST complete top-level { ... } object.
  // Skip string contents (handle \\" escapes) so braces inside strings don't count.
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = trimmed.slice(start, i + 1);
        try {
          return { ok: true, data: JSON.parse(candidate) };
        } catch (e) {
          return { ok: false, error: "raw-parse-failed", parseError: e.message };
        }
      }
    }
  }

  return { ok: false, error: "no-json-found" };
}
```

Note the `REVIEW_PROMPT_PATH` derivation — it goes from `<repo>/plugins/minimax/scripts/lib/minimax.mjs` → up two dirs → `/prompts/review.md`. Double-check by reading the actual file location after the first failed test.

- [ ] **Step 4：跑测试确认全通过 + 无回归**

```bash
node --test plugins/minimax/scripts/lib/minimax.review.test.mjs
node --test plugins/minimax/scripts/lib/*.test.mjs
```

Expected: 15 new pass (Task 3.3 total 25 review-specific so far: 10 validator + 15 builder/extractor); overall project 83+15 = 98; 0 fail.

- [ ] **Step 5：Commit**

```bash
git add plugins/minimax/scripts/lib/minimax.mjs plugins/minimax/scripts/lib/minimax.review.test.mjs
git commit -m "$(cat <<'EOF'
feat(Task 3.3): buildReviewPrompt + extractReviewJson (spec §6.2)

- buildReviewPrompt: template substitution; empty focus -> literal fallback;
  retryHint -> "# Retry note" block; schema inlined from schemaPath
- extractReviewJson: tries fenced ```json``` first, then raw { ... } slice;
  returns {ok, data} or {ok:false, error, parseError?}
- 10 unit tests: happy path, fenced (tagged/untagged), prose-prefix, malformed,
  no-json, retry hint expansion, empty focus fallback, unreadable schema throw
- Module cache for the template (invalidatable via _invalidateReviewTemplateCache)
EOF
)"
```

---

## Task 3.4 — `callMiniAgentReview` with 1-shot retry

**Why**：这是 Phase 3 的主要业务逻辑 —— 把 `callMiniAgent` + extract + validate + 可选 retry 串起来，返回统一的成功对象或 `reviewError` 诊断包。

**Files:**
- Modify: `plugins/minimax/scripts/lib/minimax.mjs` — 新增 `callMiniAgentReview` + 内部 `reviewError` helper
- Modify: `plugins/minimax/scripts/lib/minimax.review.test.mjs` — 追加集成测试（mock mini-agent 控制 response）

- [ ] **Step 1：写失败测试**

追加到 `plugins/minimax/scripts/lib/minimax.review.test.mjs`：

```js
import os from "node:os";
import { callMiniAgentReview } from "./minimax.mjs";

function mkMockMiniAgentForReview(logBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-review-mock-"));
  const logDir = path.join(dir, "log");
  fs.mkdirSync(logDir);
  const logPath = path.join(logDir, "agent_run_20260420_200000.log");
  fs.writeFileSync(logPath, buildReviewLog(logBody));
  const binPath = path.join(dir, "mini-agent");
  fs.writeFileSync(binPath, `#!/bin/sh
printf 'Log file: ${logPath}\n'
printf 'Session Statistics:\n'
exit 0
`, { mode: 0o755 });
  return { binPath, logDir, logPath };
}

function mkStatefulMockForReview(logBodies) {
  // Supports exactly 2 spawns (first + retry). Uses a counter file on disk.
  // Kept simple (if/else) to run under plain /bin/sh — no bash arrays.
  if (logBodies.length !== 2) throw new Error("mkStatefulMockForReview: expected exactly 2 logBodies (first + retry)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-review-retry-"));
  const logDir = path.join(dir, "log");
  fs.mkdirSync(logDir);
  const counterFile = path.join(dir, "counter");
  fs.writeFileSync(counterFile, "0");
  const logPath0 = path.join(logDir, "agent_run_20260420_200000.log");
  const logPath1 = path.join(logDir, "agent_run_20260420_200010.log");
  fs.writeFileSync(logPath0, buildReviewLog(logBodies[0]));
  fs.writeFileSync(logPath1, buildReviewLog(logBodies[1]));
  const binPath = path.join(dir, "mini-agent");
  fs.writeFileSync(binPath, `#!/bin/sh
n=$(cat '${counterFile}')
n=$((n+1))
echo "$n" > '${counterFile}'
if [ "$n" = "1" ]; then
  printf 'Log file: ${logPath0}\\n'
else
  printf 'Log file: ${logPath1}\\n'
fi
printf 'Session Statistics:\\n'
exit 0
`, { mode: 0o755 });
  return { binPath, logDir, counterFile };
}

function buildReviewLog({ content, finishReason = "end_turn" }) {
  const body = JSON.stringify({ content, thinking: null, tool_calls: [], finish_reason: finishReason });
  return [
    "=".repeat(80),
    "Agent Run Log - 2026-04-20 20:00:00",
    "=".repeat(80),
    "",
    "-".repeat(80),
    "[1] REQUEST",
    "Timestamp: 2026-04-20 20:00:01.000",
    "-".repeat(80),
    "{}",
    "",
    "-".repeat(80),
    "[2] RESPONSE",
    "Timestamp: 2026-04-20 20:00:05.000",
    "-".repeat(80),
    "",
    body,
    "",
  ].join("\n");
}

test("callMiniAgentReview: happy path returns validated review", async () => {
  const validJson = JSON.stringify({
    verdict: "approve",
    summary: "ok",
    findings: [],
    next_steps: [],
  });
  const { binPath, logDir } = mkMockMiniAgentForReview({ content: validJson });

  const r = await callMiniAgentReview({
    context: "diff --git a/x b/x\n+new line",
    focus: "check anything",
    schemaPath: SCHEMA_PATH,
    cwd: process.cwd(),
    timeout: 20_000,
    bin: binPath,
    logDir,
  });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, "approve");
  assert.equal(r.retry_used, false);
  assert.equal(r.findings.length, 0);
});

test("callMiniAgentReview: first-shot malformed -> retry succeeds", async () => {
  const validJson = JSON.stringify({
    verdict: "needs-attention",
    summary: "x",
    findings: [],
    next_steps: ["test"],
  });
  const { binPath, logDir } = mkStatefulMockForReview([
    { content: "here's my review: { malformed json }" },
    { content: validJson },
  ]);

  const r = await callMiniAgentReview({
    context: "diff", focus: "f", schemaPath: SCHEMA_PATH,
    cwd: process.cwd(), timeout: 30_000, bin: binPath, logDir,
  });
  assert.equal(r.ok, true);
  assert.equal(r.retry_used, true);
  assert.equal(r.verdict, "needs-attention");
  assert.ok(r.retry_notice, "retry_notice message is populated");
});

test("callMiniAgentReview: first-shot validates but missing required -> retry", async () => {
  const missingVerdict = JSON.stringify({
    summary: "x", findings: [], next_steps: [],
  });
  const validJson = JSON.stringify({
    verdict: "approve", summary: "ok", findings: [], next_steps: [],
  });
  const { binPath, logDir } = mkStatefulMockForReview([
    { content: missingVerdict },
    { content: validJson },
  ]);

  const r = await callMiniAgentReview({
    context: "d", focus: "f", schemaPath: SCHEMA_PATH,
    cwd: process.cwd(), timeout: 30_000, bin: binPath, logDir,
  });
  assert.equal(r.ok, true);
  assert.equal(r.retry_used, true);
  assert.equal(r.verdict, "approve");
});

test("callMiniAgentReview: both shots fail -> reviewError with both raw texts", async () => {
  const { binPath, logDir } = mkStatefulMockForReview([
    { content: "nope 1" },
    { content: "nope 2" },
  ]);

  const r = await callMiniAgentReview({
    context: "d", focus: "f", schemaPath: SCHEMA_PATH,
    cwd: process.cwd(), timeout: 30_000, bin: binPath, logDir,
  });
  assert.equal(r.ok, false);
  assert.equal(r.retry_used, true);
  assert.ok(r.firstRawText.includes("nope 1"));
  assert.ok(r.rawText.includes("nope 2"));
  assert.ok(r.error);
});

test("callMiniAgentReview: callMiniAgent transport error -> reviewError, no retry", async () => {
  const r = await callMiniAgentReview({
    context: "d", focus: "f", schemaPath: SCHEMA_PATH,
    cwd: process.cwd(), timeout: 5_000,
    bin: "/nonexistent/mini-agent-xxx",
    logDir: fs.mkdtempSync(path.join(os.tmpdir(), "minimax-review-nocall-")),
  });
  assert.equal(r.ok, false);
  assert.equal(r.retry_used, false);
  assert.equal(r.retriedOnce, false, "v2 alias for spec §4.5");
  assert.ok(r.diagnostic, "diagnostic bundle present");
  assert.equal(r.diagnostic.status, "not-installed");
});

test("callMiniAgentReview: truncated derived from classifier (v2 — Codex #4)", async () => {
  // Build a log with finish_reason=length so classifier returns success-but-truncated.
  const validJson = JSON.stringify({
    verdict: "approve", summary: "ok", findings: [], next_steps: [],
  });
  // buildReviewLog signature: ({content, finishReason})
  const { binPath, logDir } = (function makeLengthMock() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-trunc-"));
    const logDir_ = path.join(dir, "log"); fs.mkdirSync(logDir_);
    const lp = path.join(logDir_, "agent_run_20260420_200030.log");
    fs.writeFileSync(lp, buildReviewLog({ content: validJson, finishReason: "length" }));
    const bp = path.join(dir, "mini-agent");
    fs.writeFileSync(bp, `#!/bin/sh\nprintf 'Log file: ${lp}\\n'\nprintf 'Session Statistics:\\n'\nexit 0\n`, { mode: 0o755 });
    return { binPath: bp, logDir: logDir_ };
  })();

  const r = await callMiniAgentReview({
    context: "d", focus: "f", schemaPath: SCHEMA_PATH,
    cwd: process.cwd(), timeout: 15_000, bin: binPath, logDir,
  });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true, "classifier success-but-truncated propagated into review result");
});

test("callMiniAgentReview: reviewError raw texts are redacted (v2 — Codex #1)", async () => {
  const jwtish = "eyJ" + "A".repeat(80);
  const { binPath, logDir } = mkStatefulMockForReview([
    { content: `I found a key: ${jwtish} — here's my malformed response { broken` },
    { content: "still broken { broken" },
  ]);

  const r = await callMiniAgentReview({
    context: "d", focus: "f", schemaPath: SCHEMA_PATH,
    cwd: process.cwd(), timeout: 30_000, bin: binPath, logDir,
  });
  assert.equal(r.ok, false);
  assert.ok(r.firstRawText.includes("eyJ***REDACTED***"), `firstRawText redacted; got ${r.firstRawText.slice(0,200)}`);
  assert.ok(!r.firstRawText.includes(jwtish), "raw JWT absent");
});
```

Total Task 3.4 tests: **8** (5 original + 3 v2 additions).

- [ ] **Step 2：跑确认失败**

```bash
node --test plugins/minimax/scripts/lib/minimax.review.test.mjs
```

Expected: 8 new tests FAIL (v2 added 3 extra: retriedOnce alias assertion in existing test + truncated + redaction).

- [ ] **Step 3：实现 `callMiniAgentReview`**

在 `plugins/minimax/scripts/lib/minimax.mjs` 末尾（extractReviewJson 之后）追加：

```js
// ── callMiniAgentReview: review-specific wrapper + 1-shot retry (Task 3.4) ──
// v2 revisions: firstRawText/rawText redacted on the way in; truncated derived
// from classifier; retriedOnce alias added; retry prompt carries the previous
// failed response text (redacted, first 1500 chars).

function reviewError({ error, firstRawText = null, rawText = null, parseError = null, truncated = false, retry_used = false, diagnostic = null }) {
  return {
    ok: false,
    error,
    // v2 (Codex #1): raw texts always run through redactSecrets before surfacing
    firstRawText: firstRawText ? redactSecrets(String(firstRawText)) : null,
    rawText: rawText ? redactSecrets(String(rawText)) : null,
    parseError,
    truncated,
    retry_used,
    retriedOnce: retry_used,  // v2 (Claude spec review): spec §4.5 alias
    diagnostic,
  };
}

/**
 * Run a review: build prompt -> callMiniAgent -> extract JSON -> validate.
 * On parse/validation failure, retry once with a hint embedded in the prompt.
 *
 * @param {object} opts
 * @param {string} opts.context     — diff text
 * @param {string} opts.focus       — additional focus (may be empty)
 * @param {string} opts.schemaPath  — absolute path to review schema
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeout=120000]
 * @param {string} [opts.bin]       — mini-agent path (tests)
 * @param {string} [opts.logDir]    — log dir override (tests)
 * @param {boolean} [opts.truncated=false] — caller flags upstream truncation (reserved)
 * @returns {Promise<{ok:true, verdict, summary, findings, next_steps, truncated, retry_used, retry_notice, logPath} | reviewError>}
 */
export async function callMiniAgentReview({
  context,
  focus = "",
  schemaPath,
  cwd,
  timeout = 120_000,
  bin,
  logDir,
  truncated = false,
  onProgressLine,  // v2 (Gemini #10): caller may stream mini-agent stdout for UX
}) {
  let firstPrompt;
  try {
    firstPrompt = buildReviewPrompt({ schemaPath, focus, context });
  } catch (e) {
    return reviewError({
      error: `schema-load-failed: ${e.message}`,
      truncated,
      retry_used: false,
    });
  }

  const firstCall = await callMiniAgent({ prompt: firstPrompt, cwd, timeout, bin, logDir, onProgressLine });
  const firstCls = classifyMiniAgentResult(firstCall);
  if (firstCls.status !== "success" && firstCls.status !== "success-but-truncated") {
    return reviewError({
      error: `mini-agent call failed: ${firstCls.status}${firstCls.detail ? " — " + firstCls.detail : ""}`,
      truncated: truncated || firstCls.status === "success-but-truncated",
      retry_used: false,
      diagnostic: firstCls.diagnostic ?? null,
    });
  }

  // v2 (Codex #4): propagate truncation from the classifier into the review result.
  const firstTruncated = truncated || firstCls.status === "success-but-truncated";

  const firstExtracted = extractReviewJson(firstCls.response);
  let firstValidation = null;
  if (firstExtracted.ok) {
    firstValidation = validateReviewOutput(firstExtracted.data, schemaPath);
    if (firstValidation.ok) {
      return {
        ok: true,
        ...firstExtracted.data,
        truncated: firstTruncated,
        retry_used: false,
        retriedOnce: false,  // v2 spec §4.5 alias
        retry_notice: null,
        logPath: firstCls.logPath,
      };
    }
  }

  // Retry once with a concise error hint + verbatim-but-redacted previous response.
  const retryHint = firstExtracted.ok
    ? `schema validation errors: ${firstValidation.errors.slice(0, 3).join("; ")}`
    : `parse failure (${firstExtracted.error}${firstExtracted.parseError ? ": " + firstExtracted.parseError : ""})`;

  process.stderr.write("Warning: minimax review response failed parse/validation; retrying once with error hint...\n");

  let retryPrompt;
  try {
    // v2 (Codex #3): pass firstCls.response as previousRaw so the model sees what
    // went wrong. buildReviewPrompt handles redaction + 1500-char cap.
    retryPrompt = buildReviewPrompt({
      schemaPath, focus, context,
      retryHint,
      previousRaw: firstCls.response,
    });
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
      error: `retry mini-agent call failed: ${retryCls.status}${retryCls.detail ? " — " + retryCls.detail : ""}`,
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

  return {
    ok: true,
    ...retryExtracted.data,
    truncated: retryTruncated,
    retry_used: true,
    retriedOnce: true,  // v2 spec §4.5 alias
    retry_notice: `Initial response failed; retry succeeded (hint: ${retryHint})`,
    logPath: retryCls.logPath,
  };
}
```

- [ ] **Step 4：跑测试**

```bash
node --test plugins/minimax/scripts/lib/minimax.review.test.mjs
node --test plugins/minimax/scripts/lib/*.test.mjs
```

Expected: 8 new pass; 10 validator + 15 builder/extractor + 8 review = **33 Phase 3 tests**; total project 73 + 33 = **106 pass, 0 fail** (v2 revised counts).

- [ ] **Step 5：Commit**

```bash
git add plugins/minimax/scripts/lib/minimax.mjs plugins/minimax/scripts/lib/minimax.review.test.mjs
git commit -m "$(cat <<'EOF'
feat(Task 3.4): callMiniAgentReview with 1-shot retry (spec §6.2, §4.5)

- Runs build -> callMiniAgent -> classifyMiniAgentResult -> extractReviewJson
  -> validateReviewOutput
- On parse or validation failure: one retry with error hint embedded in
  prompt (no session resume; P0.9 Mini-Agent has no session id)
- Returns {ok:true, ...review, retry_used, retry_notice, logPath} or
  reviewError {ok:false, error, firstRawText, rawText, parseError,
  truncated, retry_used, diagnostic}
- 5 integration tests via stateful-counter mock for retry paths
EOF
)"
```

---

## Task 3.5 — `runReview` subcommand in companion (with diff collection)

**Why**：把所有东西拼起来作为 `minimax-companion.mjs review` 子命令。包括：基于 `--base` / `--scope` 跑 `git diff` 收集上下文、调 `callMiniAgentReview`、按 `--json` / text 模式渲染。

**Files:**
- Modify: `plugins/minimax/scripts/minimax-companion.mjs`

- [ ] **Step 1：在 USAGE 常量里加 review 段落 + import 扩展**

USAGE 追加：

```
  review [--json] [--base <ref>] [--scope <auto|working-tree|staged|branch>]
         [--timeout <ms>] [--cwd <path>] [focus ...]
                    Run a code review against the current git diff. Exit codes:
                      0 = success (with or without retry)
                      2 = no diff found / empty diff
                      4 = mini-agent call failed
                      5 = parse/validate failed even after 1 retry
                      6 = git command failed
```

import 追加 `callMiniAgentReview`：

```js
import {
  getMiniAgentAvailability,
  getMiniAgentAuthStatus,
  readMiniAgentConfig,
  writeMiniAgentApiKey,
  redactSecrets,
  callMiniAgent,
  classifyMiniAgentResult,
  stripAnsiSgr,
  callMiniAgentReview,
} from "./lib/minimax.mjs";
```

顶部新增 imports（companion 目前既没 path 也没 child_process，也没 fileURLToPath）：

```js
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
```

**必须**放在文件最顶部的 import 区（ES module 规定），不要放到函数体内。

- [ ] **Step 2：添加 git diff 采集 + `runReview`**

在 `runAsk` 之后、`main()` 之前插入（记得：`spawnSync` / `path` 的 import 已在 Step 1 加到顶部，**这里不再重复**）：

```js
function collectDiff({ base, scope = "auto", cwd }) {
  // v2 (Gemini #5): refuse to review while merge conflicts are unresolved —
  // `<<<<<<<` markers confuse the model and render findings unreliable.
  const unmerged = spawnSync("git", ["ls-files", "--unmerged"], { cwd, encoding: "utf8" });
  if (unmerged.status !== 0) {
    return { ok: false, reason: "git-diff-failed", detail: `git ls-files --unmerged failed: ${unmerged.stderr.trim()}` };
  }
  if (unmerged.stdout.trim().length > 0) {
    return {
      ok: false,
      reason: "merge-conflict-present",
      detail: "unresolved merge conflicts detected; resolve them before running review",
    };
  }

  // Resolve final scope.
  let effectiveScope = scope;
  if (scope === "auto") {
    const wtree = spawnSync("git", ["diff", "--name-only"], { cwd, encoding: "utf8" });
    if (wtree.status !== 0) return { ok: false, reason: "git-diff-failed", detail: wtree.stderr.trim() };
    if (wtree.stdout.trim().length > 0) effectiveScope = "working-tree";
    else {
      const staged = spawnSync("git", ["diff", "--cached", "--name-only"], { cwd, encoding: "utf8" });
      // v2 (Codex #5): check status before trusting stdout — a failing git would
      // otherwise look like "empty staged" and silently skip the branch.
      if (staged.status !== 0) return { ok: false, reason: "git-diff-failed", detail: staged.stderr.trim() };
      if (staged.stdout.trim().length > 0) effectiveScope = "staged";
      else if (base) effectiveScope = "branch";
      else return { ok: false, reason: "no-diff", detail: "no working-tree or staged changes; specify --base for branch compare" };
    }
  }

  let args;
  if (effectiveScope === "working-tree") args = ["diff"];
  else if (effectiveScope === "staged") args = ["diff", "--cached"];
  else if (effectiveScope === "branch") {
    if (!base) return { ok: false, reason: "no-base", detail: "--scope branch requires --base" };
    args = ["diff", `${base}...HEAD`];
  } else {
    return { ok: false, reason: "bad-scope", detail: `unknown --scope '${scope}'` };
  }

  const diff = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (diff.status !== 0) return { ok: false, reason: "git-diff-failed", detail: diff.stderr.trim() };
  return { ok: true, scope: effectiveScope, diff: diff.stdout };
}

// v2: removed "ok":0 (success path short-circuits straight to process.exit(0)).
const REVIEW_STATUS_EXIT = {
  "no-diff": 2,
  "no-base": 2,
  "bad-scope": 2,
  "merge-conflict-present": 2,  // v2 (Gemini #5)
  "git-diff-failed": 6,
  "call-failed": 4,
  "parse-validate-failed": 5,
};

async function runReview(rawArgs) {
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
    const err = { status: "bad-input", reason: `invalid --timeout '${options.timeout}'` };
    if (options.json) process.stdout.write(JSON.stringify(err) + "\n");
    else process.stderr.write(`Error: ${err.reason}\n`);
    process.exit(1);
  }

  const diffResult = collectDiff({ base, scope, cwd });
  if (!diffResult.ok) {
    const exitCode = REVIEW_STATUS_EXIT[diffResult.reason] ?? 6;
    const payload = { status: diffResult.reason, detail: diffResult.detail };
    if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stderr.write(`Error: ${diffResult.reason} — ${diffResult.detail}\n`);
    process.exit(exitCode);
  }
  if (!diffResult.diff.trim()) {
    const payload = { status: "no-diff", detail: `scope=${diffResult.scope} yielded empty diff` };
    if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stdout.write(`No changes under scope=${diffResult.scope}; nothing to review.\n`);
    process.exit(2);
  }

  if (!options.json) {
    process.stdout.write(`Reviewing (scope=${diffResult.scope}${base ? ", base=" + base : ""}, focus="${focus || "(none)"}" )...\n`);
    process.stdout.write("Starting MiniMax (cold start ~3s)...\n");
  }

  // v2 (Codex #8): use fileURLToPath so path resolution works on Windows too.
  const schemaPath = path.resolve(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas", "review-output.schema.json")
  );

  // v2 (Gemini #10): stream background progress to stderr so the user sees
  // "Loading skills..." etc. during the cold start. Keep stdout clean for
  // JSON mode (the callback only fires when !options.json).
  const onProgressLine = options.json ? undefined : (line) => {
    process.stderr.write(stripAnsiSgr(line) + "\n");
  };

  const r = await callMiniAgentReview({
    context: diffResult.diff,
    focus,
    schemaPath,
    cwd,
    timeout,
    onProgressLine,
  });

  if (r.ok) {
    if (options.json) {
      process.stdout.write(JSON.stringify({
        status: "ok",
        verdict: r.verdict,
        summary: r.summary,
        findings: r.findings,
        next_steps: r.next_steps,
        retry_used: r.retry_used,
        retry_notice: r.retry_notice,
        logPath: r.logPath,
      }, null, 2) + "\n");
    } else {
      const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      const findings = [...r.findings].sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
      process.stdout.write(`\nVerdict: ${r.verdict}\n`);
      process.stdout.write(`Summary: ${r.summary}\n`);
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
      if (r.next_steps.length) {
        process.stdout.write(`Next steps:\n`);
        for (const s of r.next_steps) process.stdout.write(`  - ${s}\n`);
      }
      // v2 (Gemini #2): footer mirrors ask — include model from readMiniAgentConfig.
      const cfg = readMiniAgentConfig();
      const footerParts = [];
      if (cfg.model) footerParts.push(`model: ${cfg.model}`);
      if (r.logPath) footerParts.push(`log: ${r.logPath}`);
      if (r.truncated) footerParts.push("truncated");
      if (r.retry_used) footerParts.push("retry-used");
      if (footerParts.length) process.stdout.write(`(${footerParts.join(" · ")})\n`);
      if (r.retry_used) process.stdout.write(`(note: review retry used — ${r.retry_notice})\n`);
    }
    process.exit(0);
  } else {
    const reason = r.diagnostic ? "call-failed" : "parse-validate-failed";
    const exitCode = REVIEW_STATUS_EXIT[reason] ?? 5;
    if (options.json) {
      process.stdout.write(JSON.stringify({
        status: reason,
        error: r.error,
        firstRawText: r.firstRawText,
        rawText: r.rawText,
        parseError: r.parseError,
        retry_used: r.retry_used,
        diagnostic: r.diagnostic,
      }, null, 2) + "\n");
    } else {
      process.stderr.write(`Error: ${reason} — ${r.error}\n`);
      if (r.diagnostic && r.diagnostic.stderrHeadTail) {
        process.stderr.write(`\n--- diagnostic (stderr head+tail, ANSI stripped) ---\n${r.diagnostic.stderrHeadTail}\n`);
      }
      // v2 (Claude spec review): surface log-parse partial block when classifier
      // couldn't find a terminal RESPONSE — otherwise text-mode users lose half the signal.
      if (r.diagnostic && r.diagnostic.lastPartialResponseRaw) {
        process.stderr.write(`\n--- last partial RESPONSE block (log) ---\n${String(r.diagnostic.lastPartialResponseRaw).slice(0, 1500)}\n`);
      }
      // r.firstRawText / r.rawText are already redacted inside reviewError (v2 — Codex #1).
      if (r.firstRawText) process.stderr.write(`\n(first raw response, redacted, truncated)\n${r.firstRawText.slice(0, 1500)}\n`);
      if (r.rawText) process.stderr.write(`\n(retry raw response, redacted, truncated)\n${r.rawText.slice(0, 1500)}\n`);
    }
    process.exit(exitCode);
  }
}
```

- [ ] **Step 3：路由 review 子命令**

在 `main()` 的 switch 里加（在 `case "ask":` 之后）：

```js
    case "review":
      return await runReview(rest);
```

- [ ] **Step 4：Manual smoke**

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
# Make a tiny trivial edit so there's a working-tree diff.
echo "// phase 3 smoke marker" >> plugins/minimax/scripts/lib/minimax.mjs
node plugins/minimax/scripts/minimax-companion.mjs review --json "check for obvious issues" | head -40
# Reset after smoke (do NOT commit this marker).
git checkout -- plugins/minimax/scripts/lib/minimax.mjs
```

Expected: JSON output starting with `"status": "ok"`, a `verdict`, etc. If the response fails JSON, retry path should fire (`retry_used: true`). If both fail, payload shows parse-validate-failed with both raw texts.

If first-shot passes (common case), `retry_used: false`; don't treat that as a bug.

- [ ] **Step 5：Commit**

```bash
git add plugins/minimax/scripts/minimax-companion.mjs
git commit -m "$(cat <<'EOF'
feat(Task 3.5): minimax-companion review subcommand (spec §6.2)

- runReview: --json | text, --base / --scope / --timeout / --cwd / focus
- collectDiff: git diff auto|working-tree|staged|branch (needs --base for branch)
- Delegates to callMiniAgentReview; severity-sorted rendering in text mode
- Exit code map: 0 ok / 2 no-diff / 4 call-failed / 5 parse-validate-failed / 6 git
EOF
)"
```

---

## Task 3.6 — `/minimax:review` command.md

**Why**：Claude Code 的入口，只做分派 + 交给 skill 管呈现。

**Files:**
- Create: `plugins/minimax/commands/review.md`

- [ ] **Step 1：写 command.md**

内容如下（无 emoji；对照 kimi/gemini 的 review.md 风格）：

```markdown
---
description: Run a MiniMax code review on the current diff
argument-hint: '[--json] [--base <ref>] [--scope <auto|working-tree|staged|branch>] [--timeout <ms>] [--cwd <path>] [focus ...]'
allowed-tools: Bash(node:*)
---

Invoke the minimax companion to run a review:

```bash
MINIMAX_COMPANION_CALLER=claude node "${CLAUDE_PLUGIN_ROOT}/scripts/minimax-companion.mjs" review "$ARGUMENTS"
```

Present the output to the user.

**Follow `minimax-result-handling/references/review-render.md` for presentation rules.** Key points:

**If the companion exits 0** (review succeeded, with or without retry):
1. Present the verdict, summary, findings, and next_steps verbatim.
2. Sort findings by severity (critical > high > medium > low).
3. Do NOT auto-fix any finding. The user picks which to address.
4. If `retry_used` is true, mention it in one line after the findings: "(note: review retry used — the first response failed validation)".
5. If the diff was truncated upstream (not v0.1), warn the user — v0.1 always passes the full diff through argv.

**If the companion exits non-zero**:
- exit 2 (check `status` in JSON payload to distinguish):
  - `no-diff`: nothing to review. Detail describes which scope was tried; suggest `--base <ref>` if they meant a branch compare.
  - `no-base`: user passed `--scope branch` without `--base`. Suggest supplying `--base main` (or their branch's merge-base).
  - `bad-scope`: user passed an unknown `--scope` value. Echo the detail (lists accepted values).
  - `merge-conflict-present`: `git ls-files --unmerged` showed conflicts. Tell the user "Resolve merge conflicts before running review."
- exit 4: mini-agent call failed. Present the diagnostic block as-is; suggest running `/minimax:setup` if auth-not-configured, or retrying if llm-call-failed.
- exit 5: JSON parse/validation failed even after 1 retry. Present both raw responses (`firstRawText` and `rawText`) under clearly labeled headings; do NOT paraphrase. Declarative suggestion: "The model returned non-conforming output twice. Rerun with a narrower focus to reduce confusion."
- exit 6: git command failed. Surface the error directly.

**Do NOT retry automatically** on any failure. The user decides.

### Comparing with Claude's own `/review`

If `/review` (Claude's native review) was already run earlier in the same conversation, compare findings:
- Both found: overlap
- Only MiniMax: unique
- Only Claude: unique

Surface the comparison as a small table; do not merge or re-rank.
```

- [ ] **Step 2：sanity + commit**

```bash
wc -l /Users/bing/-Code-/minimax-plugin-cc/plugins/minimax/commands/review.md
git add plugins/minimax/commands/review.md
git commit -m "$(cat <<'EOF'
feat(Task 3.6): /minimax:review command.md (spec §6.2)

- Dispatches companion review subcommand
- Severity-sorted verbatim presentation
- Exit-code -> declarative user-facing suggestion map
- Reserve slot for comparison with Claude's native /review output
EOF
)"
```

---

## Task 3.7 — `references/review-render.md` + T5 smoke + CHANGELOG + tag `phase-3-review`

**Why**：收尾。skill reference 补全呈现规则；跑 T5；更新两份 CHANGELOG；打 tag。

**Files:**
- Create: `plugins/minimax/skills/minimax-result-handling/references/review-render.md`
- Create: `doc/smoke/phase-3-T5.md`
- Modify: `CHANGELOG.md`（根）
- Modify: `plugins/minimax/CHANGELOG.md`

- [ ] **Step 1：写 review-render.md**

创建 `plugins/minimax/skills/minimax-result-handling/references/review-render.md`：

```markdown
# review-render reference

Detailed rules for rendering `/minimax:review` output. Authoritative source of truth is `plugins/minimax/commands/review.md`; this file captures cross-command context and anti-patterns.

## Success JSON shape (exit 0)

```json
{
  "status": "ok",
  "verdict": "approve" | "needs-attention",
  "summary": "<one-paragraph string>",
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "title": "<short>",
      "body": "<1-3 sentences>",
      "file": "<repo-relative path>",
      "line_start": <int>, "line_end": <int>,
      "confidence": <0..1>,
      "recommendation": "<short actionable>"
    }
  ],
  "next_steps": ["<short action>"],
  "retry_used": <bool>,
  "retry_notice": "<string|null>",
  "logPath": "<absolute path>"
}
```

## Presentation

1. Verdict line first, uncolored, verbatim: `Verdict: approve` or `Verdict: needs-attention`.
2. Summary verbatim.
3. Findings sorted by severity (critical first, low last). Within same severity, preserve the model's order. Format each finding as:
   ```
   - [<severity>] <title>
     <file>:<line_start>[-<line_end>]  (confidence <conf>)
     <body>
     fix: <recommendation>
   ```
4. Next steps verbatim, bulleted.
5. If `retry_used` is true, add a single line: `(note: review retry used — <retry_notice>)`.
6. Log path last, parenthesized.

## Disagreement

If Claude has independently reviewed the same diff (e.g. via native `/review`), Claude MAY add a comparison section AFTER the MiniMax output. Do not merge findings; present two sets side by side.

## Relation to the suspicious-tool-calls tripwire (SKILL.md)

Review responses are pure data — the schema has no `toolCalls[]` field. The model is explicitly instructed in `prompts/review.md` to return RAW JSON ONLY; any attempt to invoke tools is treated as non-conforming JSON and rejected during validation (triggers the 1-shot retry). **Therefore the suspicious-bash tripwire in `SKILL.md` does NOT apply to `/minimax:review` output.** The tripwire lives in `/minimax:rescue` (Phase 4) where the agent genuinely does run bash.

## Anti-patterns

- Do NOT suggest a fix Claude thinks is better than `recommendation`. Respect MiniMax's verbatim suggestion; if Claude disagrees, add a single "Note: Claude disagrees on <id> because Y." line.
- Do NOT silently drop a `low` finding because it seems trivial. Render all findings.
- Do NOT collapse findings into a single summary if there are several — make each one visible.
- Do NOT reformat `body` text. Preserve Chinese / mixed-language output.
- Do NOT auto-apply any `recommendation`. Ask the user which to act on.

## Error JSON shape (exit non-zero)

```json
{
  "status": "no-diff" | "git-diff-failed" | "call-failed" | "parse-validate-failed" | ...,
  "error": "<message>",
  "firstRawText": "<string|null>",
  "rawText": "<string|null>",
  "parseError": "<string|null>",
  "retry_used": <bool>,
  "diagnostic": <classifier-diagnostic|null>
}
```

When `status === "parse-validate-failed"`, the user needs the raw texts to debug their prompt or the model's non-conformance. Present both under clearly labeled headings. Claude MUST NOT rewrite them into "valid JSON"; the whole point is exposing the model's failure mode.
```

- [ ] **Step 2：跑 T5 smoke**

真实 diff 源：随便改 minimax.mjs 注释，跑一次，reset 回来。

```bash
cd /Users/bing/-Code-/minimax-plugin-cc
echo "// phase-3 T5 test comment — to be reverted after smoke" >> plugins/minimax/scripts/lib/minimax.mjs
node plugins/minimax/scripts/minimax-companion.mjs review --json > /tmp/t5.stdout 2> /tmp/t5.stderr
T5_EXIT=$?
echo "exit=$T5_EXIT"
head -c 1500 /tmp/t5.stdout
# Immediately reset the smoke artifact so it doesn't pollute a commit.
git checkout -- plugins/minimax/scripts/lib/minimax.mjs
```

**T5 PASS** means:
- `T5_EXIT === 0`
- stdout is valid JSON; `node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/t5.stdout','utf8')).status)"` prints `ok`
- `findings` is an array (possibly empty — a trivial diff might produce 0 findings)
- All required fields present and schema-valid (guaranteed since we pass validation before returning ok=true)
- `verdict` ∈ {approve, needs-attention}

If `retry_used` is true, that's still PASS (first shot failed, second recovered — the whole retry path is what T5 exercises).

If upstream 401 surfaces (Coding Plan rate limit etc.): mark T5 as **degraded-PASS** with the call-failed diagnostic included. The code path is still correct; only the upstream is flaky.

- [ ] **Step 3：write smoke doc**

Create `doc/smoke/phase-3-T5.md` with filled-in values from the run. Include: exit, status, verdict, retry_used, stdout head, command used, model / api_base snapshot (read from `readMiniAgentConfig`), and verdict assessment.

- [ ] **Step 4：CHANGELOG prepend — root**

Prepend to `CHANGELOG.md`:

```markdown
## YYYY-MM-DD HH:MM [Claude sonnet executor] — Phase 3 complete

- **status**: done
- **scope**: Phase 3 — /minimax:review + schemas/review-output.schema.json + prompts/review.md + callMiniAgentReview (1-shot retry) + companion runReview + review-render skill reference.
- **summary**: Hand-rolled draft 2020-12 subset validator (no ajv dep); buildReviewPrompt with placeholder substitution + retry-hint with verbatim prior response (redacted, capped 1500 chars per spec §4.5); extractReviewJson uses brace-balanced scanner (not string-slice heuristic); callMiniAgentReview wires build -> callMiniAgent -> classify -> extract -> validate -> retry-once-if-needed. Companion does git-diff collection (auto/working-tree/staged/branch) and refuses to run on unresolved merge conflicts. All raw-text fields in reviewError pass through redactSecrets. truncated field derives from classifier's success-but-truncated status. Spec-§4.5 alias `retriedOnce` emitted alongside `retry_used`. Skill reference covers severity-sorted rendering + clarifies the tripwire does NOT apply to review. T5 smoke <verdict>.
- **spec alignment**: schemas/review-output.schema.json is byte-aligned with gemini except for two intentional tightenings — `findings[].file.minLength: 1` and `findings[].recommendation.minLength: 1` — because empty strings in these fields produce zero diagnostic value. Registered as a minimax-specific divergence; lessons.md carries the rationale.
- **phase 5 heads-up**: `prompts/review.md`'s placeholder scheme + brace-balanced extractor + 1-shot retry wiring are directly reusable for `/minimax:adversarial-review`. Phase 5 author should not duplicate these — compose over them.
- **next**: Phase 4 plan (/minimax:rescue + --sandbox + job-control MUST serialize per P0.10 + minimax-agent subagent + 2 hooks).
```

- [ ] **Step 5：CHANGELOG prepend — plugin**

Prepend to `plugins/minimax/CHANGELOG.md`:

```markdown
## YYYY-MM-DD — Phase 3

- Add /minimax:review command + companion runReview subcommand.
- Add schemas/review-output.schema.json (draft 2020-12).
- Add prompts/review.md (strict JSON-only review template).
- Add buildReviewPrompt / extractReviewJson / validateReviewOutput / callMiniAgentReview.
- callMiniAgentReview: 1-shot retry with error hint when parse/validate fails.
- Companion collects git diff (auto/working-tree/staged/branch).
- Add minimax-result-handling references/review-render.md.
```

- [ ] **Step 6：final commit + tag**

```bash
git add plugins/minimax/skills/minimax-result-handling/references/review-render.md doc/smoke/phase-3-T5.md CHANGELOG.md plugins/minimax/CHANGELOG.md
git commit -m "$(cat <<'EOF'
chore(Task 3.7): Phase 3 complete — review-render + T5 smoke + CHANGELOG

- T5 (review --json against real diff): <PASS/degraded-PASS verdict>
- Skill reference review-render.md with severity rendering + anti-patterns
- Root and plugin CHANGELOGs updated
EOF
)"

git tag phase-3-review
```

- [ ] **Step 7：Verify**

```bash
git tag
git log --oneline phase-2-ask..HEAD
```

Expected: `phase-3-review` exists; ~10 commits since `phase-2-ask` (Tasks 3.1 through 3.7).

---

## Self-Review Checklist

1. **Spec coverage:**
   - §3.2 callMiniAgent (reused, no change) ✓
   - §4.5 diagnostic bundle (via classifyMiniAgentResult; reviewError carries `diagnostic` too) ✓
   - §6.1/§6.2 /minimax:review command (schema, verbose prompt, 1-shot retry, log-based JSON extraction) ✓
   - §8.1 T5 hard gate ✓

2. **Placeholder scan:** No TBD / TODO / "similar to task N". Schema content shown verbatim. Prompt content shown verbatim.

3. **Type consistency:**
   - `validateReviewOutput(data, schemaPath)` — Task 3.1 defines, Task 3.4 uses same signature ✓
   - `buildReviewPrompt({schemaPath, focus, context, retryHint?})` — Task 3.3 defines, Task 3.4 uses same keys ✓
   - `extractReviewJson(raw)` → `{ok, data} | {ok:false, error, parseError?}` — Task 3.3 defines, Task 3.4 consumes these exact fields ✓
   - `callMiniAgentReview` success shape `{ok:true, verdict, summary, findings, next_steps, truncated, retry_used, retry_notice, logPath}` — Task 3.4 defines, Task 3.5 consumes ✓
   - `reviewError` shape `{ok:false, error, firstRawText, rawText, parseError, truncated, retry_used, diagnostic}` — Task 3.4 defines, Task 3.5 consumes the same fields ✓
   - Exit code map in Task 3.5 covers all `diffResult.reason` + call-failed / parse-validate-failed strings ✓

4. **Non-goals honored:**
   - No `--model` ✓
   - No `--resume` ✓
   - No ajv dependency ✓
   - No session resume in retry (P0.9) ✓
   - No parallel reviews ✓

5. **DRY check:**
   - Schema loading cached once; same with prompt template
   - Diff collection in one place (companion), not duplicated in command.md
   - Validation errors displayed consistently (slice first 3)

6. **YAGNI enforced:**
   - Hand-rolled validator covers only needed keywords; doesn't try to be a full JSON Schema impl
   - Retry is exactly 1 shot, not configurable
   - git diff scope is 4 values, not a plug-in architecture

7. **v2 (3-way review) revision closure:** every entry in the "v2 — 3-way review 修订索引" table has a corresponding change in this plan (verified by re-reading each listed Task after patching). No orphan index entries; no silent TODOs.
