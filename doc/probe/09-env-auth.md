# Probe P0.9: env-auth support（已于 brainstorming 阶段完成）

## Method

- 源码搜索: `grep -R 'os\.environ\|os\.getenv\|environ\.get\|getenv' /Users/bing/.local/share/uv/tools/mini-agent/lib/python3.11/site-packages/mini_agent/`
- 实证: `MINIMAX_API_KEY=env-test ANTHROPIC_API_KEY=env-test mini-agent --version`
- 源码审读: `config.py:107-124`

## Results

- `grep`: **0 matches**（Mini-Agent 0.1.0 不读任何 env 变量）
- 实证: env 值未被读取，`mini-agent --version` 输出正常；真正的 api_key 仍只从 YAML 读
- `config.py:107-108`:
  ```python
  if "api_key" not in data:
      raise ValueError("Configuration file missing required field: api_key")
  ```
- `config.py:110-111`:
  ```python
  if not data["api_key"] or data["api_key"] == "YOUR_API_KEY_HERE":
      raise ValueError("Please configure a valid API Key")
  ```

## Conclusion

**Mini-Agent 完全不支持任何 env 变量作 api_key 源**。api_key 必须写进 `~/.mini-agent/config/config.yaml`。

## Implications for spec / plan

- Q2 决策（附录 A）锁定守 B：AskUserQuestion + YAML 原地替换
- §3.4.2 预校验 gate + §3.4.3 escape 是硬约束，v0.1 无捷径
- spec 附录 C "第五路径"（per-job 局部 config.yaml）仍是 v0.2 备选，前提是 P0.7 通过

## Hard gate verdict

**RESULT: PASS (informational)** — 已完成，无 env 捷径。Q2 走 B 路径。
