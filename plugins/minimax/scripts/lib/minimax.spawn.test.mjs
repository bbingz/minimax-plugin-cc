import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnWithHardTimeout } from "./minimax.mjs";

test("spawnWithHardTimeout: onStdoutLine is called once per newline-terminated line", async () => {
  const lines = [];
  const result = await spawnWithHardTimeout(
    "node",
    ["-e", "process.stdout.write('first\\nsecond\\nthird\\n'); process.exit(0);"],
    { timeoutMs: 5_000, onStdoutLine: (line) => lines.push(line) }
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(lines, ["first", "second", "third"]);
});

test("spawnWithHardTimeout: onStdoutLine handles split-across-chunks", async () => {
  const lines = [];
  const result = await spawnWithHardTimeout(
    "node",
    ["-e", `
      process.stdout.write('par');
      setTimeout(() => process.stdout.write('tial\\ndone\\n'), 50);
    `],
    { timeoutMs: 5_000, onStdoutLine: (line) => lines.push(line) }
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(lines, ["partial", "done"]);
});

test("spawnWithHardTimeout: stdout ring buffer caps at maxStdoutBytes", async () => {
  // produce 2MB of stdout
  const result = await spawnWithHardTimeout(
    "node",
    ["-e", "for (let i = 0; i < 2048; i++) process.stdout.write('x'.repeat(1024));"],
    { timeoutMs: 10_000, maxStdoutBytes: 64 * 1024 } // 64KB cap
  );
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.length <= 64 * 1024, `stdout length ${result.stdout.length} exceeds cap`);
  assert.equal(result.stdoutTruncated, true);
});

test("spawnWithHardTimeout: old callers without options still work (no regression)", async () => {
  const result = await spawnWithHardTimeout("node", ["-e", "console.log('ok');"], { timeoutMs: 5_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "ok");
  // Fields used by getMiniAgentAuthStatus / other Task-1.x callers -- must still exist
  assert.equal(typeof result.timedOut, "boolean");
  assert.equal(result.spawnError, null);
  assert.equal(result.stdoutTruncated, false);
  assert.equal(result.stderrTruncated, false);
});
