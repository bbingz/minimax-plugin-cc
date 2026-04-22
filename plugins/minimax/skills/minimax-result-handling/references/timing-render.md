# /minimax:timing render reference

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | history / aggregate / json rendered successfully OR no records yet |
| 2 | `--aggregate` called without valid `--kind` |
| 3 | invalid `--since` timestamp |

## Default view (no --aggregate, no --json)

Render the command's stdout verbatim. Do NOT reformat.

## --aggregate

- `--aggregate` MUST pair with a single `--kind` (ask / review / adversarial-red / adversarial-blue / rescue). `all` is REJECTED with exit 2.
- `fallback rate` displays `—` until upstream populates `usage` (see `PROGRESS.md §Upstream limitations`). Do NOT interpret `—` as "no fallback" — it means "we cannot tell".
- `p95` / `p99` may render `—` when n < 20 / n < 100 respectively (per spec §9 cutoffs).

## --json

Passthrough of ndjson records, one per line. Downstream tools parse it.

## Command constraints

`/minimax:timing` does NOT trigger a Mini-Agent spawn. It only reads `timings.ndjson`. Safe to run anywhere without token cost.

## Tripwire scan

Tripwire rules from `references/ask-render.md` (suspicious bash patterns) do NOT apply to `/minimax:timing` output — all fields are structured numbers, not user-supplied text.
