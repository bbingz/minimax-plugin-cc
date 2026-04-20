# Probe P0.4: Large prompt 传递

## 结果

| 方式 | 体积 | Exit | 结果 |
|---|---|---|---|
| argv -t "&lt;20KB&gt;" | ~21.6KB | 0 | success（prompt 被正常接受，401 认证失败属 API key 问题而非 prompt 大小问题） |
| argv -t "&lt;200KB&gt;" | ~210KB | 0 | success（同上，argv 透传 210KB 无 E2BIG 错误） |
| stdin pipe + -t "" | ~21.6KB | 0 | mini-agent unsupported for task mode — 进入交互式 session，stdin 内容作为 user message 逐行读取；`-t ""` 不触发 non-interactive 模式 |

## 结论

- LARGE_PROMPT_STRATEGY: `argv`
- argv 可接受上限: **至少 210KB OK**（macOS 默认 ARG_MAX=1048576，测试 210KB 无问题）
- 若 argv 足够: v0.1 `callMiniAgent` 直接 argv 传，无需 tmpfile trick
- stdin pipe 行为: `-t ""` 时进入交互模式，从 stdin 读取为 interactive input 而非 task prompt；mini-agent 不支持 `echo prompt | mini-agent -t -` 风格的 stdin-as-task 用法

## 软门判定

- [x] PASS: argv 策略在常见体积（≤50KB）及大体积（≤210KB）下均稳定
- [ ] FAIL: 无任一策略工作（不适用）

## Notes

- macOS ARG_MAX 为 1MB，但实际限制取决于环境变量总体积；210KB prompt 实测通过
- stdin 不支持作为 task 源：`mini-agent -t "" < file` 会进入交互模式，不适合自动化场景
- v0.1 实现建议：`callMiniAgent` 直接使用 `-t "$prompt"` argv 传递，无需 tmpfile；若将来超出 ARG_MAX，再引入 tmpfile fallback
