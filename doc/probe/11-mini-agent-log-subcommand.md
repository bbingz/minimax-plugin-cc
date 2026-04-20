# Probe P0.11: mini-agent log 子命令

## log list 输出

格式：**ANSI 彩色表格**，结构如下：

```
📁 Log Directory: /Users/bing/.mini-agent/log
────────────────────────────────────────────────────────────
Available Log Files (newest first):
   1. agent_run_20260420_154934.log
      Modified: 2026-04-20 15:49:35, Size: 213.6K
   2. agent_run_20260420_154917.log
      Modified: 2026-04-20 15:49:17, Size: 29.6K
  ... and N more files
────────────────────────────────────────────────────────────
```

- 只列文件名（不含路径前缀）
- 按 mtime 倒序排列，显示修改时间和文件大小
- 有 ANSI color codes（cyan/green/yellow/dim）；解析时需 strip ANSI

## log read &lt;filename&gt; 输出

- `mini-agent log agent_run_XXXXXX.log` 输出：**文件原始内容 + 前置 header + 后置 footer**
- 前置：3 行 ANSI 装饰（`📄 Reading: <path>` + separator）
- 后置：2 行 ANSI 装饰（separator + `✅ End of file`）
- 内容与直接 `cat` 文件：**完全相同**（diff 仅差头尾装饰行）
- 内容为纯 JSON/文本混合的结构化日志，无额外转义或截断
- 是否可作为 `parseFinalResponseFromLog` 的 fallback 二次源: **yes with caveat** — 内容与 cat 相同，但需 skip 开头 3 行和结尾 2 行 ANSI 装饰；也可直接 cat 原始 log 文件（路径来自 log list 的 log directory + filename），更简单可靠

## 软门判定

- [x] PASS: 可作 fallback 源 → spec §3.5 fallback 按计划实现
  - 推荐：直接 cat `~/.mini-agent/log/<filename>` 而非通过 `mini-agent log` 子命令（避免 ANSI strip 复杂度）
  - `mini-agent log` 更适合人类阅读，不适合程序解析

## Notes

- log 目录固定在 `~/.mini-agent/log/`，文件名格式 `agent_run_YYYYMMDD_HHMMSS.log`
- 日志 block 结构：`[N] REQUEST` / `[N] RESPONSE` / `[N] TOOL_RESULT`，每个 block 含 Timestamp 和 JSON body
- 因 401 失败的 run 只有 REQUEST block（无 RESPONSE），`parseFinalResponseFromLog` 需处理此 edge case
