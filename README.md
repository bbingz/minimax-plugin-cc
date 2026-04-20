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
- (more coming as phases complete)

## License

MIT
