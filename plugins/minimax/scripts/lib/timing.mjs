// plugins/minimax/scripts/lib/timing.mjs
// v0.1.3 per-spawn timing telemetry for minimax-plugin-cc.
// Field names mirror gemini-plugin-cc/plugins/gemini/scripts/lib/timing.mjs
// for cross-plugin re-alignment compat, except:
//   - firstEventMs, streamMs, retryMs share names but carry different semantic
//     (see spec §4 compat callout — Mini-Agent has no stream events, measurements
//      are post-hoc log-file-based)
//   - invariantKind: "3term" discriminator added (Gemini's is effectively "6term")

export class TimingAccumulator {
  constructor({ spawnedAt = Date.now(), prompt = "" } = {}) {
    this._t = {
      spawned: spawnedAt,
      firstEvent: null,
      lastEvent: null,
      close: null,
    };
    this._promptBytes = Buffer.byteLength(prompt || "", "utf8");
    this._responseBytes = 0;
    this._requestedModel = null;
    this._termination = { reason: "exit", exitCode: 0, signal: null, timedOut: false };
  }

  onFirstEvent(t = Date.now()) {
    if (this._t.firstEvent == null) {
      this._t.firstEvent = t;
      this._t.lastEvent = t;
    }
  }

  onStdoutLine(t = Date.now()) {
    if (this._t.lastEvent == null || t > this._t.lastEvent) {
      this._t.lastEvent = t;
    }
  }

  onClose(t = Date.now(), { exitCode = 0, timedOut = false, signal = null } = {}) {
    this._t.close = t;
    this._termination = {
      reason: timedOut ? "timeout" : signal ? "signal" : exitCode !== 0 ? "error" : "exit",
      exitCode,
      signal,
      timedOut,
    };
  }

  setRequestedModel(name) {
    if (this._requestedModel) return;
    if (name) this._requestedModel = name;
  }

  recordResponseBytes(n) {
    this._responseBytes += Number(n) || 0;
  }

  // Reserved no-op methods (D2 pinned contract: (event?) => void, body `return;`)
  /** @returns {void} reserved for future upstream stream-event wiring */
  onFirstToken(event)   { return; }
  /** @returns {void} reserved */
  onLastToken(event)    { return; }
  /** @returns {void} reserved */
  onToolUseStart(event) { return; }
  /** @returns {void} reserved */
  onToolResult(event)   { return; }
  /** @returns {void} reserved */
  onRetryStart(event)   { return; }
  /** @returns {void} reserved */
  onRetryEnd(event)     { return; }
  /** @returns {void} reserved */
  onStartupStats(event) { return; }
  /** @returns {void} reserved */
  onResult(event)       { return; }

  build() {
    const spawned = this._t.spawned;
    const close = this._t.close ?? Date.now();
    const firstEvent = this._t.firstEvent;
    const lastEvent = this._t.lastEvent;

    const firstEventMs = firstEvent != null ? firstEvent - spawned : null;
    const streamMs = firstEvent != null && lastEvent != null
      ? Math.max(0, lastEvent - firstEvent)
      : null;
    const tailMs = lastEvent != null ? Math.max(0, close - lastEvent) : null;
    const totalMs = close - spawned;

    const cleanExit = this._termination.reason === "exit";
    const haveSegments = firstEventMs != null && streamMs != null && tailMs != null;
    const invariantOk = cleanExit && haveSegments
      ? (firstEventMs + streamMs + tailMs === totalMs)
      : null;

    return {
      spawnedAt: new Date(spawned).toISOString(),
      firstEventMs,
      ttftMs: null,
      streamMs,
      toolMs: null,
      retryMs: null,
      tailMs,
      totalMs,
      promptBytes: this._promptBytes,
      responseBytes: this._responseBytes,
      exitCode: this._termination.exitCode,
      terminationReason: this._termination.reason,
      timedOut: this._termination.timedOut,
      signal: this._termination.signal,
      requestedModel: this._requestedModel,
      usage: [],
      tokensPerSec: null,
      coldStartPhases: null,
      invariantOk,
      invariantKind: "3term",
    };
  }
}

/** @returns {void} reserved stub for future upstream stream-event dispatch (D2) */
export function dispatchTimingEvent(event, timing) { return; }

// ─── Aggregate helpers ────────────────────────────────────────────────────────

export function percentile(values, p) {
  const filtered = values.filter((v) => v != null && typeof v === "number" && Number.isFinite(v));
  if (filtered.length === 0) return null;
  const sorted = filtered.slice().sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.max(0, Math.min(sorted.length - 1, rank - 1));
  return sorted[idx];
}

const PERCENTILE_CUTOFFS = { p50: 1, p95: 20, p99: 100 };
const METRICS = ["firstEventMs", "ttftMs", "streamMs", "toolMs", "retryMs", "totalMs"];

export function computeAggregateStats(records) {
  const n = records.length;
  const percentiles = {};
  for (const [p, cutoff] of Object.entries(PERCENTILE_CUTOFFS)) {
    if (n < cutoff) { percentiles[p] = null; continue; }
    const row = {};
    for (const m of METRICS) {
      row[m] = percentile(records.map((r) => r.timing?.[m]), Number(p.slice(1)) / 100);
    }
    percentiles[p] = row;
  }

  let slowest = null;
  for (const r of records) {
    const total = r.timing?.totalMs || 0;
    if (!slowest || total > slowest.totalMs) {
      slowest = {
        jobId: r.jobId,
        totalMs: total,
        fallback: Array.isArray(r.timing?.usage) && r.timing.usage.length > 1,
      };
    }
  }

  let fallbackCount = 0;
  let anyUsagePopulated = false;
  for (const r of records) {
    const usage = r.timing?.usage;
    if (Array.isArray(usage) && usage.length >= 1) anyUsagePopulated = true;
    if (Array.isArray(usage) && usage.length > 1) fallbackCount++;
  }
  const fallbackRate = n > 0 ? Math.round((fallbackCount / n) * 1000) / 1000 : 0;

  return {
    n,
    percentiles,
    slowest,
    fallbackCount,
    fallbackRate,
    usageAvailable: anyUsagePopulated,
  };
}

export function filterHistory(records, { kind, last, since } = {}) {
  let out = records.slice();
  if (kind && kind !== "all") out = out.filter((r) => r.kind === kind);
  if (since) out = out.filter((r) => r.ts && r.ts >= since);
  out.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  if (last) out = out.slice(0, last);
  return out;
}

// ─── Render helpers ───────────────────────────────────────────────────────────

export function formatMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

function truncateId(id, max = 13) {
  if (!id) return "?";
  return id.length <= max ? id : id.slice(0, max) + "…";
}

// Short labels for the 8-wide kind column in renderHistoryTable.
// Only `adversarial-red` (15) and `adversarial-blue` (16) would otherwise
// overflow; other kinds (`ask`/`review`/`rescue`) already fit.
const KIND_DISPLAY = { "adversarial-red": "adv-red", "adversarial-blue": "adv-blue" };
function displayKind(kind) {
  return KIND_DISPLAY[kind] || kind || "?";
}

export function renderHistoryTable(rows) {
  const lines = [];
  // `cliBoot` label replaces Gemini's `cold` (spec §7) — firstEventMs measures
  // Mini-Agent CLI boot (Python+click+skill-metadata), NOT model TTFT.
  lines.push("id              kind     total      cliBoot  ttft    gen     tool    retry   tok/s   fb   completedAt");
  for (const r of rows) {
    const t = r.timing || {};
    const usage = Array.isArray(t.usage) ? t.usage : [];
    const fb = usage.length === 0 ? "—" : usage.length > 1 ? "y" : "n";
    lines.push([
      truncateId(r.jobId).padEnd(16),
      displayKind(r.kind).padEnd(9),
      formatMs(t.totalMs).padEnd(10),
      formatMs(t.firstEventMs).padEnd(9),
      formatMs(t.ttftMs).padEnd(8),
      formatMs(t.streamMs).padEnd(8),
      formatMs(t.toolMs).padEnd(8),
      formatMs(t.retryMs).padEnd(8),
      (t.tokensPerSec != null ? String(t.tokensPerSec) : "—").padEnd(8),
      fb.padEnd(5),
      (r.ts || "—").slice(0, 19),
    ].join(""));
  }
  return lines.join("\n");
}

export function renderAggregateTable(stats, { kind = "all" } = {}) {
  const lines = [];
  lines.push(`${kind} (n=${stats.n})`);
  lines.push(`                   cliBoot     ttft        gen         tool        retry       total`);
  for (const p of ["p50", "p95", "p99"]) {
    const row = stats.percentiles[p];
    if (!row) {
      lines.push(`  ${p.padEnd(14)}  —           —           —           —           —           —`);
      continue;
    }
    const cells = METRICS
      .map((m) => formatMs(row[m]).padEnd(12))
      .join("");
    lines.push(`  ${p.padEnd(14)}  ${cells}`);
  }
  if (stats.slowest) {
    const fb = stats.slowest.fallback ? " · fallback" : "";
    lines.push(`  slowest         ${stats.slowest.jobId} · ${formatMs(stats.slowest.totalMs)}${fb}`);
  }
  if (stats.usageAvailable) {
    lines.push(`  fallback rate   ${(stats.fallbackRate * 100).toFixed(1)}%`);
  } else {
    lines.push(`  fallback rate   —          (usage unavailable; upstream dependency — see PROGRESS.md §Upstream limitations)`);
  }
  return lines.join("\n");
}

export function renderStatusSummaryLine(timing) {
  if (!timing) return "—";
  const parts = [];
  if (timing.firstEventMs != null) parts.push(`cliBoot ${formatMs(timing.firstEventMs)}`);
  if (timing.ttftMs != null)       parts.push(`ttft ${formatMs(timing.ttftMs)}`);
  if (timing.streamMs != null)     parts.push(`gen ${formatMs(timing.streamMs)}`);
  if (timing.toolMs > 0)           parts.push(`tool ${formatMs(timing.toolMs)}`);
  if (timing.retryMs > 0)          parts.push(`retry ${formatMs(timing.retryMs)}`);
  if (timing.tokensPerSec != null) parts.push(`${timing.tokensPerSec} tok/s`);
  return parts.join(" · ");
}
