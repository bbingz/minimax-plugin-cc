#!/usr/bin/env node
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
  const r = validateYamlForApiKeyWrite('api_key: "sk-real"\napi_base: "https://api.minimax.io"\n');
  assertEqual(r.ok, true);
  assertEqual(r.form, "D");
});

test("Form S (single-quoted) passes", () => {
  const r = validateYamlForApiKeyWrite("api_key: 'sk-real'\napi_base: 'https://api.minimax.io'\n");
  assertEqual(r.ok, true);
  assertEqual(r.form, "S");
});

test("plain scalar REJECTED", () => {
  const r = validateYamlForApiKeyWrite('api_key: sk-plain-key-no-quotes\nmodel: "x"\n');
  assertEqual(r.ok, false);
  assertEqual(r.reason, "plain-scalar-requires-quoting");
});

test("unquoted with spaces REJECTED", () => {
  const r = validateYamlForApiKeyWrite('api_key: MiniMax-M2.5\nmodel: "x"\n');
  assertEqual(r.ok, false);
  assertEqual(r.reason, "plain-scalar-requires-quoting");
});

test("BOM fails", () => {
  const r = validateYamlForApiKeyWrite("\uFEFFapi_key: \"sk-real\"\n");
  assertEqual(r.ok, false);
  assertEqual(r.reason, "BOM at file start");
});

test("block scalar | fails", () => {
  const r = validateYamlForApiKeyWrite('api_key: |\n  line1\n  line2\nmodel: "x"\n');
  assertEqual(r.reason, "block-scalar-indicator");
});

test("block scalar > fails", () => {
  const r = validateYamlForApiKeyWrite('api_key: >\n  folded\nmodel: "x"\n');
  assertEqual(r.reason, "block-scalar-indicator");
});

test("block scalar >- with chomping fails", () => {
  const r = validateYamlForApiKeyWrite('api_key: >-\n  folded\nmodel: "x"\n');
  assertEqual(r.reason, "block-scalar-indicator");
});

test("empty value fails", () => {
  const r = validateYamlForApiKeyWrite("api_key:\n  indented next line\nmodel: \"x\"\n");
  assertEqual(r.reason, "empty-value-looks-like-block-scalar");
});

test("duplicate api_key fails", () => {
  const r = validateYamlForApiKeyWrite('api_key: "a"\napi_key: "b"\nmodel: "x"\n');
  assertEqual(r.reason, "duplicate-api-key");
});

test("flow-style fails", () => {
  const r = validateYamlForApiKeyWrite('api_key: {nested: value}\nmodel: "x"\n');
  assertEqual(r.reason, "flow-style");
});

test("anchor fails", () => {
  const r = validateYamlForApiKeyWrite('defaults: &d\n  k: v\napi_key: *d\nmodel: "x"\n');
  assertEqual(r.reason, "anchor-alias-or-tag");
});

test("tag ! fails", () => {
  const r = validateYamlForApiKeyWrite('api_key: !!str "foo"\nmodel: "x"\n');
  assertEqual(r.reason, "anchor-alias-or-tag");
});

test("Form D with escaped quote (real) passes", () => {
  const r = validateYamlForApiKeyWrite('api_key: "he said \\"hi\\""\nmodel: "x"\n');
  assertEqual(r.ok, true);
  assertEqual(r.form, "D");
});

test("Form D with trailing content fails", () => {
  const r = validateYamlForApiKeyWrite('api_key: "foo" junk\nmodel: "x"\n');
  assertEqual(r.reason, "form-D-trailing-content");
});

test("Form D with inline comment passes", () => {
  const r = validateYamlForApiKeyWrite('api_key: "foo" # this is a comment\nmodel: "x"\n');
  assertEqual(r.ok, true);
});

test("Form D with # inside quoted value passes (quote-aware)", () => {
  const r = validateYamlForApiKeyWrite('api_key: "hash#mark-abc"\nmodel: "x"\n');
  assertEqual(r.ok, true);
  assertEqual(r.form, "D");
});

test("Form S with # inside quoted value passes", () => {
  const r = validateYamlForApiKeyWrite("api_key: 'a # b'\nmodel: 'x'\n");
  assertEqual(r.ok, true);
  assertEqual(r.form, "S");
});

test("Form D with upstream placeholder + inline comment passes (regression: gemini plan v2 concern)", () => {
  const r = validateYamlForApiKeyWrite('api_key: "YOUR_API_KEY_HERE"  # Replace with your MiniMax API Key\napi_base: "https://api.minimax.io"\n');
  assertEqual(r.ok, true);
  assertEqual(r.form, "D");
});

test("Form D unclosed fails", () => {
  const r = validateYamlForApiKeyWrite('api_key: "unclosed\nmodel: "x"\n');
  assertEqual(r.reason, "form-D-unclosed");
});

test("Form S with doubled-single-quote passes", () => {
  const r = validateYamlForApiKeyWrite("api_key: 'it''s fine'\nmodel: 'x'\n");
  assertEqual(r.ok, true);
  assertEqual(r.form, "S");
});

test("no api_key fails", () => {
  assertEqual(validateYamlForApiKeyWrite('model: "x"\n').reason, "no-api-key");
});

test("suspicious continuation fails", () => {
  const r = validateYamlForApiKeyWrite('api_key: "foo"\n  weird continuation\nmodel: "x"\n');
  assertEqual(r.reason, "suspicious-continuation-after-api-key");
});

// P0.12 fixtures (若已 committed)
test("fixture: multiline-block-scalar.yaml (P0.12)", () => {
  const p = path.join(process.cwd(), "doc/probe/fixtures/p12-antipatterns/multiline-block-scalar.yaml");
  if (fs.existsSync(p)) {
    assertEqual(validateYamlForApiKeyWrite(fs.readFileSync(p, "utf8")).ok, false);
  }
});

test("fixture: duplicate-key.yaml (P0.12)", () => {
  const p = path.join(process.cwd(), "doc/probe/fixtures/p12-antipatterns/duplicate-key.yaml");
  if (fs.existsSync(p)) {
    const r = validateYamlForApiKeyWrite(fs.readFileSync(p, "utf8"));
    assertEqual(r.ok, false);
    assertEqual(r.reason, "duplicate-api-key");
  }
});

test("fixture: upstream-placeholder.yaml (P0.12 control, should PASS)", () => {
  const p = path.join(process.cwd(), "doc/probe/fixtures/p12-antipatterns/upstream-placeholder.yaml");
  if (fs.existsSync(p)) {
    const r = validateYamlForApiKeyWrite(fs.readFileSync(p, "utf8"));
    assertEqual(r.ok, true);
    assertEqual(r.form, "D");
  }
});

console.log("# validateKeyContent");

test("accepts sk-key", () => { assertEqual(validateKeyContent("sk-abcdefghij01234567").ok, true); });
test("rejects empty", () => { assertEqual(validateKeyContent("").reason, "empty-key"); });
test("rejects newline in key", () => { assertEqual(validateKeyContent("sk-with\nnewline").reason, "whitespace-newline-in-key"); });
test("rejects too long", () => { assertEqual(validateKeyContent("a".repeat(5000)).reason, "key-too-long"); });
test("rejects control char", () => { assertEqual(validateKeyContent("sk-\u0007bel").reason, "control-char-in-key"); });

console.log("# escapeForYamlDoubleQuoted");
test("escapes backslash and quote", () => {
  assertEqual(escapeForYamlDoubleQuoted('it "works" \\here\\'), 'it \\"works\\" \\\\here\\\\');
});

console.log("# redactSecrets");
test("redacts sk- keys", () => {
  assertEqual(redactSecrets("Here is sk-abcdefghij0123456789 extra"), "Here is sk-***REDACTED*** extra");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
