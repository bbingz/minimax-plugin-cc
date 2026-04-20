# Probe P0.8: API key format

## 源头取证

- **Mini-Agent Bearer token usage**: `default_headers={"Authorization": f"Bearer {api_key}"}` (anthropic_client.py:45)
- **api_key 字段类型**: `str`（config.py:25，Pydantic `LLMConfig.api_key: str`）
- **Mini-Agent 对 key 格式零校验**: 仅检查非空 + 非 placeholder `"YOUR_API_KEY_HERE"`（config.py:110）
- **Anthropic SDK 版本**: 0.34.0，接受任意 opaque string 作 key，无格式校验
- openai_client.py 同样使用 Bearer 模式（`Authorization: Bearer <key>`）

## 推断的 key 形态

| 可能性 | 格式 | 依据 |
|--------|------|------|
| 最可能 | `eyJ...`（JWT-like） | MiniMax 平台使用 JWT 格式，401 错误信息要求 "API secret key" in Authorization header |
| 可能 | `sk-...` 前缀 | MiniMax 文档/示例中常见；Anthropic-style key |
| 不太可能 | 纯 UUID / hex | 无平台依据 |

> 注：实测时 bearer token 打到 `api.minimax.io` 返回 401（"Please carry the API secret key
> in the 'Authorization' field"），说明 key 格式需符合 MiniMax 平台要求，但
> mini-agent 本身不做格式验证。

## 写入前建议校验

- **极宽松 regex（v0.1 采用）**: `^[A-Za-z0-9_\-\.+/=]{20,}$`
  - 排除控制字符、空白、YAML 特殊字符
  - 长度下限 20 防止截断的无效 key
- **或不校验**: v0.1 只检查长度 ≥ 8 + 无控制字符即可（fail-closed：宁可误拒也不写坏文件）

## Redaction regex（spec §3.4 已用）

```
/eyJ[A-Za-z0-9_\-\.]{20,}/  →  eyJ***
/sk-[A-Za-z0-9_\-\.]{20,}/  →  sk-***
```

两条 regex 覆盖最可能的两种形态，顺序：JWT-like 优先（更长、更具体）。

## Notes

- mini-agent 的 `config.yaml` YAML 顶层 key 用 `yaml.safe_load` 解析，
  api_key 值类型为 Python str，不会被 YAML boolean/int 误解析（除非裸写 `true`/`false`/数字）。
- `YOUR_API_KEY_HERE` 是唯一被硬编码拒绝的 placeholder，plugin 写入时需同样避免写入此值。
- `openai_client.py` 亦使用相同 Bearer 模式，key 格式一致。
