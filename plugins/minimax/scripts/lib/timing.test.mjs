import { test } from "node:test";
import assert from "node:assert/strict";
import { TimingAccumulator, dispatchTimingEvent } from "./timing.mjs";

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
