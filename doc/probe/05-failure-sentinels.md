# Probe P0.5: Failure sentinels × locale matrix

## Context

Tested with `mini-agent v0.1` using a fake API key (`sk-fake-probe-key-not-real`) in all scenarios.
As a result, the `invalid_model` scenario is structurally indistinguishable from `invalid_key` at the
HTTP layer: MiniMax returns `401` before inspecting the model name. Both collapse to the same
L3 sentinel path.

## Matrix (16 samples)

| 场景 | locale | exit | L1_auth | L1_cfgmiss | L1_socks | L3_retry | L3_stats | log_line |
|---|---|---|---|---|---|---|---|---|
| 401/invalid_key | en_US.UTF-8 | 0 | 0 | 0 | 0 | 1 | 1 | 1 |
| 401/invalid_key | zh_CN.UTF-8 | 0 | 0 | 0 | 0 | 1 | 1 | 1 |
| 401/invalid_key | C | 0 | 0 | 0 | 0 | 1 | 1 | 1 |
| 401/invalid_key | POSIX | 0 | 0 | 0 | 0 | 1 | 1 | 1 |
| model/invalid_model | en_US.UTF-8 | 0 | 0 | 0 | 0 | 1 | 1 | 1 |
| model/invalid_model | zh_CN.UTF-8 | 0 | 0 | 0 | 0 | 1 | 1 | 1 |
| model/invalid_model | C | 0 | 0 | 0 | 0 | 1 | 1 | 1 |
| model/invalid_model | POSIX | 0 | 0 | 0 | 0 | 1 | 1 | 1 |
| cwd/bad_cwd | en_US.UTF-8 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| cwd/bad_cwd | zh_CN.UTF-8 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| cwd/bad_cwd | C | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| cwd/bad_cwd | POSIX | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| term/sigterm_midway | en_US.UTF-8 | 143 | 0 | 0 | 0 | 0 | 0 | 0 |
| term/sigterm_midway | zh_CN.UTF-8 | 143 | 0 | 0 | 0 | 0 | 0 | 0 |
| term/sigterm_midway | C | 143 | 0 | 0 | 0 | 0 | 0 | 0 |
| term/sigterm_midway | POSIX | 143 | 0 | 0 | 0 | 0 | 0 | 0 |

Notes on counts:
- `L3_retry`: grep count for `"Retry failed"` (stripped of ANSI). Actual printed string: `❌ Retry failed: LLM call failed after 4 retries`
- `L3_stats`: grep count for `"Session Statistics:"`. Actual printed string: `Session Statistics:`
- `log_line`: grep count for `"Log file:"`. Actual printed string: `📝 Log file: <path>`
- `cwd_err` (additional): 4 OSError/FileNotFoundError lines in bad_cwd scenario (Python traceback)

## Layer 1 (源码常量) 稳定性

Source location: `mini_agent/config.py` raises ValueError → caught in `mini_agent/cli.py` and printed as `❌ Error: <msg>`

- `Please configure a valid API Key`: **未触发** 于任何 16 次采样。触发条件：`api_key` 字段为空字符串或 `"YOUR_API_KEY_HERE"`。我们的 mock/fake key (`sk-fake-probe-key-not-real`) 通过了 config 验证，错误推迟到 API 调用层。
- `Configuration file not found`: **未触发** 于任何 16 次采样。触发条件：`config.yaml` 文件不存在。所有场景均有 config 文件。
- `ImportError: Using SOCKS proxy`: **未触发**，源码中未找到此字符串。可能属于 httpx/openai 依赖层，需要 SOCKS 代理配置才能触发。
- 跨 locale 稳定性: **N/A** — 均未触发，无法验证。

## Layer 3 (stdout sentinel) 稳定性

Source locations:
- `"Retry failed"` → `mini_agent/agent.py`: `print(f"❌ Retry failed: {error_msg}")`
- `"Session Statistics:"` → `mini_agent/cli.py`: `print(f"Session Statistics:")`
- `"Log file:"` → `mini_agent/agent.py`: `print(f"📝 Log file: {self.logger.get_log_file_path()}")`

- `Retry failed`: 命中 **8/16** 场景（401 × 4 + invalid_model × 4）。SIGTERM 场景在第 1 次 retry 等待期间被 kill，未完成全部重试，**不触发**。bad_cwd 在 agent 启动前崩溃，**不触发**。跨 locale **完全稳定**（字符串为 ASCII 常量，无 locale 敏感路径）。
- `Session Statistics:`: 与 `Retry failed` 完全同步，命中 **8/16**。SIGTERM kill 在 Session Statistics 打印前（进程收到 SIGTERM 后无信号处理器，直接终止，不执行 cleanup）。跨 locale **完全稳定**。
- `Log file:`: 同上 8/16，跨 locale **完全稳定**。

## 额外发现

### bad_cwd 场景（exit=1）
- 错误路径：Python traceback（`FileNotFoundError` + `OSError: [Errno 30] Read-only file system`），通过 `sys.stderr`/`sys.stdout` 混合输出。
- **无任何 mini-agent 自定义 sentinel**，仅 Python 原生异常。
- 跨 locale 稳定：OSError 消息由 libc `strerror()` 生成，macOS 上英文不随 `LC_ALL` 变化（darwin 系统 strerror 不 i18n）。

### sigterm 场景（exit=143 = 128+15）
- 进程在第 1 次 retry 的 1s 等待期间被 kill（sleep 3s 内 mini-agent 发出第 1 次 API 请求失败后等待重试）。
- 无 SIGTERM handler：进程直接终止，**不打印任何 sentinel**，exit=143。
- 跨 locale **完全稳定**。

### invalid_model 退化为 401
- MiniMax API 在鉴权失败时返回 401，不检查 model 名称。因此在无有效 API key 的环境中，`invalid_model` 与 `invalid_key` 行为完全相同。
- 区分 model 错误需要：有效 API key + 不存在的 model name → 服务端应返回 `404` 或 `400 invalid_model`。

## 结论

### spec §4.1 三层 sentinel 可用性判断（v0.1）

**Layer 1（源码常量，config 阶段）**:
- `"Please configure a valid API Key"` 和 `"Configuration file not found"` 是可靠的 L1 sentinel，但**触发条件严格**：仅在 config 文件缺失或 key 为空/占位符时触发。实际假 key 场景（用户填了格式正确但无效的 key）不触发 L1，直接进入 L3 路径。
- **插件实现建议**：`getMiniAgentAuthStatus` 应同时检测 L1（config 阶段快速失败）和 L3（API 调用阶段失败）两种路径。

**Layer 3（stdout sentinel，agent 运行阶段）**:
- `"Retry failed"` + `"Session Statistics:"` + `"Log file:"` 跨 4 个 locale 完全稳定，**可直接作为 v0.1 主检测 sentinel**。
- 这些字符串为 ASCII 硬编码，无 i18n 路径，locale 设置不影响输出。

**bad_cwd 和 sigterm 无 sentinel**:
- bad_cwd → 依赖 exit code=1 + Python traceback 关键词（`OSError`、`FileNotFoundError`）检测。
- sigterm → 仅 exit code=143 可用。

## Notes（locale 敏感点）

全部 L3 sentinel 字符串为 ASCII 常量，**无 locale 敏感问题**。以下是实现 `getMiniAgentAuthStatus` 时需注意的 normalization 点：

1. **ANSI 颜色码必须剥离**：所有 sentinel 均包裹在 ANSI 转义中（如 `\x1b[91m❌ Retry failed:\x1b[0m`），匹配前必须 strip。
2. **Unicode emoji 前缀**：`📝 Log file:` 含 emoji，匹配时用 `contains("Log file:")` 而非 startsWith。
3. **OSError 消息语言**：macOS 上 `strerror()` 不随 `LC_ALL` 变化，但 Linux glibc 环境可能输出本地化错误消息（如 zh_CN 下 `无此文件或目录`）。跨平台检测 bad_cwd 应依赖 exit code，不依赖 strerror 字符串。
4. **invalid_model 退化**：无法通过 sentinel 区分 401 和 invalid_model，需要解析 `Last error:` 行中的 HTTP error body JSON（字段 `error.type`）。
