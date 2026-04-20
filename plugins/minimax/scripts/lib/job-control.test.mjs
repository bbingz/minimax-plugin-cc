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
