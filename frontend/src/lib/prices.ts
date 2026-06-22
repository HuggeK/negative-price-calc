// Client-side electricity price fetching from Sourceful's Price API.
//
// Sourceful's Price API is a no-key wrapper around ENTSO-E day-ahead data:
//   GET https://mainnet.srcful.dev/price/electricity/{ZONE}?date=YYYY-MM-DD
//   -> { "prices": [ { "datetime": <tz-aware ISO>, "price": <EUR/MWh> }, ... ] }
//
// Prices are returned in EUR/MWh at absolute timestamps, so we convert each instant to
// Europe/Stockholm wall-clock (to line up with naive production timestamps) and EUR/MWh
// to SEK/kWh using an exchange rate (default matches the Python tooling).
//
// NOTE: this must be reachable with CORS from the browser; it is Sourceful's own API so
// that is expected, but verify in-browser if prices fail to load.

import type { Granularity, PriceInterval } from "./types";

const API_BASE = "https://mainnet.srcful.dev/price/electricity";
const CACHE_PREFIX = "srcful:v1:";
const CONCURRENCY = 8;
const DEFAULT_EUR_SEK = 11.5; // EUR -> SEK; ENTSO-E/Sourceful quote EUR/MWh.

export interface PriceFetchProgress {
  done: number;
  total: number;
}

interface RawPrice {
  datetime: string;
  price: number;
}

/** Map UI area codes (SE_3) and variants to Sourceful zone codes (SE3). */
export function normalizeZone(area: string): "SE1" | "SE2" | "SE3" | "SE4" {
  const m = String(area).toUpperCase().match(/SE[_-]?([1-4])/);
  if (!m) throw new Error(`Okänt elområde: ${area}`);
  return `SE${m[1]}` as "SE1" | "SE2" | "SE3" | "SE4";
}

// Convert an absolute instant to Europe/Stockholm wall-clock (ms, treated as naive local),
// matching how production timestamps are handled elsewhere.
const stockholmParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Stockholm",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function toStockholmWallClock(iso: string): number {
  const instant = Date.parse(iso); // tz-aware ISO -> absolute UTC ms
  const p: Record<string, string> = {};
  for (const part of stockholmParts.formatToParts(new Date(instant))) p[part.type] = part.value;
  const hour = p.hour === "24" ? 0 : Number(p.hour);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
}

function dateKey(d: Date): { y: number; m: string; d: string } {
  return {
    y: d.getFullYear(),
    m: String(d.getMonth() + 1).padStart(2, "0"),
    d: String(d.getDate()).padStart(2, "0"),
  };
}

/** All calendar dates (local) spanned by [startMs, endMs]. */
export function datesInRange(startMs: number, endMs: number): Date[] {
  const out: Date[] = [];
  const cur = new Date(startMs);
  cur.setHours(0, 0, 0, 0);
  const last = new Date(endMs);
  last.setHours(0, 0, 0, 0);
  while (cur.getTime() <= last.getTime()) {
    out.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function readCache(key: string): RawPrice[] | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? (JSON.parse(raw) as RawPrice[]) : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, data: RawPrice[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(data));
  } catch {
    // Quota exceeded or disabled storage — non-fatal, we just refetch next time.
  }
}

async function fetchDay(zone: string, d: Date, signal?: AbortSignal): Promise<RawPrice[]> {
  const { y, m, d: dd } = dateKey(d);
  const key = `${zone}:${y}-${m}-${dd}`;
  const cached = readCache(key);
  if (cached) return cached;

  const url = `${API_BASE}/${zone}?date=${y}-${m}-${dd}`;
  const res = await fetch(url, { signal });
  if (res.status === 404) {
    writeCache(key, []);
    return [];
  }
  if (!res.ok) throw new Error(`Prishämtning misslyckades (${res.status}) för ${y}-${m}-${dd}`);
  const data = await res.json();
  const prices: RawPrice[] = Array.isArray(data?.prices) ? data.prices : [];
  writeCache(key, prices);
  return prices;
}

/** Run async tasks with a bounded concurrency pool. */
async function pool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

export interface PriceData {
  intervals: PriceInterval[];
  granularity: Granularity;
}

/**
 * Fetch all price intervals for a zone covering [startMs, endMs] (local wall-clock).
 * One request per calendar day (cached + bounded concurrency); intervals' end times are
 * inferred from the spacing between consecutive points, so hourly and 15-minute data both work.
 */
export async function fetchPrices(
  area: string,
  startMs: number,
  endMs: number,
  opts: { signal?: AbortSignal; onProgress?: (p: PriceFetchProgress) => void; eurSek?: number } = {}
): Promise<PriceData> {
  const zone = normalizeZone(area);
  const eurSek = opts.eurSek ?? DEFAULT_EUR_SEK;
  const days = datesInRange(startMs, endMs);
  const perDay: RawPrice[][] = new Array(days.length);
  let done = 0;

  await pool(days, CONCURRENCY, async (d, idx) => {
    perDay[idx] = await fetchDay(zone, d, opts.signal);
    done += 1;
    opts.onProgress?.({ done, total: days.length });
  });

  // Flatten to (start, price) points, convert units/timezone, sort and de-duplicate.
  const points: Array<{ start: number; eurPerKwh: number }> = [];
  for (const day of perDay) {
    for (const p of day) {
      if (p == null || p.datetime == null || p.price == null) continue;
      points.push({ start: toStockholmWallClock(p.datetime), eurPerKwh: Number(p.price) / 1000 });
    }
  }
  points.sort((a, b) => a.start - b.start);
  const unique = points.filter((p, i) => i === 0 || p.start !== points[i - 1].start);

  // Infer the median step to bound the last interval's end.
  const diffs: number[] = [];
  for (let i = 1; i < unique.length; i++) diffs.push(unique[i].start - unique[i - 1].start);
  diffs.sort((a, b) => a - b);
  const stepMs = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 3_600_000;

  const intervals: PriceInterval[] = unique.map((p, i) => ({
    start: p.start,
    end: i + 1 < unique.length ? unique[i + 1].start : p.start + stepMs,
    eurPerKwh: p.eurPerKwh,
    sekPerKwh: p.eurPerKwh * eurSek,
  }));

  return { intervals, granularity: detectGranularity(intervals) };
}

/** Detect granularity from the median interval length. */
export function detectGranularity(intervals: { start: number; end: number }[]): Granularity {
  if (intervals.length === 0) return "unknown";
  const mins = intervals
    .map((i) => (i.end - i.start) / 60000)
    .filter((m) => m > 0)
    .sort((a, b) => a - b);
  if (mins.length === 0) return "unknown";
  const med = mins[Math.floor(mins.length / 2)];
  if (med <= 20) return "15min";
  if (med <= 90) return "hourly";
  return "daily";
}
