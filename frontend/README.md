# Negativa Prisanalyseraren — web app

The browser-only frontend for the Negative Price Calculator. It parses your solar
export file, fetches Swedish spot prices, and computes the whole analysis **client-side**
(no backend). Deployed as a static site to GitHub Pages.

**Live:** https://huggek.github.io/negative-price-calc/

## Develop

```bash
npm install
npm run dev      # http://localhost:3000
npm run lint
```

## Build (static export)

```bash
NEXT_PUBLIC_BASE_PATH=/negative-price-calc npm run build   # outputs ./out
```

`next.config.ts` uses `output: "export"`, so `npm run build` produces a fully static
site in `out/`. Set `NEXT_PUBLIC_BASE_PATH` to `/<repo>` for a GitHub Pages project site
(leave empty for a user/organization page or custom domain).

## Where the logic lives — `src/lib/`

- `parseProduction.ts` — CSV + Excel parsing (Swedish formats; hourly / 15-min / daily)
- `xlsx.ts` — dependency-free `.xlsx` / `.xlsm` reader (ZIP + native `DecompressionStream`)
- `prices.ts` — elprisetjustnu.se price client (no key, CORS, SEK/kWh, 15-min)
- `analyze.ts` — interval-aware analysis (overlap allocation), fuse flat-peak, export compensation + self-consumption valuation
- `aiSummary.ts` — optional Swedish AI summary via OpenRouter (user-supplied key, in-browser)

Engine sanity tests: `node --experimental-strip-types scripts/test-analyze.mjs`.

## Deploy

Pushing to `main` triggers `.github/workflows/deploy-pages.yml`, which builds this app and
publishes `out/` to GitHub Pages. UI components come from the Sourceful design system
(`@sourceful-energy/ui`) — see [CLAUDE.md](CLAUDE.md).
