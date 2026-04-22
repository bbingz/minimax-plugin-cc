import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callMiniAgent, classifyMiniAgentResult } from "./minimax.mjs";

function mkMockMiniAgent(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-mock-"));
  const binPath = path.join(dir, "mini-agent");
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return { binPath, dir };
}

function mkMockLogDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "minimax-log-"));
}

function buildLogText({ content = "hello from mock", finishReason = "stop" } = {}) {
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
    "{\"messages\": []}",
    "",
    "-".repeat(80),
    "[2] RESPONSE",
    "Timestamp: 2026-04-20 10:44:41.000",
    "-".repeat(80),
    "",
    body,
    "",
    ""
  ].join("\n");
}

test("callMiniAgent: happy path captures logPath from stdout and parses RESPONSE", async () => {
  const logDir = mkMockLogDir();
  const logPath = path.join(logDir, "agent_run_20260420_104430.log");
  fs.writeFileSync(logPath, buildLogText({ content: "hi there" }));

  const { binPath } = mkMockMiniAgent(`#!/bin/sh
printf 'Log file: %s\\n' "${logPath}"
printf 'Session Statistics:\\n'
exit 0
`);

  const progressLines = [];
  const r = await callMiniAgent({
    prompt: "hello",
    cwd: process.cwd(),
    timeout: 15_000,
    bin: binPath,
    logDir,
    onProgressLine: (line) => progressLines.push(line),
  });

  assert.equal(r.exitCode, 0);
  assert.equal(r.logPath, logPath);
  assert.equal(r.logParse.ok, true);
  assert.equal(r.logParse.response, "hi there");
  assert.equal(r.logParse.finishReason, "stop");
  assert.ok(progressLines.some(l => l.includes("Log file:")), "progress callback received Log file line");
});

test("callMiniAgent: logPath fallback via snapshot diff when stdout line missing", async () => {
  const logDir = mkMockLogDir();
  const expectedLog = path.join(logDir, "agent_run_20260420_104501.log");
  // Stage a pre-existing .log file (ends in .log so it enters snapshotBefore set).
  // Mock script then copies it to the "new" expected location; diff must only
  // find the newly-created expectedLog, not the pre-staged one.
  fs.writeFileSync(path.join(logDir, "_staged.log"), buildLogText({ content: "snapshot fallback ok" }));

  const { binPath } = mkMockMiniAgent(`#!/bin/sh
sleep 0.2
cp '${logDir}/_staged.log' '${expectedLog}'
printf 'Session Statistics:\\n'
exit 0
`);

  const r = await callMiniAgent({
    prompt: "hello",
    cwd: process.cwd(),
    timeout: 15_000,
    bin: binPath,
    logDir,
  });

  assert.equal(r.logPath, expectedLog, "snapshot diff must resolve the new .log file");
  assert.equal(r.logParse.ok, true);
  assert.equal(r.logParse.response, "snapshot fallback ok");
});

test("callMiniAgent: no log produced -> logParse is null, logPath is null, still resolves", async () => {
  const logDir = mkMockLogDir();
  const { binPath } = mkMockMiniAgent(`#!/bin/sh
printf 'some output but no Log file line and no log written\\n' >&2
exit 0
`);

  const r = await callMiniAgent({
    prompt: "hello",
    cwd: process.cwd(),
    timeout: 15_000,
    bin: binPath,
    logDir,
  });

  assert.equal(r.exitCode, 0);
  assert.equal(r.logPath, null);
  assert.equal(r.logParse, null);
  assert.ok(r.rawStderr.includes("no Log file line"));
});

test("callMiniAgent: spawnError (ENOENT) is surfaced, no log parse attempted", async () => {
  const logDir = mkMockLogDir();
  const r = await callMiniAgent({
    prompt: "x",
    cwd: process.cwd(),
    timeout: 5_000,
    bin: "/nonexistent/bin/mini-agent-xxxxx",
    logDir,
  });
  assert.ok(r.spawnError, "spawnError present");
  assert.equal(r.logPath, null);
  assert.equal(r.logParse, null);
});

test("callMiniAgent: timeout triggers SIGTERM and timedOut=true", async () => {
  const logDir = mkMockLogDir();
  const { binPath } = mkMockMiniAgent(`#!/bin/sh
sleep 30
`);
  const t0 = Date.now();
  const r = await callMiniAgent({
    prompt: "x",
    cwd: process.cwd(),
    timeout: 1_000,
    bin: binPath,
    logDir,
  });
  const dt = Date.now() - t0;
  assert.equal(r.timedOut, true);
  assert.ok(dt < 10_000, `timeout should resolve quickly, took ${dt}ms`);
});

test("classifyMiniAgentResult: success when finish_reason=stop + non-empty content", () => {
  const r = classifyMiniAgentResult({
    rawStdout: "Log file: /tmp/x.log\nSession Statistics:\n",
    rawStderr: "",
    exitCode: 0,
    signal: null,
    spawnError: null,
    timedOut: false,
    logPath: "/tmp/x.log",
    logParse: { ok: true, partial: false, response: "hi", toolCalls: [], thinking: null, finishReason: "stop" },
  });
  assert.equal(r.status, "success");
  assert.equal(r.response, "hi");
});

test("classifyMiniAgentResult: success when finish_reason=end_turn (Anthropic provider)", () => {
  const r = classifyMiniAgentResult({
    rawStdout: "", rawStderr: "", exitCode: 0, signal: null, spawnError: null, timedOut: false,
    logPath: "/tmp/x.log",
    logParse: { ok: true, partial: false, response: "Hello!", toolCalls: [], thinking: "greeting", finishReason: "end_turn" },
  });
  assert.equal(r.status, "success");
  assert.equal(r.response, "Hello!");
  assert.equal(r.finishReason, "end_turn");
});

test("classifyMiniAgentResult: success-but-truncated when finish_reason=length", () => {
  const r = classifyMiniAgentResult({
    rawStdout: "", rawStderr: "", exitCode: 0, signal: null, spawnError: null, timedOut: false,
    logPath: "/tmp/x.log",
    logParse: { ok: true, partial: false, response: "partial text", toolCalls: [], thinking: null, finishReason: "length" },
  });
  assert.equal(r.status, "success-but-truncated");
});

test("classifyMiniAgentResult: incomplete when finish_reason=tool_calls (agent未闭环)", () => {
  const r = classifyMiniAgentResult({
    rawStdout: "", rawStderr: "", exitCode: 0, signal: null, spawnError: null, timedOut: false,
    logPath: "/tmp/x.log",
    logParse: { ok: true, partial: false, response: "", toolCalls: [{id:"a",name:"bash",arguments:{}}], thinking: null, finishReason: "tool_calls" },
  });
  assert.equal(r.status, "incomplete");
});

test("classifyMiniAgentResult: needs-socksio overrides log-based classification (Layer 1)", () => {
  const r = classifyMiniAgentResult({
    rawStdout: "",
    rawStderr: "ImportError: Using SOCKS proxy but socksio not installed\n",
    exitCode: 0, signal: null, spawnError: null, timedOut: false,
    logPath: null, logParse: null,
  });
  assert.equal(r.status, "needs-socksio");
});

test("classifyMiniAgentResult: config-missing (Layer 1)", () => {
  const r = classifyMiniAgentResult({
    rawStdout: "", rawStderr: "Configuration file not found at ~/.mini-agent/config/config.yaml\n",
    exitCode: 0, signal: null, spawnError: null, timedOut: false,
    logPath: null, logParse: null,
  });
  assert.equal(r.status, "config-missing");
});

test("classifyMiniAgentResult: auth-not-configured (Layer 1)", () => {
  const r = classifyMiniAgentResult({
    rawStdout: "", rawStderr: "ValueError: Please configure a valid API Key\n",
    exitCode: 0, signal: null, spawnError: null, timedOut: false,
    logPath: null, logParse: null,
  });
  assert.equal(r.status, "auth-not-configured");
});

test("classifyMiniAgentResult: not-installed when spawnError ENOENT", () => {
  const r = classifyMiniAgentResult({
    rawStdout: "", rawStderr: "", exitCode: null, signal: null,
    spawnError: Object.assign(new Error("spawn mini-agent ENOENT"), { code: "ENOENT" }),
    timedOut: false, logPath: null, logParse: null,
  });
  assert.equal(r.status, "not-installed");
});

test("classifyMiniAgentResult: llm-call-failed when Retry failed in stdout (Layer 3)", () => {
  const r = classifyMiniAgentResult({
    rawStdout: "\x1b[31m❌ Retry failed\x1b[0m after 3 attempts\nSession Statistics:\n",
    rawStderr: "", exitCode: 0, signal: null, spawnError: null, timedOut: false,
    logPath: "/tmp/x.log",
    logParse: { ok: false, partial: true, reason: "no-response-block", response: "", toolCalls: [] },
  });
  assert.equal(r.status, "llm-call-failed");
});

test("classifyMiniAgentResult: success-claimed-but-no-log (Layer 3 fallback)", () => {
  const r = classifyMiniAgentResult({
    rawStdout: "Session Statistics:\nDuration: 1.2s\n", rawStderr: "",
    exitCode: 0, signal: null, spawnError: null, timedOut: false,
    logPath: null, logParse: null,
  });
  assert.equal(r.status, "success-claimed-but-no-log");
});

test("classifyMiniAgentResult: unknown-crashed default fallback", () => {
  const r = classifyMiniAgentResult({
    rawStdout: "", rawStderr: "some unexpected error\n",
    exitCode: 1, signal: null, spawnError: null, timedOut: false,
    logPath: null, logParse: null,
  });
  assert.equal(r.status, "unknown-crashed");
});

test("classifyMiniAgentResult: timedOut maps to llm-call-failed with reason=hard-timeout", () => {
  const r = classifyMiniAgentResult({
    rawStdout: "", rawStderr: "", exitCode: null, signal: "SIGKILL",
    spawnError: null, timedOut: true, logPath: null, logParse: null,
  });
  assert.equal(r.status, "llm-call-failed");
  assert.equal(r.reason, "hard-timeout");
});

test("classifyMiniAgentResult: diagnostic bundle includes stderr head+tail (ANSI stripped)", () => {
  const stderr = "line1\n\x1b[31merror: something\x1b[0m\n" + "x".repeat(3000) + "\ntail line\n";
  const r = classifyMiniAgentResult({
    rawStdout: "", rawStderr: stderr, exitCode: 0, signal: null, spawnError: null, timedOut: false,
    logPath: null, logParse: null,
  });
  assert.ok(r.diagnostic, "diagnostic bundle exists for non-success");
  assert.ok(!r.diagnostic.stderrHeadTail.includes("\x1b["), "ANSI stripped");
  assert.ok(r.diagnostic.stderrHeadTail.includes("line1"));
  assert.ok(r.diagnostic.stderrHeadTail.includes("tail line"));
});

test("classifyMiniAgentResult: spawn-failed for non-ENOENT spawnError", () => {
  const r = classifyMiniAgentResult({
    rawStdout: "", rawStderr: "", exitCode: null, signal: null,
    spawnError: Object.assign(new Error("spawn mini-agent EACCES"), { code: "EACCES" }),
    timedOut: false, logPath: null, logParse: null,
  });
  assert.equal(r.status, "spawn-failed");
  assert.ok(r.detail && r.detail.includes("EACCES"), `expected detail to include EACCES, got: ${r.detail}`);
});

test("callMiniAgent v0.1.3: return envelope includes timing/jobId/kind; prior fields preserved", async () => {
  const logDir = mkMockLogDir();
  const logPath = path.join(logDir, "agent_run_20260420_104430.log");
  fs.writeFileSync(logPath, buildLogText({ content: "hello world" }));
  const { binPath } = mkMockMiniAgent(`#!/bin/sh
printf 'Log file: %s\\n' "${logPath}"
printf 'Session Statistics:\\n'
exit 0
`);

  const result = await callMiniAgent({
    prompt: "hello",
    cwd: process.cwd(),
    timeout: 15_000,
    bin: binPath,
    logDir,
    jobId: "mj-regression",
    kind: "ask",
  });

  // PRIOR return shape preserved (v0.1.2 contract):
  for (const field of ["prompt","cwd","exitCode","signal","timedOut","spawnError","rawStdout","rawStderr","stdoutTruncated","stderrTruncated","logPath","logParse"]) {
    assert.ok(field in result, `prior field '${field}' must still be on result`);
  }
  assert.equal(result.prompt, "hello");
  assert.equal(result.exitCode, 0);

  // NEW fields (v0.1.3):
  assert.ok(result.timing, "result.timing must be present");
  assert.equal(typeof result.timing, "object");
  assert.equal(result.timing.invariantKind, "3term");
  assert.equal(result.jobId, "mj-regression");
  assert.equal(result.kind, "ask");
  assert.ok(result.timing.responseBytes > 0, "responseBytes derived from logParse.response");

  // Null defaults when tags omitted (legacy-caller compat per spec §5):
  const legacy = await callMiniAgent({
    prompt: "hi",
    cwd: process.cwd(),
    timeout: 15_000,
    bin: binPath,
    logDir,
  });
  assert.equal(legacy.jobId, null);
  assert.equal(legacy.kind, null);
  assert.ok(legacy.timing);
});
