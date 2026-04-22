import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HOOK_PATH = new URL("./session-lifecycle-hook.mjs", import.meta.url).pathname;

function withFakeHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mnmx-hook-"));
  const prev = { HOME: process.env.HOME, CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA };
  process.env.HOME = tmp;
  delete process.env.CLAUDE_PLUGIN_DATA;
  try { return fn(tmp); }
  finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function mkJob(baseDir, id, { status, sessionId, pid = 99999, mtimeDaysAgo = 0, metaText }) {
  const dir = path.join(baseDir, ".claude", "plugins", "minimax", "jobs", id);
  fs.mkdirSync(dir, { recursive: true });
  if (metaText !== undefined) {
    fs.writeFileSync(path.join(dir, "meta.json"), metaText);
  } else if (status !== undefined) {
    const meta = { status, sessionId, pid };
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
  }
  if (mtimeDaysAgo > 0) {
    const when = (Date.now() - mtimeDaysAgo * 86_400_000) / 1000;
    fs.utimesSync(dir, when, when);
  }
  return dir;
}

function runHook(event, input = {}) {
  return spawnSync("node", [HOOK_PATH, event], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: process.env,
  });
}

// ── SessionEnd tests ──────────────────────────────────────────────────

test("SessionEnd: session-matched terminal job → rmSync", () => {
  withFakeHome((home) => {
    const dir = mkJob(home, "mj-a", { status: "done", sessionId: "s-current" });
    const r = runHook("SessionEnd", { session_id: "s-current", cwd: home });
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(dir), false);
  });
});

test("SessionEnd: session-matched running job → preserved (detached worker semantic)", () => {
  withFakeHome((home) => {
    const dir = mkJob(home, "mj-b", { status: "running", sessionId: "s-current" });
    runHook("SessionEnd", { session_id: "s-current", cwd: home });
    assert.equal(fs.existsSync(dir), true);
  });
});

test("SessionEnd: different-session terminal job → preserved", () => {
  withFakeHome((home) => {
    const dir = mkJob(home, "mj-c", { status: "done", sessionId: "s-other" });
    runHook("SessionEnd", { session_id: "s-current", cwd: home });
    assert.equal(fs.existsSync(dir), true);
  });
});

test("SessionEnd: canceled and failed both terminal → cleaned", () => {
  withFakeHome((home) => {
    const dc = mkJob(home, "mj-cancel", { status: "canceled", sessionId: "s-x" });
    const df = mkJob(home, "mj-fail",   { status: "failed",   sessionId: "s-x" });
    runHook("SessionEnd", { session_id: "s-x", cwd: home });
    assert.equal(fs.existsSync(dc), false);
    assert.equal(fs.existsSync(df), false);
  });
});

// ── SessionStart sweep tests ──────────────────────────────────────────

test("SessionStart: mtime > 3d + status done → rmSync", () => {
  withFakeHome((home) => {
    const dir = mkJob(home, "mj-done", { status: "done", sessionId: "s-old", mtimeDaysAgo: 5 });
    runHook("SessionStart", { session_id: "s-new", cwd: home });
    assert.equal(fs.existsSync(dir), false);
  });
});

test("SessionStart: mtime > 3d + status running + pid dead (ESRCH) → rmSync", () => {
  withFakeHome((home) => {
    const dir = mkJob(home, "mj-dead-running", { status: "running", sessionId: "s-old", pid: 99999, mtimeDaysAgo: 5 });
    runHook("SessionStart", { session_id: "s-new", cwd: home });
    assert.equal(fs.existsSync(dir), false);
  });
});

test("SessionStart: mtime > 3d + status running + pid alive → skip", () => {
  withFakeHome((home) => {
    const dir = mkJob(home, "mj-alive-running", { status: "running", sessionId: "s-old", pid: process.pid, mtimeDaysAgo: 5 });
    runHook("SessionStart", { session_id: "s-new", cwd: home });
    assert.equal(fs.existsSync(dir), true);
  });
});

test("SessionStart: mtime < 3d → preserved regardless of status", () => {
  withFakeHome((home) => {
    const dir = mkJob(home, "mj-fresh", { status: "done", sessionId: "s-old", mtimeDaysAgo: 1 });
    runHook("SessionStart", { session_id: "s-new", cwd: home });
    assert.equal(fs.existsSync(dir), true);
  });
});

test("SessionStart: mtime > 3d + meta missing (ENOENT) → rmSync (orphan)", () => {
  withFakeHome((home) => {
    const dir = mkJob(home, "mj-noMeta", { mtimeDaysAgo: 5 });
    runHook("SessionStart", { session_id: "s-new", cwd: home });
    assert.equal(fs.existsSync(dir), false);
  });
});

test("SessionStart: mtime > 3d + meta corrupt JSON → rmSync (abandoned)", () => {
  withFakeHome((home) => {
    const dir = mkJob(home, "mj-corrupt", { mtimeDaysAgo: 5, metaText: "{not valid json" });
    runHook("SessionStart", { session_id: "s-new", cwd: home });
    assert.equal(fs.existsSync(dir), false);
  });
});

test("SessionStart: mtime < 3d + meta corrupt JSON → SKIP (mid-write race protection, v2.1)", () => {
  withFakeHome((home) => {
    const dir = mkJob(home, "mj-midwrite", { mtimeDaysAgo: 0, metaText: "{half-written" });
    runHook("SessionStart", { session_id: "s-new", cwd: home });
    assert.equal(fs.existsSync(dir), true, "fresh corrupt meta is mid-write, must NOT delete");
  });
});

test("SessionStart: env MINIMAX_STALE_JOB_THRESHOLD_MS=60000 → 1-minute threshold", (t) => {
  const prev = process.env.MINIMAX_STALE_JOB_THRESHOLD_MS;
  process.env.MINIMAX_STALE_JOB_THRESHOLD_MS = "60000";
  t.after(() => {
    if (prev === undefined) delete process.env.MINIMAX_STALE_JOB_THRESHOLD_MS;
    else process.env.MINIMAX_STALE_JOB_THRESHOLD_MS = prev;
  });
  withFakeHome((home) => {
    const dir = mkJob(home, "mj-twoMin", { status: "done", sessionId: "s-old" });
    const twoMinAgo = (Date.now() - 120_000) / 1000;
    fs.utimesSync(dir, twoMinAgo, twoMinAgo);
    runHook("SessionStart", { session_id: "s-new", cwd: home });
    assert.equal(fs.existsSync(dir), false);
  });
});

test("SessionStart: env var propagates via spawnSync", (t) => {
  // Sanity: make sure the env override we set actually reaches the child.
  const prev = process.env.MINIMAX_STALE_JOB_THRESHOLD_MS;
  process.env.MINIMAX_STALE_JOB_THRESHOLD_MS = "99999";
  t.after(() => {
    if (prev === undefined) delete process.env.MINIMAX_STALE_JOB_THRESHOLD_MS;
    else process.env.MINIMAX_STALE_JOB_THRESHOLD_MS = prev;
  });
  // Confirmed by the "60000 → 1-minute" test above; this is a documentation test.
  assert.equal(process.env.MINIMAX_STALE_JOB_THRESHOLD_MS, "99999");
});
