# minimax-plugin-cc

Claude Code plugin integrating MiniMax via Mini-Agent.

**Status:** v0.1 in development. Spec: `docs/superpowers/specs/2026-04-20-minimax-plugin-cc-design.md` (v5, two rounds of spec review + three rounds of plan review + Phase 0 probe findings integrated).

## Prerequisites

- [Claude Code](https://claude.ai/code)
- [Mini-Agent](https://github.com/MiniMax-AI/Mini-Agent) ≥ 0.1.0:

```
uv tool install --with socksio git+https://github.com/MiniMax-AI/Mini-Agent.git
```

- Configured `~/.mini-agent/config/config.yaml` with valid MiniMax API key

## Install (development)

```bash
claude plugins add ./plugins/minimax
```

## Commands (v0.1 incremental)

- `/minimax:setup` — verify Mini-Agent installation, auth state, and write API key (if needed)
- `/minimax:ask`, `/minimax:review`, `/minimax:adversarial-review`, `/minimax:rescue`
- `/minimax:status`, `/minimax:result`, `/minimax:cancel`, `/minimax:task-resume-candidate`
- `/minimax:timing` (v0.1.3) — per-spawn timing history (last-N / `--aggregate` percentiles / `--json`)

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_PLUGIN_DATA` | `~/.claude/plugins/data/minimax-minimax-plugin` | Root for `timings.ndjson` and related plugin data |
| `MINI_AGENT_BIN` | `mini-agent` | Override Mini-Agent CLI path |
| `MINIMAX_STALE_JOB_THRESHOLD_MS` | `259200000` (3 days) | SessionStart mtime-based prune threshold for `~/.claude/plugins/minimax/jobs/`. See `docs/superpowers/specs/2026-04-22-v0.1.3-timing-cleanup-upstream.md` §D3/D4. Set to a smaller value (e.g. `60000` = 1 min) if you want more aggressive cleanup. |

## License

MIT
