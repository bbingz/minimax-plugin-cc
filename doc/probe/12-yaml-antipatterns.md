# Probe P0.12: YAML anti-pattern fixtures for gate tests

## Fixtures（各应被 validateYamlForApiKeyWrite 拒绝）

| # | 文件 | 拒绝原因 | YAML 语义 |
|---|------|---------|-----------|
| 1 | `multiline-block-scalar.yaml` | `block-scalar-indicator` | `api_key: |` 开头为 block scalar，值跨多行 |
| 2 | `duplicate-key.yaml` | `duplicate-api-key` | 同一文档两次出现 `api_key:`，`yaml.safe_load` 取最后一个（静默） |
| 3 | `flow-style.yaml` | `flow-style` | `api_key: {nested: value}` 为 mapping flow style，非 scalar |
| 4 | `anchor-alias.yaml` | `anchor-alias-or-tag` | `api_key: *defaults` 为 alias 引用，值为 dict |
| 5 | `bom.yaml` | `bom-at-file-start` | 文件首字节 `EF BB BF`（UTF-8 BOM），破坏 regex 匹配 |
| 6 | `plain-scalar.yaml` | `plain-scalar-requires-quoting` | `api_key: unquoted-plain-scalar` 无引号，regex 替换可能误匹配 |

## Control（应 PASS Form D）

| 文件 | 说明 |
|------|------|
| `upstream-placeholder.yaml` | 上游 `config-example.yaml` 格式 regression 防御；Form D = 双引号 quoted scalar + `# Replace ...` 注释 |

## Phase 1 Task 1.7 单元测试期望

```typescript
// 对 6 个 reject fixtures：期望 ok=false, reason 匹配各自枚举
for (const f of rejectFixtures) {
  const result = validateYamlForApiKeyWrite(readFileSync(f, 'utf8'));
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/block-scalar|duplicate-api-key|flow-style|anchor-alias|bom|plain-scalar/);
}

// 对 1 个 pass fixture：期望 ok=true, form='D'
const ctrl = validateYamlForApiKeyWrite(readFileSync('upstream-placeholder.yaml', 'utf8'));
expect(ctrl.ok).toBe(true);
expect(ctrl.form).toBe('D');
```

## 检测方法参考

- **multiline-block-scalar**: regex `/^api_key:\s*[|>]/m` → reject
- **duplicate-key**: 手动 parse 行数组，计数 `api_key:` 出现次数 > 1 → reject（不依赖 safeload，因其静默取后者）
- **flow-style**: regex `/^api_key:\s*[{\[]/m` → reject
- **anchor-alias**: regex `/^api_key:\s*\*/m` → reject
- **bom**: `content.startsWith('\uFEFF')` → reject
- **plain-scalar**: regex `/^api_key:\s*[^"'\n{|\[*]/m` 且非空 → reject（要求引号）
- **Form D（pass）**: regex `/^api_key:\s*"[^"\n]*"/m` → ok=true

## Notes

- `duplicate-key.yaml` 的危险性：`yaml.safe_load` 静默取第二个值，攻击者可预置恶意占位后再插入 dup key。
  检测器必须在 raw text 层做行计数，不能依赖解析结果。
- `bom.yaml` 在 Node.js `readFileSync('utf8')` 下会保留 BOM 字符（`\uFEFF` 前缀），
  使 `^api_key:` 的 `^` 在 BOM 行之后失效（取决于 multiline flag）。
- `anchor-alias.yaml` 中 `*defaults` 解析后为 dict（`{k: "shared-key-via-anchor"}`），
  赋给 api_key 导致类型错误，应在 raw text 层拒绝。
