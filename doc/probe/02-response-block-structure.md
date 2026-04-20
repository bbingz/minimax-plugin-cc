---
name: P0.2 RESPONSE Block Structure
description: Probe result for Mini-Agent log block format and terminal-state rule validation
type: probe-result
---

# Probe P0.2: RESPONSE block structure

## Block delimiter
- Header separator: 80 dashes (`-` × 80), matching regex `^-{80}$`
- File header separator: 80 equals signs (`=` × 80), matching regex `^={80}$`
- Block header regex: `^\[([0-9]+)\] (REQUEST|RESPONSE|TOOL_RESULT)$` — confirmed

Note: log_index is shared across all block types (REQUEST, RESPONSE, TOOL_RESULT),
so block numbers are sequential across types (e.g. [1] REQUEST, [2] RESPONSE, [3] TOOL_RESULT, [4] REQUEST ...).

## 401 场景下日志内容
- REQUEST blocks: 1
- RESPONSE blocks: 0
- 原因（源码确认）: `agent.py` line 371-383 中，`await self.llm.generate(...)` 抛出 `RetryExhaustedError`
  后直接 `return error_msg`，跳过了 line 390 的 `self.logger.log_response(...)` 调用。
- 结论: 0 RESPONSE blocks 是预期行为，与 spec §3.5 假设吻合。

## RESPONSE JSON shape（实际结构 — 与 spec §3.5 假设不符）

**实际 JSON 结构**（来自 `logger.py` line 103-118）:
```json
{
  "content": "<string, assistant text reply>",
  "thinking": "<optional string>",
  "tool_calls": [
    {
      "id": "...",
      "name": "...",
      "arguments": {}
    }
  ],
  "finish_reason": "<stop|tool_use|...>"
}
```

**与 spec §3.5 假设的差异**:
- spec 假设 `stop_reason` 字段 → 实际是 `finish_reason`
- spec 假设 `content[]` 数组（Anthropic 原始格式）→ 实际是 `content` 字符串
- Mini-Agent 日志记录的是**已解析/规范化**的响应，不是 Anthropic API 原始 JSON

这意味着 spec §3.5 的终态选择规则需要调整：
- 旧规则: "倒序找第一个有 `stop_reason` 或非空 `content[].text` 的 RESPONSE block"
- 新规则应改为: "倒序找第一个有 `finish_reason` 或非空 `content`（字符串非空）的 RESPONSE block"

## SIGTERM 场景
- SIGTERM 在第 2 次 401 retry 期间触发（sleep 4s，retry 序列是 1s+2s+4s）
- 日志文件：存在，结构与 401 场景相同（只有 1 个 REQUEST block，0 RESPONSE）
- 最后 RESPONSE block: missing（无 RESPONSE block）
- `finish_reason` 字段: missing
- 部分 JSON: 无（log_response 从未被调用）
- SIGTERM 不影响已写入日志的完整性（文件 append 模式，REQUEST 已完整写入）

## 终态选择规则验证（spec §3.5 修订）

**原 spec 假设**（需修订）：
- "倒序找第一个有 stop_reason 或非空 text 的 RESPONSE block"

**实际规则应为**：
- 字段名：`finish_reason`（不是 `stop_reason`）
- 内容字段：`content`（字符串，不是 `content[]` 数组）
- 401/SIGTERM 场景：无 RESPONSE block → 返回 `{ partial: true, reason: "no_response_logged" }`

**各场景行为**：
- 401 场景: 无 RESPONSE block → 终态 = `{ success: false, partial: true }`
- SIGTERM 场景（在 401 retry 中）: 同上
- 正常完成（auth 成功）: 倒序找第一个有非空 `content` 或有 `finish_reason` 的 RESPONSE block

## Hard gate verdict
**RESULT: PASS** — 分隔符/header 格式符合 spec §3.5 假设；401/SIGTERM 无 RESPONSE 是预期行为。
但 spec §3.5 需修订两处：`stop_reason` → `finish_reason`，`content[]` → `content`（字符串）。
这是 spec 级别修订，不影响 P0.2 硬门判定。

## Notes
1. `log_index` 跨 REQUEST/RESPONSE/TOOL_RESULT 连续递增，故 RESPONSE block 不一定是偶数编号。
   解析时应按类型筛选，不能假设奇偶。
2. RESPONSE block `tool_calls` 字段（若有）包含完整参数，可用于重建工具调用链。
3. 日志文件以 `=`×80 开头（文件 header），块间用 `-`×80 分隔，两种 separator 都会被
   `^[=-]{80}$` 匹配到，实现时应区分（文件 header 不是 block separator）。
4. Mini-Agent 使用 MiniMax API（OpenAI 兼容格式），不是 Anthropic API，
   所以日志 JSON 是 OpenAI 兼容格式的规范化版本，非 Anthropic 原生响应。
