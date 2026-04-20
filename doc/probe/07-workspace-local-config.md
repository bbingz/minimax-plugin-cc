# Probe P0.7: Workspace-local config override

## 结果

| 模式 | 局部 config 生效 | 依据 |
|------|-----------------|------|
| `--workspace /tmp/mm-p7`（cwd ≠ workspace） | **no** | system_prompt 从 `~/.mini-agent/config/` 加载；API 请求打到真实 MiniMax 端点得 401 |
| `cd /tmp/mm-p7 && mini-agent`（cwd = workspace） | **yes** | system_prompt 从 `/private/tmp/mm-p7/mini_agent/config/system_prompt.md` 加载（workspace-local 目录）；API 请求打到 LOCAL-FINGERPRINT-X 端点（连接失败/超时） |

### 源码确认

`config.py::find_config_file()` 搜索顺序：

```
1) Path.cwd() / "mini_agent" / "config" / filename   ← 基于 cwd，非 --workspace
2) Path.home() / ".mini-agent" / "config" / filename
3) <package> / "mini_agent" / "config" / filename
```

`--workspace` flag 仅影响 `workspace_dir`（BashTool cwd、FileTools 路径解析），
**不影响 config 搜索路径**。

## Config 搜索优先级（实测）

```
Priority 1 (最高): cwd/mini_agent/config/<filename>        ← cd 模式下生效
Priority 2:        ~/.mini-agent/config/<filename>          ← --workspace 模式下用此
Priority 3 (最低): <package>/mini_agent/config/<filename>
```

## 软门判定

- [x] **通过（条件性）**: v0.2 可做 per-job 局部 config，但需通过 **cd 到 workspace 目录** 的方式，
  而非 `--workspace` flag。
- [ ] `--workspace` flag 触发第五路径：**不通过**（flag 不影响 config 搜索）。

## v0.2 实现建议

若需 spec §8.5 "第五路径"（--workspace 模式下局部 config 优先）：
- mini-agent 需在 CLI 初始化时将 workspace path 注入 `find_config_file` 搜索链，
  优先检查 `<workspace>/mini_agent/config/` 或 `<workspace>/.mini-agent/config/`。
- 目前实现中 `--workspace` 与 config 搜索完全解耦，第五路径需上游改动。
- **替代方案（无需上游改动）**: plugin 在调用 mini-agent 前 `cd` 到 workspace，
  或通过环境变量 / `MINI_AGENT_CONFIG_PATH` 显式传路径（若上游支持）。
