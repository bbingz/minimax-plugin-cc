#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import {
  validateYamlForApiKeyWrite,
  validateKeyContent,
  escapeForYamlDoubleQuoted,
  redactSecrets,
  extractLogPathFromStdout,
  parseFinalResponseFromLog,
  buildAdversarialPrompt,
  RED_STANCE_INSTRUCTION,
  BLUE_STANCE_INSTRUCTION,
  _invalidateAdversarialTemplateCache,
} from "./minimax.mjs";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++; }
}
async function asyncTest(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
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

test("Form S unclosed fails", () => {
  const r = validateYamlForApiKeyWrite("api_key: 'unclosed\nmodel: 'x'\n");
  assertEqual(r.reason, "form-S-unclosed");
});

test("Form S with trailing content fails", () => {
  const r = validateYamlForApiKeyWrite("api_key: 'foo' junk\nmodel: 'x'\n");
  assertEqual(r.reason, "form-S-trailing-content");
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

console.log("# buildAdversarialPrompt (Phase 5 Task 5.2)");
const ADVERSARIAL_SCHEMA_PATH = path.resolve("plugins/minimax/schemas/review-output.schema.json");

test("buildAdversarialPrompt: red stance injects RED_STANCE_INSTRUCTION verbatim", () => {
  _invalidateAdversarialTemplateCache();
  const out = buildAdversarialPrompt({
    stance: "red",
    schemaPath: ADVERSARIAL_SCHEMA_PATH,
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
    schemaPath: ADVERSARIAL_SCHEMA_PATH,
    focus: "",
    context: "diff --git a/x.js b/x.js\n+let x = 1;\n",
  });
  assert.ok(out.includes(BLUE_STANCE_INSTRUCTION), "blue stance text must appear");
  assert.ok(!out.includes(RED_STANCE_INSTRUCTION), "red stance text must NOT appear when stance=blue");
  assert.ok(out.includes("(no additional focus provided)"), "empty focus → placeholder default");
});

test("buildAdversarialPrompt: rejects unknown stance", () => {
  assert.throws(
    () => buildAdversarialPrompt({ stance: "purple", schemaPath: ADVERSARIAL_SCHEMA_PATH, focus: "", context: "x" }),
    /stance must be 'red' or 'blue'/
  );
});

test("buildAdversarialPrompt: retry hint and previousRaw are interpolated and redacted", () => {
  _invalidateAdversarialTemplateCache();
  const previous = "leak token sk-aaaaaaaaaaaaaaaaaaaa secret";
  const out = buildAdversarialPrompt({
    stance: "red",
    schemaPath: ADVERSARIAL_SCHEMA_PATH,
    focus: "",
    context: "x",
    retryHint: "schema validation errors: bad type",
    previousRaw: previous,
  });
  assert.ok(out.includes("# 重试提示"), "retry block must render (Chinese title per C4)");
  assert.ok(out.includes("schema validation errors: bad type"));
  assert.ok(out.includes("sk-***REDACTED***"), "secret must be redacted");
  assert.ok(!out.includes("sk-aaaaaaaaaaaaaaaaaaaa"), "raw secret must not leak");
});

test("buildAdversarialPrompt: user diff containing {{X}} is NOT mistaken for leftover placeholder (C3 regression)", () => {
  _invalidateAdversarialTemplateCache();
  const reactDiff = "diff --git a/x.jsx b/x.jsx\n+const Greeting = () => <div>{{userName}}</div>;\n";
  const out = buildAdversarialPrompt({
    stance: "red",
    schemaPath: ADVERSARIAL_SCHEMA_PATH,
    focus: "",
    context: reactDiff,
  });
  assert.ok(out.includes("{{userName}}"), "user content {{X}} must survive verbatim into final prompt");
  assert.ok(!out.includes("{{STANCE_INSTRUCTION}}"), "real placeholders still substituted");
  assert.ok(!out.includes("{{CONTEXT}}"), "real placeholders still substituted");
});

test("buildAdversarialPrompt: previousRaw containing literal {{CONTEXT}} does NOT poison substitution (M2 v0.1.1)", () => {
  _invalidateAdversarialTemplateCache();
  // Simulate a model first-shot response that happens to mention "{{CONTEXT}}" in
  // its prose (e.g. explaining why its output failed) — this gets fed back as
  // previousRaw on retry. Pre-M2: the literal {{CONTEXT}} would be replaced first
  // (first-match) leaving the real slot unfilled and triggering misleading error.
  const previous = "I confused myself: I thought {{CONTEXT}} was a literal marker.";
  const out = buildAdversarialPrompt({
    stance: "blue",
    schemaPath: ADVERSARIAL_SCHEMA_PATH,
    focus: "",
    context: "REAL_DIFF_PAYLOAD",
    retryHint: "schema validation errors: bad type",
    previousRaw: previous,
  });
  assert.ok(out.includes("REAL_DIFF_PAYLOAD"), "real context payload must reach the {{CONTEXT}} slot");
  assert.ok(out.includes("{{CONTEXT}}"), "previousRaw's literal {{CONTEXT}} must survive verbatim (treated as user data)");
  assert.ok(!out.includes("__MINIMAX_CONTEXT_SLOT__"), "internal sentinel must not leak");
});

(async () => {
  console.log("# extractLogPathFromStdout");

  test("extracts plain log line", () => {
    const s = "Loading...\n📝 Log file: /Users/x/.mini-agent/log/agent_run_20260420_104430.log\nMore";
    assertEqual(extractLogPathFromStdout(s), "/Users/x/.mini-agent/log/agent_run_20260420_104430.log");
  });

  test("extracts ANSI-wrapped log line", () => {
    const s = "\x1b[2m📝 Log file: /tmp/agent_run_test.log\x1b[0m";
    assertEqual(extractLogPathFromStdout(s), "/tmp/agent_run_test.log");
  });

  test("returns null if absent", () => {
    assertEqual(extractLogPathFromStdout("No log here"), null);
  });

  console.log("# parseFinalResponseFromLog (state machine + OpenAI schema)");
  const fs = await import("node:fs");

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
    assertEqual(r.blockIndex, 2);
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

  await asyncTest("handles multi-line pretty-printed JSON (scanBraces cross-line)", async () => {
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

  await asyncTest("401 scenario (no RESPONSE block) returns partial:true", async () => {
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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
