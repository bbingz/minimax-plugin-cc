# minimax-prompt-recipes

Recipes pulled from Phase 1-5 smoke runs against MiniMax-M2 7B and Coding-Plan endpoints.

## Recipe: Chinese-language code review

```
你是一名资深代码审查员，请对下面的 diff 做一次审查。
返回严格匹配下面 schema 的 RAW JSON，不要 markdown 代码栅栏，不要前言后记。
severity 字段必须是英文枚举：critical / high / medium / low（中文严重度会让 schema 校验失败）。

# Schema
```json
{ ... }
```

# Diff
```
{ ... diff ... }
```
```

适用：M2.7 中文 prose 输出能力，比强迫英文版准确率更高。

## Recipe: Multi-step agent task with Skills

```
请帮我把 input.csv 转换成排序后的 Excel 文件，按 region 分 sheet。
你可以使用以下 Claude Skills：xlsx / pdf / pptx / docx / canvas-design / algorithmic-art / theme-factory / brand-guidelines / artifacts-builder / webapp-testing / mcp-builder / skill-creator / internal-comms / slack-gif-creator / template-skill。
通过 get_skill(<name>) 加载需要的 skill。
只在 workspace 目录下读写文件，不要使用绝对路径（this is an isolated workdir, not a security sandbox）。
```

适用：`/minimax:rescue --sandbox`。Skills 列表中文友好；声明 workspace 边界减小后续 tripwire 命中率。

## Recipe: Adversarial-review red stance (programmatic)

由 `buildAdversarialPrompt({stance: "red", ...})` 自动注入 `RED_STANCE_INSTRUCTION`。其核心要点（手写时勿迂回）：

- summary 写成 ship/no-ship 判定（"不要发布" / "阻塞 release"），不要平衡修辞（"既有改进也有顾虑"）
- 攻击面：鉴权 / 数据丢失 / 回滚 / 竞态 / empty-state / 版本漂移 / observability
- 不要用"可能" / "或许"软化 finding；要么有依据写实，要么删掉
- severity 用英文枚举 critical/high/medium/low
- 本任务只读：不写文件、不执行修改型 bash

完整文本见 `plugins/minimax/scripts/lib/minimax.mjs::RED_STANCE_INSTRUCTION`；手写禁忌另见 `minimax-prompt-antipatterns.md` "单 prompt 同时要求红+蓝 findings"。

## Recipe: Adversarial-review blue stance (programmatic)

由 `buildAdversarialPrompt({stance: "blue", ...})` 自动注入 `BLUE_STANCE_INSTRUCTION`。其核心要点（与红队措辞反向）：

- summary 写成 ship-with-confidence 或 ship-with-mitigations 判定，不要向红队靠拢
- 任务重心：(1) 评估现有防御层是否充分 (schema 校验/类型系统/上游 sanitize/测试覆盖等)；(2) 找低成本 mitigation gap
- finding 是 mitigation gap，不是 risk；recommendation 必须是具体动作
- severity 校准：critical = 不补会出生产事故；high = 显著运维风险；medium = 维护期 toil；low = 可选打磨
- 找不到 mitigation gap 时 `findings` 空数组合法（不影响 T9）
- 本任务只读

完整文本见 `plugins/minimax/scripts/lib/minimax.mjs::BLUE_STANCE_INSTRUCTION`。

## Recipe: ask question (no JSON)

```
（中文直接问，不需要 schema 块）
帮我用一句话解释什么是 Bloom filter？
```

适用：`/minimax:ask`。不要给 schema、不要给输出格式约束 —— 否则 M2.7 会输出空 JSON。

## Recipe: rescue 多文件改动 with constraint declaration

```
请在 plugins/foo/ 下加一个新模块 bar.js，导出 doBar() 函数。
约束：
1. 只在 plugins/foo/ 目录下读写文件，不动其他目录（this is an isolated workdir, not a security sandbox）
2. 不调用 git commit，让用户自己 review
3. 写完后跑 plugins/foo/test.js 验证
```

适用：`/minimax:rescue --sandbox`。约束写在编号列表里，比 prose 更稳定。
