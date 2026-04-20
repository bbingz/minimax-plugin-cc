# Probe P0.10: 并发 spawn 日志归属（条件硬门）

## 运行
3 轮 × 3 并发 = 9 次 spawn

## 结果（9 行）
| Round | Tag | diff_count | stdout_in_diff | stdoutLog 文件名 |
|---|---|---|---|---|
| 1 | R1T1 | 1 | true | agent_run_20260420_154802.log |
| 1 | R1T2 | 1 | true | agent_run_20260420_154802.log |
| 1 | R1T3 | 1 | true | agent_run_20260420_154802.log |
| 2 | R2T1 | 1 | true | agent_run_20260420_154814.log |
| 2 | R2T2 | 1 | true | agent_run_20260420_154814.log |
| 2 | R2T3 | 1 | true | agent_run_20260420_154814.log |
| 3 | R3T1 | 1 | true | agent_run_20260420_154825.log |
| 3 | R3T2 | 1 | true | agent_run_20260420_154825.log |
| 3 | R3T3 | 1 | true | agent_run_20260420_154825.log |

## 总成功率
- Total: 9
- 成功归属: 9（表面上 stdout_in_diff=true）
- 成功率: 100%

## 失败模式分析
- 是否出现同秒 timestamp 冲突导致同名？**yes**
- 文件名精度: 秒级 (YYYYMMDD_HHMMSS.log)
- 同秒冲突情况：**每轮 3 个并发 spawn 全部使用相同文件名**（Round1: 全为 `_154802.log`，Round2: 全为 `_154814.log`，Round3: 全为 `_154825.log`）。diff_count=1 表示 3 个 spawn 共享同一个日志文件，无法唯一归属。虽然 `stdout_in_diff=true`，是因为 snapshot 的 diff 集合中确实包含该文件名，但归属是假阳性——3 个 spawn 都指向同一文件，不能区分。

## 条件硬门判定

**RESULT: FAIL** — 同秒 timestamp 冲突导致并发 spawn 共享同名日志文件，3 个并发任务无法被唯一归属（diff_count=1 表明每轮 3 个 spawn 生成同一个文件名）。`stdout_in_diff=true` 是假阳性，因为归属不唯一。
  → Phase 4 job-control 必须改为**串行化 job 调度**

## Notes
对 spec §3.3 "spawn 前后快照" 实现建议：
1. 日志文件名必须包含更高精度时间戳（毫秒级：`YYYYMMDD_HHMMSSmmm`）或附加随机后缀/PID，避免同秒冲突。
2. snapshot-diff 方法在并发场景下不可靠，应改为 spawn 时记录 PID 并在 stdout 中输出带 PID 的唯一标识。
3. Phase 4 job-control.mjs 应串行调度 job，或在启动每个 spawn 时强制等待至少 1 秒，确保时间戳唯一性。
4. 更健壮方案：spawn 时传入 job-id 环境变量，日志文件名包含 job-id，彻底消除竞争。
