import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const VALID_STATUSES = new Set(["queued", "starting", "running", "done", "failed", "canceled"]);

export function defaultWorkspaceRoot() {
  return process.env.MINIMAX_JOBS_ROOT
    || path.join(os.homedir(), ".claude", "plugins", "minimax", "jobs");
}

export function jobDir(workspaceRoot, jobId) {
  return path.join(workspaceRoot, jobId);
}

function metaPath(workspaceRoot, jobId) {
  return path.join(jobDir(workspaceRoot, jobId), "meta.json");
}

function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

export function createJob({ workspaceRoot, prompt, cwd, sandbox, sessionId, extraArgs = [], timeout = 300_000 }) {
  if (!workspaceRoot) throw new Error("createJob: workspaceRoot required");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const jobId = "mj-" + crypto.randomUUID();
  const dir = jobDir(workspaceRoot, jobId);
  fs.mkdirSync(dir, { recursive: true });

  let workdir = cwd;
  if (sandbox) {
    workdir = path.join(dir, "workspace");
    fs.mkdirSync(workdir, { recursive: true });
  }

  const meta = {
    jobId,
    status: "queued",
    prompt,
    cwd,
    workdir,
    sandbox: Boolean(sandbox),
    sessionId: sessionId || null,
    extraArgs,
    timeout,
    canceled: false,
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    pid: null,
    exitCode: null,
    signal: null,
    miniAgentLogPath: null,
    stdoutTruncated: false,
    stderrTruncated: false,
    queueToken: null,
  };
  atomicWriteJson(metaPath(workspaceRoot, jobId), meta);
  return { jobId, meta };
}

export function readJob(workspaceRoot, jobId) {
  try {
    const text = fs.readFileSync(metaPath(workspaceRoot, jobId), "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function updateJobMeta(workspaceRoot, jobId, patch) {
  if (patch.status !== undefined && !VALID_STATUSES.has(patch.status)) {
    throw new Error(`updateJobMeta: invalid status '${patch.status}'`);
  }
  const current = readJob(workspaceRoot, jobId);
  if (!current) throw new Error(`updateJobMeta: job ${jobId} not found`);
  const merged = { ...current, ...patch, updatedAt: Date.now() };
  atomicWriteJson(metaPath(workspaceRoot, jobId), merged);
  return merged;
}

export function listJobs(workspaceRoot) {
  let entries;
  try {
    entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const jobs = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith("mj-")) continue;
    const meta = readJob(workspaceRoot, e.name);
    if (meta) jobs.push(meta);
  }
  jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return jobs;
}

export function filterJobsBySession(jobs, sessionId) {
  if (!sessionId) return jobs;
  return jobs.filter(j => j.sessionId === sessionId);
}

// ── Serial queue (P0.10 conditional-hard-gate FAIL; only one mini-agent
//     spawn may run at a time in v0.1) ────────────────────────────────────
//
// Uses a DIRECTORY as the lock primitive, not a file. fs.mkdirSync is atomic
// in POSIX (either creates or EEXIST). Stale reclaim: rename the directory
// aside, then rmSync it. Renaming is atomic even if a racer also tries — the
// loser gets ENOENT and falls back to the normal retry path.

export function queueLockPath(workspaceRoot) {
  return path.join(workspaceRoot, ".queue-lock");
}

function ownerPath(lockDir) {
  return path.join(lockDir, "owner.json");
}

function readLockOwner(lockDir) {
  try {
    const text = fs.readFileSync(ownerPath(lockDir), "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed.pid !== "number" || typeof parsed.token !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== "ESRCH"; }
}

export async function acquireQueueSlot(workspaceRoot, {
  pollIntervalMs = 300,
  maxWaitMs = 5 * 60 * 1000,
  staleMs = 5 * 60 * 1000,
} = {}) {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const lockDir = queueLockPath(workspaceRoot);
  const deadline = Date.now() + maxWaitMs;

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      const token = crypto.randomUUID();
      const payload = { pid: process.pid, token, mtime: new Date().toISOString() };
      fs.writeFileSync(ownerPath(lockDir), JSON.stringify(payload), "utf8");
      return { acquired: true, token };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const owner = readLockOwner(lockDir);
      let shouldReclaim = false;
      if (!owner) {
        shouldReclaim = true;
      } else {
        const alive = pidAlive(owner.pid);
        const mtimeMs = Date.parse(owner.mtime || "") || 0;
        const aged = (Date.now() - mtimeMs) > staleMs;
        if (!alive || aged) shouldReclaim = true;
      }
      if (shouldReclaim) {
        const stagedPath = lockDir + ".stale." + crypto.randomUUID();
        try {
          fs.renameSync(lockDir, stagedPath);
          fs.rmSync(stagedPath, { recursive: true, force: true });
        } catch (e) {
          // ENOENT => another racer already moved it; fall through to next iteration
          if (e.code !== "ENOENT") { /* swallow; retry */ }
        }
        continue;
      }
    }

    if (Date.now() >= deadline) {
      return { acquired: false, reason: "queue-timeout" };
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
}

export function releaseQueueSlot(workspaceRoot, token) {
  const lockDir = queueLockPath(workspaceRoot);
  const owner = readLockOwner(lockDir);
  if (!owner) return;
  if (owner.token !== token) return;
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
}
