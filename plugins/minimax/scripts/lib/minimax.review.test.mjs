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
