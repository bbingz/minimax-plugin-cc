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
 * @param {{timeoutMs?: number, cwd?: string, env?: object}} options
 * @returns {Promise<{exitCode: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, spawnError: Error|null}>}
 */
export function spawnWithHardTimeout(bin, args, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, cwd, env } = options;

  return new Promise((resolve) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;
    let didTimeout = false;
    let termTimer, killTimer;

    const finalize = (extras) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      resolve({
        exitCode: proc.exitCode ?? null,
        signal: proc.signalCode ?? null,
        stdout: stdoutBuf,
        stderr: stderrBuf,
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
        timedOut: false, spawnError,
      });
    }

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.removeAllListeners("close");
      resolve({ exitCode: null, signal: null, stdout: stdoutBuf, stderr: stderrBuf, timedOut: false, spawnError: err });
    });

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    proc.stdout.on("data", (chunk) => { stdoutBuf += stdoutDecoder.write(chunk); });
    proc.stderr.on("data", (chunk) => { stderrBuf += stderrDecoder.write(chunk); });

    proc.once("close", () => {
      stdoutBuf += stdoutDecoder.end();
      stderrBuf += stderrDecoder.end();
      finalize({});
    });

    // 硬超时三段式
    termTimer = setTimeout(() => {
      if (settled) return;
      didTimeout = true;
      try { proc.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        if (settled) return;
        try { proc.kill("SIGKILL"); } catch {}
        // 最终兜底：500ms 后若 close 仍未触发，强制 resolve
        setTimeout(() => {
          if (!settled) {
            settled = true;
            clearTimeout(termTimer); clearTimeout(killTimer);
            resolve({
              exitCode: null, signal: "SIGKILL",
              stdout: stdoutBuf, stderr: stderrBuf,
              timedOut: true, spawnError: null,
            });
          }
        }, 500);
      }, 5_000);
    }, timeoutMs);
  });
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
