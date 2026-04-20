import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callMiniAgent } from "./minimax.mjs";

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
