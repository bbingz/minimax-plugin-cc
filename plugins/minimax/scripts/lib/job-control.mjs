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
