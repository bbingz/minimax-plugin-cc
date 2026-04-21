# prompt-blocks

Reusable prompt fragments. Copy-paste into prompt builders; do NOT reword (consistency matters for retry self-correction).

## Block: output-contract-bilingual

中文 prompt 上下文里强制 enum 字段保持英文：

```
# 输出契约

- 仅返回 RAW JSON 对象，严格匹配下方 schema。
- 不写前言后记，不要 markdown 代码栅栏。
- severity 字段必须是英文枚举之一：critical / high / medium / low。中文严重度（严重/高/中/低）会让 schema 校验失败。
- verdict 字段必须是英文枚举之一：approve / needs-attention。
- 每条 finding 必须包含全部字段；缺一即整条 finding 被拒。
- 不要编造行号；不确定时整条 finding 删掉。
```

## Block: workspace-constraint

`/minimax:rescue` 场景下声明 workspace 边界，降低 tripwire 命中（this is an isolated workdir, not a security sandbox）：

```
约束：
1. 只在 workspace 目录下读写文件，不要使用 / 开头的绝对路径（workspace 是隔离 workdir，不是安全 sandbox）
2. 不要执行 sudo / chmod 0777 / curl | sh / rm -rf / 这类危险命令
3. 不要 git commit；改完让用户自己 review
4. 找不到需要的工具时，先用 get_skill(<name>) 加载 Claude Skills，不要自己 pip install
```

## Block: skills-whitelist

`/minimax:rescue` 任务可能用到 Skills 时附上：

```
你可以使用以下 Claude Skills：
xlsx / pdf / pptx / docx / canvas-design / algorithmic-art / theme-factory / brand-guidelines / artifacts-builder / webapp-testing / mcp-builder / skill-creator / internal-comms / slack-gif-creator / template-skill。
通过 get_skill(<name>) 按需加载。
```

## Block: retry-hint

JSON parse / validate 失败时的 retry hint（programmatic，由 buildReviewPrompt / buildAdversarialPrompt 注入）：

```
# Retry note

Your previous response failed validation: <SPECIFIC ERROR>. Output RAW JSON ONLY matching the schema above — no code fences, no preamble.

## Previous response (verbatim, first 1500 chars, secrets redacted)

<REDACTED PREVIOUS RAW>
```

理由：客观描述错误 + 回灌原文，让模型自己定位。绝不写"你上次错了"这种判定型措辞。

## Block: red-team stance

由 `RED_STANCE_INSTRUCTION` 模块常量提供（`scripts/lib/minimax.mjs`）。手写禁忌见 antipatterns "单 prompt 同时要求红+蓝 findings"。

## Block: blue-team stance

由 `BLUE_STANCE_INSTRUCTION` 模块常量提供（`scripts/lib/minimax.mjs`）。**蓝队的 finding 是 mitigation gap，不是 risk** —— recommendation 字段必须给具体动作。
