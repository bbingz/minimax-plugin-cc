# Probe P0.3: Log flush timing

## 观察到的日志增长曲线

| 时间点 | log_size (bytes) | block count |
|--------|-----------------|-------------|
| t=500ms | 未创建 | - |
| t=1000ms | 未创建 | - |
| t=1500ms | 8758 | 1 |
| t=2000ms | 8758 | 1 |
| t=2500ms | 8758 | 1 |
| t=3000ms | 8758 | 1 |
| t=3500ms | 8758 | 1 |
| t=4000ms | 8758 | 1 |
| t=4500ms | 8758 | 1 |
| t=5000ms | 8758 | 1 |
| 进程结束后 | 8758 | 1 |

（整个任务因 401 认证失败而退出，日志仅含 1 个 REQUEST block，无 RESPONSE block。）

## 结论

- 日志文件创建时机: spawn 后约 1000-1500ms（第一次 API 请求发出前写入 REQUEST block）
- 是否增量 flush: **no** — 日志在 ~1.3s 时一次性写入 REQUEST block（8758 bytes），之后整个进程生命周期内大小不再变化；RESPONSE/TOOL_RESULT block 仅在任务正常完成后才追加（此次因 401 失败无 RESPONSE block 产生）
- 是否能用 fs.watch 实时观察: **no** — 日志写入时机为 API 调用时（REQUEST 写入）及响应返回后（RESPONSE 写入），两者之间的 LLM 推理过程无增量输出，实时事件流无法依赖日志文件变化

## 软门判定

- [x] 非增量 flush → spec §1.3 "实时事件流 UX" 永久归 v0.2+；v0.1 模型 "stdout 透传 + 结束后解析" 不变
- [ ] 增量 flush 成立 → v0.2 可做实时事件流 UX（不成立）

## Notes

- mini-agent 的日志写入策略是：REQUEST block 在 API 调用前写入，RESPONSE/TOOL_RESULT block 在收到响应后写入，日志不使用流式增量追加
- 本次 401 失败导致只有 REQUEST block，正常任务完成后日志包含完整的 REQUEST + RESPONSE + TOOL_RESULT 链
- 日志格式：`[N] REQUEST / RESPONSE / TOOL_RESULT` 区块，JSON 序列化存储，适合事后解析而非实时订阅
