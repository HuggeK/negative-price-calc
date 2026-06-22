# 🌐 Web Application

The web app is a **browser-only static site** — open it and analyze; nothing is uploaded
to a server.

**👉 https://huggek.github.io/negative-price-calc/**

## Use it

1. Upload your solar export CSV (**15-minute / quarter-hour recommended**; hourly and daily also work) — or click **Prova med exempeldata** to run a bundled 15-minute sample.
2. Choose your bidding zone (SE1–SE4).
3. (Optional) set main fuse size, VAT / energy tax / grid fee, and the AI summary toggle (off by default).
4. Click **Analysera** — the report renders in the browser (labelled with the data resolution, kvart / 15-min); download JSON or CSV.

Prices are fetched in-browser from the free [elprisetjustnu.se API](https://www.elprisetjustnu.se/elpris-api) (no key, CORS, 15-min). The optional AI summary runs in-browser via OpenRouter with a key you provide.

## Run locally

```bash
cd frontend
npm install
npm run dev      # http://localhost:3000
```

## How it works

Everything is client-side TypeScript in `frontend/src/lib/`:

- `parseProduction.ts` — parse the CSV (Swedish formats; hourly/15-min/daily)
- `prices.ts` — fetch spot prices (elprisetjustnu.se API), already in SEK/kWh
- `analyze.ts` — interval-aware analysis: negative-price exposure, timing discount,
  grid-connection flat peaks (main fuse), export compensation (elnät förlustersättning + elhandel påslag/avdrag + VAT) and self-consumption valuation
- `aiSummary.ts` — optional Swedish summary via OpenRouter

## Deploy

Static export published to GitHub Pages by `.github/workflows/deploy-pages.yml` on every
push to `main`. See [README.md](README.md) and [frontend/README.md](frontend/README.md).

> Note: the Python code now lives in [`python/`](python/). The legacy Flask UI templates have
> been removed; `python/app.py` now only exposes an optional API and is not used by the static site.
