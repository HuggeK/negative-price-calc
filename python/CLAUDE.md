# CLAUDE.md — Python library / CLI

Guidance for working in the `python/` folder. See the repo-root
[CLAUDE.md](../CLAUDE.md) for the overall architecture.

## What this is

The Python implementation of the analysis: a feature-parity **library + CLI** for
offline / scripted use and for ENTSO-E price fetching (the browser can't call ENTSO-E).
It is **not** the deployed product — that's the static web app in `../frontend`.

## Parity rule

The TypeScript engine (`../frontend/src/lib/`) ships to users, so implement analysis
changes there **first**, then mirror them here and add a test. Concretely:

| TypeScript (`frontend/src/lib`) | Python (`python/`) |
|---|---|
| `analyze.ts` (overlap allocation, fuse, export compensation, self-consumption) | `core/price_analyzer.py` `analyze_data()` |
| `parseProduction.ts` `assessResolution()` | `core/intervals.py` `assess_resolution()` |
| `parseProduction.ts` `combineProduction()` | `core/intervals.py` `combine_production()` |
| `analyze.ts` `nextFuseStep()` / fuse-upgrade | `core/price_analyzer.py` `next_fuse_step()` + `fuse_upgrade` block |
| granularity helpers | `core/intervals.py` |

> Browser-only (no Python mirror): `lib/strang.ts` (SMHI STRÅNG irradiance) — it relies on
> the model's public CORS API and is only meaningful in the static web app.

**Canonical valuation** lives in `core/price_analyzer.analyze_data()`:
- Export compensation per company: `(spot + grid_fixed + spot·grid_pct% + trader_fixed +
  spot·trader_pct%) · (1+VAT)` (params `vat_rate`, `grid_fixed`, `grid_pct`,
  `trader_fixed`, `trader_pct`). **VAT is asymmetric**: it's added to the export (sales) side
  only when `vat_registered=True`; the self-consumption (buy) side always includes VAT
  (a consumer always pays moms on bought electricity).
- Self-consumption: `(spot + energy_tax + grid_fee)·(1+VAT)` vs. the effective export price
  (params `self_energy_tax`, `self_grid_fee`).
- Export-at-loss: quarters where the effective price < 0 (`export_at_loss` block: count,
  break-even spot, daily series, worst-occasions rows).
- Fuse upgrade: `fuse_upgrade` block (params `next_fuse_monthly_fee`, `installed_kwp`) — counts
  only sustained clipping (≥2 consecutive intervals at the cap), unlocked headroom bounded by
  `min(next fuse limit, kWp)`, valued at the effective price during those quarters, annualized
  and weighed against the extra annual subscription (`worth_upgrading`).

Note: `cli/main.py`'s `build_storytelling_payload` still carries an older inline
self-consumption block (export baseline = spot only) and is a follow-up to align to
`analyze_data`.

## Commands (run from `python/`)

```bash
uv sync
uv run se-cli analyze <file> --area SE_4 --json
uv run pytest                  # or: python -m pytest test_intervals.py test_core.py
uv run black . && uv run isort .
```

## Conventions

- **Interval-aware**: never assume one row == one hour. Use `core/intervals.py`
  (`infer_step_hours`, `interval_hours_series`) so metrics reflect real durations.
- **15-minute resolution** is the recommended input (Swedish market since 2025-10-01).
  Validate with `assess_resolution()`; warn (don't hard-fail) on coarser data.
- pandas 3.0: use `freq="h"` (lowercase), not the deprecated `"H"`.
- `core/__init__.py` imports are resilient: `PriceAnalyzer` and `PriceDatabaseManager`
  always import; `PriceFetcher` / `ProductionLoader` are optional (heavy deps).
- When emitting `--json` from `cli/main.py`, keep stdout machine-readable — send any
  warnings to **stderr**.
- Default data paths are relative to this folder (`data/price_data.db`).
