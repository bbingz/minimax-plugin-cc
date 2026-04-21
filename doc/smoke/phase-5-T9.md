# Phase 5 T9 smoke — `/minimax:adversarial-review` hard gate

**Date:** 2026-04-21
**Mini-Agent version:** mini-agent 0.1.0
**Model:** MiniMax-M2.7-highspeed (api.minimaxi.com/anthropic — Coding Plan)
**Fixture:** `/tmp/minimax-smoke-3iezQ7` (mktemp isolated repo per M3)

## Input diff

```diff
diff --git a/fetch-user.js b/fetch-user.js
index bcf9045..7e00852 100644
--- a/fetch-user.js
+++ b/fetch-user.js
@@ -1,5 +1,6 @@
 async function fetchUser(id) {
   const res = await fetch(`https://api.example.com/users/${id}`);
+  if (!res.ok) console.log("fetch failed");
   return res.json();
 }
 module.exports = { fetchUser };
```

中性 fixture per M14: fetch 没有 timeout、错误只 log 不抛、JSON parse 可能崩。红蓝双方都有发力空间。

## Command

```bash
node plugins/minimax/scripts/minimax-companion.mjs \
  adversarial-review --json --scope staged --cwd "$SMOKE_DIR" --timeout 180000
```

## Run metrics

- exit code: **0**
- elapsed: **41s** (cold start + red spawn + blue spawn, no retry)
- queue slot held: ~41s
- red.retry_used: false
- blue.retry_used: false

## Output (key fields)

| Field | Red Team | Blue Team |
|---|---|---|
| ok | true | true |
| verdict | needs-attention | approve |
| findings count | 2 | 1 |
| top severity | critical | low |
| logPath | `~/.mini-agent/log/agent_run_20260421_184451.log` | `~/.mini-agent/log/agent_run_20260421_184512.log` |

### Red Team summary (verbatim)

> 阻塞 release - fetch 错误处理形同虚设，在网络故障时 `res` 为 undefined/null 会导致 TypeError crash，在 HTTP 错误时仍返回 res.json() 而非抛出异常，调用者无法区分成功/失败，silent failure 传播到下游决策层。

### Red Team findings

1. **[critical] Network failure causes TypeError crash** (fetch-user.js:2, conf 0.95)
   当 fetch 本身失败（网络断开/DNS 失败/超时）时，`res` 为 undefined/null。`if (!res.ok)` 在 undefined 上访问 `.ok` 属性会抛出 TypeError，导致调用方 crash。
2. **[critical] HTTP error responses return parsed JSON instead of throwing** (fetch-user.js:3, conf 0.95)
   当 API 返回 4xx/5xx 时，`res.ok` 为 false，但代码仍执行 `return res.json()`。典型 silent failure，调用方可能基于错误数据做下游决策。

### Blue Team summary (verbatim)

> 本次改动仅新增一行 console.log 用于记录 fetch 失败状态，未改变函数返回值，调用方的异常处理路径保持不变。原有错误传播机制（fetch 失败 → res.json() 抛出异常 → 调用方 catch）完整保留，blast radius 仅限于调试日志层面。diff 极其简单，回滚成本可忽略。

### Blue Team findings

1. **[low] 生产环境建议使用统一日志框架而非 console.log** (fetch-user.js:2, conf 0.85)
   console.log 在容器化/K8s 环境中可能截断或丢失；生产级应用通常配置 Winston/Pino 等结构化日志。

## T9 verdict

**PASS** — 红蓝两 viewpoint 均产出 schema-valid JSON；红 2 + 蓝 1 = 3 findings（≥1 满足 v2 C2 lenient 解读）。

红蓝**有效分歧**：红队攻击底层代码的固有 bug（network → TypeError, HTTP error → silent JSON），蓝队聚焦 diff 自身的窄范围（只是加 console.log，没改返回值）。两个 viewpoint 都站得住脚，验证了双 spawn 架构的设计意图。

## I9 observation: red critical ratio = 100% (2/2)

I9 触发阈值为 >70%。本轮 red findings 全是 critical：
- "Network failure causes TypeError crash"
- "HTTP error responses return parsed JSON instead of throwing"

**判定**：两个 finding 都是实质技术 bug（confidence 0.95），有具体 line + 具体 recommendation，**不是**激将语言导致的过度对抗性幻觉。样本太小（n=2）不足以触发措辞降级预案；保留观察供 lessons.md 坑 11 延伸记录，待积累更多样本后再判。

## Notes

- 0 retry on either side — first-shot JSON 都通过 schema validation。RED/BLUE_STANCE_INSTRUCTION 的中文措辞 + 输出契约段产出 raw JSON 稳定。
- 41s 总耗时显著低于 plan 预估的 50-90s，提示 P0.1 的 ~10s 冷启动估算偏保守（Coding Plan 端点实际更快）。
- 红蓝 logPath 时间戳间隔 21s，说明红队耗时 ~20s，蓝队耗时 ~21s，与"双 spawn 顺序执行"语义一致。
- 主仓库 working tree 全程干净（M3 兑现）。
