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
