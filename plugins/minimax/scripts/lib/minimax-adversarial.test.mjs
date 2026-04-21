import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { callMiniAgentAdversarial } from "./minimax.mjs";

const SCHEMA_PATH = path.resolve("plugins/minimax/schemas/review-output.schema.json");

// Build a mini-agent log file on disk whose RESPONSE block carries `content`.
// Mirrors the buildLogText pattern in minimax.ask.test.mjs (per v2 I6).
function writeLogFile(logPath, { content, finishReason = "stop" }) {
  const body = JSON.stringify({ content, thinking: null, tool_calls: [], finish_reason: finishReason });
  const text = [
    "=".repeat(80),
    "Agent Run Log - mock",
    "=".repeat(80),
    "",
    "-".repeat(80),
    "[1] REQUEST",
    "-".repeat(80),
    "{\"messages\": []}",
    "",
    "-".repeat(80),
    "[2] RESPONSE",
    "-".repeat(80),
    "",
    body,
    "",
  ].join("\n");
  fs.writeFileSync(logPath, text);
}

// Random suffix per call avoids retry collision when the same stance is invoked
// twice in quick succession (v2 I4 — second spawn must produce a fresh log path).
function rand() { return Math.random().toString(36).slice(2, 8); }

// Build a fake mini-agent that:
//   - Inspects -t <prompt> for 红队/蓝队 tokens to determine stance.
//   - Appends the stance to a trace file (v2 I2 — lets tests assert spawn count).
//   - Writes a fresh log file with the canned content for that stance, then
//     prints "Log file: <path>" so callMiniAgent can pick it up.
function makeFakeBin({ redResponse, blueResponse }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-agent-fake-"));
  const binPath = path.join(tmpDir, "mini-agent");
  const logDir = path.join(tmpDir, "log");
  const traceFile = path.join(tmpDir, "trace.log");
  const redResponseFile = path.join(tmpDir, "red-response.txt");
  const blueResponseFile = path.join(tmpDir, "blue-response.txt");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(traceFile, "");
  fs.writeFileSync(redResponseFile, redResponse);
  fs.writeFileSync(blueResponseFile, blueResponse);

  // The shell script needs three pieces of state per invocation:
  //   stance from prompt, response file path, log path with random suffix.
  // We construct via a Node helper invoked from sh — sh just orchestrates.
  const helperPath = path.join(tmpDir, "mock-helper.mjs");
  fs.writeFileSync(helperPath, `
import fs from "node:fs";
const [, , stance, responsePath, logPath] = process.argv;
const content = fs.readFileSync(responsePath, "utf8");
const body = JSON.stringify({ content, thinking: null, tool_calls: [], finish_reason: "stop" });
const text = [
  "=".repeat(80),
  "Agent Run Log - mock",
  "=".repeat(80),
  "",
  "-".repeat(80),
  "[1] REQUEST",
  "-".repeat(80),
  '{"messages": []}',
  "",
  "-".repeat(80),
  "[2] RESPONSE",
  "-".repeat(80),
  "",
  body,
  "",
].join("\\n");
fs.writeFileSync(logPath, text);
fs.appendFileSync(process.env.MOCK_TRACE_FILE, stance + "\\n");
process.stdout.write("Log file: " + logPath + "\\n");
process.stdout.write("Session Statistics:\\n");
`);

  const script = `#!/bin/sh
PROMPT=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-t" ]; then shift; PROMPT="$1"; break; fi
  shift
done
case "$PROMPT" in
  *"你是红队"*) STANCE=red; RESP_PATH="${redResponseFile}" ;;
  *"你是蓝队"*) STANCE=blue; RESP_PATH="${blueResponseFile}" ;;
  *) STANCE=unknown; RESP_PATH="${redResponseFile}" ;;
esac
TS=$(date +%Y%m%d_%H%M%S)
RAND=$(awk 'BEGIN{srand(); printf "%06x", int(rand()*16777216)}')
LOGFILE="${logDir}/agent_run_\${TS}_\${STANCE}_\${RAND}.log"
node ${helperPath} "$STANCE" "$RESP_PATH" "$LOGFILE"
exit 0
`;
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  process.env.MOCK_TRACE_FILE = traceFile;

  return {
    binPath,
    logDir,
    traceFile,
    readTrace: () => fs.readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean),
    cleanup: () => {
      delete process.env.MOCK_TRACE_FILE;
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

test("callMiniAgentAdversarial: red parse fails → ok=false side=red, no blue spawn", async () => {
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
    const trace = fake.readTrace();
    const redCount = trace.filter(s => s === "red").length;
    const blueCount = trace.filter(s => s === "blue").length;
    assert.equal(redCount, 1, "red spawned once (success)");
    assert.equal(blueCount, 2, "blue spawned twice (first + retry)");
  } finally {
    fake.cleanup();
  }
});

// writeLogFile helper kept exported for symmetry/future tests; suppress unused-warning by referencing it.
if (typeof writeLogFile === "function" && process.env.UNUSED) writeLogFile();
if (typeof rand === "function" && process.env.UNUSED) rand();
