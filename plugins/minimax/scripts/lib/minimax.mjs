import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
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

// ── YAML write gate (spec §3.4.2 state machine, plan v5) ──────
//
// 只接受 Form D（"..."）和 Form S（'...'）两种单行形态；plain scalar 一律拒。
// Quote-aware: 引号内的 `#` / `{` / `[` 是字面文本，不是注释/流式标记。

function findClosingDoubleQuote(s, start) {
  // YAML 1.2.2 §5.7: 双引号内 `\` 转义下一字符；遇未转义 `"` 即闭合
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === '"') return i;
    i++;
  }
  return -1;
}

function findClosingSingleQuote(s, start) {
  // YAML 1.2.2 §7.3.2: `''` 是转义；其他 `'` 即闭合
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === "'") {
      if (s[i + 1] === "'") { i += 2; continue; }
      return i;
    }
    i++;
  }
  return -1;
}

function findInlineCommentAfter(s, startIdx) {
  // 只有 ` #` 或 `\t#` 才算 inline comment（YAML 1.2.2 §6.6：`#` 前必须有空白）
  for (let i = startIdx; i < s.length; i++) {
    if ((s[i] === " " || s[i] === "\t") && s[i + 1] === "#") return i;
  }
  return -1;
}

/**
 * spec §3.4.2 state machine — quote-aware trailing comment detection.
 * @returns {{ ok: boolean, reason?: string, lineNumber?: number, form?: "D"|"S" }}
 */
export function validateYamlForApiKeyWrite(text) {
  if (!text) return { ok: false, reason: "empty-file" };
  if (text.charCodeAt(0) === 0xFEFF) return { ok: false, reason: "BOM at file start" };

  const lines = text.split(/\r?\n/);
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    if (raw.trimStart().startsWith("#")) continue;
    if (raw[0] === " " || raw[0] === "\t") continue;
    const m = raw.match(/^api_key\s*:\s*(.*)$/);
    if (m) matches.push({ index: i, valueRaw: m[1] });
  }

  if (matches.length === 0) return { ok: false, reason: "no-api-key" };
  if (matches.length > 1) return { ok: false, reason: "duplicate-api-key", lineNumber: matches[1].index + 1 };

  const match = matches[0];
  // 不预先 stripInlineComment——引号内 `#` 是字面
  let v = match.valueRaw.replace(/\s+$/, "");

  if (v === "") return { ok: false, reason: "empty-value-looks-like-block-scalar", lineNumber: match.index + 1 };

  if (/^[|>]/.test(v)) {
    return { ok: false, reason: "block-scalar-indicator", lineNumber: match.index + 1 };
  }
  if (v.startsWith("{") || v.startsWith("[")) {
    return { ok: false, reason: "flow-style", lineNumber: match.index + 1 };
  }
  if (v.startsWith("&") || v.startsWith("*") || v.startsWith("!")) {
    return { ok: false, reason: "anchor-alias-or-tag", lineNumber: match.index + 1 };
  }

  // Form D
  if (v.startsWith('"')) {
    const close = findClosingDoubleQuote(v, 0);
    if (close < 0) return { ok: false, reason: "form-D-unclosed", lineNumber: match.index + 1 };
    const afterClose = v.slice(close + 1);
    const commentIdx = findInlineCommentAfter(afterClose, 0);
    const trailing = (commentIdx >= 0 ? afterClose.slice(0, commentIdx) : afterClose).trim();
    if (trailing !== "") return { ok: false, reason: "form-D-trailing-content", lineNumber: match.index + 1 };
    const next = lines[match.index + 1];
    if (next && (next[0] === " " || next[0] === "\t") && next.trim() !== "" && !next.trimStart().startsWith("#")) {
      return { ok: false, reason: "suspicious-continuation-after-api-key", lineNumber: match.index + 2 };
    }
    return { ok: true, lineNumber: match.index + 1, form: "D" };
  }

  // Form S
  if (v.startsWith("'")) {
    const close = findClosingSingleQuote(v, 0);
    if (close < 0) return { ok: false, reason: "form-S-unclosed", lineNumber: match.index + 1 };
    const afterClose = v.slice(close + 1);
    const commentIdx = findInlineCommentAfter(afterClose, 0);
    const trailing = (commentIdx >= 0 ? afterClose.slice(0, commentIdx) : afterClose).trim();
    if (trailing !== "") return { ok: false, reason: "form-S-trailing-content", lineNumber: match.index + 1 };
    const next = lines[match.index + 1];
    if (next && (next[0] === " " || next[0] === "\t") && next.trim() !== "" && !next.trimStart().startsWith("#")) {
      return { ok: false, reason: "suspicious-continuation-after-api-key", lineNumber: match.index + 2 };
    }
    return { ok: true, lineNumber: match.index + 1, form: "S" };
  }

  // Plain scalar —— 强制拒绝
  return { ok: false, reason: "plain-scalar-requires-quoting", lineNumber: match.index + 1 };
}

// ── Key content validation (spec §3.4.3) ──────────────────────

const CONTROL_CHAR_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const MAX_KEY_LEN = 4096;

export function validateKeyContent(newKey) {
  if (typeof newKey !== "string" || newKey.length === 0) return { ok: false, reason: "empty-key" };
  if (newKey.length > MAX_KEY_LEN) return { ok: false, reason: "key-too-long" };
  if (CONTROL_CHAR_REGEX.test(newKey)) return { ok: false, reason: "control-char-in-key" };
  if (/\n|\r|\t/.test(newKey)) return { ok: false, reason: "whitespace-newline-in-key" };
  // 代理对检测
  for (let i = 0; i < newKey.length; i++) {
    const c = newKey.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const n = newKey.charCodeAt(i + 1);
      if (!(n >= 0xDC00 && n <= 0xDFFF)) return { ok: false, reason: "unpaired-surrogate" };
      i++;
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      return { ok: false, reason: "unpaired-surrogate" };
    }
  }
  return { ok: true };
}

export function escapeForYamlDoubleQuoted(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

// ── API key redaction (spec §3.4) ─────────────────────────────

export function redactSecrets(text) {
  if (!text) return text;
  return String(text)
    .replace(/sk-[A-Za-z0-9_\-\.]{20,}/g, "sk-***REDACTED***")
    .replace(/eyJ[A-Za-z0-9_\-\.]{20,}/g, "eyJ***REDACTED***");
}

// ── Atomic YAML api_key write (spec §3.4 / §4.2, plan v5) ─────

function fsyncAndRename(tmpPath, targetPath) {
  const fd = fs.openSync(tmpPath, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmpPath, targetPath);
  try {
    const dirFd = fs.openSync(path.dirname(targetPath), "r");
    try { fs.fsyncSync(dirFd); } catch { /* Windows 允许 fail */ }
    finally { fs.closeSync(dirFd); }
  } catch { /* 目录打开失败忽略 */ }
}

/**
 * Write api_key into MINI_AGENT_CONFIG_PATH atomically, under withLockAsync.
 * @returns {Promise<{ok:boolean, reason?:string, lineNumber?:number, form?:"D"}>}
 */
export async function writeMiniAgentApiKey(newKey) {
  const keyCheck = validateKeyContent(newKey);
  if (!keyCheck.ok) return keyCheck;

  let text;
  try { text = fs.readFileSync(MINI_AGENT_CONFIG_PATH, "utf8"); }
  catch (err) { return { ok: false, reason: `read-failed: ${err.code || err.message}` }; }

  const gate = validateYamlForApiKeyWrite(text);
  if (!gate.ok) return gate;

  // 规范化输出为 Form D（§3.4.3）
  const escapedKey = escapeForYamlDoubleQuoted(newKey);
  const next = text.replace(/^api_key\s*:\s*.*$/m, `api_key: "${escapedKey}"`);

  const tmpPath = `${MINI_AGENT_CONFIG_PATH}.tmp.${process.pid}.${Date.now()}`;
  if (path.dirname(tmpPath) !== path.dirname(MINI_AGENT_CONFIG_PATH)) {
    return { ok: false, reason: "tmpfile-not-same-dir" };
  }

  try {
    await withLockAsync(MINI_AGENT_LOCK_PATH, async () => {
      fs.writeFileSync(tmpPath, next, { mode: 0o600 });
      fsyncAndRename(tmpPath, MINI_AGENT_CONFIG_PATH);
    });
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    return { ok: false, reason: `lock-or-write-failed: ${err.message}` };
  }

  _invalidateConfigCache();
  return { ok: true, lineNumber: gate.lineNumber, form: "D" };
}

// ── spawn with hard timeout (spec §3.6, plan v5) ──────────────
//
// 三段式 timeout 保证：即便子进程吞 SIGTERM，Promise 也必在 timeoutMs + 5s + 500ms 内 resolve
//
// 流程:
//   timeoutMs 到 → SIGTERM
//   +5s → SIGKILL
//   +500ms → 强制 resolve（even if close 未触发）
//
// stdout/stderr 用 StringDecoder 增量消费；error/exit/close 事件分离
// 移除所有 listener 防泄漏（plan v3 codex MED）

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {{timeoutMs?: number, cwd?: string, env?: object, onStdoutLine?: (line: string) => void, maxStdoutBytes?: number, maxStderrBytes?: number}} options
 * @returns {Promise<{exitCode: number|null, signal: string|null, stdout: string, stderr: string, stdoutTruncated: boolean, stderrTruncated: boolean, timedOut: boolean, spawnError: Error|null}>}
 */
export function spawnWithHardTimeout(bin, args, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cwd,
    env,
    onStdoutLine,
    maxStdoutBytes = 1_048_576, // 1 MiB default (spec §3.3)
    maxStderrBytes = 65_536,    //  64 KiB default (spec §3.3)
  } = options;

  return new Promise((resolve) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let lineCarry = "";
    let settled = false;
    let didTimeout = false;
    let termTimer, killTimer;

    const finalize = (extras) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      // flush trailing line carry (no trailing \n but still a line from consumer POV)
      if (typeof onStdoutLine === "function" && lineCarry.length > 0) {
        try { onStdoutLine(lineCarry); } catch {}
        lineCarry = "";
      }
      resolve({
        exitCode: proc?.exitCode ?? null,
        signal: proc?.signalCode ?? null,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        stdoutTruncated,
        stderrTruncated,
        timedOut: didTimeout,
        spawnError: null,
        ...extras,
      });
    };

    let proc;
    try {
      proc = spawn(bin, args, {
        cwd, env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (spawnError) {
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      return resolve({
        exitCode: null, signal: null, stdout: "", stderr: "",
        stdoutTruncated: false, stderrTruncated: false,
        timedOut: false, spawnError,
      });
    }

    proc.on("error", (err) => {
      if (settled) return;
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.removeAllListeners("close");
      // Route through finalize() so lineCarry gets flushed on spawn error
      // (ENOENT/EPERM etc.). proc.exitCode/signalCode are null here, matching
      // the prior inline resolve() shape.
      finalize({ spawnError: err });
    });

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    proc.stdout.on("data", (chunk) => {
      const decoded = stdoutDecoder.write(chunk);
      if (!decoded) return;
      if (typeof onStdoutLine === "function") {
        lineCarry += decoded;
        let idx;
        while ((idx = lineCarry.indexOf("\n")) !== -1) {
          const line = lineCarry.slice(0, idx);
          lineCarry = lineCarry.slice(idx + 1);
          try { onStdoutLine(line); } catch {}
        }
      }
      const combined = stdoutBuf + decoded;
      if (combined.length > maxStdoutBytes) {
        stdoutBuf = combined.slice(combined.length - maxStdoutBytes);
        stdoutTruncated = true;
      } else {
        stdoutBuf = combined;
      }
    });

    proc.stderr.on("data", (chunk) => {
      const decoded = stderrDecoder.write(chunk);
      if (!decoded) return;
      const combined = stderrBuf + decoded;
      if (combined.length > maxStderrBytes) {
        stderrBuf = combined.slice(combined.length - maxStderrBytes);
        stderrTruncated = true;
      } else {
        stderrBuf = combined;
      }
    });

    // spec §3.3: complete on 'close' (full stdio drain), not 'exit'
    proc.once("close", () => {
      stdoutBuf += stdoutDecoder.end();
      stderrBuf += stderrDecoder.end();
      finalize({});
    });

    // Hard timeout: SIGTERM → SIGKILL → 500ms force-resolve
    termTimer = setTimeout(() => {
      if (settled) return;
      didTimeout = true;
      try { proc.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        if (settled) return;
        try { proc.kill("SIGKILL"); } catch {}
        setTimeout(() => {
          if (!settled) {
            settled = true;
            clearTimeout(termTimer); clearTimeout(killTimer);
            resolve({
              exitCode: null, signal: "SIGKILL",
              stdout: stdoutBuf, stderr: stderrBuf,
              stdoutTruncated, stderrTruncated,
              timedOut: true, spawnError: null,
            });
          }
        }, 500);
      }, 5_000);
    }, timeoutMs);
  });
}

// ── callMiniAgent (spec §3.2, §3.3) ─────────────────────────────────────────
// Reuses MINI_AGENT_LOG_DIR / MINI_AGENT_BIN constants (exported at file top,
// honoring env overrides MINI_AGENT_LOG_DIR / MINI_AGENT_BIN for tests).

function snapshotLogDir(dir) {
  try {
    return new Set(fs.readdirSync(dir).filter(name => name.endsWith(".log")));
  } catch {
    return new Set();
  }
}

function diffLogSnapshot(beforeSet, dir) {
  let afterFiles;
  try { afterFiles = fs.readdirSync(dir).filter(name => name.endsWith(".log")); }
  catch { return null; }

  const novel = afterFiles.filter(name => !beforeSet.has(name));
  if (novel.length === 0) return null;
  // Multiple new logs → v0.1 does not disambiguate (P0.10 conditional gate FAIL;
  // Phase 4 must serialize). Pick latest mtime as a best-guess; single-spawn
  // case only yields one novel entry anyway.
  const stats = novel.map(name => {
    const p = path.join(dir, name);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(p).mtimeMs; } catch {}
    return { p, mtimeMs };
  });
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stats[0].p;
}

/**
 * Spawn mini-agent one-shot, pipe stdout to progress callback, capture Log file
 * line (fallback: snapshot diff), then parse log on close.
 *
 * Returns raw context — callers run `classifyMiniAgentResult` (Task 2.3) to
 * map to a status.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeout=120000]
 * @param {string[]} [opts.extraArgs=[]]
 * @param {(line:string)=>void} [opts.onProgressLine]
 * @param {string} [opts.bin=MINI_AGENT_BIN]
 * @param {string} [opts.logDir=MINI_AGENT_LOG_DIR]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {Promise<object>}
 */
export async function callMiniAgent({
  prompt,
  cwd,
  timeout = 120_000,
  extraArgs = [],
  onProgressLine,
  bin = MINI_AGENT_BIN,
  logDir = MINI_AGENT_LOG_DIR,
  env,
} = {}) {
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("callMiniAgent: prompt must be a non-empty string");
  }
  const resolvedCwd = cwd || process.cwd();

  const beforeSet = snapshotLogDir(logDir);

  let capturedLogPath = null;
  let linesSeen = 0;

  const forwardLine = (line) => {
    linesSeen += 1;
    // spec §3.3: regex-scan first 30 stdout lines for "Log file:"
    if (!capturedLogPath && linesSeen <= 30) {
      const m = line.match(/Log file:\s+(\S+\.log)/);
      if (m) capturedLogPath = m[1];
    }
    if (typeof onProgressLine === "function") {
      try { onProgressLine(line); } catch {}
    }
  };

  const args = ["-t", prompt, "-w", resolvedCwd, ...extraArgs];
  const result = await spawnWithHardTimeout(bin, args, {
    cwd: resolvedCwd,
    env,
    timeoutMs: timeout,
    onStdoutLine: forwardLine,
  });

  // Fallback: stdout didn't surface logPath → diff snapshot
  let logPath = capturedLogPath;
  if (!logPath) {
    logPath = diffLogSnapshot(beforeSet, logDir);
  }

  let logParse = null;
  if (logPath) {
    try {
      logParse = await parseFinalResponseFromLog(logPath);
    } catch (err) {
      logParse = { ok: false, partial: true, reason: `log-parse-threw: ${err.code || err.message}`, response: "", toolCalls: [] };
    }
  }

  return {
    prompt,
    cwd: resolvedCwd,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    spawnError: result.spawnError,
    rawStdout: result.stdout,
    rawStderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    logPath,
    logParse,
  };
}

// ── Log path extraction & response parsing (spec §3.5, state machine; P0.2 schema) ─

export function extractLogPathFromStdout(stdoutOrFirstLines) {
  const lines = Array.isArray(stdoutOrFirstLines)
    ? stdoutOrFirstLines
    : stdoutOrFirstLines.split("\n").slice(0, 30);
  for (const line of lines) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, "");
    const m = clean.match(/Log file:\s+(\S+\.log)/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Count unescaped { and } on a line, respecting JSON string context.
 */
function scanBraces(line, startInString) {
  let opens = 0, closes = 0;
  let inString = startInString;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === "\\") { i++; continue; }  // skip escaped
      if (c === '"') inString = false;
    } else {
      if (c === '"') inString = true;
      else if (c === "{") opens++;
      else if (c === "}") closes++;
    }
  }
  return { opens, closes, endsInString: inString };
}

/**
 * Parse Mini-Agent log into blocks using a line-by-line state machine.
 * Returns array of { n, kind: "REQUEST"|"RESPONSE"|"TOOL_RESULT", json, raw, truncated? }.
 */
function parseLogBlocks(text) {
  const STATE = { SEEK_HEADER: 0, SKIP_TO_BODY: 1, COLLECT_BODY: 2 };
  let state = STATE.SEEK_HEADER;
  const blocks = [];
  let current = null;
  let accLines = [];
  let braceDepth = 0;
  let inString = false;

  const lines = text.split(/\r?\n/);

  const finishBlock = (truncated) => {
    if (!current) return;
    current.raw = accLines.join("\n");
    try { current.json = JSON.parse(current.raw); }
    catch { current.json = null; }
    if (truncated) current.truncated = true;
    blocks.push(current);
    current = null;
    accLines = [];
    braceDepth = 0;
    inString = false;
  };

  for (const line of lines) {
    if (state === STATE.SEEK_HEADER) {
      const m = line.match(/^\[(\d+)\]\s+(REQUEST|RESPONSE|TOOL_RESULT)$/);
      if (m) {
        current = { n: parseInt(m[1], 10), kind: m[2] };
        state = STATE.SKIP_TO_BODY;
      }
      continue;
    }
    if (state === STATE.SKIP_TO_BODY) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("{")) {
        accLines = [line];
        const r = scanBraces(line, false);
        braceDepth = r.opens - r.closes;
        inString = r.endsInString;
        if (braceDepth <= 0 && !inString) {
          finishBlock(false);
          state = STATE.SEEK_HEADER;
        } else {
          state = STATE.COLLECT_BODY;
        }
      }
      continue;
    }
    if (state === STATE.COLLECT_BODY) {
      accLines.push(line);
      const r = scanBraces(line, inString);
      braceDepth += r.opens - r.closes;
      inString = r.endsInString;
      if (braceDepth <= 0 && !inString) {
        finishBlock(false);
        state = STATE.SEEK_HEADER;
      }
    }
  }
  if (state === STATE.COLLECT_BODY && current) finishBlock(true);

  return blocks;
}

// P0.2 实测：Mini-Agent 日志用 OpenAI 兼容格式（非 Anthropic 原始）
const TERMINAL_FINISH_REASONS = new Set([
  "stop", "stop_sequence", "length", "tool_calls", "tool_use", "content_filter", "max_tokens"
]);

function pickTerminalResponse(blocks) {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (!b.json) continue;
    const hasFinishReason = typeof b.json.finish_reason === "string"
      && TERMINAL_FINISH_REASONS.has(b.json.finish_reason);
    const hasNonEmptyContent = typeof b.json.content === "string" && b.json.content.length > 0;
    if (hasFinishReason || hasNonEmptyContent) return b;
  }
  return null;
}

function extractToolCalls(responseJson) {
  // P0.2: tool_calls 是顶层字段（OpenAI 格式 [{id, name, arguments}]）
  const arr = Array.isArray(responseJson?.tool_calls) ? responseJson.tool_calls : [];
  return arr.map(c => ({ id: c.id, name: c.name, arguments: c.arguments }));
}

function extractTextResponse(responseJson) {
  // P0.2: content 是字符串
  return typeof responseJson?.content === "string" ? responseJson.content : "";
}

function extractThinking(responseJson) {
  return typeof responseJson?.thinking === "string" ? responseJson.thinking : null;
}

/**
 * Parse the final assistant response from a Mini-Agent log file.
 * Uses state machine (spec §3.5 + P0.2 schema). On main-path failure,
 * tries `mini-agent log <file>` fallback in isolated try/catch —
 * fallback failure must NOT affect main-path result.
 */
export async function parseFinalResponseFromLog(logPath) {
  let text;
  try { text = fs.readFileSync(logPath, "utf8"); }
  catch (err) {
    return { ok: false, partial: true, reason: `read-failed: ${err.code || err.message}`, response: "", toolCalls: [] };
  }

  const blocks = parseLogBlocks(text);
  const responseBlocks = blocks.filter(b => b.kind === "RESPONSE");

  if (responseBlocks.length === 0) {
    const fb = await tryMiniAgentLogFallback(logPath);
    return {
      ok: false,
      partial: true,
      reason: "no-response-block",
      response: "",
      toolCalls: [],
      fallbackUsed: fb.used,
      fallbackOk: fb.ok,
    };
  }

  const picked = pickTerminalResponse(responseBlocks);
  if (picked) {
    return {
      ok: true,
      partial: false,
      response: extractTextResponse(picked.json),
      toolCalls: extractToolCalls(picked.json),
      thinking: extractThinking(picked.json),
      finishReason: picked.json.finish_reason || null,
      blockIndex: picked.n,
    };
  }

  const fb = await tryMiniAgentLogFallback(logPath);
  const lastBlock = responseBlocks[responseBlocks.length - 1];
  return {
    ok: false,
    partial: true,
    reason: "no-terminal-block",
    response: "",
    toolCalls: [],
    lastPartialResponseRaw: lastBlock?.raw ?? null,
    fallbackUsed: fb.used,
    fallbackOk: fb.ok,
    fallbackResponse: fb.parsedResponse,
  };
}

/**
 * Best-effort fallback — failures NEVER propagate to main path.
 */
async function tryMiniAgentLogFallback(logPath) {
  try {
    const basename = path.basename(logPath);
    const result = await spawnWithHardTimeout(MINI_AGENT_BIN, ["log", basename], { timeoutMs: 10_000 });
    if (result.spawnError || result.timedOut) return { used: true, ok: false };
    const blocks = parseLogBlocks(result.stdout || "");
    const responseBlocks = blocks.filter(b => b.kind === "RESPONSE");
    const picked = pickTerminalResponse(responseBlocks);
    if (!picked) return { used: true, ok: false };
    return {
      used: true,
      ok: true,
      parsedResponse: extractTextResponse(picked.json),
    };
  } catch {
    return { used: true, ok: false };
  }
}

// ── Auth check (spec §3.6, async + hard timeout, P0.2 schema) ──

const CONFIG_NOT_CONFIGURED_PATTERN = /Please configure a valid API Key/;
const CONFIG_NOT_FOUND_PATTERN = /Configuration file not found/;
const SOCKS_IMPORT_ERROR_PATTERN = /ImportError: Using SOCKS proxy/;

export function stripAnsiSgr(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

// ── classifyMiniAgentResult (spec §4.1 three-layer sentinel) ────────────────

// Accept both OpenAI-style values (stop/stop_sequence/length/tool_calls) and
// Anthropic-native values (end_turn/max_tokens/tool_use). Mini-Agent passes
// through whichever the upstream provider emits; with provider="anthropic" on
// api.minimaxi.com/anthropic we see `end_turn`.
const FINISH_REASON_SUCCESS = new Set(["stop", "stop_sequence", "end_turn"]);
const FINISH_REASON_TRUNCATED = new Set(["length", "max_tokens"]);
const FINISH_REASON_INCOMPLETE = new Set(["tool_calls", "tool_use", "content_filter", "function_call"]);

const LAYER3_RETRY_FAILED = /❌?\s*Retry failed|LLM call failed after/;
const LAYER3_SESSION_STATS = /Session Statistics:/;

/**
 * Classify a callMiniAgent result into a stable status string per spec §4.1.
 *
 * @param {object} ctx - output of callMiniAgent (rawStdout, rawStderr, exitCode,
 *                       signal, spawnError, timedOut, logPath, logParse)
 * @returns {object} `{status, reason?, detail?, response?, toolCalls?, thinking?,
 *                     finishReason?, logPath?, diagnostic?}`
 */
export function classifyMiniAgentResult(ctx) {
  const {
    rawStdout = "",
    rawStderr = "",
    spawnError = null,
    timedOut = false,
    logPath = null,
    logParse = null,
  } = ctx || {};

  const stdoutStripped = stripAnsiSgr(rawStdout);
  const stderrStripped = stripAnsiSgr(rawStderr);
  const combined = stderrStripped + "\n" + stdoutStripped;

  // Hard-fail preconditions: spawnError and timeout come first.
  if (spawnError) {
    if (spawnError.code === "ENOENT") {
      return makeFailure("not-installed", "mini-agent binary not found on PATH", ctx, stdoutStripped, stderrStripped);
    }
    return makeFailure("spawn-failed", redactSecrets(spawnError.message || String(spawnError)), ctx, stdoutStripped, stderrStripped);
  }

  if (timedOut) {
    return makeFailure("llm-call-failed", undefined, ctx, stdoutStripped, stderrStripped, "hard-timeout");
  }

  // Layer 1 - source constants (most stable)
  if (SOCKS_IMPORT_ERROR_PATTERN.test(combined)) {
    return makeFailure("needs-socksio", "httpx SOCKS extra missing", ctx, stdoutStripped, stderrStripped);
  }
  if (CONFIG_NOT_CONFIGURED_PATTERN.test(combined)) {
    return makeFailure("auth-not-configured", "Mini-Agent ValueError: invalid API key", ctx, stdoutStripped, stderrStripped);
  }
  if (CONFIG_NOT_FOUND_PATTERN.test(combined)) {
    return makeFailure("config-missing", "Mini-Agent FileNotFoundError", ctx, stdoutStripped, stderrStripped);
  }

  // Layer 2 - log structure (P0.2 OpenAI schema)
  if (logParse && logParse.ok && logParse.finishReason) {
    if (FINISH_REASON_SUCCESS.has(logParse.finishReason) && logParse.response) {
      return {
        status: "success",
        response: logParse.response,
        toolCalls: logParse.toolCalls || [],
        thinking: logParse.thinking ?? null,
        finishReason: logParse.finishReason,
        logPath,
      };
    }
    if (FINISH_REASON_TRUNCATED.has(logParse.finishReason)) {
      return {
        status: "success-but-truncated",
        response: logParse.response || "",
        toolCalls: logParse.toolCalls || [],
        thinking: logParse.thinking ?? null,
        finishReason: logParse.finishReason,
        logPath,
        diagnostic: buildDiagnostic("success-but-truncated", stdoutStripped, stderrStripped, logParse, logPath),
      };
    }
    if (FINISH_REASON_INCOMPLETE.has(logParse.finishReason)) {
      return {
        status: "incomplete",
        response: logParse.response || "",
        toolCalls: logParse.toolCalls || [],
        thinking: logParse.thinking ?? null,
        finishReason: logParse.finishReason,
        logPath,
        diagnostic: buildDiagnostic("incomplete", stdoutStripped, stderrStripped, logParse, logPath),
      };
    }
  }

  // Layer 3 - stdout sentinel (most fragile; fallback)
  if (LAYER3_RETRY_FAILED.test(stdoutStripped) || LAYER3_RETRY_FAILED.test(stderrStripped)) {
    return makeFailure("llm-call-failed", undefined, ctx, stdoutStripped, stderrStripped);
  }
  if (LAYER3_SESSION_STATS.test(stdoutStripped) && (!logParse || !logParse.ok)) {
    return makeFailure(
      "success-claimed-but-no-log",
      "Session Statistics present but log did not yield a terminal RESPONSE block",
      ctx, stdoutStripped, stderrStripped
    );
  }

  return makeFailure("unknown-crashed", undefined, ctx, stdoutStripped, stderrStripped);
}

function makeFailure(status, detail, ctx, stdoutStripped, stderrStripped, reason) {
  const result = {
    status,
    response: "",
    toolCalls: [],
    thinking: null,
    finishReason: ctx?.logParse?.finishReason ?? null,
    logPath: ctx?.logPath ?? null,
    diagnostic: buildDiagnostic(status, stdoutStripped, stderrStripped, ctx?.logParse ?? null, ctx?.logPath ?? null),
  };
  if (reason !== undefined) result.reason = reason;
  if (detail !== undefined) result.detail = redactSecrets(detail);
  return result;
}

function buildDiagnostic(status, stdoutStripped, stderrStripped, logParse, logPath) {
  // spec §4.5: stderrHeadTail = first 256 + last 2048; no hard byte truncation elsewhere.
  const head = stderrStripped.slice(0, 256);
  const tail = stderrStripped.slice(Math.max(0, stderrStripped.length - 2048));
  const stderrHeadTail = stderrStripped.length > (256 + 2048)
    ? `${head}\n... <${stderrStripped.length - 256 - 2048} bytes elided> ...\n${tail}`
    : stderrStripped;
  return {
    status,
    stderrHeadTail: redactSecrets(stderrHeadTail),
    stdoutTail: redactSecrets(stdoutStripped.slice(Math.max(0, stdoutStripped.length - 2048))),
    lastCompleteResponseBlock: (logParse && logParse.ok)
      ? { content: logParse.response, toolCalls: logParse.toolCalls, finishReason: logParse.finishReason }
      : null,
    lastPartialResponseRaw: (logParse && !logParse.ok) ? (logParse.lastPartialResponseRaw ?? null) : null,
    logPath: logPath ?? null,
  };
}

export async function getMiniAgentAuthStatus(cwd) {
  const cfg = readMiniAgentConfig();
  if (cfg.readError === "config-missing") {
    return { loggedIn: false, reason: "config-missing", detail: "config.yaml not found at " + MINI_AGENT_CONFIG_PATH };
  }
  if (!cfg.api_key || cfg.api_key === "YOUR_API_KEY_HERE") {
    return { loggedIn: false, reason: "auth-not-configured", detail: "api_key is placeholder or empty" };
  }

  const r = await callMiniAgent({
    prompt: "ping",
    cwd: cwd || process.cwd(),
    timeout: AUTH_CHECK_TIMEOUT_MS,
  });

  const cls = classifyMiniAgentResult(r);
  if (cls.status === "success") {
    return { loggedIn: true, model: cfg.model || null, apiBase: cfg.api_base || null };
  }
  return { loggedIn: false, reason: cls.status, detail: cls.detail || cls.reason || null };
}

// -- Review output validator (Phase 3 Task 3.1) ------------------------------
// Hand-rolled draft 2020-12 subset -- covers only the keywords used by
// plugins/minimax/schemas/review-output.schema.json:
//   type / required / enum / items / properties / minLength / minimum / maximum
// Intentionally NOT a general-purpose validator. Adding deps (ajv etc.) would
// inflate install footprint for a single schema.

let _schemaCache = new Map();

function loadSchema(schemaPath) {
  // Normalize so relative vs absolute callers share a cache entry (code-review M-2).
  const key = path.resolve(schemaPath);
  if (_schemaCache.has(key)) return _schemaCache.get(key);
  const text = fs.readFileSync(key, "utf8");
  const schema = JSON.parse(text);
  _schemaCache.set(key, schema);
  return schema;
}

export function _invalidateSchemaCache() { _schemaCache = new Map(); }

function typeMatches(value, expected) {
  if (expected === "integer") return Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && !Number.isNaN(value);
  if (expected === "string") return typeof value === "string";
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return value && typeof value === "object" && !Array.isArray(value);
  if (expected === "boolean") return typeof value === "boolean";
  if (expected === "null") return value === null;
  return false;
}

// code-review I-1: distinguish null from object in error messages
function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// code-review I-2: join without dropping `[N]` into `.[N]`
function formatPath(pathParts) {
  if (pathParts.length === 0) return "(root)";
  let out = "";
  for (const p of pathParts) {
    if (p.startsWith("[")) out += p;
    else out += out === "" ? p : "." + p;
  }
  return out;
}

function validateNode(value, node, pathParts, errors) {
  const pathStr = formatPath(pathParts);

  if (node.type) {
    if (!typeMatches(value, node.type)) {
      errors.push(`${pathStr}: type expected ${node.type}, got ${typeName(value)}`);
      return;
    }
  }

  if (node.enum && !node.enum.includes(value)) {
    errors.push(`${pathStr}: enum violation (got ${JSON.stringify(value)}; allowed ${JSON.stringify(node.enum)})`);
  }

  if (node.type === "string") {
    if (typeof node.minLength === "number" && value.length < node.minLength) {
      errors.push(`${pathStr}: minLength ${node.minLength} not met (got length ${value.length})`);
    }
  }

  if (node.type === "integer" || node.type === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) {
      errors.push(`${pathStr}: minimum ${node.minimum} not met (got ${value})`);
    }
    if (typeof node.maximum === "number" && value > node.maximum) {
      errors.push(`${pathStr}: maximum ${node.maximum} exceeded (got ${value})`);
    }
  }

  if (node.type === "object") {
    if (Array.isArray(node.required)) {
      for (const key of node.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push(`${pathStr === "(root)" ? key : pathStr + "." + key}: required key missing`);
        }
      }
    }
    if (node.properties) {
      for (const [key, sub] of Object.entries(node.properties)) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          validateNode(value[key], sub, [...pathParts, key], errors);
        }
      }
    }
  }

  if (node.type === "array" && node.items) {
    for (let i = 0; i < value.length; i++) {
      validateNode(value[i], node.items, [...pathParts, `[${i}]`], errors);
    }
  }
}

export function validateReviewOutput(data, schemaPath) {
  const errors = [];
  let schema;
  try {
    schema = loadSchema(schemaPath);
  } catch (err) {
    return { ok: false, errors: [`schema-load: ${err.code || err.message}`] };
  }
  validateNode(data, schema, [], errors);
  return { ok: errors.length === 0, errors };
}

// ── Review prompt builder + JSON extractor (Phase 3 Task 3.3; v2 revised) ───

const REVIEW_PROMPT_PATH = path.resolve(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts", "review.md")
);

let _reviewTemplateCache = null;

function loadReviewTemplate() {
  if (_reviewTemplateCache !== null) return _reviewTemplateCache;
  _reviewTemplateCache = fs.readFileSync(REVIEW_PROMPT_PATH, "utf8");
  return _reviewTemplateCache;
}

export function _invalidateReviewTemplateCache() { _reviewTemplateCache = null; }

/**
 * Build the review prompt by substituting placeholders in prompts/review.md.
 *
 * @param {object} opts
 * @param {string} opts.schemaPath   — absolute path to the review schema JSON
 * @param {string} opts.focus        — user-provided focus hint (may be empty)
 * @param {string} opts.context      — full diff text
 * @param {string} [opts.retryHint]  — if non-empty, render a "# Retry note" block
 * @param {string} [opts.previousRaw]— v2 (Codex #3): prior failed response to echo
 *                                     back into the retry prompt (redacted, capped 1500)
 * @returns {string}
 */
export function buildReviewPrompt({ schemaPath, focus, context, retryHint, previousRaw }) {
  const schemaText = fs.readFileSync(schemaPath, "utf8");
  const template = loadReviewTemplate();
  const focusRendered = (focus && focus.trim()) ? focus : "(no additional focus provided)";

  let retryBlock = "";
  if (retryHint && retryHint.trim()) {
    const lines = [
      "# Retry note",
      "",
      `Your previous response failed validation: ${retryHint}. Output RAW JSON ONLY matching the schema above — no code fences, no preamble.`,
    ];
    if (previousRaw && previousRaw.trim()) {
      const redacted = redactSecrets(String(previousRaw)).slice(0, 1500);
      lines.push("");
      lines.push("## Previous response (verbatim, first 1500 chars, secrets redacted)");
      lines.push("");
      lines.push(redacted);
    }
    retryBlock = lines.join("\n");
  }

  // v2 (C3): substitute non-CONTEXT placeholders first; validate against an
  // explicit whitelist of expected slots; only then substitute {{CONTEXT}} last
  // so user-supplied diff containing {{X}} (React/Vue templates) is treated as
  // data, not mistaken for an unreplaced placeholder.
  const EXPECTED_PLACEHOLDERS = ["{{SCHEMA_JSON}}", "{{FOCUS}}", "{{RETRY_HINT}}", "{{CONTEXT}}"];
  let staged = template
    .replace("{{SCHEMA_JSON}}", schemaText)
    .replace("{{FOCUS}}", focusRendered)
    .replace("{{RETRY_HINT}}", retryBlock);
  for (const p of EXPECTED_PLACEHOLDERS) {
    if (p === "{{CONTEXT}}") continue;
    if (staged.includes(p)) {
      throw new Error(`buildReviewPrompt: placeholder ${p} not substituted (template malformed?)`);
    }
  }
  const result = staged.replace("{{CONTEXT}}", context);
  if (result.includes("{{CONTEXT}}")) {
    throw new Error("buildReviewPrompt: {{CONTEXT}} placeholder missing from template");
  }

  return result.trimEnd();
}

// ── Adversarial review prompt builder (Phase 5 Task 5.2) ────────────────────

const ADVERSARIAL_PROMPT_PATH = path.resolve(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts", "adversarial-review.md")
);

let _adversarialTemplateCache = null;

function loadAdversarialTemplate() {
  if (_adversarialTemplateCache !== null) return _adversarialTemplateCache;
  _adversarialTemplateCache = fs.readFileSync(ADVERSARIAL_PROMPT_PATH, "utf8");
  return _adversarialTemplateCache;
}

export function _invalidateAdversarialTemplateCache() { _adversarialTemplateCache = null; }

// v2 (C1): 内嵌的人物引用统一用中文「」而非 ASCII " 嵌套，避免 JS SyntaxError
// v2 (I9): 措辞被 reviewer 标"激将"，T9 smoke (Task 5.10) 后视红队 severity 分布判断是否降级
export const RED_STANCE_INSTRUCTION = [
  "你是红队（red team）。本次审查的唯一目标是**击破**这次改动的可发布性。",
  "默认怀疑。除非证据明示，否则假设它会以隐蔽、高代价、用户可见的方式失败。",
  "不要因「作者意图良好」或「看起来会有后续修复」给出妥协。只在 happy path 工作的代码即视为真问题。",
  "重点攻击面：",
  "- 鉴权、权限、租户隔离、信任边界",
  "- 数据丢失/损坏/重复/不可逆状态变更",
  "- 回滚安全、retry、部分失败、幂等性缺口",
  "- 竞态、顺序假设、stale 状态、re-entrancy",
  "- empty/null/timeout/降级依赖行为",
  "- 版本漂移、schema 漂移、迁移风险、兼容性回退",
  "- observability 缺口（出问题查不到）",
  "summary 字段写成简短的 ship/no-ship 判定。「不要发布」/「阻塞 release」/「高风险回退」这种开头是合法的；「本次改动既有改进也有顾虑」这种平衡修辞是不合法的。",
  "不要用「可能」/「或许」/「存在风险」软化 finding —— 要么有依据写实，要么删掉。",
  "本任务是只读审查：不要写文件、不执行修改型 bash 命令；只输出 JSON。",
].join("\n");

// v2 (I10): 蓝队任务重心从"预判反驳"改为"评估现有防御层 + 找低成本 mitigation gap"
// (双 spawn 下蓝队看不到红队，预判反驳易产 straw-man)
// v2 (M9): 末尾加 severity 校准段，避免蓝队把"加一行日志"标 critical
export const BLUE_STANCE_INSTRUCTION = [
  "你是蓝队（blue team）。本次审查的唯一目标是**辩护**这次改动的可发布性。",
  "默认相信。除非证据明示，否则假设它在合理输入下能正确工作。",
  "你的核心任务有两个：(1) **评估现有防御层是否充分**——已有的 schema 校验、类型系统、上游已 sanitize 的输入、测试覆盖、回滚机制、降级路径、容错设计——并指出这些防御为什么让看似危险的代码实际安全；(2) 找出现有改动里**真实存在的、值得修但低成本可修**的 mitigation gap（防御深度、可观测性、文档、retry 策略调优等）。",
  "重点关注：",
  "- 已有的防御层（schema 校验、类型系统、上游已 sanitize 的输入）让看似危险的代码实际安全",
  "- 测试覆盖、回滚机制、降级路径、容错设计的现有保护",
  "- 影响半径其实有限的场景（即使有 risk，blast radius 可控）",
  "- 低成本的 mitigation 增量（如加一行日志、补一个 metric、一个 assert）",
  "summary 字段写成简短的 ship-with-confidence 或 ship-with-mitigations 判定。「可以发布」/「现有防御足够」/「加 X 即可发布」这种开头是合法的；「本次改动有重大风险」这种向红队靠拢的修辞是不合法的（你不是仲裁，你是辩方）。",
  "蓝队的 finding 是 mitigation gap，不是 risk。每个 finding 的 recommendation 字段必须给出具体动作（不是「考虑增强」这种模糊话）。",
  "**蓝队 severity 校准**：critical = 不补会出生产事故；high = 不补有显著运维风险；medium = 维护期 toil；low = 可选打磨。不要把「加一行日志」标 critical。",
  "如果你确实找不到任何 mitigation gap，`findings` 为空数组合法（说明现有改动按蓝队视角已经足够好；这不影响 T9 通过）。",
  "本任务是只读审查：不要写文件、不执行修改型 bash 命令；只输出 JSON。",
].join("\n");

/**
 * Build the adversarial-review prompt for a given stance.
 *
 * @param {object} opts
 * @param {"red"|"blue"} opts.stance        — which viewpoint instruction to inject
 * @param {string} opts.schemaPath          — absolute path to review-output.schema.json
 * @param {string} opts.focus               — user-supplied focus hint (may be empty)
 * @param {string} opts.context             — full diff text
 * @param {string} [opts.retryHint]         — if non-empty, render a retry note block
 * @param {string} [opts.previousRaw]       — prior failed response (redacted, capped 1500)
 * @returns {string}
 */
export function buildAdversarialPrompt({ stance, schemaPath, focus, context, retryHint, previousRaw }) {
  if (stance !== "red" && stance !== "blue") {
    throw new Error(`buildAdversarialPrompt: stance must be 'red' or 'blue', got '${stance}'`);
  }
  const stanceInstruction = stance === "red" ? RED_STANCE_INSTRUCTION : BLUE_STANCE_INSTRUCTION;
  const schemaText = fs.readFileSync(schemaPath, "utf8");
  const template = loadAdversarialTemplate();
  const focusRendered = (focus && focus.trim()) ? focus : "(no additional focus provided)";

  // v2 (C4): retry hint 全中文，与 stance 主体语境一致；避免 M2.7 双语切换跑偏
  let retryBlock = "";
  if (retryHint && retryHint.trim()) {
    const lines = [
      "# 重试提示",
      "",
      `你上一次的输出未通过校验：${retryHint}。请只返回严格匹配上方 schema 的 RAW JSON，不要 markdown 代码栅栏，不要前言后记。`,
    ];
    if (previousRaw && previousRaw.trim()) {
      const redacted = redactSecrets(String(previousRaw)).slice(0, 1500);
      lines.push("");
      lines.push("## 上次响应原文（截前 1500 字符，已脱敏）");
      lines.push("");
      lines.push(redacted);
    }
    retryBlock = lines.join("\n");
  }

  // v2 (C3): leftover 校验改为白名单 set 在 {{CONTEXT}} 替换之前做，避免误命中用户 diff 中的 {{...}} 文本
  const EXPECTED_PLACEHOLDERS = ["{{STANCE_INSTRUCTION}}", "{{SCHEMA_JSON}}", "{{FOCUS}}", "{{RETRY_HINT}}", "{{CONTEXT}}"];
  let staged = template
    .replace("{{STANCE_INSTRUCTION}}", stanceInstruction)
    .replace("{{SCHEMA_JSON}}", schemaText)
    .replace("{{FOCUS}}", focusRendered)
    .replace("{{RETRY_HINT}}", retryBlock);
  for (const p of EXPECTED_PLACEHOLDERS) {
    if (p === "{{CONTEXT}}") continue;
    if (staged.includes(p)) {
      throw new Error(`buildAdversarialPrompt: placeholder ${p} not substituted (template malformed?)`);
    }
  }
  const result = staged.replace("{{CONTEXT}}", context);
  if (result.includes("{{CONTEXT}}")) {
    throw new Error("buildAdversarialPrompt: {{CONTEXT}} placeholder missing from template");
  }

  return result.trimEnd();
}

/**
 * Pull a JSON object out of an assistant response that may include code fences
 * or surrounding prose. Returns {ok, data} or {ok:false, error, parseError?}.
 *
 * v2 (Codex #2): the raw-slice branch now uses a brace-balanced scanner that
 * returns the FIRST COMPLETE JSON object, not the span from first { to last }
 * (which would fuse separate objects if the model emitted reasoning then answer).
 */
export function extractReviewJson(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "empty-response" };
  }

  const trimmed = raw.trim();

  // Case 1: fenced block ```[json]? ... ```
  const fenceMatch = trimmed.match(/```(?:json|JSON)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    if (!inner) return { ok: false, error: "fenced-empty", parseError: null };
    try {
      return { ok: true, data: JSON.parse(inner) };
    } catch (e) {
      return { ok: false, error: "fenced-parse-failed", parseError: e.message };
    }
  }

  // Case 2: brace-balanced scan — find FIRST complete top-level { ... } object.
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = trimmed.slice(start, i + 1);
        try {
          return { ok: true, data: JSON.parse(candidate) };
        } catch (e) {
          return { ok: false, error: "raw-parse-failed", parseError: e.message };
        }
      }
    }
  }

  return { ok: false, error: "no-json-found" };
}

// ── callMiniAgentReview: review-specific wrapper + 1-shot retry (Task 3.4) ──
function reviewError({ error, firstRawText = null, rawText = null, parseError = null, truncated = false, retry_used = false, diagnostic = null }) {
  return {
    ok: false,
    error,
    firstRawText: firstRawText ? redactSecrets(String(firstRawText)) : null,
    rawText: rawText ? redactSecrets(String(rawText)) : null,
    parseError,
    truncated,
    retry_used,
    retriedOnce: retry_used,
    diagnostic,
  };
}

// Single source of truth for the success return — keeps `retriedOnce` derived
// from `retry_used` (matching the reviewError pattern), so the two flags can
// never drift out of sync at different call sites.
function reviewSuccess(data, { truncated, retry_used, retry_notice, logPath }) {
  return {
    ok: true,
    ...data,
    truncated,
    retry_used,
    retriedOnce: retry_used,
    retry_notice,
    logPath,
  };
}

/**
 * Generic review-style call: one spawn + 1-shot retry on parse/validate failure.
 *
 * Both /minimax:review and /minimax:adversarial-review share this skeleton.
 * Differences are isolated to the `buildPrompt` callback and `errorPrefix`.
 *
 * Module-private (no `export`); only callMiniAgentReview / callMiniAgentAdversarial use this.
 *
 * @param {object} opts
 * @param {(args:{retryHint?:string,previousRaw?:string})=>string} opts.buildPrompt
 *        — pure function returning the full prompt string given optional retry args
 * @param {string} opts.schemaPath          — schema for validateReviewOutput
 * @param {string} opts.cwd
 * @param {number} [opts.timeout=120000]
 * @param {string} [opts.bin]
 * @param {string} [opts.logDir]
 * @param {boolean} [opts.truncated=false]
 * @param {(line:string)=>void} [opts.onProgressLine]
 * @param {string} [opts.retryWarning]      — stderr warning shown before retry; default mirrors review
 * @param {string} [opts.errorPrefix]       — error string prefix for prompt-build failures.
 *                                            Defaults to "schema-load-failed" (review's historic value).
 * @returns {Promise<{ok:true,...,truncated,retry_used,retriedOnce,retry_notice,logPath} | {ok:false,error,...}>}
 */
async function _callReviewLike({
  buildPrompt,
  schemaPath,
  cwd,
  timeout = 120_000,
  bin,
  logDir,
  truncated = false,
  onProgressLine,
  retryWarning = "Warning: minimax review response failed parse/validation; retrying once with error hint...\n",
  errorPrefix = "schema-load-failed",
}) {
  let firstPrompt;
  try {
    firstPrompt = buildPrompt({});
  } catch (e) {
    return reviewError({ error: `${errorPrefix}: ${e.message}`, truncated, retry_used: false });
  }

  const firstCall = await callMiniAgent({ prompt: firstPrompt, cwd, timeout, bin, logDir, onProgressLine });
  const firstCls = classifyMiniAgentResult(firstCall);
  if (firstCls.status !== "success" && firstCls.status !== "success-but-truncated") {
    return reviewError({
      error: `mini-agent call failed: ${firstCls.status}${firstCls.detail ? " -- " + firstCls.detail : ""}`,
      truncated: truncated || firstCls.status === "success-but-truncated",
      retry_used: false,
      diagnostic: firstCls.diagnostic ?? null,
    });
  }

  const firstTruncated = truncated || firstCls.status === "success-but-truncated";

  const firstExtracted = extractReviewJson(firstCls.response);
  let firstValidation = null;
  if (firstExtracted.ok) {
    firstValidation = validateReviewOutput(firstExtracted.data, schemaPath);
    if (firstValidation.ok) {
      return reviewSuccess(firstExtracted.data, {
        truncated: firstTruncated,
        retry_used: false,
        retry_notice: null,
        logPath: firstCls.logPath,
      });
    }
  }

  const retryHint = firstExtracted.ok
    ? `schema validation errors: ${firstValidation.errors.slice(0, 3).join("; ")}`
    : `parse failure (${firstExtracted.error}${firstExtracted.parseError ? ": " + firstExtracted.parseError : ""})`;

  process.stderr.write(retryWarning);

  let retryPrompt;
  try {
    retryPrompt = buildPrompt({ retryHint, previousRaw: firstCls.response });
  } catch (e) {
    return reviewError({
      error: `Failed to rebuild retry prompt: ${e.message}`,
      firstRawText: firstCls.response,
      truncated: firstTruncated,
      retry_used: true,
    });
  }

  const retryCall = await callMiniAgent({ prompt: retryPrompt, cwd, timeout, bin, logDir, onProgressLine });
  const retryCls = classifyMiniAgentResult(retryCall);
  const retryTruncated = firstTruncated || retryCls.status === "success-but-truncated";

  if (retryCls.status !== "success" && retryCls.status !== "success-but-truncated") {
    return reviewError({
      error: `retry mini-agent call failed: ${retryCls.status}${retryCls.detail ? " -- " + retryCls.detail : ""}`,
      firstRawText: firstCls.response,
      truncated: retryTruncated,
      retry_used: true,
      diagnostic: retryCls.diagnostic ?? null,
    });
  }

  const retryExtracted = extractReviewJson(retryCls.response);
  if (!retryExtracted.ok) {
    return reviewError({
      error: `review failed after 1 retry: ${retryExtracted.error}`,
      parseError: retryExtracted.parseError ?? null,
      firstRawText: firstCls.response,
      rawText: retryCls.response,
      truncated: retryTruncated,
      retry_used: true,
    });
  }
  const retryValidation = validateReviewOutput(retryExtracted.data, schemaPath);
  if (!retryValidation.ok) {
    return reviewError({
      error: `review failed schema validation after 1 retry: ${retryValidation.errors.slice(0, 3).join("; ")}`,
      firstRawText: firstCls.response,
      rawText: retryCls.response,
      truncated: retryTruncated,
      retry_used: true,
    });
  }

  return reviewSuccess(retryExtracted.data, {
    truncated: retryTruncated,
    retry_used: true,
    retry_notice: `Initial response failed; retry succeeded (hint: ${retryHint})`,
    logPath: retryCls.logPath,
  });
}

export async function callMiniAgentReview({
  context,
  focus = "",
  schemaPath,
  cwd,
  timeout = 120_000,
  bin,
  logDir,
  truncated = false,
  onProgressLine,
}) {
  const buildPrompt = ({ retryHint, previousRaw } = {}) =>
    buildReviewPrompt({ schemaPath, focus, context, retryHint, previousRaw });
  return _callReviewLike({
    buildPrompt,
    schemaPath,
    cwd,
    timeout,
    bin,
    logDir,
    truncated,
    onProgressLine,
    retryWarning: "Warning: minimax review response failed parse/validation; retrying once with error hint...\n",
  });
}

/**
 * Adversarial review: spawn mini-agent twice, once with red stance, once with
 * blue stance. Both must succeed for ok=true. Each side gets its own 1-shot
 * retry budget independently.
 *
 * The caller is responsible for queue serialization (runAdversarialReview holds
 * a single queue slot across both spawns — see Plan §D5.3).
 *
 * v2 (I5): error string omits "red-team failed:" / "blue-team failed:" prefix
 *          since `side` field already conveys which viewpoint failed.
 *
 * @returns Promise<
 *   | { ok: true, red: <reviewSuccess>, blue: <reviewSuccess> }
 *   | { ok: false, side: "red"|"blue", red?: any, blue?: any, error: string }
 * >
 */
export async function callMiniAgentAdversarial({
  context,
  focus = "",
  schemaPath,
  cwd,
  timeout = 120_000,
  bin,
  logDir,
  truncated = false,
  onProgressLine,
}) {
  const wrapStance = (stance) => (line) => {
    if (typeof onProgressLine === "function") onProgressLine(`[${stance}] ${line}`);
  };

  const redResult = await _callReviewLike({
    buildPrompt: ({ retryHint, previousRaw } = {}) =>
      buildAdversarialPrompt({ stance: "red", schemaPath, focus, context, retryHint, previousRaw }),
    schemaPath,
    cwd,
    timeout,
    bin,
    logDir,
    truncated,
    onProgressLine: onProgressLine ? wrapStance("red") : undefined,
    retryWarning: "Warning: minimax adversarial-review (red) response failed parse/validation; retrying once with error hint...\n",
    errorPrefix: "prompt-build-failed",
  });

  if (!redResult.ok) {
    return {
      ok: false,
      side: "red",
      red: redResult,
      error: redResult.error,
    };
  }

  const blueResult = await _callReviewLike({
    buildPrompt: ({ retryHint, previousRaw } = {}) =>
      buildAdversarialPrompt({ stance: "blue", schemaPath, focus, context, retryHint, previousRaw }),
    schemaPath,
    cwd,
    timeout,
    bin,
    logDir,
    truncated,
    onProgressLine: onProgressLine ? wrapStance("blue") : undefined,
    retryWarning: "Warning: minimax adversarial-review (blue) response failed parse/validation; retrying once with error hint...\n",
    errorPrefix: "prompt-build-failed",
  });

  if (!blueResult.ok) {
    return {
      ok: false,
      side: "blue",
      red: redResult,
      blue: blueResult,
      error: blueResult.error,
    };
  }

  return {
    ok: true,
    red: redResult,
    blue: blueResult,
  };
}
