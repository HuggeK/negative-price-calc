# Negative Price Calculator

Analyze your solar export against historical Swedish spot prices — including negative prices — and see what your electricity was actually worth. The web app runs entirely in your browser; your production file never leaves your device.

**[Live app](https://srcfl.github.io/negative-price-calc/)**

<img src="https://img.shields.io/badge/License-MIT-green.svg" alt="MIT License">
<img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome">

## Overview

When you have solar panels you sell excess electricity to the grid, but spot prices sometimes go negative — meaning you pay to export. Since the 60 öre/kWh tax credit ended on 1 January 2026, the spot price alone decides what your export is worth. Upload your meter export and the tool reports:

- Total export and revenue at realized spot prices.
- Negative-price exposure: quarters, kWh and cost of exporting at negative prices.
- Grid-connection load: how often export was pinned at your main-fuse limit.
- Effective export pay from both your elnätsbolag (förlustersättning) and elhandelsbolag (påslag/avdrag), each a fixed (öre/kWh) + variable (% of spot) part, plus VAT.
- Loss-making quarters where the effective price fell below zero, with a chart and a table.
- Self-consumption value: what a kWh is worth used yourself vs. exported.
- Whether upgrading or downgrading the main fuse would pay off.
- Optional Swedish AI summary, generated in the browser with your own key.
- JSON / CSV export of the results.

## Features

- Private and serverless: all parsing, price-matching and analysis run client-side.
- No API key for prices: uses the free [elprisetjustnu.se API](https://www.elprisetjustnu.se/elpris-api) (CORS-enabled, native 15-minute, prices in SEK).
- Interval-aware: handles any mix of hourly / 15-minute / daily data via overlap allocation.
- Swedish bidding zones SE1–SE4.
- Grid-connection analysis: main-fuse flat-peak detection (3-phase, 400 V).
- Export compensation per company (elnät + elhandel), each fixed (öre/kWh) + variable (% of spot) + VAT.
- Loss-making quarters: count, chart and table of quarters exported below break-even.
- Monthly forecast: expected net per full-data month after fixed monthly fees.
- Fuse up/downgrade analysis: extra/lower subscription fee weighed against unlocked or clipped export.
- Optional SMHI STRÅNG solar irradiance for sunlit-hour pricing and a rough potential-production estimate.
- Inputs in öre/kWh; results show kronor for totals and öre for per-kWh values.

## Usage

1. Export your meter data as CSV from your grid/energy company's portal. 15-minute (quarter-hour) data is recommended; hourly and daily are detected automatically. Grid companies often cap 15-minute exports at ~3 months — upload several files and they are combined.
2. Upload the file(s), or click **Prova med exempeldata** to run a bundled 15-minute sample.
3. Choose your bidding zone (SE1–SE4).
4. Optionally set the main fuse size, VAT, export compensation per company, self-consumption inputs, and a position for STRÅNG.
5. Click **Analysera**. The report appears in the browser and can be downloaded as JSON or CSV.

Sample files are in [`python/data/samples/`](python/data/samples/); the bundled web example is [`frontend/public/exempel-15min.csv`](frontend/public/exempel-15min.csv). The browser app reads CSV (export Excel as CSV first); the Python CLI also reads Excel.

## Price data

Prices come from the free, no-key [elprisetjustnu.se API](https://www.elprisetjustnu.se/elpris-api) (CORS-enabled, so it works from the browser):

```
GET https://www.elprisetjustnu.se/api/v1/prices/{YYYY}/{MM}-{DD}_{ZONE}.json
```

Values are returned in SEK/kWh (and EUR/kWh) at the market resolution — 15-minute from 2025-10-01, hourly before.

**Why not an ENTSO-E key in the browser?** ENTSO-E sends no CORS headers, so a static-site browser cannot read its responses, and any client-side key is publicly visible. The browser app therefore uses elprisetjustnu.se. To use an ENTSO-E key, run the Python CLI (`ENTSOE_API_KEY`), which runs locally where CORS does not apply.

## Architecture

```
negative-price-calc/
├── frontend/                     # Deployed web app (Next.js, static export)
│   ├── public/exempel-15min.csv  # Bundled 15-min example
│   └── src/
│       ├── app/page.tsx          # Upload UI, settings, results
│       ├── components/           # Results cards, charts, terminal, upload
│       └── lib/                  # Client-side engine:
│           ├── parseProduction.ts  #   CSV parsing + 15-min validation + multi-file combine
│           ├── prices.ts           #   elprisetjustnu.se price client
│           ├── analyze.ts          #   interval-aware analysis (overlap allocation)
│           ├── strang.ts           #   SMHI STRÅNG irradiance client (browser-only)
│           └── aiSummary.ts        #   optional OpenRouter summary (BYO key)
└── python/                       # Python library / CLI (feature parity)
    ├── core/
    │   ├── price_analyzer.py     #   interval-aware analysis + fuse up/downgrade
    │   ├── intervals.py          #   granularity helpers + 15-min validation + combine
    │   ├── price_fetcher.py      #   ENTSO-E fetch (ENTSOE_API_KEY) + SQLite cache
    │   └── db_manager.py         #   price cache (resolution-aware)
    ├── cli/main.py               #   se-cli command-line interface
    └── data/samples/             #   Example production files
```

The web app is fully client-side and needs no backend. The Python CLI/library mirrors the analysis for offline/scripted use; STRÅNG is browser-only.

## Run locally

Web app:

```bash
cd frontend
npm install
npm run dev          # http://localhost:3000
```

Python CLI (optional):

```bash
cd python
uv sync
uv run se-cli analyze your_file.csv --area SE_4 --json
uv run se-cli analyze your_file.csv --area SE_4 --vat 25 --energy-tax 0.4282 --transmission-fee 0.25
```

The CLI fetches prices from ENTSO-E (`ENTSOE_API_KEY`) or uses the bundled SQLite cache. See [`python/README.md`](python/README.md).

## Deployment (GitHub Pages)

GitHub Actions ([`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)) builds `frontend/` and publishes `frontend/out` on every push to `main`. For a fork: enable Settings → Pages → Source: GitHub Actions, then push to `main` (the build sets `NEXT_PUBLIC_BASE_PATH=/<repo>`).

## Tests

```bash
# Python
cd python
uv run pytest

# TypeScript engine (from repo root)
node --experimental-strip-types frontend/scripts/test-analyze.mjs
```

## Contributing

Fork, create a feature branch, make the change (keep the TS engine and Python analyzer in parity), run the tests, and open a pull request.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

- Price data from [elprisetjustnu.se](https://www.elprisetjustnu.se/elpris-api).
- Solar irradiance from [SMHI STRÅNG](https://opendata.smhi.se/apidocs/strang/).
- Built for the Swedish solar community by [Sourceful Energy](https://sourceful.energy).
