#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  getMiniAgentAvailability,
  getMiniAgentAuthStatus,
  readMiniAgentConfig,
  writeMiniAgentApiKey,
  redactSecrets,
  callMiniAgent,
  classifyMiniAgentResult,
  stripAnsiSgr,
  callMiniAgentReview,
  callMiniAgentAdversarial,
} from "./lib/minimax.mjs";
import { binaryAvailable } from "./lib/process.mjs";
import {
  defaultWorkspaceRoot,
  acquireQueueSlot,
  releaseQueueSlot,
  createJob,
  readJob,
  updateJobMeta,
  listJobs,
  filterJobsBySession,
  cancelJob,
  jobDir,
} from "./lib/job-control.mjs";

const USAGE = `Usage: minimax-companion <subcommand> [options]

Subcommands:
  setup [--json] [--enable-review-gate|--disable-review-gate]
                    Check mini-agent CLI availability and auth state.

  write-key --api-key <key> [--api-base <url>] [--json]
                    Write api_key (and optionally api_base) into config.yaml.

  ask [--json] [--timeout <ms>] [--cwd <path>] "<prompt>"
                    One-shot question via mini-agent -t. Streams stdout live
                    (ANSI-stripped) to main stdout. On success returns response
                    (text or JSON). Exit codes:
                      0 = success / success-but-truncated
                      2 = incomplete (tool_calls unresolved)
                      3 = auth/config/socksio/not-installed
                      4 = llm-call-failed
                      5 = unknown-crashed / success-claimed-but-no-log

  review [--json] [--base <ref>] [--scope <auto|working-tree|staged|branch>]
         [--timeout <ms>] [--cwd <path>] [focus ...]
                    Run a code review against the current git diff. Exit codes:
                      0 = success (with or without retry)
                      2 = no diff / no base / bad scope / merge conflict present
                      4 = mini-agent call failed
                      5 = parse/validate failed even after 1 retry
                      6 = git command failed

  adversarial-review [--json] [--base <ref>] [--scope <auto|working-tree|staged|branch>]
                     [--timeout <ms>] [--cwd <path>] [focus ...]
                    Two-pass adversarial review (red team then blue team) on the
                    current git diff. Both viewpoints must succeed (T9 hard gate).
                    Exit codes:
                      0 = both red and blue succeeded
                      2 = no diff / no base / bad scope / merge conflict present
                      4 = mini-agent call failed on either side (or queue-timeout)
                      5 = parse/validate failed on either side
                      6 = git command failed

  rescue [--json] [--sandbox] [--background] [--timeout <ms>] [--cwd <path>]
         <prompt>
                    Delegate a multi-step agent task. Default workdir = caller
                    cwd; --sandbox uses jobs/<jobId>/workspace/ (isolated
                    workdir, NOT a security boundary). --background detaches a
                    worker and returns jobId immediately. Serial execution
                    (P0.10): only one mini-agent spawn in flight at a time.

  status [--json] [--all] [<jobId>]
                    List current-session jobs (or --all). With <jobId>: snapshot.

  result [--json] <jobId>
                    Print a finished job's final response.

  cancel [--json] [--keep-workspace] <jobId>
                    SIGTERM -> 5s -> SIGKILL. Removes sandbox workspace by default.

  task-resume-candidate [--json]
                    List the 5 most recent ~/.mini-agent/log/ files
                    (v0.1 informational; Mini-Agent has no resume — P0.9).
`;

function maskApiKey(k) {
  if (!k || typeof k !== "string") return null;
  if (k === "YOUR_API_KEY_HERE") return "<placeholder>";
  if (k.length < 12) return "<short>";
  return k.slice(0, 4) + "***" + k.slice(-4);
}

async function runSetup(rawArgs) {
  const { options } = parseArgs(rawArgs, {
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
  });

  const availability = getMiniAgentAvailability();
  const cfg = readMiniAgentConfig();
  const installers = {
    uv: binaryAvailable("uv", ["--version"]).available,
    pipx: binaryAvailable("pipx", ["--version"]).available,
    curl: binaryAvailable("sh", ["-c", "command -v curl"]).available,
  };

  let auth = { loggedIn: false, reason: "not-checked" };
  if (availability.available) {
    if (cfg.api_key && cfg.api_key !== "YOUR_API_KEY_HERE") {
      auth = await getMiniAgentAuthStatus(process.cwd());
    } else {
      auth = { loggedIn: false, reason: "auth-not-configured", detail: "api_key is placeholder or missing" };
    }
  }

  const status = {
    installed: availability.available,
    version: availability.available ? availability.detail : null,
    authenticated: auth.loggedIn,
    authReason: auth.reason || null,
    authDetail: auth.detail ? redactSecrets(auth.detail) : null,
    model: auth.model || cfg.model || null,
    apiBase: cfg.api_base || null,
    apiKeyMasked: maskApiKey(cfg.api_key),
    configPath: cfg.raw ? "~/.mini-agent/config/config.yaml" : (cfg.readError || "missing"),
    installers,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  } else {
    process.stdout.write(formatSetupText(status) + "\n");
  }
  process.exit(0);
}

function formatSetupText(s) {
  const lines = [];
  lines.push(`installed:       ${s.installed ? `yes (${s.version})` : "no"}`);
  lines.push(`authenticated:   ${s.authenticated ? "yes" : `no (${s.authReason})`}`);
  lines.push(`api_base:        ${s.apiBase || "(not set)"}`);
  lines.push(`model:           ${s.model || "(not set)"}`);
  lines.push(`api_key:         ${s.apiKeyMasked || "(not set)"}`);
  if (!s.installed) {
    lines.push("");
    lines.push("Installers detected:");
    lines.push(`  uv:    ${s.installers.uv ? "yes" : "no"}`);
    lines.push(`  pipx:  ${s.installers.pipx ? "yes" : "no"}`);
    lines.push(`  curl:  ${s.installers.curl ? "yes" : "no"}`);
  }
  if (s.authDetail) lines.push(`\nauth detail: ${s.authDetail}`);
  return lines.join("\n");
}

async function runWriteKey(rawArgs) {
  const { options } = parseArgs(rawArgs, {
    booleanOptions: ["json"],
    valueOptions: ["api-key", "api-base"],
  });

  if (!options["api-key"]) {
    const err = { ok: false, reason: "missing --api-key" };
    if (options.json) process.stdout.write(JSON.stringify(err) + "\n");
    else process.stderr.write("Error: --api-key is required\n");
    process.exit(1);
  }

  const result = await writeMiniAgentApiKey(options["api-key"]);

  if (options.json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else if (result.ok) {
    process.stdout.write(`api_key written (form=${result.form}, line=${result.lineNumber})\n`);
  } else {
    process.stderr.write(`write failed: ${result.reason}${result.lineNumber ? " at line " + result.lineNumber : ""}\n`);
  }
  process.exit(result.ok ? 0 : 2);
}

const STATUS_EXIT_CODE = {
  "success": 0,
  "success-but-truncated": 0,
  "incomplete": 2,
  "auth-not-configured": 3,
  "config-missing": 3,
  "needs-socksio": 3,
  "not-installed": 3,
  "spawn-failed": 5,
  "llm-call-failed": 4,
  "unknown-crashed": 5,
  "success-claimed-but-no-log": 5,
};

async function runAsk(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, {
    booleanOptions: ["json"],
    valueOptions: ["timeout", "cwd"],
  });

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    if (options.json) process.stdout.write(JSON.stringify({ status: "bad-input", reason: "prompt is empty" }) + "\n");
    else process.stderr.write("Error: prompt is required\n");
    process.exit(1);
  }

  const timeout = options.timeout ? Number(options.timeout) : 120_000;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    if (options.json) {
      process.stdout.write(JSON.stringify({ status: "bad-input", reason: `invalid --timeout '${options.timeout}'` }) + "\n");
    } else {
      process.stderr.write(`Error: invalid --timeout '${options.timeout}'\n`);
    }
    process.exit(1);
  }

  const cwd = options.cwd || process.cwd();

  // T3: immediate "not frozen" signal for text mode (JSON mode must not pollute stdout).
  if (!options.json) {
    process.stdout.write("Starting MiniMax (cold start ~3s)...\n");
  }

  const onProgressLine = (line) => {
    if (options.json) return;
    process.stdout.write(stripAnsiSgr(line) + "\n");
  };

  // v2 Task 4.0 (C6): route through the P0.10 serial queue so ask/review/rescue
  // can't race for log-file attribution under seconds-precision timestamps.
  const workspaceRoot = defaultWorkspaceRoot();
  const slot = await acquireQueueSlot(workspaceRoot, { maxWaitMs: timeout + 30_000 });
  if (!slot.acquired) {
    const payload = { status: "queue-timeout", reason: slot.reason };
    if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stderr.write(`Error: queue-timeout (${slot.reason})\n`);
    process.exit(4);
  }
  let result;
  try {
    result = await callMiniAgent({ prompt, cwd, timeout, onProgressLine });
  } finally {
    releaseQueueSlot(workspaceRoot, slot.token);
  }
  const cls = classifyMiniAgentResult(result);

  const exitCode = STATUS_EXIT_CODE[cls.status] ?? 5;

  if (options.json) {
    const payload = (cls.status === "success" || cls.status === "success-but-truncated")
      ? {
          status: cls.status,
          response: cls.response,
          toolCalls: cls.toolCalls,
          finishReason: cls.finishReason,
          logPath: cls.logPath,
          thinking: cls.thinking,
        }
      : {
          status: cls.status,
          reason: cls.reason ?? null,
          detail: cls.detail ?? null,
          logPath: cls.logPath ?? null,
          diagnostic: cls.diagnostic ?? null,
        };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else if (cls.status === "success" || cls.status === "success-but-truncated") {
    const cfg = readMiniAgentConfig();
    process.stdout.write("\n---\n" + cls.response + "\n");
    const footerParts = [];
    if (cfg.model) footerParts.push(`model: ${cfg.model}`);
    if (cls.logPath) footerParts.push(`log: ${cls.logPath}`);
    if (cls.status === "success-but-truncated") footerParts.push("truncated");
    if (footerParts.length) process.stdout.write(`(${footerParts.join(" · ")})\n`);
  } else {
    process.stderr.write(`Error: ${cls.status}${cls.detail ? " — " + cls.detail : ""}\n`);
    if (cls.diagnostic && cls.diagnostic.stderrHeadTail && cls.diagnostic.stderrHeadTail.trim()) {
      process.stderr.write("\n--- diagnostic (stderr head+tail, ANSI stripped) ---\n");
      process.stderr.write(cls.diagnostic.stderrHeadTail + "\n");
    }
    if (cls.logPath) process.stderr.write(`log: ${cls.logPath}\n`);
  }

  process.exit(exitCode);
}

// Task 3.5: runReview subcommand

function collectDiff({ base, scope = "auto", cwd }) {
  // Refuse to review while merge conflicts are unresolved
  const unmerged = spawnSync("git", ["ls-files", "--unmerged"], { cwd, encoding: "utf8" });
  if (unmerged.status !== 0) {
    return { ok: false, reason: "git-diff-failed", detail: `git ls-files --unmerged failed: ${unmerged.stderr.trim()}` };
  }
  if (unmerged.stdout.trim().length > 0) {
    return {
      ok: false,
      reason: "merge-conflict-present",
      detail: "unresolved merge conflicts detected; resolve them before running review",
    };
  }

  let effectiveScope = scope;
  if (scope === "auto") {
    const wtree = spawnSync("git", ["diff", "--name-only"], { cwd, encoding: "utf8" });
    if (wtree.status !== 0) return { ok: false, reason: "git-diff-failed", detail: wtree.stderr.trim() };
    if (wtree.stdout.trim().length > 0) effectiveScope = "working-tree";
    else {
      const staged = spawnSync("git", ["diff", "--cached", "--name-only"], { cwd, encoding: "utf8" });
      if (staged.status !== 0) return { ok: false, reason: "git-diff-failed", detail: staged.stderr.trim() };
      if (staged.stdout.trim().length > 0) effectiveScope = "staged";
      else if (base) effectiveScope = "branch";
      else return { ok: false, reason: "no-diff", detail: "no working-tree or staged changes; specify --base for branch compare" };
    }
  }

  let args;
  if (effectiveScope === "working-tree") args = ["diff"];
  else if (effectiveScope === "staged") args = ["diff", "--cached"];
  else if (effectiveScope === "branch") {
    if (!base) return { ok: false, reason: "no-base", detail: "--scope branch requires --base" };
    args = ["diff", `${base}...HEAD`];
  } else {
    return { ok: false, reason: "bad-scope", detail: `unknown --scope '${scope}'` };
  }

  const diff = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (diff.status !== 0) return { ok: false, reason: "git-diff-failed", detail: diff.stderr.trim() };
  return { ok: true, scope: effectiveScope, diff: diff.stdout };
}

const REVIEW_STATUS_EXIT = {
  "no-diff": 2,
  "no-base": 2,
  "bad-scope": 2,
  "merge-conflict-present": 2,
  "git-diff-failed": 6,
  "call-failed": 4,
  "parse-validate-failed": 5,
};

async function runReview(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, {
    booleanOptions: ["json"],
    valueOptions: ["timeout", "cwd", "base", "scope"],
  });

  const cwd = options.cwd || process.cwd();
  const base = options.base || null;
  const scope = options.scope || "auto";
  const focus = positionals.join(" ").trim();
  const timeout = options.timeout ? Number(options.timeout) : 120_000;

  if (!Number.isFinite(timeout) || timeout <= 0) {
    if (options.json) {
      process.stdout.write(JSON.stringify({ status: "bad-input", reason: `invalid --timeout '${options.timeout}'` }) + "\n");
    } else {
      process.stderr.write(`Error: invalid --timeout '${options.timeout}'\n`);
    }
    process.exit(1);
  }

  const diffResult = collectDiff({ base, scope, cwd });
  if (!diffResult.ok) {
    const exitCode = REVIEW_STATUS_EXIT[diffResult.reason] ?? 6;
    const payload = { status: diffResult.reason, detail: diffResult.detail };
    if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stderr.write(`Error: ${diffResult.reason} -- ${diffResult.detail}\n`);
    process.exit(exitCode);
  }
  if (!diffResult.diff.trim()) {
    const payload = { status: "no-diff", detail: `scope=${diffResult.scope} yielded empty diff` };
    if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stdout.write(`No changes under scope=${diffResult.scope}; nothing to review.\n`);
    process.exit(2);
  }

  if (!options.json) {
    process.stdout.write(`Reviewing (scope=${diffResult.scope}${base ? ", base=" + base : ""}, focus="${focus || "(none)"}")...\n`);
    process.stdout.write("Starting MiniMax (cold start ~3s)...\n");
  }

  const schemaPath = path.resolve(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas", "review-output.schema.json")
  );

  const onProgressLine = options.json ? undefined : (line) => {
    process.stderr.write(stripAnsiSgr(line) + "\n");
  };

  // v2 Task 4.0 (C6): serialize through the shared queue. *2+30s because
  // callMiniAgentReview may spawn mini-agent twice (first + retry).
  const workspaceRoot = defaultWorkspaceRoot();
  const slot = await acquireQueueSlot(workspaceRoot, { maxWaitMs: timeout * 2 + 30_000 });
  if (!slot.acquired) {
    const payload = { status: "queue-timeout", reason: slot.reason };
    if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stderr.write(`Error: queue-timeout (${slot.reason})\n`);
    process.exit(4);
  }
  let r;
  try {
    r = await callMiniAgentReview({
      context: diffResult.diff,
      focus,
      schemaPath,
      cwd,
      timeout,
      onProgressLine,
    });
  } finally {
    releaseQueueSlot(workspaceRoot, slot.token);
  }

  if (r.ok) {
    if (options.json) {
      process.stdout.write(JSON.stringify({
        status: "ok",
        verdict: r.verdict,
        summary: r.summary,
        findings: r.findings,
        next_steps: r.next_steps,
        retry_used: r.retry_used,
        retriedOnce: r.retriedOnce,
        retry_notice: r.retry_notice,
        truncated: r.truncated,
        logPath: r.logPath,
      }, null, 2) + "\n");
    } else {
      const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      const findings = [...r.findings].sort((a, b) => (sevOrder[a.severity] ?? 99) - (sevOrder[b.severity] ?? 99));
      process.stdout.write(`\nVerdict: ${r.verdict}\n`);
      process.stdout.write(`Summary: ${r.summary}\n`);
      if (findings.length === 0) {
        process.stdout.write("Findings: (none)\n");
      } else {
        process.stdout.write(`Findings (${findings.length}):\n`);
        for (const f of findings) {
          process.stdout.write(`  - [${f.severity}] ${f.title}\n`);
          process.stdout.write(`    ${f.file}:${f.line_start}${f.line_end !== f.line_start ? "-" + f.line_end : ""}  (confidence ${f.confidence})\n`);
          process.stdout.write(`    ${f.body}\n`);
          process.stdout.write(`    fix: ${f.recommendation}\n`);
        }
      }
      if (r.next_steps.length) {
        process.stdout.write("Next steps:\n");
        for (const s of r.next_steps) process.stdout.write(`  - ${s}\n`);
      }
      const cfg = readMiniAgentConfig();
      const footerParts = [];
      if (cfg.model) footerParts.push(`model: ${cfg.model}`);
      if (r.logPath) footerParts.push(`log: ${r.logPath}`);
      if (r.truncated) footerParts.push("truncated");
      if (r.retry_used) footerParts.push("retry-used");
      if (footerParts.length) process.stdout.write(`(${footerParts.join(" · ")})\n`);
      if (r.retry_used) process.stdout.write(`(note: review retry used -- ${r.retry_notice})\n`);
    }
    process.exit(0);
  } else {
    const reason = r.diagnostic ? "call-failed" : "parse-validate-failed";
    const exitCode = REVIEW_STATUS_EXIT[reason] ?? 5;
    if (options.json) {
      process.stdout.write(JSON.stringify({
        status: reason,
        error: r.error,
        firstRawText: r.firstRawText,
        rawText: r.rawText,
        parseError: r.parseError,
        retry_used: r.retry_used,
        retriedOnce: r.retriedOnce,
        diagnostic: r.diagnostic,
      }, null, 2) + "\n");
    } else {
      process.stderr.write(`Error: ${reason} -- ${r.error}\n`);
      if (r.diagnostic && r.diagnostic.stderrHeadTail) {
        process.stderr.write(`\n--- diagnostic (stderr head+tail, ANSI stripped) ---\n${r.diagnostic.stderrHeadTail}\n`);
      }
      if (r.diagnostic && r.diagnostic.lastPartialResponseRaw) {
        process.stderr.write(`\n--- last partial RESPONSE block (log) ---\n${String(r.diagnostic.lastPartialResponseRaw).slice(0, 1500)}\n`);
      }
      if (r.firstRawText) process.stderr.write(`\n(first raw response, redacted, truncated)\n${r.firstRawText.slice(0, 1500)}\n`);
      if (r.rawText) process.stderr.write(`\n(retry raw response, redacted, truncated)\n${r.rawText.slice(0, 1500)}\n`);
    }
    process.exit(exitCode);
  }
}

// ── Task 5.4: runAdversarialReview (dual-stance red+blue, single queue slot) ─

const ADVERSARIAL_STATUS_EXIT = {
  "no-diff": 2,
  "no-base": 2,
  "bad-scope": 2,
  "merge-conflict-present": 2,
  "git-diff-failed": 6,
  "call-failed": 4,
  "parse-validate-failed": 5,
};

async function runAdversarialReview(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, {
    booleanOptions: ["json"],
    valueOptions: ["timeout", "cwd", "base", "scope"],
  });

  const cwd = options.cwd || process.cwd();
  const base = options.base || null;
  const scope = options.scope || "auto";
  const focus = positionals.join(" ").trim();
  const timeout = options.timeout ? Number(options.timeout) : 120_000;

  if (!Number.isFinite(timeout) || timeout <= 0) {
    if (options.json) {
      process.stdout.write(JSON.stringify({ status: "bad-input", reason: `invalid --timeout '${options.timeout}'` }) + "\n");
    } else {
      process.stderr.write(`Error: invalid --timeout '${options.timeout}'\n`);
    }
    process.exit(1);
  }

  const diffResult = collectDiff({ base, scope, cwd });
  if (!diffResult.ok) {
    const exitCode = ADVERSARIAL_STATUS_EXIT[diffResult.reason] ?? 6;
    const payload = { status: diffResult.reason, detail: diffResult.detail };
    if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stderr.write(`Error: ${diffResult.reason} -- ${diffResult.detail}\n`);
    process.exit(exitCode);
  }
  if (!diffResult.diff.trim()) {
    const payload = { status: "no-diff", detail: `scope=${diffResult.scope} yielded empty diff` };
    if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stdout.write(`No changes under scope=${diffResult.scope}; nothing to adversarially review.\n`);
    process.exit(2);
  }

  if (!options.json) {
    process.stdout.write(`Adversarial review (scope=${diffResult.scope}${base ? ", base=" + base : ""}, focus="${focus || "(none)"}")...\n`);
    // v2 (I14): cold start ~10s (P0.1 实测); 双 spawn 总 ~50-90s 主路径
    // v2 (I15): 显式 UX 提示 queue slot 持有窗口
    process.stdout.write("Starting MiniMax red team (cold start ~10s; full red+blue ~50-90s)...\n");
    process.stdout.write("Queue slot held for adversarial-review (~60s typical, up to ~120s with retries); other /minimax:* commands will wait.\n");
    // v0.2 TODO (M11): consider --single-spawn / --fast flag for cold-start-sensitive use
  }

  const schemaPath = path.resolve(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas", "review-output.schema.json")
  );

  const onProgressLine = options.json ? undefined : (line) => {
    process.stderr.write(stripAnsiSgr(line) + "\n");
  };

  // D5.3: hold a single queue slot across both red and blue spawns + each side's
  // 1-shot retry. Worst case: 2 stances × 2 spawns each = 4 × timeout.
  //
  // v2 (I7): cwd is shared across both spawns. Adversarial-review prompts are
  // explicitly read-only (prompts/adversarial-review.md 末尾声明 "本任务是只读
  // 审查...只输出 JSON"), but Mini-Agent's file-write tool is not blocked at the
  // runtime level. If the model violates the prompt and writes a file, blue
  // stance's spawn will read the polluted cwd. Acceptable for v0.1; tripwire
  // (minimax-result-handling SKILL §suspicious bash) catches obvious abuse.
  const workspaceRoot = defaultWorkspaceRoot();
  const slot = await acquireQueueSlot(workspaceRoot, { maxWaitMs: timeout * 4 + 30_000 });
  if (!slot.acquired) {
    const payload = { status: "queue-timeout", reason: slot.reason };
    if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stderr.write(`Error: queue-timeout (${slot.reason})\n`);
    process.exit(4);
  }

  let r;
  try {
    r = await callMiniAgentAdversarial({
      context: diffResult.diff,
      focus,
      schemaPath,
      cwd,
      timeout,
      onProgressLine,
    });
  } finally {
    releaseQueueSlot(workspaceRoot, slot.token);
  }

  if (r.ok) {
    if (options.json) {
      process.stdout.write(JSON.stringify({
        status: "ok",
        red: pickViewpointPayload(r.red),
        blue: pickViewpointPayload(r.blue),
      }, null, 2) + "\n");
    } else {
      renderViewpointText("Red Team", r.red);
      process.stdout.write("\n");
      renderViewpointText("Blue Team", r.blue);
      const cfg = readMiniAgentConfig();
      const footerParts = [];
      if (cfg.model) footerParts.push(`model: ${cfg.model}`);
      if (r.red.logPath) footerParts.push(`red-log: ${r.red.logPath}`);
      if (r.blue.logPath) footerParts.push(`blue-log: ${r.blue.logPath}`);
      if (r.red.retry_used) footerParts.push("red-retry-used");
      if (r.blue.retry_used) footerParts.push("blue-retry-used");
      if (footerParts.length) process.stdout.write(`(${footerParts.join(" · ")})\n`);
    }
    process.exit(0);
  } else {
    const failedSide = r.side === "red" ? r.red : r.blue;
    const reason = failedSide.diagnostic ? "call-failed" : "parse-validate-failed";
    const exitCode = ADVERSARIAL_STATUS_EXIT[reason] ?? 5;
    if (options.json) {
      process.stdout.write(JSON.stringify({
        status: reason,
        side: r.side,
        error: r.error,
        red: r.red ? pickViewpointPayload(r.red) : null,
        blue: r.blue ? pickViewpointPayload(r.blue) : null,
        firstRawText: failedSide.firstRawText ?? null,
        rawText: failedSide.rawText ?? null,
        parseError: failedSide.parseError ?? null,
        diagnostic: failedSide.diagnostic ?? null,
      }, null, 2) + "\n");
    } else {
      process.stderr.write(`Error: ${reason} (${r.side} team) -- ${r.error}\n`);
      if (failedSide.diagnostic && failedSide.diagnostic.stderrHeadTail) {
        process.stderr.write(`\n--- diagnostic (${r.side} stderr head+tail) ---\n${failedSide.diagnostic.stderrHeadTail}\n`);
      }
      if (failedSide.firstRawText) process.stderr.write(`\n(${r.side} first raw response, redacted, truncated)\n${failedSide.firstRawText.slice(0, 1500)}\n`);
      if (failedSide.rawText) process.stderr.write(`\n(${r.side} retry raw response, redacted, truncated)\n${failedSide.rawText.slice(0, 1500)}\n`);
      if (r.side === "blue" && r.red?.ok) {
        process.stderr.write(`\n(red team succeeded; rerun for blue. Red verdict: ${r.red.verdict})\n`);
      }
    }
    process.exit(exitCode);
  }
}

function pickViewpointPayload(v) {
  if (!v.ok) {
    return {
      ok: false,
      error: v.error,
      retry_used: v.retry_used,
      retriedOnce: v.retriedOnce,
    };
  }
  return {
    ok: true,
    verdict: v.verdict,
    summary: v.summary,
    findings: v.findings,
    next_steps: v.next_steps,
    retry_used: v.retry_used,
    retriedOnce: v.retriedOnce,
    retry_notice: v.retry_notice,
    truncated: v.truncated,
    logPath: v.logPath,
  };
}

function renderViewpointText(label, v) {
  process.stdout.write(`=== ${label} ===\n`);
  if (!v.ok) {
    process.stdout.write(`(${label} failed: ${v.error})\n`);
    return;
  }
  process.stdout.write(`Verdict: ${v.verdict}\n`);
  process.stdout.write(`Summary: ${v.summary}\n`);
  const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const findings = [...v.findings].sort((a, b) => (sevOrder[a.severity] ?? 99) - (sevOrder[b.severity] ?? 99));
  if (findings.length === 0) {
    process.stdout.write("Findings: (none)\n");
  } else {
    process.stdout.write(`Findings (${findings.length}):\n`);
    for (const f of findings) {
      process.stdout.write(`  - [${f.severity}] ${f.title}\n`);
      process.stdout.write(`    ${f.file}:${f.line_start}${f.line_end !== f.line_start ? "-" + f.line_end : ""}  (confidence ${f.confidence})\n`);
      process.stdout.write(`    ${f.body}\n`);
      process.stdout.write(`    fix: ${f.recommendation}\n`);
    }
  }
  if (v.next_steps.length) {
    process.stdout.write("Next steps:\n");
    for (const s of v.next_steps) process.stdout.write(`  - ${s}\n`);
  }
  if (v.retry_used) {
    process.stdout.write(`(${label}: retry used -- ${v.retry_notice})\n`);
  }
}

// ── Task 4.4/4.5: runRescue (foreground + --background) ──────────────────

async function runRescue(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, {
    booleanOptions: ["json", "sandbox", "background"],
    valueOptions: ["timeout", "cwd"],
  });

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    if (options.json) process.stdout.write(JSON.stringify({ status: "bad-input", reason: "prompt is empty" }) + "\n");
    else process.stderr.write("Error: prompt is required\n");
    process.exit(1);
  }
  const timeout = options.timeout ? Number(options.timeout) : 300_000;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    if (options.json) process.stdout.write(JSON.stringify({ status: "bad-input", reason: `invalid --timeout '${options.timeout}'` }) + "\n");
    else process.stderr.write(`Error: invalid --timeout '${options.timeout}'\n`);
    process.exit(1);
  }
  const cwd = options.cwd || process.cwd();
  const sandbox = Boolean(options.sandbox);
  const sessionId = process.env.MINIMAX_COMPANION_SESSION_ID || null;
  const workspaceRoot = defaultWorkspaceRoot();

  // ── Background: detach worker, exit immediately with jobId ────────
  if (options.background) {
    const { jobId, meta: jobMeta } = createJob({
      workspaceRoot, prompt, cwd, sandbox, sessionId, extraArgs: [], timeout,
    });
    const slot = await acquireQueueSlot(workspaceRoot, { maxWaitMs: 60_000 });
    if (!slot.acquired) {
      await updateJobMeta(workspaceRoot, jobId, { status: "failed", endedAt: Date.now(), error: "queue-timeout" });
      const payload = { status: "queue-timeout", jobId };
      if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      else process.stderr.write(`Error: queue-timeout (jobId=${jobId})\n`);
      process.exit(4);
    }
    await updateJobMeta(workspaceRoot, jobId, { queueToken: slot.token });

    const script = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [script, "_worker", jobId, "--workspace-root", workspaceRoot], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, MINIMAX_COMPANION_SESSION_ID: sessionId || "" },
    });
    child.unref();

    await updateJobMeta(workspaceRoot, jobId, { pid: child.pid, status: "starting" });
    const payload = { jobId, status: "starting", workdir: jobMeta.workdir };
    if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stdout.write(`Rescue job ${jobId} started in background. Poll with /minimax:status ${jobId}.\n`);
    process.exit(0);
  }

  // ── Foreground: create job, acquire queue, run, release ─────────────
  const { jobId, meta } = createJob({ workspaceRoot, prompt, cwd, sandbox, sessionId, timeout });
  if (!options.json) {
    process.stdout.write(`Rescue job ${jobId} created (workdir=${meta.workdir}${sandbox ? ", sandbox" : ""}).\n`);
    process.stdout.write("Waiting for queue slot...\n");
  }

  const slot = await acquireQueueSlot(workspaceRoot, { maxWaitMs: timeout + 30_000 });
  if (!slot.acquired) {
    await updateJobMeta(workspaceRoot, jobId, { status: "failed", endedAt: Date.now() });
    const payload = { status: "queue-timeout", jobId, detail: slot.reason };
    if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stderr.write(`Error: queue-timeout (${slot.reason})\n`);
    process.exit(4);
  }

  try {
    if (!options.json) process.stdout.write("Starting MiniMax (cold start ~3s)...\n");
    await updateJobMeta(workspaceRoot, jobId, { status: "running", startedAt: Date.now(), pid: process.pid });

    const onProgressLine = options.json ? undefined : (line) => process.stdout.write(stripAnsiSgr(line) + "\n");
    const result = await callMiniAgent({ prompt, cwd: meta.workdir, timeout, onProgressLine });
    const cls = classifyMiniAgentResult(result);

    await updateJobMeta(workspaceRoot, jobId, {
      status: (cls.status === "success" || cls.status === "success-but-truncated") ? "done" : "failed",
      endedAt: Date.now(),
      exitCode: result.exitCode,
      signal: result.signal,
      miniAgentLogPath: cls.logPath,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      classifyStatus: cls.status,
      response: cls.response ?? null,
      finishReason: cls.finishReason ?? null,
    });

    const jDir = jobDir(workspaceRoot, jobId);
    fs.writeFileSync(path.join(jDir, "stdout.log"), String(result.rawStdout || ""), "utf8");
    fs.writeFileSync(path.join(jDir, "stderr.log"), String(result.rawStderr || ""), "utf8");

    const exitCode = STATUS_EXIT_CODE[cls.status] ?? 5;
    if (options.json) {
      const payload = (cls.status === "success" || cls.status === "success-but-truncated")
        ? { jobId, status: cls.status, response: cls.response, toolCalls: cls.toolCalls, finishReason: cls.finishReason, thinking: cls.thinking, logPath: cls.logPath }
        : { jobId, status: cls.status, reason: cls.reason ?? null, detail: cls.detail ?? null, logPath: cls.logPath ?? null, diagnostic: cls.diagnostic ?? null };
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    } else if (cls.status === "success" || cls.status === "success-but-truncated") {
      const cfg = readMiniAgentConfig();
      process.stdout.write("\n---\n" + cls.response + "\n");
      const footer = [];
      if (cfg.model) footer.push(`model: ${cfg.model}`);
      if (cls.logPath) footer.push(`log: ${cls.logPath}`);
      footer.push(`job: ${jobId}`);
      if (cls.status === "success-but-truncated") footer.push("truncated");
      process.stdout.write(`(${footer.join(" \u00B7 ")})\n`);
    } else {
      process.stderr.write(`Error: ${cls.status}${cls.detail ? " -- " + cls.detail : ""}\n`);
      if (cls.diagnostic && cls.diagnostic.stderrHeadTail) {
        process.stderr.write(`\n--- diagnostic (stderr head+tail, ANSI stripped) ---\n${cls.diagnostic.stderrHeadTail}\n`);
      }
      process.stderr.write(`job: ${jobId}\n`);
    }
    process.exit(exitCode);
  } finally {
    releaseQueueSlot(workspaceRoot, slot.token);
  }
}

// ── Task 4.5: _worker (internal detached subprocess) ─────────────────────

async function runWorker(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, {
    valueOptions: ["workspace-root"],
  });
  const jobId = positionals[0];
  if (!jobId) { process.stderr.write("_worker: missing jobId\n"); process.exit(2); }
  const workspaceRoot = options["workspace-root"] || defaultWorkspaceRoot();
  const meta = readJob(workspaceRoot, jobId);
  if (!meta) { process.stderr.write(`_worker: job ${jobId} not found\n`); process.exit(2); }

  let exitCode = 0;
  try {
    await updateJobMeta(workspaceRoot, jobId, { status: "running", startedAt: Date.now(), pid: process.pid });

    const jDir = jobDir(workspaceRoot, jobId);
    const stdoutFile = path.join(jDir, "stdout.log");
    const stderrFile = path.join(jDir, "stderr.log");
    const stdoutWs = fs.createWriteStream(stdoutFile, { flags: "a" });
    const onProgressLine = (line) => { try { stdoutWs.write(stripAnsiSgr(line) + "\n"); } catch {} };

    let result, cls;
    try {
      result = await callMiniAgent({
        prompt: meta.prompt,
        cwd: meta.workdir,
        timeout: meta.timeout || 300_000,
        extraArgs: meta.extraArgs || [],
        onProgressLine,
      });
      cls = classifyMiniAgentResult(result);
    } catch (err) {
      try {
        await updateJobMeta(workspaceRoot, jobId, {
          status: "failed",
          endedAt: Date.now(),
          error: redactSecrets(err.message || String(err)),
        });
      } catch { /* keep going to finally */ }
      try { fs.writeFileSync(stderrFile, `worker exception: ${err.message}\n`, "utf8"); } catch {}
      stdoutWs.end();
      exitCode = 2;
      return;
    }

    try { fs.writeFileSync(stderrFile, String(result.rawStderr || ""), "utf8"); } catch {}
    stdoutWs.end();

    try {
      await updateJobMeta(workspaceRoot, jobId, {
        status: (cls.status === "success" || cls.status === "success-but-truncated") ? "done" : "failed",
        endedAt: Date.now(),
        exitCode: result.exitCode,
        signal: result.signal,
        miniAgentLogPath: cls.logPath,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        classifyStatus: cls.status,
        response: cls.response ?? null,
        finishReason: cls.finishReason ?? null,
      });
    } catch { /* finally still releases queue */ }
  } finally {
    if (meta.queueToken) releaseQueueSlot(workspaceRoot, meta.queueToken);
  }
  process.exit(exitCode);
}

// ── Task 4.6: status / result / cancel / task-resume-candidate ───────────

function formatElapsed(startMs, endMs) {
  if (!startMs) return "?";
  const dt = Math.max(0, (endMs || Date.now()) - startMs);
  const s = Math.floor(dt / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}m${r}s`;
}

async function runStatus(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, { booleanOptions: ["json", "all"] });
  const workspaceRoot = defaultWorkspaceRoot();
  const sessionId = process.env.MINIMAX_COMPANION_SESSION_ID || null;

  if (positionals[0]) {
    const jobId = positionals[0];
    const meta = readJob(workspaceRoot, jobId);
    if (!meta) {
      if (options.json) process.stdout.write(JSON.stringify({ status: "not-found", jobId }) + "\n");
      else process.stderr.write(`Job not found: ${jobId}\n`);
      process.exit(2);
    }
    if (options.json) {
      process.stdout.write(JSON.stringify(meta, null, 2) + "\n");
    } else {
      process.stdout.write(`${meta.jobId}  ${meta.status}  (${formatElapsed(meta.startedAt, meta.endedAt)})\n`);
      process.stdout.write(`  prompt: ${(meta.prompt || "").slice(0, 80)}${(meta.prompt || "").length > 80 ? "..." : ""}\n`);
      process.stdout.write(`  workdir: ${meta.workdir}${meta.sandbox ? "  (sandbox)" : ""}\n`);
      if (meta.miniAgentLogPath) process.stdout.write(`  log: ${meta.miniAgentLogPath}\n`);
    }
    process.exit(0);
  }

  let jobs = listJobs(workspaceRoot);
  if (!options.all) jobs = filterJobsBySession(jobs, sessionId);
  if (options.json) {
    process.stdout.write(JSON.stringify(jobs, null, 2) + "\n");
  } else if (jobs.length === 0) {
    process.stdout.write("(no jobs for this session; use --all for all sessions)\n");
  } else {
    for (const j of jobs) {
      process.stdout.write(`${j.jobId}  ${j.status.padEnd(9)}  ${formatElapsed(j.startedAt, j.endedAt).padStart(6)}  ${(j.prompt || "").slice(0, 60)}\n`);
    }
  }
  process.exit(0);
}

async function runResult(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, { booleanOptions: ["json"] });
  const jobId = positionals[0];
  if (!jobId) {
    if (options.json) process.stdout.write(JSON.stringify({ status: "bad-input", reason: "jobId required" }) + "\n");
    else process.stderr.write("Error: jobId required\n");
    process.exit(1);
  }
  const workspaceRoot = defaultWorkspaceRoot();
  const meta = readJob(workspaceRoot, jobId);
  if (!meta) {
    if (options.json) process.stdout.write(JSON.stringify({ status: "not-found", jobId }) + "\n");
    else process.stderr.write(`Job not found: ${jobId}\n`);
    process.exit(2);
  }
  if (meta.status !== "done" && meta.status !== "failed" && meta.status !== "canceled") {
    if (options.json) process.stdout.write(JSON.stringify({ status: "not-finished", currentStatus: meta.status, jobId }) + "\n");
    else process.stderr.write(`Job ${jobId} is ${meta.status}; not yet finished\n`);
    process.exit(2);
  }

  if (options.json) {
    const payload = {
      jobId: meta.jobId,
      status: meta.status,
      classifyStatus: meta.classifyStatus,
      response: meta.response,
      finishReason: meta.finishReason,
      miniAgentLogPath: meta.miniAgentLogPath,
      sandbox: meta.sandbox,
      workdir: meta.workdir,
      startedAt: meta.startedAt,
      endedAt: meta.endedAt,
      exitCode: meta.exitCode,
      signal: meta.signal,
      stdoutTruncated: meta.stdoutTruncated,
      stderrTruncated: meta.stderrTruncated,
      canceled: meta.canceled,
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    const cfg = readMiniAgentConfig();
    process.stdout.write(`job: ${meta.jobId}  status: ${meta.status}\n`);
    if (meta.response) {
      process.stdout.write("\n---\n" + meta.response + "\n");
      const footer = [];
      if (cfg.model) footer.push(`model: ${cfg.model}`);
      if (meta.miniAgentLogPath) footer.push(`log: ${meta.miniAgentLogPath}`);
      if (meta.finishReason) footer.push(`finish: ${meta.finishReason}`);
      process.stdout.write(`(${footer.join(" \u00B7 ")})\n`);
    } else {
      process.stdout.write("(no response recorded)\n");
      if (meta.miniAgentLogPath) process.stdout.write(`log: ${meta.miniAgentLogPath}\n`);
    }
  }
  process.exit(0);
}

async function runCancel(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, { booleanOptions: ["json", "keep-workspace"] });
  const jobId = positionals[0];
  if (!jobId) {
    if (options.json) process.stdout.write(JSON.stringify({ status: "bad-input", reason: "jobId required" }) + "\n");
    else process.stderr.write("Error: jobId required\n");
    process.exit(1);
  }
  const workspaceRoot = defaultWorkspaceRoot();
  const r = await cancelJob(workspaceRoot, jobId, { keepWorkspace: Boolean(options["keep-workspace"]) });
  if (!r.ok) {
    if (options.json) process.stdout.write(JSON.stringify({ status: r.reason }) + "\n");
    else process.stderr.write(`Error: ${r.reason}\n`);
    process.exit(2);
  }
  const payload = { status: r.alreadyFinished ? "already-finished" : "canceled", jobId, killed: r.killed };
  if (options.json) process.stdout.write(JSON.stringify(payload) + "\n");
  else process.stdout.write(`Job ${jobId} ${payload.status}${r.killed ? " (SIGTERM/SIGKILL)" : ""}.\n`);
  process.exit(0);
}

async function runTaskResumeCandidate(rawArgs) {
  const { options } = parseArgs(rawArgs, { booleanOptions: ["json"] });
  const logDir = process.env.MINI_AGENT_LOG_DIR || path.join(os.homedir(), ".mini-agent", "log");
  let files;
  try {
    files = fs.readdirSync(logDir)
      .filter(f => f.startsWith("agent_run_") && f.endsWith(".log"))
      .map(f => {
        const full = path.join(logDir, f);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
        return { name: f, path: full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 5);
  } catch (err) {
    const payload = { status: "log-dir-missing", detail: String(err.code || err.message), candidates: [] };
    if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stderr.write(`Mini-Agent log dir not found: ${logDir}\n`);
    process.exit(2);
  }
  const payload = {
    status: "ok",
    note: "v0.1 does NOT resume -- Mini-Agent has no external session id (P0.9). Informational only.",
    candidates: files,
  };
  if (options.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    process.stdout.write("Most recent Mini-Agent log files (v0.1 cannot resume; informational only):\n");
    for (const f of files) {
      process.stdout.write(`  ${new Date(f.mtimeMs).toISOString()}  ${f.path}\n`);
    }
    if (files.length === 0) process.stdout.write("  (none)\n");
  }
  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);

  let [sub, ...rest] = argv;
  if (rest.length === 1 && !rest[0].startsWith("-") && rest[0].includes(" ")) {
    rest = splitRawArgumentString(rest[0]);
  }

  switch (sub) {
    case "setup":
      return await runSetup(rest);
    case "write-key":
      return await runWriteKey(rest);
    case "ask":
      return await runAsk(rest);
    case "review":
      return await runReview(rest);
    case "adversarial-review":
      return await runAdversarialReview(rest);
    case "rescue":
      return await runRescue(rest);
    case "status":
      return await runStatus(rest);
    case "result":
      return await runResult(rest);
    case "cancel":
      return await runCancel(rest);
    case "task-resume-candidate":
      return await runTaskResumeCandidate(rest);
    case "_worker":
      return await runWorker(rest);
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      process.exit(0);
      break;
    default:
      process.stderr.write(`Unknown subcommand: ${sub}\n${USAGE}\n`);
      process.exit(1);
  }
}

main().catch(err => {
  process.stderr.write(`companion fatal: ${err.message}\n`);
  process.exit(99);
});
