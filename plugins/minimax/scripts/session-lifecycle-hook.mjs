#!/usr/bin/env node
import process from "node:process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// v0.1.3 constants — status enum matches job-control.mjs::VALID_STATUSES
const TERMINAL_STATUSES = new Set(["done", "failed", "canceled"]);
const NON_TERMINAL_STATUSES = new Set(["queued", "starting", "running"]);
const DEFAULT_STALE_MS = 3 * 24 * 60 * 60 * 1000;

function getStaleThresholdMs() {
  const fromEnv = Number(process.env.MINIMAX_STALE_JOB_THRESHOLD_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_STALE_MS;
}

function jobsDir() {
  return path.join(os.homedir(), ".claude", "plugins", "minimax", "jobs");
}

function listJobDirs() {
  try {
    return fs.readdirSync(jobsDir())
      .filter((name) => name.startsWith("mj-"))
      .map((name) => path.join(jobsDir(), name));
  } catch { return []; }
}

function readJobMeta(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, "meta.json"), "utf8");
    return { ok: true, meta: JSON.parse(raw) };
  } catch (e) {
    if (e.code === "ENOENT") return { ok: false, error: "missing" };
    return { ok: false, error: "corrupt" };
  }
}

function dirMtimeMs(dir) {
  try { return fs.statSync(dir).mtimeMs; } catch { return null; }
}

function safeRmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch { /* EACCES etc — silent (spec §D3) */ }
}

function isPidAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (e) {
    if (e.code === "ESRCH") return false;
    if (e.code === "EPERM") return true;  // exists but not ours
    return false;
  }
}

function cleanupSessionJobs(sessionId) {
  if (!sessionId) return;
  for (const dir of listJobDirs()) {
    const r = readJobMeta(dir);
    if (!r.ok) continue;  // SessionEnd does not touch missing/corrupt (SessionStart does)
    if (r.meta.sessionId !== sessionId) continue;
    if (TERMINAL_STATUSES.has(r.meta.status)) safeRmDir(dir);
  }
}

function pruneStaleJobs() {
  const threshold = getStaleThresholdMs();
  const now = Date.now();
  for (const dir of listJobDirs()) {
    const mtime = dirMtimeMs(dir);
    if (mtime == null) continue;
    const isStale = (now - mtime) > threshold;

    const r = readJobMeta(dir);

    if (!r.ok) {
      // Missing meta + stale → orphan → rmSync
      if (r.error === "missing" && isStale) { safeRmDir(dir); continue; }
      // Corrupt meta + stale → abandoned → rmSync
      if (r.error === "corrupt" && isStale) { safeRmDir(dir); continue; }
      // Corrupt meta + fresh → mid-write race protection → skip (v2.1)
      continue;
    }

    if (!isStale) continue;

    if (TERMINAL_STATUSES.has(r.meta.status)) {
      safeRmDir(dir);
      continue;
    }
    if (NON_TERMINAL_STATUSES.has(r.meta.status)) {
      if (r.meta.pid && !isPidAlive(r.meta.pid)) {
        safeRmDir(dir);
      }
      // else: alive / missing pid → preserve conservatively
      continue;
    }
    // Unknown status → skip conservatively
  }
}

// ── Event handlers ─────────────────────────────────────────────────────

const event = process.argv[2];
const stateDir = path.join(os.homedir(), ".claude", "plugins", "minimax");
fs.mkdirSync(stateDir, { recursive: true });
const sidFile = path.join(stateDir, "session-id");

let hookInput = {};
try {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (raw) hookInput = JSON.parse(raw);
} catch { /* stdin optional */ }

if (event === "SessionStart") {
  const sid = hookInput.session_id
    || process.env.CLAUDE_SESSION_ID
    || process.env.SESSION_ID
    || ("claude-" + Date.now());
  try { fs.writeFileSync(sidFile, sid, "utf8"); } catch {}

  if (process.env.CLAUDE_ENV_FILE) {
    try {
      fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `MINIMAX_COMPANION_SESSION_ID=${sid}\n`, "utf8");
    } catch {}
  }
  process.stdout.write(JSON.stringify({ env: { MINIMAX_COMPANION_SESSION_ID: sid } }) + "\n");

  // v0.1.3: mtime-based stale sweep (4-branch decision tree per D3).
  // Never let sweep failure block session startup.
  try { pruneStaleJobs(); } catch { /* swallow */ }
} else if (event === "SessionEnd") {
  try { fs.unlinkSync(sidFile); } catch {}
  const sid = hookInput.session_id || process.env.MINIMAX_COMPANION_SESSION_ID;
  // v0.1.3: clean THIS session's terminal jobs (D3 SessionEnd branch).
  try { cleanupSessionJobs(sid); } catch { /* swallow */ }
}

process.exit(0);
