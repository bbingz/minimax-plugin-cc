import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { binaryAvailable } from "./process.mjs";
import { withLockAsync } from "./state.mjs";

const DEFAULT_TIMEOUT_MS = 300_000;
const AUTH_CHECK_TIMEOUT_MS = 30_000;

export const PARENT_SESSION_ENV = "MINIMAX_COMPANION_SESSION_ID";
export const MINI_AGENT_BIN = process.env.MINI_AGENT_BIN || "mini-agent";

// plan v5 修正（gemini review）：路径常量都可通过 env 覆盖（测试 / mock / CI 场景）
const DEFAULT_MM_DIR = path.join(os.homedir(), ".mini-agent");
export const MINI_AGENT_CONFIG_PATH =
  process.env.MINI_AGENT_CONFIG_PATH ||
  path.join(DEFAULT_MM_DIR, "config", "config.yaml");
export const MINI_AGENT_LOG_DIR =
  process.env.MINI_AGENT_LOG_DIR ||
  path.join(DEFAULT_MM_DIR, "log");
export const MINI_AGENT_LOCK_PATH =
  process.env.MINI_AGENT_LOCK_PATH ||
  path.join(path.dirname(MINI_AGENT_CONFIG_PATH), ".lock");

// ── Top-level YAML key scanner (spec §3.4) ────────────────────
//
// Reads a single top-level string value for a given key.
// Does NOT support: multiline strings (| > literals), flow style ({}, []),
// anchors/aliases (& *), tags (! !!), or nested documents.
// v0.1 scope: enough for {api_key, api_base, model, provider}.

export function readYamlTopLevelKey(text, key) {
  if (!text) return null;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);  // strip BOM
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    // 跳过缩进行（子字段/数组项/延续行）
    if (raw.length !== raw.trimStart().length) continue;
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\w+)\s*:\s*(?:"([^"]*)"|'([^']*)'|([^#\s][^#]*?))\s*(?:#.*)?$/);
    if (m && m[1] === key) return m[2] ?? m[3] ?? (m[4] ? m[4].trim() : null);
  }
  return null;
}

let _configCache;

export function readMiniAgentConfig() {
  if (_configCache !== undefined) return _configCache;
  try {
    const text = fs.readFileSync(MINI_AGENT_CONFIG_PATH, "utf8");
    _configCache = {
      api_key: readYamlTopLevelKey(text, "api_key"),
      api_base: readYamlTopLevelKey(text, "api_base"),
      model: readYamlTopLevelKey(text, "model"),
      provider: readYamlTopLevelKey(text, "provider"),
      raw: text,
    };
  } catch (err) {
    _configCache = {
      api_key: null, api_base: null, model: null, provider: null, raw: null,
      readError: err.code === "ENOENT" ? "config-missing" : `read-error: ${err.message}`,
    };
  }
  return _configCache;
}

// 缓存失效（仅供测试使用）
export function _invalidateConfigCache() { _configCache = undefined; }

// ── Availability ──────────────────────────────────────────────

export function getMiniAgentAvailability(cwd) {
  return binaryAvailable(MINI_AGENT_BIN, ["--version"], { cwd });
}
