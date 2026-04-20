#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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
} from "./lib/minimax.mjs";
import { binaryAvailable } from "./lib/process.mjs";

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

  review [--json] [--timeout <ms>] [--cwd <path>] [--base <ref>] [--scope <mode>] [focus]
                    Review git diff with mini-agent. Auto scope prefers working
                    tree, then staged, then branch when --base is provided.
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

  const result = await callMiniAgent({ prompt, cwd, timeout, onProgressLine });
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

  const r = await callMiniAgentReview({
    context: diffResult.diff,
    focus,
    schemaPath,
    cwd,
    timeout,
    onProgressLine,
  });

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
      const findings = [...r.findings].sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
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
