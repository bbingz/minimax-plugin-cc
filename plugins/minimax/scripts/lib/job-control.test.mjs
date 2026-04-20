import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createJob, readJob, updateJobMeta, listJobs, jobDir,
} from "./job-control.mjs";

function mkWorkspaceRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "minimax-jobs-"));
}

test("createJob: initializes meta with queued status and mj- prefix id", () => {
  const root = mkWorkspaceRoot();
  const job = createJob({
    workspaceRoot: root,
    prompt: "hello",
    cwd: process.cwd(),
    sandbox: false,
    sessionId: "sess-abc",
  });
  assert.ok(job.jobId.startsWith("mj-"), `jobId should start with mj-, got ${job.jobId}`);
  assert.equal(job.meta.status, "queued");
  assert.equal(job.meta.sandbox, false);
  assert.equal(job.meta.canceled, false);
  assert.equal(job.meta.prompt, "hello");
  assert.equal(job.meta.cwd, process.cwd());
  assert.equal(job.meta.sessionId, "sess-abc");
  assert.equal(typeof job.meta.createdAt, "number");
  assert.equal(job.meta.timeout, 300_000);
  assert.ok(fs.existsSync(path.join(jobDir(root, job.jobId), "meta.json")));
});

test("createJob: --sandbox creates workspace/ subdir", () => {
  const root = mkWorkspaceRoot();
  const job = createJob({ workspaceRoot: root, prompt: "x", cwd: process.cwd(), sandbox: true, sessionId: "s" });
  assert.equal(job.meta.sandbox, true);
  assert.ok(fs.existsSync(path.join(jobDir(root, job.jobId), "workspace")));
  assert.equal(job.meta.workdir, path.join(jobDir(root, job.jobId), "workspace"));
});

test("createJob: default workdir === cwd (no workspace mkdir)", () => {
  const root = mkWorkspaceRoot();
  const job = createJob({ workspaceRoot: root, prompt: "x", cwd: "/tmp/proj", sandbox: false, sessionId: "s" });
  assert.equal(job.meta.workdir, "/tmp/proj");
  assert.equal(fs.existsSync(path.join(jobDir(root, job.jobId), "workspace")), false);
});

test("createJob: timeout field persisted into meta", () => {
  const root = mkWorkspaceRoot();
  const job = createJob({ workspaceRoot: root, prompt: "x", cwd: "/", sandbox: false, sessionId: "s", timeout: 45_000 });
  assert.equal(job.meta.timeout, 45_000);
});

test("readJob / updateJobMeta: round-trip atomic update", async () => {
  const root = mkWorkspaceRoot();
  const job = createJob({ workspaceRoot: root, prompt: "x", cwd: "/tmp", sandbox: false, sessionId: "s" });
  await updateJobMeta(root, job.jobId, { status: "running", pid: 12345 });
  const after = readJob(root, job.jobId);
  assert.equal(after.status, "running");
  assert.equal(after.pid, 12345);
  assert.equal(after.prompt, "x");
});

test("readJob: returns null for missing job", () => {
  const root = mkWorkspaceRoot();
  assert.equal(readJob(root, "mj-does-not-exist"), null);
});

test("listJobs: returns newest-first by createdAt", async () => {
  const root = mkWorkspaceRoot();
  const a = createJob({ workspaceRoot: root, prompt: "a", cwd: "/", sandbox: false, sessionId: "s" });
  // Guarantee a different createdAt
  await new Promise(r => setTimeout(r, 5));
  const b = createJob({ workspaceRoot: root, prompt: "b", cwd: "/", sandbox: false, sessionId: "s" });
  const list = listJobs(root);
  assert.ok(list.length === 2);
  assert.ok(list[0].createdAt >= list[1].createdAt, "newest first");
});

test("listJobs: empty on missing root returns []", () => {
  const root = path.join(os.tmpdir(), "minimax-jobs-" + Date.now() + "-none");
  assert.deepEqual(listJobs(root), []);
});

test("updateJobMeta: rejects unknown status but accepts known ones", async () => {
  const root = mkWorkspaceRoot();
  const job = createJob({ workspaceRoot: root, prompt: "x", cwd: "/", sandbox: false, sessionId: "s" });
  for (const s of ["queued", "starting", "running", "done", "failed", "canceled"]) {
    await updateJobMeta(root, job.jobId, { status: s });
  }
  await assert.rejects(
    () => updateJobMeta(root, job.jobId, { status: "totally-bogus" }),
    /invalid status/
  );
});

// ── Task 4.2: serial queue ──────────────────────────────────────────────

import { acquireQueueSlot, releaseQueueSlot, queueLockPath } from "./job-control.mjs";

test("acquireQueueSlot: acquires when no prior lock; releaseQueueSlot removes it", async () => {
  const root = mkWorkspaceRoot();
  const slot = await acquireQueueSlot(root, { pollIntervalMs: 50, maxWaitMs: 2000 });
  assert.ok(slot.acquired, `should acquire; reason=${slot.reason}`);
  assert.equal(fs.existsSync(queueLockPath(root)), true);
  releaseQueueSlot(root, slot.token);
  assert.equal(fs.existsSync(queueLockPath(root)), false);
});

test("acquireQueueSlot: blocks if another lock is held by live PID", async () => {
  const root = mkWorkspaceRoot();
  const slot1 = await acquireQueueSlot(root, { pollIntervalMs: 50, maxWaitMs: 2000 });
  assert.ok(slot1.acquired);
  const t0 = Date.now();
  const slot2 = await acquireQueueSlot(root, { pollIntervalMs: 50, maxWaitMs: 500 });
  const dt = Date.now() - t0;
  assert.equal(slot2.acquired, false);
  assert.equal(slot2.reason, "queue-timeout");
  assert.ok(dt >= 400, `should have waited ~500ms, took ${dt}ms`);
  releaseQueueSlot(root, slot1.token);
});

test("acquireQueueSlot: reclaims stale lock (dead PID)", async () => {
  const root = mkWorkspaceRoot();
  fs.mkdirSync(root, { recursive: true });
  // Fabricate stale directory-lock: mkdir + owner.json with a dead PID
  const stagedDir = queueLockPath(root);
  fs.mkdirSync(stagedDir, { recursive: true });
  fs.writeFileSync(path.join(stagedDir, "owner.json"),
    JSON.stringify({ pid: 999999, token: "stale", mtime: new Date().toISOString() }));
  const slot = await acquireQueueSlot(root, { pollIntervalMs: 50, maxWaitMs: 2000 });
  assert.ok(slot.acquired, `stale reclaim; reason=${slot.reason}`);
  releaseQueueSlot(root, slot.token);
});

test("acquireQueueSlot: reclaims stale lock (mtime > staleMs)", async () => {
  const root = mkWorkspaceRoot();
  fs.mkdirSync(root, { recursive: true });
  const stagedDir = queueLockPath(root);
  fs.mkdirSync(stagedDir, { recursive: true });
  const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(stagedDir, "owner.json"),
    JSON.stringify({ pid: process.pid, token: "aged", mtime: oldTime }));
  const slot = await acquireQueueSlot(root, { pollIntervalMs: 50, maxWaitMs: 2000, staleMs: 60_000 });
  assert.ok(slot.acquired);
  releaseQueueSlot(root, slot.token);
});

test("releaseQueueSlot: unknown token leaves lock alone (defensive)", async () => {
  const root = mkWorkspaceRoot();
  const slot = await acquireQueueSlot(root, { pollIntervalMs: 50, maxWaitMs: 2000 });
  releaseQueueSlot(root, "wrong-token");
  assert.equal(fs.existsSync(queueLockPath(root)), true, "wrong token must not release");
  releaseQueueSlot(root, slot.token);
});

test("acquireQueueSlot: two concurrent attempts serialize (FIFO-ish)", async () => {
  const root = mkWorkspaceRoot();
  const order = [];
  const slot1 = await acquireQueueSlot(root, { pollIntervalMs: 30, maxWaitMs: 2000 });
  assert.ok(slot1.acquired);
  const pending = acquireQueueSlot(root, { pollIntervalMs: 30, maxWaitMs: 2000 });
  order.push("slot1-acquired");
  await new Promise(r => setTimeout(r, 200));
  order.push("slot1-about-to-release");
  releaseQueueSlot(root, slot1.token);
  const slot2 = await pending;
  order.push("slot2-acquired");
  assert.ok(slot2.acquired, `slot2 should acquire after release; reason=${slot2.reason}`);
  assert.deepEqual(order, ["slot1-acquired", "slot1-about-to-release", "slot2-acquired"]);
  releaseQueueSlot(root, slot2.token);
});
