#!/usr/bin/env node
import process from "node:process";
import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  getMiniAgentAvailability,
  getMiniAgentAuthStatus,
  readMiniAgentConfig,
  writeMiniAgentApiKey,
  redactSecrets,
} from "./lib/minimax.mjs";
import { binaryAvailable } from "./lib/process.mjs";

const USAGE = `Usage: minimax-companion <subcommand> [options]

Subcommands:
  setup [--json] [--enable-review-gate|--disable-review-gate]
                    Check mini-agent CLI availability and auth state.
                    In interactive Claude Code flow, this may prompt (via AskUserQuestion)
                    for API key and api_base region if missing.

  write-key --api-key <key> [--api-base <url>] [--json]
                    Write api_key (and optionally api_base) into config.yaml with
                    hardened gate + atomic write + stale-lock recovery.
                    Returns { ok, reason?, form?, lineNumber? }.

(More subcommands arrive in Phase 2+.)
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
