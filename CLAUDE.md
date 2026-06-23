# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is now

The **deployed product is a browser-only static web app** (Next.js in `frontend/`) hosted on **GitHub Pages**: https://huggek.github.io/negative-price-calc/. All analysis runs **client-side in TypeScript** — there is no backend at runtime. The Python code lives in **`python/`** (`python/core/`, `python/cli/`) and is kept as a feature-parity library/CLI for offline/scripted use; `python/app.py` (Flask) is optional and not used by the static site.

When adding analysis features, implement them in the TypeScript engine first (it ships) and mirror them in the Python analyzer with a test. See `MEMORY` notes about keeping TS + Python in parity.

## Development Commands

### Web app (the deployed one)
```bash
cd frontend
npm install
npm run dev        # http://localhost:3000
npm run lint
NEXT_PUBLIC_BASE_PATH=/negative-price-calc npm run build   # static export -> frontend/out
```

### Python library / CLI (in `python/`)
```bash
cd python
uv sync
uv run se-cli analyze [file] --area [area] --json
uv run pytest                      # or: python -m pytest test_intervals.py test_core.py
uv run black . && uv run isort .
```

### TypeScript engine tests
```bash
node --experimental-strip-types frontend/scripts/test-analyze.mjs
```

## Architecture Overview

### Frontend (deployed app) — `frontend/src/`
- `app/page.tsx` — upload UI, settings (fuse, VAT, export compensation [fixed öre ± / loss %], self-consumption [energy tax + grid fee, öre], AI toggle), runs the analysis, renders results. Inputs are in öre/kWh.
- `components/` — results cards, price chart, streaming log, file upload
- `lib/` — the client-side engine:
  - `parseProduction.ts` — CSV + Excel parsing (Swedish formats: semicolon, decimal comma, BOM; hourly/15-min/daily) + `assessResolution()` 15-min validation. Excel (`.xlsx`/`.xlsm`) goes through `xlsx.ts`; the "El Rapport" template (formula-only month tabs, real data in a hidden `Serie` matrix) is reconstructed into an hourly series.
  - `xlsx.ts` — dependency-free `.xlsx`/`.xlsm` reader (manual ZIP parse + native `DecompressionStream` for DEFLATE + worksheet/shared-string/date-style XML → per-sheet string grids)
  - `prices.ts` — **elprisetjustnu.se** price client (CORS, no key, SEK/kWh, native 15-min)
  - `analyze.ts` — **interval-aware** analysis via overlap allocation; fuse flat-peak + export-compensation (elnätsbolag + elhandelsbolag, each fixed öre/kWh + variable % of spot, then VAT) + self-consumption valuation + per-quarter export-at-loss (count, daily series, worst-occasions table)
  - `aiSummary.ts` — optional Swedish AI summary via OpenRouter (browser, user-supplied key)

### Python library / CLI — `python/core/`, `python/cli/`
- `python/core/price_analyzer.py` — interval-aware analysis (aligns prices onto a finer grid; duration-based "hours"; fuse flat-peak)
- `python/core/intervals.py` — granularity helpers + `assess_resolution()` 15-min validation (parity with `assessResolution()`)
- `python/core/price_fetcher.py` — ENTSO-E fetch (needs `ENTSOE_API_KEY`) + SQLite cache (`python/core/db_manager.py`)
- `python/cli/main.py` — `se-cli` (supports `--vat`, `--energy-tax`, `--transmission-fee`)
- See [`python/README.md`](python/README.md) and [`python/CLAUDE.md`](python/CLAUDE.md).

### Key concepts
- **15-minute resolution is the recommended input.** The Swedish market moved to 15-minute (quarter-hour) settlement on 2025-10-01; quarter-hour data is needed to see negative-price quarters and short export peaks. Both engines validate it (`assessResolution` / `assess_resolution`) and warn — but don't hard-fail — on coarser data.
- **Interval-aware**: never assume "one row = one hour". Production and prices may be hourly, 15-minute (Swedish market from 2025-10-01), or daily; energy/cost and "hours" metrics are computed from each interval's real duration.
- **Price source**: the browser app uses the elprisetjustnu.se API (CORS, no key, 15-min, SEK). ENTSO-E can't be called from the browser (no CORS headers, and a client-side key would be exposed); the Python `price_fetcher` uses ENTSO-E directly (key required) plus the bundled SQLite cache.
- **Area codes**: `SE1`/`SE_1`/`SE-1` all normalize to the same zone (SE1–SE4).

## Deployment

GitHub Actions (`.github/workflows/deploy-pages.yml`) builds `frontend/` as a static export and publishes to GitHub Pages on every push to `main` (set `NEXT_PUBLIC_BASE_PATH=/<repo>`). Enable **Settings → Pages → Source: GitHub Actions** once.

## Environment Configuration

- Browser app: no environment needed for prices (Sourceful, no key). AI summary uses a user-supplied OpenRouter key entered in the UI (stored only in the browser).
- Python CLI: `ENTSOE_API_KEY` (price fetch), `DATABASE_PATH` (optional, default `data/price_data.db`, relative to `python/`). Copy `python/.env.example` to `python/.env`.

## Testing Strategy

- `python/test_intervals.py` — interval-aware analysis + fuse parity + 15-min resolution validation (pytest)
- `python/test_core.py` — core import/analyzer smoke tests
- `frontend/scripts/test-analyze.mjs` — TypeScript engine sanity checks (analysis + parsing + resolution validation)
- Sample production files in `python/data/samples/`; the web app's example file is `frontend/public/exempel-15min.csv`
