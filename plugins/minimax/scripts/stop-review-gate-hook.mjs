#!/usr/bin/env node
// Stop-time review gate for MiniMax.
// Default-disabled; enabled via setup --enable-review-gate flipping
// state.json.reviewGate.enabled = true.
//
// v0.1 limitation (plan v2 M4): this hook invokes the default review prompt.
// prompts/stop-review-gate.md is a spec §6.6 deliverable whose wiring
// (custom --prompt-override flag on the review subcommand) is deferred to
// Phase 5. The file exists so the prompt text can be iterated; it is NOT
// currently consumed by the review pipeline.

import process from "node:process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const stateFile = path.join(os.homedir(), ".claude", "plugins", "minimax", "state.json");
let enabled = false;
try {
  const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  enabled = Boolean(s && s.reviewGate && s.reviewGate.enabled);
} catch {}

if (!enabled) { process.exit(0); }

const promptPath = path.join(process.env.CLAUDE_PLUGIN_ROOT || "", "prompts", "stop-review-gate.md");
let promptText = "";
try { promptText = fs.readFileSync(promptPath, "utf8"); } catch {}

const companion = path.join(process.env.CLAUDE_PLUGIN_ROOT || "", "scripts", "minimax-companion.mjs");
// --timeout 600000 so the review can use up to 10 minutes before the hook's
// own 900s (15min) budget kicks in.
const r = spawnSync(process.execPath, [companion, "review", "--json", "--timeout", "600000"], {
  encoding: "utf8",
  env: { ...process.env, MINIMAX_REVIEW_PROMPT_OVERRIDE: promptText || "" },
  timeout: 800_000,
});
if (r.status !== 0 && r.stdout) {
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: "MiniMax review gate flagged issues. Output below.",
    additionalContext: r.stdout.slice(0, 60_000),
  }) + "\n");
  process.exit(0);
}
process.exit(0);
