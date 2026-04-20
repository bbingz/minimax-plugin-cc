# Probe P0.1: --task one-shot stability

## Run
5× `mini-agent -t "Reply with exactly: OK-<N>" -w /tmp`

## Results
| Run | Exit code | Duration (ms) | Log file: line present | Line# of Log file: (in first 30) |
|---|---|---|---|---|
| 1 | 0 | 11466 | yes | 27 |
| 2 | 0 | 10587 | yes | 27 |
| 3 | 0 | 10429 | yes | 27 |
| 4 | 0 | 10543 | yes | 27 |
| 5 | 0 | 10474 | yes | 27 |

## Cold-start timing
- p50: 10543 ms
- p95: 11466 ms
- Maximum observed: 11466 ms

## Log file path regex
`/Log file:\s+(\S+\.log)/` — **confirmed works**

Actual paths match: `/Users/bing/.mini-agent/log/agent_run_YYYYMMDD_HHMMSS.log`

Example: `agent_run_20260420_153912.log`

## Observations
- 5/5 自然退出 (yes) — all exit_code=0, no hang, no signal crash
- `Log file:` 行 5/5 都在前 30 行内捕获到 (yes) — consistently at line 27
- 其他异常：401 认证错误（预期行为，使用 fake key；重试 3 次后正常退出）；MCP 工具未加载（minimax_search / memory 被 disabled，属配置设计）

## Hard gate verdict
**RESULT: PASS** — 5/5 自然退出 + `Log file:` 行全部捕获
