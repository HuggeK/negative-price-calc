# Negative Price Calculator — Python library & CLI

This folder holds the **Python** implementation of the electricity price / solar
production analysis. It is a feature-parity library and command-line tool kept for
**offline / scripted use** and for fetching prices from **ENTSO-E** (which the browser
can't call).

> The **deployed product** is the browser-only web app in [`../frontend`](../frontend),
> hosted on GitHub Pages. It runs the same analysis client-side in TypeScript. When you
> change analysis behaviour, do it in the TypeScript engine first (it ships) and mirror
> it here with a test — see the repo [CLAUDE.md](../CLAUDE.md).

## Layout

```
python/
├── core/                  # analysis library
│   ├── price_analyzer.py  # interval-aware analysis (overlap allocation, fuse flat-peak)
│   ├── intervals.py       # granularity helpers + 15-min resolution validation
│   ├── price_fetcher.py   # ENTSO-E fetch (needs ENTSOE_API_KEY) + SQLite cache
│   ├── db_manager.py      # SQLite cache (resolution-aware completeness check)
│   └── production_loader.py
├── cli/main.py            # `se-cli` — the primary CLI
├── main.py                # minimal alternate CLI entry point
├── app.py, run_webapp.py  # optional Flask API (NOT used by the static site)
├── utils/                 # AI explainer + CSV format helpers
├── scripts/populate_prices.py
├── static/                # assets for the optional Flask app
├── data/                  # SQLite price cache + sample production files
│   ├── price_data.db      # bundled ENTSO-E price cache
│   └── samples/           # example production files
├── pyproject.toml, uv.lock
├── Dockerfile, .dockerignore   # container for the optional Flask app
└── test_intervals.py, test_core.py
```

## Setup

Uses [uv](https://docs.astral.sh/uv/). Run everything from this `python/` folder:

```bash
cd python
uv sync
```

## CLI usage

```bash
# Primary CLI (se-cli)
uv run se-cli analyze data/samples/"Produktion exempel 15min.csv" --area SE_4 --json
uv run se-cli analyze <file> --area SE_3 --vat 25 --energy-tax 0.4282 --transmission-fee 0.25

# Minimal alternate entry point
uv run negative-price-calc --production-file <file> --area SE_4
```

Area codes accept `SE1` / `SE_1` / `SE-1` (all normalize to the same zone, SE1–SE4).

## Data resolution (15-minute / quarter-hour)

The Swedish electricity market moved to **15-minute** market time units on
**2025-10-01**. The analysis is *interval-aware* — it never assumes "one row = one hour",
so hourly and daily files still work — but **15-minute (quarter-hour) data is
recommended** to capture negative-price quarters and short export peaks.

`core.intervals.assess_resolution(index)` validates the resolution and returns an
`ok` / `warning` result with a message; both CLIs print a warning when the input
isn't 15-minute. This mirrors `assessResolution()` in the TypeScript engine.

## Tests

```bash
cd python
uv run pytest                         # or: python -m pytest test_intervals.py test_core.py
uv run black . && uv run isort .
```

- `test_intervals.py` — interval-aware analysis, fuse parity, and 15-minute resolution validation.
- `test_core.py` — import / analyzer smoke tests.

## Environment

Copy `.env.example` to `.env`:

- `ENTSOE_API_KEY` — required for fetching prices from ENTSO-E.
- `DATABASE_PATH` — optional, default `data/price_data.db` (relative to this folder).
- `OPENAI_API_KEY` — optional, enables the AI explainer / LLM-assisted CSV parsing.

## Optional Flask app (Docker)

`app.py` is an optional Flask API and is **not** used by the deployed static site.
From the repo root:

```bash
docker compose up --build        # builds ./python, serves on :8080
```

or build this folder directly:

```bash
docker build -t negative-price-calc ./   # from inside python/
```
