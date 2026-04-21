# minimax-prompt-antipatterns

Empirically failed prompts on MiniMax-M2 7B and Coding-Plan endpoints, collected during Phase 2-5 smoke runs.

## Anti-pattern: 让 M2.7 翻译已是中文的输入

```
请把下面的中文需求翻译成英文，再做 review：
（中文 diff）
```

失败：M2.7 拒绝翻译"已经是目标语言"的输入；返回原文或空 response。
修复：直接中文问，保留中文输入。

## Anti-pattern: severity 字段允许中文

```
schema 上写了 severity ∈ {critical, high, medium, low}，但用户用中文 prompt 时模型经常返回 severity: "高"。
```

失败：schema validator 报 enum 错。
修复：prompt 显式声明 "severity 必须是英文枚举之一：critical / high / medium / low；中文严重度会让 schema 校验失败"。

## Anti-pattern: 单 prompt 同时要求红+蓝 findings

```
请同时从红队和蓝队两个视角审查这次 diff，红队 findings 和蓝队 findings 各列一组。
```

失败：M2.7 偏向最后出现的 stance 指令，红队 findings 经常变成稀疏 placeholder；T9 抖动严重。
修复：双 spawn 架构（Phase 5）。每次只灌一个 stance。kimi-plugin-cc 通过单 stance 设计天然规避此坑；minimax 因双 stance 需求采用双 spawn。

## Anti-pattern: ask 命令带 schema

```
（/minimax:ask）请回答 X 问题，并按下面 schema 返回 JSON。
```

失败：classifier 判 success-but-empty；用户看到空字符串。
修复：ask 命令不传 schema 段；让模型自由输出 prose。

## Anti-pattern: prompt 末尾留 "thanks"/"如有疑问请告知"

M2.7 会把这种社交语句视为信号，附上 "好的，希望对你有帮助" 之类后记，破坏 RAW JSON 输出。
修复：prompt 严格收束于 schema 段，不留社交收尾。

## Anti-pattern: 在 retry hint 里责怪模型

```
你上次输出失败了，请这次写对。
```

失败：模型自我防御行为（输出"你说我错了，但其实我是对的，因为..."），retry 也失败。
修复：客观描述失败原因（"schema validation errors: ..."）+ 回灌前 1500 字脱敏原文，让模型自己定位错在哪。retry hint 与主体 prompt 用同一种语言（M2.7 中文 prompt 下 retry hint 也用中文，避免双语切换）。

## Anti-pattern: rescue 模式下问问题

```
（/minimax:rescue）请解释这段代码做什么。
```

失败：rescue 是 agent dispatch，模型会启动 bash 工具去探索文件系统；UX 不符合预期，且额外消耗 quota。
修复：解释类问题用 `/minimax:ask`；rescue 留给"做事"任务。

## Anti-pattern: prompt placeholder 用通配正则做 leftover guard

```js
// 错的写法（C3 bug）：
const leftover = result.match(/\{\{[A-Z_]+\}\}/);
if (leftover) throw new Error(...);
```

失败：用户的 diff 含 React/Vue 模板语法（`{{userName}}` 等）会误命中并抛错。
修复：用预期 placeholder 白名单 set，且在 `{{CONTEXT}}` 替换之前做校验（context 里的 `{{...}}` 是 user data，不是 placeholder）。
