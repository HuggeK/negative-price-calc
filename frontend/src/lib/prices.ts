// Client-side electricity price fetching from elprisetjustnu.se.
//
// Why this source: it is free, requires no API key, sends `Access-Control-Allow-Origin: *`
// (so it works directly from a static GitHub Pages site), serves the four Swedish bidding
// zones, and natively returns 15-minute resolution for dates on/after 2025-10-01 (and
// hourly before that). The Sourceful price API was decommissioned.
//
// Endpoint: https://www.elprisetjustnu.se/api/v1/prices/{YYYY}/{MM}-{DD}_{ZONE}.json
// Returns: [{ SEK_per_kWh, EUR_per_kWh, EXR, time_start, time_end }, ...]

import type { Granularity, PriceInterval } from "./types";

const API_BASE = "https://www.elprisetjustnu.se/api/v1/prices";
const CACHE_PREFIX = "elpris:v1:";
const CONCURRENCY = 8;

export interface PriceFetchProgress {
  done: number;
  total: number;
}

interface RawPrice {
  SEK_per_kWh: number;
  EUR_per_kWh: number;
  EXR: number;
  time_start: string;
  time_end: string;
}

/** Map UI area codes (SE_3) and variants to elprisetjustnu zone codes (SE3). */
export function normalizeZone(area: string): "SE1" | "SE2" | "SE3" | "SE4" {
  const m = String(area).toUpperCase().match(/SE[_-]?([1-4])/);
  if (!m) throw new Error(`Okänt elområde: ${area}`);
  return `SE${m[1]}` as "SE1" | "SE2" | "SE3" | "SE4";
}

/**
 * Parse an ISO timestamp that carries an offset (e.g. "2025-11-03T00:00:00+01:00")
 * into a local Europe/Stockholm wall-clock number. We deliberately drop the offset
 * and treat the wall-clock components as the canonical key, because production files
 * are naive local time. This mirrors the original tool's tz-naive Stockholm handling.
 */
function localWallClock(iso: string): number {
  // Take the "YYYY-MM-DDTHH:mm:ss" part and interpret it as UTC for stable arithmetic.
  const naive = iso.slice(0, 19);
  return Date.parse(naive + "Z");
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

  const url = `${API_BASE}/${y}/${m}-${dd}_${zone}.json`;
  const res = await fetch(url, { signal });
  if (res.status === 404) {
    // No data for this date (future date or before coverage). Treat as empty.
    writeCache(key, []);
    return [];
  }
  if (!res.ok) throw new Error(`Prishämtning misslyckades (${res.status}) för ${y}-${m}-${dd}`);
  const data = (await res.json()) as RawPrice[];
  writeCache(key, data);
  return data;
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
 * Fetches one request per calendar day (with cache + bounded concurrency) and flattens.
 */
export async function fetchPrices(
  area: string,
  startMs: number,
  endMs: number,
  opts: { signal?: AbortSignal; onProgress?: (p: PriceFetchProgress) => void } = {}
): Promise<PriceData> {
  const zone = normalizeZone(area);
  const days = datesInRange(startMs, endMs);
  const perDay: RawPrice[][] = new Array(days.length);
  let done = 0;

  await pool(days, CONCURRENCY, async (d, idx) => {
    perDay[idx] = await fetchDay(zone, d, opts.signal);
    done += 1;
    opts.onProgress?.({ done, total: days.length });
  });

  const intervals: PriceInterval[] = [];
  for (const day of perDay) {
    for (const p of day) {
      intervals.push({
        start: localWallClock(p.time_start),
        end: localWallClock(p.time_end),
        sekPerKwh: p.SEK_per_kWh,
        eurPerKwh: p.EUR_per_kWh,
      });
    }
  }
  intervals.sort((a, b) => a.start - b.start);

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
