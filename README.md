# ⚡ Negative Price Calculator

Analyze your solar export against historical Swedish spot prices — including **negative prices** — and see what your electricity was actually worth. The web app runs **entirely in your browser**: your production file never leaves your device.

**[🔗 Live app →](https://huggek.github.io/negative-price-calc/)**

<img src="https://img.shields.io/badge/License-MIT-green.svg" alt="MIT License">
<img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome">

---

## 🎯 What is this?

When you have solar panels you sell excess electricity to the grid. But spot prices sometimes go **negative** — meaning you pay to export. Since the 60 öre/kWh tax credit ended on 1 January 2026, the spot price alone decides what your export is worth. This tool helps you:

- 📊 **Analyze your production** — upload your hourly / 15-minute / daily export CSV
- 💸 **Detect negative-price periods** — see when exporting cost you money
- ⏱️ **Catch sub-hour peaks** — full **15-minute** resolution (the Swedish market moved to 15-min on 2025-10-01)
- 🔌 **Check your grid connection** — how long export was pinned at your main-fuse limit ("flat peaks")
- 🏠 **Value self-consumption** — using payment/VAT settings (spot + energy tax + grid fee) × (1 + VAT)
- 🤖 **Get an AI summary** (optional) — Swedish-language, generated in your browser with your own key
- 💾 **Export results** — download JSON or CSV

## ✨ Key features

- **🔒 Private & serverless** — all parsing, price-matching and analysis run client-side; nothing is uploaded
- **🔌 No API key for prices** — uses the free [Sourceful Price API](https://docs.sourceful.energy/developer/price-api) (a wrapper around ENTSO-E data)
- **⏱️ Interval-aware** — correctly handles any mix of hourly / 15-minute / daily data via overlap allocation
- **🇸🇪 Swedish bidding zones** — SE1–SE4
- **🔌 Grid-connection analysis** — main-fuse flat-peak detection (3-phase, 400 V)
- **🏠 Self-consumption valuation** — configurable VAT, energy tax and grid fee
- **🤖 Optional AI summary** — via OpenRouter, using a key you supply (stored only in your browser)
- **📨 Optional newsletter** — opt in to Sourceful Energy updates (never required to run an analysis)

## 📖 How to use

1. **Get your export data** — log in to your grid/energy company's portal and export your meter data as CSV.
2. **Upload the file** — hourly, 15-minute or daily data is detected automatically.
3. **Choose your bidding zone** — SE1–SE4.
4. **(Optional) settings** — main fuse size (A), VAT %, energy tax and grid fee (kr/kWh), and the AI summary toggle.
5. **Click "Analysera"** — the report appears directly in the browser. Download it as JSON or CSV.

Sample files live in [`data/samples/`](data/samples/). The browser app reads **CSV** (export Excel files as CSV first); the Python CLI also reads Excel.

## 🧮 What the analysis shows

- **Total export & revenue** (SEK) at realized spot prices
- **Negative-price exposure** — hours, kWh and cost of exporting at negative prices
- **Timing discount** — how far below the market average you were paid
- **Grid connection** — peak power, and time/energy at the main-fuse limit (when a fuse size is given)
- **Self-consumption value** — worth of a kWh used yourself vs. exported (when VAT/fees are given)
- **Monthly breakdown** chart

## 💰 Price data

Prices come from the **Sourceful Price API** — a free, no-key wrapper around ENTSO-E day-ahead data:

```
GET https://mainnet.srcful.dev/price/electricity/{ZONE}?date=YYYY-MM-DD
```

Returned in EUR/MWh at the market resolution (15-minute from 2025-10-01, hourly before) and converted to SEK/kWh in the app. Docs: https://docs.sourceful.energy/developer/price-api

## 🏗️ Architecture

```
negative-price-calc/
├── frontend/                     # The deployed web app (Next.js, static export)
│   └── src/
│       ├── app/page.tsx          # Upload UI, settings, results
│       ├── components/           # Results cards, charts, terminal, upload
│       └── lib/                  # Client-side engine:
│           ├── parseProduction.ts  #   CSV parsing (Swedish formats)
│           ├── prices.ts           #   Sourceful Price API client
│           ├── analyze.ts          #   interval-aware analysis (overlap allocation)
│           └── aiSummary.ts        #   optional OpenRouter summary (browser, BYO key)
├── core/                         # Python library / CLI (feature parity)
│   ├── price_analyzer.py         #   interval-aware analysis + fuse flat-peak
│   ├── intervals.py              #   granularity helpers
│   ├── price_fetcher.py          #   ENTSO-E fetch (needs ENTSOE_API_KEY) + SQLite cache
│   └── db_manager.py             #   price cache (resolution-aware)
├── cli/main.py                   # `se-cli` command-line interface
├── app.py                        # Optional Flask API (not used by the static app)
└── data/samples/                 # Example production files
```

The **web app is fully client-side** and needs no backend. The **Python CLI/library** mirrors the analysis (15-minute intervals, fuse flat-peak, VAT/self-consumption) for offline/scripted use.

## 🚀 Run locally

### Web app (the deployed one)

```bash
cd frontend
npm install
npm run dev          # http://localhost:3000
```

### Python CLI (optional)

```bash
uv sync
uv run se-cli analyze your_file.csv --area SE_4 --json
# self-consumption valuation:
uv run se-cli analyze your_file.csv --area SE_4 --vat 25 --energy-tax 0.4282 --transmission-fee 0.25
```

The CLI fetches prices from ENTSO-E (set `ENTSOE_API_KEY`) or uses the bundled SQLite cache.

## ☁️ Deployment (GitHub Pages)

The web app is a static export deployed by GitHub Actions ([`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)) on every push to `main`. To deploy your own fork:

1. Enable **Settings → Pages → Source: GitHub Actions**.
2. Push to `main`. The workflow builds `frontend/` (with `NEXT_PUBLIC_BASE_PATH=/<repo>`) and publishes `frontend/out`.

## 🧪 Tests

```bash
# Python (interval-aware analysis + fuse parity)
uv run pytest            # or: python -m pytest test_intervals.py test_core.py

# TypeScript engine sanity checks
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

- Price data via the [Sourceful Price API](https://docs.sourceful.energy/developer/price-api) (ENTSO-E wrapper)
- Built for the Swedish solar community by [Sourceful Energy](https://sourceful.energy)
```
