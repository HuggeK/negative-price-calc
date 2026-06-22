# ⚡ Negative Price Calculator

Analyze your solar export against historical Swedish spot prices — including **negative prices** — and see what your electricity was actually worth. The web app runs **entirely in your browser**: your production file never leaves your device.

**[🔗 Live app →](https://huggek.github.io/negative-price-calc/)**

<img src="https://img.shields.io/badge/License-MIT-green.svg" alt="MIT License">
<img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome">

---

## 🎯 What is this?

When you have solar panels you sell excess electricity to the grid. But spot prices sometimes go **negative** — meaning you pay to export. Since the 60 öre/kWh tax credit ended on 1 January 2026, the spot price alone decides what your export is worth. This tool helps you:

- 📊 **Analyze your production** — upload your export CSV (**15-minute / quarter-hour recommended**; hourly and daily also work)
- 💸 **Detect negative-price periods** — see when exporting cost you money
- ⏱️ **Catch sub-hour peaks** — full **15-minute** resolution (the Swedish market moved to 15-min on 2025-10-01)
- 🔌 **Check your grid connection** — how long export was pinned at your main-fuse limit ("flat peaks")
- 💱 **See your real export pay** — effective compensation = (spot + förlustersättning [%·spot] + fast påslag/avdrag) × (1 + moms)
- 🏠 **Value self-consumption** — what a kWh is worth used yourself vs. exported, as a separate section
- 🤖 **Get an AI summary** (optional) — Swedish-language, generated in your browser with your own key
- 💾 **Export results** — download JSON or CSV

## ✨ Key features

- **🔒 Private & serverless** — all parsing, price-matching and analysis run client-side; nothing is uploaded
- **🔌 No API key for prices** — uses the free [elprisetjustnu.se API](https://www.elprisetjustnu.se/elpris-api) (CORS-enabled, native 15-minute, prices already in SEK)
- **⏱️ Interval-aware** — correctly handles any mix of hourly / 15-minute / daily data via overlap allocation
- **🇸🇪 Swedish bidding zones** — SE1–SE4
- **🔌 Grid-connection analysis** — main-fuse flat-peak detection (3-phase, 400 V)
- **💱 Export compensation** — fixed surcharge/deduction + loss compensation (% of spot) + VAT
- **🏠 Self-consumption valuation** — value of self-use vs. exporting, in a separate section
- **🪙 Familiar units** — inputs in öre/kWh; results show kronor for totals and öre for per-kWh
- **🤖 Optional AI summary** — via OpenRouter, using a key you supply (stored only in your browser)
- **📨 Optional newsletter** — opt in to Sourceful Energy updates (never required to run an analysis)

## 📖 How to use

1. **Get your export data** — log in to your grid/energy company's portal and export your meter data as CSV.
2. **Upload the file** — **15-minute (quarter-hour) data is recommended**; hourly and daily are also detected automatically. No file of your own? Click **Prova med exempeldata** to run a bundled 15-minute sample.
3. **Choose your bidding zone** — SE1–SE4.
4. **(Optional) settings** — main fuse size (A), VAT %, export compensation (fixed öre/kWh ± and loss % of spot), and self-consumption inputs (energy tax + grid fee, in öre/kWh). AI summary toggle is off by default.
5. **Click "Analysera"** — the report appears directly in the browser, labelled with the data resolution (kvart / 15-min). Download it as JSON or CSV.

Sample files live in [`python/data/samples/`](python/data/samples/); the web app's bundled example is [`frontend/public/exempel-15min.csv`](frontend/public/exempel-15min.csv). The browser app reads **CSV** (export Excel files as CSV first); the Python CLI also reads Excel.

## 🧮 What the analysis shows

- **Total export & revenue** (SEK) at realized spot prices
- **Negative-price exposure** — hours, kWh and cost of exporting at negative prices
- **Timing discount** — how far below the market average you were paid
- **Grid connection** — peak power, and time/energy at the main-fuse limit (when a fuse size is given)
- **Export compensation** — effective price/kWh and total you actually get paid (spot + loss% + fixed, × VAT)
- **Self-consumption value** — worth of a kWh used yourself vs. exported (when energy tax / grid fee are given)
- **Monthly breakdown** chart

## 💰 Price data

Prices come from the free, no-key **[elprisetjustnu.se API](https://www.elprisetjustnu.se/elpris-api)** (CORS-enabled, so it works directly from the browser):

```
GET https://www.elprisetjustnu.se/api/v1/prices/{YYYY}/{MM}-{DD}_{ZONE}.json
```

Returned already in SEK/kWh (and EUR/kWh) at the market resolution — **15-minute** from 2025-10-01, hourly before. elprisetjustnu.se is credited as the price source in the app footer.

### Why not your own ENTSO-E key in the browser?

ENTSO-E's API sends no CORS headers, so a browser on a static site cannot read its responses; and any key placed in client-side code is publicly visible, so it cannot be kept secret. The **browser app** therefore uses elprisetjustnu.se. To use an ENTSO-E key, run the **Python CLI** (`ENTSOE_API_KEY`), which runs locally/server-side where CORS does not apply.

## 🏗️ Architecture

```
negative-price-calc/
├── frontend/                     # The deployed web app (Next.js, static export)
│   ├── public/exempel-15min.csv  # Bundled 15-min example for the "Prova med exempeldata" button
│   └── src/
│       ├── app/page.tsx          # Upload UI, settings, results
│       ├── components/           # Results cards, charts, terminal, upload
│       └── lib/                  # Client-side engine:
│           ├── parseProduction.ts  #   CSV parsing (Swedish formats) + 15-min validation
│           ├── prices.ts           #   elprisetjustnu.se price client
│           ├── analyze.ts          #   interval-aware analysis (overlap allocation)
│           └── aiSummary.ts        #   optional OpenRouter summary (browser, BYO key)
└── python/                       # Python library / CLI (feature parity)
    ├── core/
    │   ├── price_analyzer.py     #   interval-aware analysis + fuse flat-peak
    │   ├── intervals.py          #   granularity helpers + 15-min validation
    │   ├── price_fetcher.py      #   ENTSO-E fetch (needs ENTSOE_API_KEY) + SQLite cache
    │   └── db_manager.py         #   price cache (resolution-aware)
    ├── cli/main.py               #   `se-cli` command-line interface
    ├── app.py                    #   Optional Flask API (not used by the static app)
    └── data/samples/             #   Example production files
```

The **web app is fully client-side** and needs no backend. The **Python CLI/library** mirrors the analysis (15-minute intervals, fuse flat-peak, VAT/self-consumption) for offline/scripted use.

## 🚀 Run locally

### Web app (the deployed one)

```bash
cd frontend
npm install
npm run dev          # http://localhost:3000
```

### Python CLI (optional, in `python/`)

```bash
cd python
uv sync
uv run se-cli analyze your_file.csv --area SE_4 --json
# self-consumption valuation:
uv run se-cli analyze your_file.csv --area SE_4 --vat 25 --energy-tax 0.4282 --transmission-fee 0.25
```

The CLI fetches prices from ENTSO-E (set `ENTSOE_API_KEY`) or uses the bundled SQLite cache. See [`python/README.md`](python/README.md) for details.

## ☁️ Deployment (GitHub Pages)

The web app is a static export deployed by GitHub Actions ([`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)) on every push to `main`. To deploy your own fork:

1. Enable **Settings → Pages → Source: GitHub Actions**.
2. Push to `main`. The workflow builds `frontend/` (with `NEXT_PUBLIC_BASE_PATH=/<repo>`) and publishes `frontend/out`.

## 🧪 Tests

```bash
# Python (interval-aware analysis + fuse parity + 15-min validation)
cd python
uv run pytest            # or: python -m pytest test_intervals.py test_core.py

# TypeScript engine sanity checks (from repo root)
node --experimental-strip-types frontend/scripts/test-analyze.mjs
```

## 🤝 Contributing

1. Fork and create a feature branch.
2. Make your change (keep the TS engine and Python analyzer in parity).
3. Run the tests above.
4. Open a Pull Request.

## 📄 License

MIT — see [LICENSE](LICENSE).

## 🙏 Acknowledgments

- Price data from [elprisetjustnu.se](https://www.elprisetjustnu.se/elpris-api)
- Built for the Swedish solar community by [Sourceful Energy](https://sourceful.energy)
```
