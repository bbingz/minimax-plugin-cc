# Probe P0.6: YAML concurrent write race

## 无锁 20 并发结果

| 指标 | 值 |
|------|----|
| 最终 api_key 是某一次写入的值 | yes |
| file size 与原始文件一致 | yes (2818 bytes) |
| model 行保留 | yes |
| api_base 行保留 | yes |
| retry block 保留 | yes |

### 观察到的病态

- macOS APFS 下，20 并发 writeFileSync 最终"幸存"一个完整写入（last-write-wins）。
- 字段无丢失，但这依赖 Node.js 单进程内 V8 event loop + OS 层的原子写语义，
  **不是 YAML 安全**，而是文件系统恰好的副作用。
- 若换成多进程（如 2 个独立 mini-agent 进程同时写），`read-modify-write` 模式
  必然产生 TOCTOU 竞态：进程 A 读到旧内容覆盖进程 B 的写入。
- 单次 `writeFileSync` 在 APFS 上确实是原子的（write syscall for small files），
  但 read-then-write 间隙（50ms 随机延迟模拟了此窗口）使竞态窗口暴露。

## 结论

- 无锁场景**必然需要锁**: yes（spec §4.2 withLockAsync 合理）
- 即使单进程内 20 协程并发，Node.js async/await 中 `readFileSync` → delay → `writeFileSync`
  会在 delay 期间让其他协程抢先写入，本轮读到的内容已过时。

## v0.1 实现要点

1. **withLockAsync 锁机制** — 跨进程文件锁（proper-lockfile 或 fs-based），防 TOCTOU。
2. **同目录 tmpfile + fsync + rename** — 保证写操作原子可见，非截断式覆盖。
3. **predicate gate fail-closed** — 持锁后重新校验 YAML 结构，若异常直接 throw。

## Notes

对 spec §3.4 实现的补充观察：
- `yaml.safe_load` 在并发无锁读时不会崩溃（文件始终完整），但数据竞态在 read-modify-write
  层面依然存在，不能依赖 YAML 解析层保护数据一致性。
- `plain-scalar` 形式的 api_key（无引号）在并发 regex 替换中不受影响；
  但 multiline block scalar 会使 regex `/^api_key:\s*.*$/m` 只替换首行，遗留第二行，
  是额外的 YAML 损坏向量（详见 P0.12 fixtures）。
