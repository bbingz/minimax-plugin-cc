import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendTimingHistory, resolveTimingHistoryFile } from "./state.mjs";

async function withTmpPluginData(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-timing-"));
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tmp;
  try { return await fn(tmp); }
  finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("appendTimingHistory: basic append + each line JSON-parseable + returns true", () => {
  withTmpPluginData((tmp) => {
    const ok1 = appendTimingHistory({ _v: 1, jobId: "mj-1", kind: "ask", ts: "t1", timing: { totalMs: 100 } });
    const ok2 = appendTimingHistory({ _v: 1, jobId: "mj-2", kind: "ask", ts: "t2", timing: { totalMs: 200 } });
    assert.equal(ok1, true);
    assert.equal(ok2, true);
    const lines = fs.readFileSync(path.join(tmp, "timings.ndjson"), "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    for (const line of lines) JSON.parse(line);
  });
});

test("appendTimingHistory: 10MB cap triggers half-trim; retained lines are newer half", () => {
  withTmpPluginData((tmp) => {
    const pad = "x".repeat(6_000);
    for (let i = 0; i < 2000; i++) {
      appendTimingHistory({ _v: 1, jobId: `mj-${i}`, kind: "ask", ts: `t${i}`, timing: { pad } });
    }
    const final = fs.readFileSync(path.join(tmp, "timings.ndjson"), "utf8").split("\n").filter(Boolean);
    assert.ok(final.length < 2000, `expected trim; got ${final.length}`);
    const firstId = JSON.parse(final[0]).jobId;
    const firstIdx = Number(firstId.slice(3));
    assert.ok(firstIdx > 500, `first retained jobId should be > mj-500; got ${firstId}`);
  });
});

test("appendTimingHistory: crash recovery — file without trailing newline gets one prepended", () => {
  withTmpPluginData((tmp) => {
    const file = path.join(tmp, "timings.ndjson");
    fs.writeFileSync(file, `{"partial":true}`);
    const ok = appendTimingHistory({ _v: 1, jobId: "mj-new", kind: "ask", ts: "t1", timing: {} });
    assert.equal(ok, true);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).partial, true);
    assert.equal(JSON.parse(lines[1]).jobId, "mj-new");
  });
});

test("appendTimingHistory: concurrent (Promise.all) — all succeed, all records present", async () => {
  await withTmpPluginData(async (tmp) => {
    const rec = (id) => ({ _v: 1, jobId: id, kind: "ask", ts: "t", timing: {} });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => Promise.resolve(appendTimingHistory(rec(`mj-${i}`))))
    );
    assert.ok(results.every((r) => r === true), "all 10 concurrent appends must return true");
    const lines = fs.readFileSync(path.join(tmp, "timings.ndjson"), "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 10);
    for (const line of lines) JSON.parse(line);
  });
});

test("appendTimingHistory: empty 0-byte file — no leading newline prepended", () => {
  withTmpPluginData((tmp) => {
    const file = path.join(tmp, "timings.ndjson");
    fs.writeFileSync(file, "");
    appendTimingHistory({ _v: 1, jobId: "mj-1", kind: "ask", ts: "t", timing: {} });
    const content = fs.readFileSync(file, "utf8");
    assert.ok(!content.startsWith("\n"), "empty file path must not prepend newline");
    assert.equal(content.split("\n").filter(Boolean).length, 1);
  });
});

test("resolveTimingHistoryFile: respects CLAUDE_PLUGIN_DATA env, else falls back to ~/.claude/plugins/data/minimax-minimax-plugin", () => {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = "/tmp/explicit-test-path";
  try {
    assert.equal(resolveTimingHistoryFile(), "/tmp/explicit-test-path/timings.ndjson");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
  delete process.env.CLAUDE_PLUGIN_DATA;
  const fallback = resolveTimingHistoryFile();
  assert.ok(fallback.endsWith("/timings.ndjson"), "fallback ends with filename");
  assert.ok(fallback.includes("minimax-minimax-plugin"), `fallback path must match Gemini-style; got ${fallback}`);
});
