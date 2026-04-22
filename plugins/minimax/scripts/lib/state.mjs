import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Constants ────────────────────────────────────────────

export const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "minimax-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

// ── Timing history constants (v0.1.3) ────────────────────
// Separate from FALLBACK_STATE_ROOT_DIR (which is tmpdir-based for jobs).
// Telemetry lives at Gemini-compat path so cross-plugin tooling finds it.
const TIMING_FALLBACK_DIR = path.join(os.homedir(), ".claude", "plugins", "data", "minimax-minimax-plugin");
const TIMING_FILE_NAME = "timings.ndjson";
const TIMING_LOCK_NAME = "timings.ndjson.lock";
const TIMING_LOCK_ACQUIRE_MS = 10_000;
const TIMING_LOCK_STALE_MS = 30_000;
const TIMING_MAX_BYTES = 10 * 1024 * 1024;

// ── Path resolution ──────────────────────────────────────

function computeWorkspaceSlug(workspaceRoot) {
  const base = path.basename(workspaceRoot);
  const slug = base.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const hash = crypto
    .createHash("sha256")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 16);
  return `${slug}-${hash}`;
}

export function stateRootDir() {
  const pluginData = process.env[PLUGIN_DATA_ENV];
  if (pluginData) {
    return path.join(pluginData, "state");
  }
  return FALLBACK_STATE_ROOT_DIR;
}

export function resolveStateDir(workspaceRoot) {
  return path.join(stateRootDir(), computeWorkspaceSlug(workspaceRoot));
}

export function resolveStateFile(workspaceRoot) {
  return path.join(resolveStateDir(workspaceRoot), STATE_FILE_NAME);
}

export function resolveJobsDir(workspaceRoot) {
  return path.join(resolveStateDir(workspaceRoot), JOBS_DIR_NAME);
}

export function ensureStateDir(workspaceRoot) {
  fs.mkdirSync(resolveJobsDir(workspaceRoot), { recursive: true });
}

export function resolveJobFile(workspaceRoot, jobId) {
  return path.join(resolveJobsDir(workspaceRoot), `${jobId}.json`);
}

export function resolveJobLogFile(workspaceRoot, jobId) {
  return path.join(resolveJobsDir(workspaceRoot), `${jobId}.log`);
}

// ── Default state ────────────────────────────────────────

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {},
    jobs: [],
  };
}

// ── State I/O ────────────────────────────────────────────

export function loadState(workspaceRoot) {
  const file = resolveStateFile(workspaceRoot);
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      if (!raw.trim()) continue; // empty file from concurrent write
      const state = JSON.parse(raw);
      if (state && typeof state === "object") return state;
    } catch {
      if (attempt < maxRetries - 1) {
        // Brief pause before retry — concurrent writer may still be flushing
        const waitUntil = Date.now() + 20;
        while (Date.now() < waitUntil) { /* spin */ }
        continue;
      }
    }
  }
  return defaultState();
}

export function saveState(workspaceRoot, state) {
  ensureStateDir(workspaceRoot);
  // Prune old jobs
  state.jobs = pruneJobs(state.jobs);
  // Remove orphaned job files
  cleanupOrphanedFiles(workspaceRoot, state.jobs);
  fs.writeFileSync(
    resolveStateFile(workspaceRoot),
    JSON.stringify(state, null, 2) + "\n"
  );
}

export function updateState(workspaceRoot, mutate) {
  ensureStateDir(workspaceRoot);
  const lockFile = resolveStateFile(workspaceRoot) + ".lock";
  const maxRetries = 10;
  const retryDelayMs = 50;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Acquire exclusive lock
      const lockFd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.closeSync(lockFd);

      try {
        const state = loadState(workspaceRoot);
        mutate(state);
        saveState(workspaceRoot, state);
        return state;
      } finally {
        removeFileIfExists(lockFile);
      }
    } catch (e) {
      if (e.code === "EEXIST") {
        // Lock held by another process, retry after delay
        const waitUntil = Date.now() + retryDelayMs * (attempt + 1);
        while (Date.now() < waitUntil) { /* spin */ }

        // Clean up stale locks (older than 30s)
        try {
          const stat = fs.statSync(lockFile);
          if (Date.now() - stat.mtimeMs > 30_000) {
            removeFileIfExists(lockFile);
          }
        } catch { /* lock already removed */ }
        continue;
      }
      throw e;
    }
  }

  // Fallback: proceed without lock after exhausting retries
  const state = loadState(workspaceRoot);
  mutate(state);
  saveState(workspaceRoot, state);
  return state;
}

function pruneJobs(jobs) {
  return jobs
    .slice()
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
    .slice(0, MAX_JOBS);
}

function cleanupOrphanedFiles(workspaceRoot, jobs) {
  const jobIds = new Set(jobs.map((j) => j.id));
  const jobsDir = resolveJobsDir(workspaceRoot);
  try {
    for (const file of fs.readdirSync(jobsDir)) {
      const id = file.replace(/\.(json|log)$/, "");
      if (!jobIds.has(id)) {
        removeFileIfExists(path.join(jobsDir, file));
      }
    }
  } catch {
    // jobsDir may not exist yet
  }
}

function removeFileIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

// ── Job operations ───────────────────────────────────────

export function generateJobId(prefix = "mj") {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString("hex");
  return `${prefix}-${ts}-${rand}`;
}

export function upsertJob(workspaceRoot, jobPatch) {
  return updateState(workspaceRoot, (state) => {
    const now = new Date().toISOString();
    const idx = state.jobs.findIndex((j) => j.id === jobPatch.id);
    if (idx >= 0) {
      state.jobs[idx] = { ...state.jobs[idx], ...jobPatch, updatedAt: now };
    } else {
      state.jobs.push({
        ...jobPatch,
        createdAt: jobPatch.createdAt || now,
        updatedAt: now,
      });
    }
  });
}

export function listJobs(workspaceRoot) {
  return loadState(workspaceRoot).jobs;
}

export function writeJobFile(workspaceRoot, jobId, payload) {
  ensureStateDir(workspaceRoot);
  const file = resolveJobFile(workspaceRoot, jobId);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
}

export function readJobFile(jobFile) {
  try {
    return JSON.parse(fs.readFileSync(jobFile, "utf8"));
  } catch {
    return null;
  }
}

export function removeJobFile(jobFile) {
  removeFileIfExists(jobFile);
}

// ── Config operations ────────────────────────────────────

export function getConfig(workspaceRoot) {
  return loadState(workspaceRoot).config || {};
}

export function setConfig(workspaceRoot, key, value) {
  updateState(workspaceRoot, (state) => {
    state.config = state.config || {};
    state.config[key] = value;
  });
}

// ── withLockAsync: async lock with stale-lock recovery ───
// (spec §4.2, plan v5)
//
// Async counterpart to the sync lock logic in updateState above.
// minimax.mjs::writeMiniAgentApiKey uses this function.
// Lock file content: JSON { pid, mtime }
//
// Stale-lock detection:
//   - File absent              → proceed (no lock held)
//   - File present, parse fail / empty / missing pid → stale, unlink and retry
//   - JSON has pid: process.kill(pid, 0) throws ESRCH → stale (process dead)
//   - JSON has mtime: age > 60s → stale
//   - Otherwise               → lock is alive, wait LOCK_RETRY_SLEEP_MS and retry
//   - After LOCK_MAX_RETRIES exhausted → throw Error("LOCK_CONTENDED")

const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_SLEEP_MS = 100;
const LOCK_MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryReadLockPayload(lockPath) {
  try {
    const text = fs.readFileSync(lockPath, "utf8");
    if (!text || text.trim() === "") return null; // empty file → corrupted
    const obj = JSON.parse(text);
    if (typeof obj.pid !== "number") return null; // missing pid → corrupted
    return obj;
  } catch (err) {
    if (err.code === "ENOENT") return undefined; // file does not exist
    return null; // JSON parse error or other read error → treat as stale
  }
}

function isStale(payload) {
  if (payload === null) return true;      // corrupted / empty / missing fields
  if (payload === undefined) return false; // file absent — not stale (no lock)
  // Check whether the locking process is still alive
  try {
    process.kill(payload.pid, 0);
  } catch (err) {
    if (err.code === "ESRCH") return true; // process no longer exists
    // EPERM: process alive but we lack permission to signal — not stale
  }
  // Check mtime age
  if (payload.mtime) {
    const age = Date.now() - new Date(payload.mtime).getTime();
    if (age > LOCK_STALE_MS) return true;
  }
  return false;
}

export async function withLockAsync(lockPath, asyncFn) {
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, mtime: new Date().toISOString() });

  let acquired = false;
  for (let attempt = 0; attempt <= LOCK_MAX_RETRIES && !acquired; attempt++) {
    // Check whether an existing lock is stale
    const existing = tryReadLockPayload(lockPath);
    if (existing === undefined) {
      // Lock file absent — fall through to creation attempt
    } else if (isStale(existing)) {
      // Stale or corrupted lock — remove it
      try { fs.unlinkSync(lockPath); } catch { /* race: another process beat us, continue */ }
    } else {
      // Live lock held by another process
      if (attempt < LOCK_MAX_RETRIES) {
        await sleep(LOCK_RETRY_SLEEP_MS);
        continue;
      }
      throw new Error("LOCK_CONTENDED");
    }

    // Attempt atomic exclusive creation (wx flag = O_CREAT | O_EXCL)
    try {
      fs.writeFileSync(lockPath, payload, { flag: "wx" });
      acquired = true;
    } catch (err) {
      if (err.code === "EEXIST" && attempt < LOCK_MAX_RETRIES) {
        await sleep(LOCK_RETRY_SLEEP_MS);
        continue;
      }
      throw err;
    }
  }

  if (!acquired) throw new Error("LOCK_CONTENDED");

  // Execute asyncFn and release lock regardless of outcome
  try {
    return await asyncFn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* already cleaned up or never created, ignore */ }
  }
}

// ── Timing history (v0.1.3) ──────────────────────────────

function resolveTimingDir() {
  const pluginData = process.env[PLUGIN_DATA_ENV];
  return pluginData || TIMING_FALLBACK_DIR;
}

export function resolveTimingHistoryFile() {
  return path.join(resolveTimingDir(), TIMING_FILE_NAME);
}

function resolveTimingLockFile() {
  return path.join(resolveTimingDir(), TIMING_LOCK_NAME);
}

function removeTimingLock() {
  try { fs.unlinkSync(resolveTimingLockFile()); } catch { /* already gone */ }
}

function acquireTimingLockSync() {
  const lockFile = resolveTimingLockFile();
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + TIMING_LOCK_ACQUIRE_MS;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.closeSync(fd);
      return lockFile;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const until = Date.now() + 25;
      while (Date.now() < until) { /* spin */ }
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > TIMING_LOCK_STALE_MS) {
          try { fs.unlinkSync(lockFile); } catch { /* gone */ }
        }
      } catch { /* gone */ }
    }
  }
  return null;
}

/**
 * Append a timing record to timings.ndjson.
 * Returns true on success, false on lock-acquire timeout.
 * May THROW from pre-lock paths (EACCES on mkdirSync/statSync) or from renameSync
 * during trim (EACCES/EXDEV). Callers MUST try/catch. See spec §6.
 */
export function appendTimingHistory(record) {
  const file = resolveTimingHistoryFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = acquireTimingLockSync();
  if (!lock) {
    try { process.stderr.write(`[timing] lock acquire timeout; dropping record ${record?.jobId || "?"}\n`); } catch { /* ignore */ }
    return false;
  }
  try {
    // Crash recovery: if file exists without trailing \n, prepend one before append
    let needsLeadingNewline = false;
    try {
      const st = fs.statSync(file);
      if (st.size > 0) {
        const buf = Buffer.alloc(1);
        const fd = fs.openSync(file, "r");
        try { fs.readSync(fd, buf, 0, 1, st.size - 1); }
        finally { fs.closeSync(fd); }
        if (buf[0] !== 0x0A /* \n */) needsLeadingNewline = true;
      }
    } catch { /* new file */ }

    const line = (needsLeadingNewline ? "\n" : "") + JSON.stringify(record) + "\n";
    fs.appendFileSync(file, line);

    // Retention best-effort; if trim fails the record IS already appended.
    try {
      const st = fs.statSync(file);
      if (st.size > TIMING_MAX_BYTES) {
        const raw = fs.readFileSync(file, "utf8");
        const lines = raw.split("\n").filter(Boolean);
        const valid = [];
        for (const l of lines) {
          try { JSON.parse(l); valid.push(l); } catch { /* drop invalid */ }
        }
        const keep = valid.slice(Math.floor(valid.length / 2));
        const tmp = file + ".tmp";
        fs.writeFileSync(tmp, keep.join("\n") + "\n");
        fs.renameSync(tmp, file);
      }
    } catch (e) {
      try { process.stderr.write(`[timing] trim failed (record already appended): ${e.message}\n`); } catch { /* ignore */ }
    }
    return true;
  } finally {
    removeTimingLock();
  }
}
