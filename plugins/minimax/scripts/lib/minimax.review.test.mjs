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

test("validateReviewOutput: nested finding.severity enum violation (v2 - Codex #6)", () => {
  const o = validOutput();
  o.findings[0].severity = "catastrophic";
  const r = validateReviewOutput(o, SCHEMA_PATH);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /severity/.test(e) && /enum/.test(e)));
});

test("validateReviewOutput: null input reports 'got null' not 'got object' (code-review I-1)", () => {
  const r = validateReviewOutput(null, SCHEMA_PATH);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /got null/.test(e)), `expected 'got null' in errors; got: ${JSON.stringify(r.errors)}`);
});

test("validateReviewOutput: undefined input reports 'got undefined' (code-review M-1)", () => {
  const r = validateReviewOutput(undefined, SCHEMA_PATH);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /got undefined/.test(e)));
});

test("validateReviewOutput: nested error path uses findings[0].X not findings.[0].X (code-review I-2)", () => {
  const o = validOutput();
  o.findings[0].confidence = 1.5;
  const r = validateReviewOutput(o, SCHEMA_PATH);
  assert.equal(r.ok, false);
  const hit = r.errors.find(e => /confidence/.test(e));
  assert.ok(hit, `no confidence error: ${JSON.stringify(r.errors)}`);
  assert.ok(hit.includes("findings[0].confidence"), `expected 'findings[0].confidence' in path; got: ${hit}`);
  assert.ok(!hit.includes("findings.[0]"), `legacy dotted-bracket path leaked: ${hit}`);
});

// ── Task 3.3 tests: buildReviewPrompt + extractReviewJson ────────────────

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

test("buildReviewPrompt: focus containing literal {{CONTEXT}} is preserved as user data (M2 v0.1.1)", () => {
  // After v0.1.1 M2 fix: real {{CONTEXT}} slot is swapped to a sentinel BEFORE
  // any user-supplied placeholder substitution. So focus / retryHint / previousRaw
  // can safely contain literal "{{CONTEXT}}" without poisoning the substitution.
  // The literal text is preserved verbatim in the final prompt.
  const out = buildReviewPrompt({
    schemaPath: SCHEMA_PATH,
    focus: "please review {{CONTEXT}} carefully",
    context: "diff",
  });
  // Real CONTEXT slot received the actual context value
  assert.ok(out.includes("diff"), "real {{CONTEXT}} slot must contain context value");
  // Focus's literal {{CONTEXT}} survives verbatim
  assert.ok(out.includes("please review {{CONTEXT}} carefully"), "focus must survive verbatim with its literal {{CONTEXT}}");
  // No template artifact leaked
  assert.ok(!out.includes("__MINIMAX_CONTEXT_SLOT__"), "sentinel must not leak");
});

import os from "node:os";
import { callMiniAgentReview } from "./minimax.mjs";

function buildReviewLog({ content, finishReason = "stop" }) {
  const body = JSON.stringify({ content, thinking: null, tool_calls: [], finish_reason: finishReason });
  return [
    "=".repeat(80),
    "Agent Run Log - 2026-04-20 10:44:30",
    "=".repeat(80),
    "",
    "",
    "-".repeat(80),
    "[1] REQUEST",
    "Timestamp: 2026-04-20 10:44:37.000",
    "-".repeat(80),
    "{\"messages\":[]}",
    "",
    "-".repeat(80),
    "[2] RESPONSE",
    "Timestamp: 2026-04-20 10:44:41.000",
    "-".repeat(80),
    "",
    body,
    "",
    "",
  ].join("\n");
}

function mkMockMiniAgentForReview({ logDir, content, finishReason = "stop", stdout = "", stderr = "" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-review-mock-"));
  const binPath = path.join(dir, "mini-agent");
  const logPath = path.join(logDir, `review_${Date.now()}_${Math.random().toString(16).slice(2)}.log`);
  const script = `#!/usr/bin/env node
import fs from "node:fs";
const logPath = ${JSON.stringify(logPath)};
fs.writeFileSync(logPath, ${JSON.stringify(buildReviewLog({ content, finishReason }))});
process.stdout.write("Log file: " + logPath + "\\n");
${stdout ? `process.stdout.write(${JSON.stringify(stdout)});` : ""}
process.stdout.write("Session Statistics:\\n");
${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ""}
`;
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return { binPath, dir, logPath };
}

function mkStatefulMockForReview({ logDir, steps }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-review-stateful-"));
  const binPath = path.join(dir, "mini-agent");
  const counterPath = path.join(dir, "counter.txt");
  const scriptedSteps = steps.map((step, index) => {
    const logPath = step.writeLog === false
      ? null
      : path.join(logDir, `review_stateful_${index + 1}_${Date.now()}_${Math.random().toString(16).slice(2)}.log`);
    return {
      ...step,
      logPath,
      logText: logPath ? buildReviewLog({ content: step.content, finishReason: step.finishReason ?? "stop" }) : null,
    };
  });

  const script = `#!/usr/bin/env node
import fs from "node:fs";
const counterPath = ${JSON.stringify(counterPath)};
const steps = ${JSON.stringify(scriptedSteps)};
let count = 0;
try { count = Number(fs.readFileSync(counterPath, "utf8")) || 0; } catch {}
count += 1;
fs.writeFileSync(counterPath, String(count));
const step = steps[Math.min(count - 1, steps.length - 1)];
if (step.removeSelf) {
  try { fs.unlinkSync(process.argv[1]); } catch {}
}
if (step.stderr) process.stderr.write(step.stderr);
if (step.logPath) {
  fs.writeFileSync(step.logPath, step.logText);
  process.stdout.write("Log file: " + step.logPath + "\\n");
}
if (step.stdout) process.stdout.write(step.stdout);
if (step.sessionStats !== false) process.stdout.write("Session Statistics:\\n");
process.exit(step.exitCode ?? 0);
`;
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return { binPath, dir, counterPath };
}

test("callMiniAgentReview: happy path succeeds without retry", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-review-log-"));
  const { binPath } = mkMockMiniAgentForReview({
    logDir,
    content: JSON.stringify(validOutput()),
  });

  const r = await callMiniAgentReview({
    context: "diff --git a/a.js b/a.js",
    focus: "check findings",
    schemaPath: SCHEMA_PATH,
    cwd: process.cwd(),
    timeout: 5_000,
    bin: binPath,
    logDir,
  });

  assert.equal(r.ok, true);
  assert.equal(r.retry_used, false);
  assert.equal(r.retriedOnce, false);
  assert.equal(r.retry_notice, null);
  assert.equal(r.verdict, "approve");
});

test("callMiniAgentReview: malformed first shot retries once and succeeds", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-review-log-"));
  const { binPath } = mkStatefulMockForReview({
    logDir,
    steps: [
      { content: '{"verdict":"approve"', finishReason: "stop" },
      { content: JSON.stringify(validOutput()), finishReason: "stop" },
    ],
  });

  const r = await callMiniAgentReview({
    context: "diff",
    focus: "",
    schemaPath: SCHEMA_PATH,
    cwd: process.cwd(),
    timeout: 5_000,
    bin: binPath,
    logDir,
  });

  assert.equal(r.ok, true);
  assert.equal(r.retry_used, true);
  assert.equal(r.retriedOnce, true);
  assert.match(r.retry_notice, /retry succeeded/);
});

test("callMiniAgentReview: schema-invalid first shot retries once and succeeds", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-review-log-"));
  const invalid = validOutput();
  delete invalid.verdict;
  const { binPath } = mkStatefulMockForReview({
    logDir,
    steps: [
      { content: JSON.stringify(invalid), finishReason: "stop" },
      { content: JSON.stringify(validOutput()), finishReason: "stop" },
    ],
  });

  const r = await callMiniAgentReview({
    context: "diff",
    focus: "",
    schemaPath: SCHEMA_PATH,
    cwd: process.cwd(),
    timeout: 5_000,
    bin: binPath,
    logDir,
  });

  assert.equal(r.ok, true);
  assert.equal(r.retry_used, true);
  assert.equal(r.retriedOnce, true);
  assert.equal(r.verdict, "approve");
});

test("callMiniAgentReview: both shots fail parse and preserve both raw texts", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-review-log-"));
  const { binPath } = mkStatefulMockForReview({
    logDir,
    steps: [
      { content: "not json at all", finishReason: "stop" },
      { content: "{still-not-json", finishReason: "stop" },
    ],
  });

  const r = await callMiniAgentReview({
    context: "diff",
    focus: "",
    schemaPath: SCHEMA_PATH,
    cwd: process.cwd(),
    timeout: 5_000,
    bin: binPath,
    logDir,
  });

  assert.equal(r.ok, false);
  assert.equal(r.retry_used, true);
  assert.equal(r.retriedOnce, true);
  assert.equal(typeof r.firstRawText, "string");
  assert.equal(typeof r.rawText, "string");
});

test("callMiniAgentReview: missing binary returns not-installed diagnostic without retry", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-review-log-"));

  const r = await callMiniAgentReview({
    context: "diff",
    focus: "",
    schemaPath: SCHEMA_PATH,
    cwd: process.cwd(),
    timeout: 5_000,
    bin: "/nonexistent/bin/mini-agent-review",
    logDir,
  });

  assert.equal(r.ok, false);
  assert.equal(r.retry_used, false);
  assert.equal(r.retriedOnce, false);
  assert.equal(r.diagnostic?.status, "not-installed");
});

test("callMiniAgentReview: success-but-truncated first shot still returns ok=true", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-review-log-"));
  const { binPath } = mkMockMiniAgentForReview({
    logDir,
    content: JSON.stringify(validOutput()),
    finishReason: "length",
  });

  const r = await callMiniAgentReview({
    context: "diff",
    focus: "",
    schemaPath: SCHEMA_PATH,
    cwd: process.cwd(),
    timeout: 5_000,
    bin: binPath,
    logDir,
  });

  assert.equal(r.ok, true);
  assert.equal(r.truncated, true, "classifier success-but-truncated propagated");
  assert.equal(r.retry_used, false);
});

test("callMiniAgentReview: raw texts are redacted before surfacing parse failures", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-review-log-"));
  const token = "eyJabcdefghijklmnopqrstuvwxyz1234567890";
  const { binPath } = mkStatefulMockForReview({
    logDir,
    steps: [
      { content: `bad ${token}`, finishReason: "stop" },
      { content: "still bad", finishReason: "stop" },
    ],
  });

  const r = await callMiniAgentReview({
    context: "diff",
    focus: "",
    schemaPath: SCHEMA_PATH,
    cwd: process.cwd(),
    timeout: 5_000,
    bin: binPath,
    logDir,
  });

  assert.equal(r.ok, false);
  assert.match(r.firstRawText, /eyJ\*\*\*REDACTED\*\*\*/);
  assert.ok(!r.firstRawText.includes(token), "original JWT-like token must be redacted");
});

test("callMiniAgentReview: retry transport failure returns retry_used=true with diagnostic", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-review-log-"));
  const { binPath } = mkStatefulMockForReview({
    logDir,
    steps: [
      { content: "not valid json", finishReason: "stop", removeSelf: true },
    ],
  });

  const r = await callMiniAgentReview({
    context: "diff",
    focus: "",
    schemaPath: SCHEMA_PATH,
    cwd: process.cwd(),
    timeout: 5_000,
    bin: binPath,
    logDir,
  });

  assert.equal(r.ok, false);
  assert.equal(r.retry_used, true);
  assert.equal(r.retriedOnce, true);
  assert.equal(r.diagnostic?.status, "not-installed");
});
