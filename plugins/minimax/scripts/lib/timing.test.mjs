import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TimingAccumulator, dispatchTimingEvent,
  percentile, computeAggregateStats, filterHistory,
  formatMs, renderHistoryTable, renderAggregateTable, renderStatusSummaryLine,
} from "./timing.mjs";

const mkRecord = ({ kind = "ask", ts = "2026-04-22T10:00:00.000Z", jobId = "mj-X", timing = {} }) => ({
  _v: 1, jobId, kind, ts,
  timing: {
    firstEventMs: 100, ttftMs: null, streamMs: 1000, toolMs: null, retryMs: null,
    tailMs: 50, totalMs: 1150, usage: [], tokensPerSec: null,
    ...timing,
  },
});

test("TimingAccumulator: happy path — spawn/firstEvent/multiple stdout/close yields complete record", () => {
  const t0 = 1_000_000;
  const timing = new TimingAccumulator({ spawnedAt: t0, prompt: "hello" });
  timing.setRequestedModel("MiniMax-M2.7-highspeed");
  timing.onFirstEvent(t0 + 156);
  timing.onStdoutLine(t0 + 160);
  timing.onStdoutLine(t0 + 12_956);
  timing.recordResponseBytes(8912);
  timing.onClose(t0 + 13_032, { exitCode: 0, timedOut: false, signal: null });
  const rec = timing.build();
  assert.equal(rec.firstEventMs, 156);
  assert.equal(rec.streamMs, 12_800);
  assert.equal(rec.tailMs, 76);
  assert.equal(rec.totalMs, 13_032);
  assert.equal(rec.promptBytes, Buffer.byteLength("hello", "utf8"));
  assert.equal(rec.responseBytes, 8912);
  assert.equal(rec.exitCode, 0);
  assert.equal(rec.terminationReason, "exit");
  assert.equal(rec.timedOut, false);
  assert.equal(rec.signal, null);
  assert.equal(rec.requestedModel, "MiniMax-M2.7-highspeed");
  assert.deepEqual(rec.usage, []);
  assert.equal(rec.tokensPerSec, null);
  assert.equal(rec.coldStartPhases, null);
  assert.equal(rec.ttftMs, null);
  assert.equal(rec.toolMs, null);
  assert.equal(rec.retryMs, null);
  assert.equal(rec.invariantOk, true);
  assert.equal(rec.invariantKind, "3term");
});

test("TimingAccumulator: no-stdout path — firstEventMs/streamMs/tailMs all null", () => {
  const t0 = 2_000_000;
  const timing = new TimingAccumulator({ spawnedAt: t0 });
  timing.onClose(t0 + 500, { exitCode: 1, timedOut: false, signal: null });
  const rec = timing.build();
  assert.equal(rec.firstEventMs, null);
  assert.equal(rec.streamMs, null);
  assert.equal(rec.tailMs, null);
  assert.equal(rec.totalMs, 500);
  assert.equal(rec.exitCode, 1);
  assert.equal(rec.terminationReason, "error");
  assert.equal(rec.invariantOk, null);
});

test("TimingAccumulator: single stdout line — streamMs = 0", () => {
  const t0 = 3_000_000;
  const timing = new TimingAccumulator({ spawnedAt: t0 });
  timing.onFirstEvent(t0 + 200);
  timing.onClose(t0 + 250, { exitCode: 0, timedOut: false, signal: null });
  const rec = timing.build();
  assert.equal(rec.firstEventMs, 200);
  assert.equal(rec.streamMs, 0);
  assert.equal(rec.tailMs, 50);
  assert.equal(rec.totalMs, 250);
  assert.equal(rec.invariantOk, true);
});

test("TimingAccumulator: tailMs clamped ≥ 0 if close precedes lastEvent (clock skew)", () => {
  const t0 = 4_000_000;
  const timing = new TimingAccumulator({ spawnedAt: t0 });
  timing.onFirstEvent(t0 + 100);
  timing.onStdoutLine(t0 + 300);
  timing.onClose(t0 + 250, { exitCode: 0, timedOut: false, signal: null });
  const rec = timing.build();
  assert.equal(rec.tailMs, 0);
});

test("TimingAccumulator: onClose covers timeout / signal / error / exit", () => {
  const base = (state) => {
    const t = new TimingAccumulator({ spawnedAt: 0 });
    t.onClose(100, state);
    return t.build();
  };
  assert.equal(base({ exitCode: 0, timedOut: false, signal: null }).terminationReason, "exit");
  assert.equal(base({ exitCode: 124, timedOut: true, signal: null }).terminationReason, "timeout");
  assert.equal(base({ exitCode: 137, timedOut: false, signal: "SIGKILL" }).terminationReason, "signal");
  assert.equal(base({ exitCode: 2, timedOut: false, signal: null }).terminationReason, "error");
});

test("TimingAccumulator: invariantOk null when terminationReason !== 'exit'", () => {
  const t = new TimingAccumulator({ spawnedAt: 0 });
  t.onFirstEvent(100);
  t.onStdoutLine(200);
  t.onClose(300, { exitCode: 124, timedOut: true, signal: null });
  assert.equal(t.build().invariantOk, null);
});

test("TimingAccumulator: recordResponseBytes accumulates", () => {
  const t = new TimingAccumulator({ spawnedAt: 0 });
  t.recordResponseBytes(100);
  t.recordResponseBytes(200);
  t.onClose(1, { exitCode: 0 });
  assert.equal(t.build().responseBytes, 300);
});

test("TimingAccumulator: reserved no-op methods callable without throw (D2 contract)", () => {
  const t = new TimingAccumulator({ spawnedAt: 0 });
  for (const m of ["onFirstToken", "onLastToken", "onToolUseStart", "onToolResult",
                   "onRetryStart", "onRetryEnd", "onStartupStats", "onResult"]) {
    const ret = t[m]({ type: "anything" });
    assert.equal(ret, undefined, `${m} must return void, got ${ret}`);
  }
  const dispatched = dispatchTimingEvent({ type: "init", model: "X" }, t);
  assert.equal(dispatched, undefined);
  t.onFirstEvent(50);
  t.onClose(100, { exitCode: 0 });
  const rec = t.build();
  assert.equal(rec.firstEventMs, 50);
  assert.equal(rec.requestedModel, null);
});

test("TimingAccumulator: setRequestedModel first-wins", () => {
  const t = new TimingAccumulator({ spawnedAt: 0 });
  t.setRequestedModel("A");
  t.setRequestedModel("B");
  t.onClose(1, { exitCode: 0 });
  assert.equal(t.build().requestedModel, "A");
});

test("percentile: empty or all-null returns null", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([null, null], 0.5), null);
});

test("percentile: basic ranks", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([10, 20, 30, 40, 50], 0.95), 50);
  assert.equal(percentile([1, 2, 3], 0.99), 3);
});

test("computeAggregateStats: n=19 → p95 null, n=20 → p95 populated (boundary)", () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => mkRecord({ timing: { totalMs: 1000 + i } }));
  assert.equal(computeAggregateStats(mk(19)).percentiles.p95, null);
  assert.ok(computeAggregateStats(mk(20)).percentiles.p95);
});

test("computeAggregateStats: n=99 → p99 null, n=100 → p99 populated (boundary)", () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => mkRecord({ timing: { totalMs: 1000 + i } }));
  assert.equal(computeAggregateStats(mk(99)).percentiles.p99, null);
  assert.ok(computeAggregateStats(mk(100)).percentiles.p99);
});

test("computeAggregateStats: usage=[] everywhere → fallbackRate 0, usageAvailable false", () => {
  const records = [mkRecord({ timing: { usage: [] } }), mkRecord({ timing: { usage: [] } })];
  const stats = computeAggregateStats(records);
  assert.equal(stats.fallbackRate, 0);
  assert.equal(stats.fallbackCount, 0);
  assert.equal(stats.usageAvailable, false);
});

test("computeAggregateStats: fallback detected when any usage.length > 1", () => {
  const records = [
    mkRecord({ timing: { usage: [{ model: "A", input: 1, output: 1, thoughts: 0 }] } }),
    mkRecord({ timing: { usage: [
      { model: "A", input: 1, output: 1, thoughts: 0 },
      { model: "B-fallback", input: 0, output: 1, thoughts: 0 },
    ] } }),
  ];
  const stats = computeAggregateStats(records);
  assert.equal(stats.fallbackCount, 1);
  assert.equal(stats.fallbackRate, 0.5);
  assert.equal(stats.usageAvailable, true);
});

test("filterHistory: kind filter", () => {
  const recs = [mkRecord({ kind: "ask" }), mkRecord({ kind: "review" }), mkRecord({ kind: "ask" })];
  const out = filterHistory(recs, { kind: "ask" });
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.kind === "ask"));
});

test("filterHistory: since filter — future timestamp returns empty", () => {
  const recs = [mkRecord({ ts: "2026-04-22T10:00:00.000Z" })];
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const out = filterHistory(recs, { since: future });
  assert.equal(out.length, 0);
});

test("filterHistory: last N newest-first ordering", () => {
  const recs = [
    mkRecord({ jobId: "mj-oldest", ts: "2026-04-20T10:00:00.000Z" }),
    mkRecord({ jobId: "mj-middle", ts: "2026-04-21T10:00:00.000Z" }),
    mkRecord({ jobId: "mj-newest", ts: "2026-04-22T10:00:00.000Z" }),
  ];
  const out = filterHistory(recs, { last: 2 });
  assert.equal(out.length, 2);
  assert.equal(out[0].jobId, "mj-newest");
  assert.equal(out[1].jobId, "mj-middle");
});

test("filterHistory: kind 'all' passes through all records", () => {
  const recs = [mkRecord({ kind: "ask" }), mkRecord({ kind: "review" })];
  const out = filterHistory(recs, { kind: "all" });
  assert.equal(out.length, 2);
});

test("formatMs: units", () => {
  assert.equal(formatMs(null), "—");
  assert.equal(formatMs(500), "500ms");
  assert.equal(formatMs(1500), "1.5s");
  assert.equal(formatMs(65_500), "1m 5s");
});

test("renderHistoryTable: uses cliBoot header; null fields render '—'", () => {
  const rows = [mkRecord({ kind: "ask", timing: { firstEventMs: 156, streamMs: 12_800, tailMs: 76, totalMs: 13_032 } })];
  const out = renderHistoryTable(rows);
  assert.ok(out.includes("cliBoot"), "header must use 'cliBoot'");
  assert.ok(out.includes("156ms"));
  assert.ok(out.includes("—"), "null fields render as '—'");
  assert.ok(!out.match(/\bcold\b/), "literal 'cold' column header is removed");
});

test("renderHistoryTable: empty input returns header only", () => {
  const out = renderHistoryTable([]);
  assert.ok(out.includes("cliBoot"));
  assert.equal(out.trim().split("\n").length, 1);
});

test("renderHistoryTable: jobId > 13 chars is truncated with '…' so kind column stays aligned", () => {
  const long = "mj-b54d32f1-32f3-44d9-a2d2-f697c2dce723";
  const rows = [mkRecord({ jobId: long, kind: "ask", timing: { totalMs: 1000 } })];
  const out = renderHistoryTable(rows);
  const dataLine = out.split("\n")[1];
  assert.ok(!dataLine.includes(long), "full long jobId must not appear");
  assert.ok(dataLine.includes("mj-b54d32f1-3…"), `truncated form expected; got: ${dataLine}`);
  assert.match(dataLine, /mj-b54d32f1-3…\s{2}ask/, "exactly 2 spaces between truncated id and kind column");
});

test("renderHistoryTable: short jobId (≤13 chars) is preserved unchanged", () => {
  const rows = [mkRecord({ jobId: "mj-short", kind: "ask", timing: { totalMs: 100 } })];
  const out = renderHistoryTable(rows);
  const dataLine = out.split("\n")[1];
  assert.ok(dataLine.startsWith("mj-short"), "short id should appear verbatim");
  assert.ok(!dataLine.includes("…"), "no truncation marker for short ids");
});

test("renderHistoryTable: adversarial-red/blue abbreviated to adv-red/adv-blue (kind col stays 8-wide)", () => {
  const rows = [
    mkRecord({ jobId: "mj-r1", kind: "adversarial-red", timing: { totalMs: 62000 } }),
    mkRecord({ jobId: "mj-b1", kind: "adversarial-blue", timing: { totalMs: 24500 } }),
  ];
  const out = renderHistoryTable(rows);
  const [redLine, blueLine] = out.split("\n").slice(1, 3);
  assert.ok(redLine.includes("adv-red"), `expected 'adv-red'; got: ${redLine}`);
  assert.ok(!redLine.includes("adversarial-red"), "full 'adversarial-red' should NOT appear in history column");
  assert.ok(blueLine.includes("adv-blue"), `expected 'adv-blue'; got: ${blueLine}`);
  assert.ok(!blueLine.includes("adversarial-blue"), "full 'adversarial-blue' should NOT appear");
  // verify total column separation: kind 'adv-blue' (8) padEnd(8) + space before total
  assert.match(blueLine, /adv-blue\s+\d/, "adv-blue kind column must have whitespace before total");
});

test("renderHistoryTable: ask/review/rescue kinds are NOT abbreviated", () => {
  const rows = [
    mkRecord({ jobId: "mj-a", kind: "ask", timing: { totalMs: 1000 } }),
    mkRecord({ jobId: "mj-v", kind: "review", timing: { totalMs: 5000 } }),
    mkRecord({ jobId: "mj-s", kind: "rescue", timing: { totalMs: 7100 } }),
  ];
  const out = renderHistoryTable(rows);
  assert.match(out, /\bask\b/);
  assert.match(out, /\breview\b/);
  assert.match(out, /\brescue\b/);
});

test("renderAggregateTable: fallback rate renders '—' when usageAvailable false", () => {
  const stats = {
    n: 5,
    percentiles: { p50: { firstEventMs: 100, ttftMs: null, streamMs: 1000, toolMs: null, retryMs: null, totalMs: 1150 }, p95: null, p99: null },
    slowest: { jobId: "mj-X", totalMs: 1500, fallback: false },
    fallbackCount: 0, fallbackRate: 0, usageAvailable: false,
  };
  const out = renderAggregateTable(stats, { kind: "ask" });
  assert.ok(out.includes("n=5"));
  assert.ok(/fallback rate\s+—/.test(out), "renders em-dash when upstream usage unavailable");
  assert.ok(!out.match(/fallback rate\s+0\.0%/), "must NOT render 0.0% (misleading)");
});

test("renderAggregateTable: fallback rate renders percentage when usage available", () => {
  const stats = {
    n: 10, percentiles: { p50: null, p95: null, p99: null },
    slowest: null, fallbackCount: 1, fallbackRate: 0.1, usageAvailable: true,
  };
  const out = renderAggregateTable(stats, { kind: "ask" });
  assert.ok(/fallback rate\s+10\.0%/.test(out));
});

test("renderStatusSummaryLine: null timing returns em-dash", () => {
  assert.equal(renderStatusSummaryLine(null), "—");
});

test("renderStatusSummaryLine: populated fields only", () => {
  const out = renderStatusSummaryLine({
    firstEventMs: 156, ttftMs: null, streamMs: 12_800, toolMs: 0, retryMs: 0, tokensPerSec: null,
  });
  assert.ok(out.includes("cliBoot 156ms"));
  assert.ok(out.includes("gen 12.8s"));
  assert.ok(!out.includes("ttft"));
});

test("D7 integration: two distinct records under different kinds with different jobIds (via state.mjs ndjson)", async () => {
  const fs_ = await import("node:fs");
  const os_ = await import("node:os");
  const path_ = await import("node:path");
  const { appendTimingHistory } = await import("./state.mjs");
  const tmp = fs_.mkdtempSync(path_.join(os_.tmpdir(), "d7-"));
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tmp;
  try {
    const red = { _v: 1, jobId: "mj-red", kind: "adversarial-red", ts: "t1", timing: { totalMs: 100 } };
    const blue = { _v: 1, jobId: "mj-blue", kind: "adversarial-blue", ts: "t2", timing: { totalMs: 200 } };
    appendTimingHistory(red);
    appendTimingHistory(blue);
    const file = path_.join(tmp, "timings.ndjson");
    const lines = fs_.readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    const kinds = lines.map((l) => JSON.parse(l).kind).sort();
    assert.deepEqual(kinds, ["adversarial-blue", "adversarial-red"]);
    const jobIds = lines.map((l) => JSON.parse(l).jobId);
    assert.notEqual(jobIds[0], jobIds[1], "red and blue jobIds must differ");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    fs_.rmSync(tmp, { recursive: true, force: true });
  }
});
