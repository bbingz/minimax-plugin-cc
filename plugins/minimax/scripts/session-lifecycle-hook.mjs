#!/usr/bin/env node
import process from "node:process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const event = process.argv[2];
const stateDir = path.join(os.homedir(), ".claude", "plugins", "minimax");
fs.mkdirSync(stateDir, { recursive: true });
const sidFile = path.join(stateDir, "session-id");

if (event === "SessionStart") {
  // Claude Code injects CLAUDE_SESSION_ID or similar. Fallback synthesizes a
  // fresh id each session — filterJobsBySession will NOT show cross-session
  // jobs by default; user must pass --all.
  const sid = process.env.CLAUDE_SESSION_ID || process.env.SESSION_ID || ("claude-" + Date.now());
  try { fs.writeFileSync(sidFile, sid, "utf8"); } catch {}

  // Dual protocol (plan v2 C2): append to CLAUDE_ENV_FILE (stable across
  // Claude Code versions) AND emit {env:{...}} JSON to stdout (newer protocol).
  if (process.env.CLAUDE_ENV_FILE) {
    try {
      fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `MINIMAX_COMPANION_SESSION_ID=${sid}\n`, "utf8");
    } catch {}
  }
  process.stdout.write(JSON.stringify({ env: { MINIMAX_COMPANION_SESSION_ID: sid } }) + "\n");
} else if (event === "SessionEnd") {
  try { fs.unlinkSync(sidFile); } catch {}
}
process.exit(0);
