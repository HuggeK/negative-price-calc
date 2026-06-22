# Quick Start Guide

## Just use it — no install

The app runs entirely in your browser. Open it on GitHub Pages:

**👉 https://huggek.github.io/negative-price-calc/**

1. Upload your solar export file (CSV — hourly, 15-minute or daily).
2. Pick your bidding zone (SE1–SE4).
3. (Optional) set your main fuse size and VAT / energy-tax / grid-fee, and toggle the AI summary.
4. Click **Analysera** — the report appears right in the browser. Download it as JSON or CSV.

Nothing is uploaded to a server: parsing, price-matching and analysis all happen on your device. Prices come from the free [elprisetjustnu.se API](https://www.elprisetjustnu.se/elpris-api) (no key required), credited as the source in the app.

No file of your own? Try one from [`data/samples/`](data/samples/).

## Optional: AI summary

Toggle **AI-sammanfattning** and paste your own [OpenRouter](https://openrouter.ai) API key. It is stored only in your browser and used to generate a short Swedish summary client-side.

## Run the web app locally (optional)

```bash
cd frontend
npm install
npm run dev          # http://localhost:3000
```

## Use the Python CLI (optional)

```bash
uv sync
uv run se-cli analyze your_file.csv --area SE_4 --json
```

The CLI fetches prices from ENTSO-E (set `ENTSOE_API_KEY`) or uses the bundled price cache.

## Electricity areas

- **SE1**: Northern Sweden (Luleå)
- **SE2**: Central Sweden (Sundsvall)
- **SE3**: Central Sweden (Stockholm)
- **SE4**: Southern Sweden (Malmö)

## Need help?

See the full [README.md](README.md) or open an issue on GitHub.

---

Made with ❤️ for the solar energy community
