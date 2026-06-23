// SMHI STRÅNG client — historical solar irradiance for a point, straight from the browser.
//
// STRÅNG is SMHI's mesoscale solar-radiation *model* (a hindcast that assimilates satellite
// cloud observations + atmospheric data), not raw ground measurements. It covers the Nordic
// region on a ~2.5 km grid, hourly, back to 1999. The open API sends `Access-Control-Allow-
// Origin: *`, so we can call it directly from the static site (no key, no backend).
//
// We only send a position (lat/lon), a date range, and which radiation parameter we want —
// none of the user's production/price data leaves the browser.

const STRANG_BASE =
  "https://opendata-download-metanalys.smhi.se/api/category/strang1g/version/1/geotype/point";

/** Parameter 118 = global (horizontal) radiation, the relevant one for PV potential. */
export const STRANG_PARAM_GLOBAL = 118;

export interface StrangPoint {
  /** Sample time (ms since epoch). Values are instantaneous at the full hour, UTC. */
  time: number;
  /** Global horizontal irradiance in W/m². */
  wm2: number;
}

/** Rough bounds of STRÅNG's Nordic coverage — used to warn before a request. */
export function withinStrangCoverage(lat: number, lon: number): boolean {
  return lat >= 52 && lat <= 72 && lon >= 2 && lon <= 40;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Fetch hourly global horizontal irradiance (W/m²) for a point and date range.
 * Dates are inclusive day bounds (YYYY-MM-DD), as STRÅNG expects.
 */
export async function fetchStrangGlobalRadiation(
  lat: number,
  lon: number,
  fromMs: number,
  toMs: number,
  opts: { signal?: AbortSignal } = {}
): Promise<StrangPoint[]> {
  const lonR = Math.round(lon * 1e4) / 1e4;
  const latR = Math.round(lat * 1e4) / 1e4;
  const url =
    `${STRANG_BASE}/lon/${lonR}/lat/${latR}/parameter/${STRANG_PARAM_GLOBAL}/data.json` +
    `?from=${isoDay(fromMs)}&to=${isoDay(toMs)}`;
  const res = await fetch(url, { signal: opts.signal });
  if (!res.ok) throw new Error(`SMHI STRÅNG svarade ${res.status} (${res.statusText}).`);
  const data: Array<{ date_time: string; value: number }> = await res.json();
  return data
    .map((d) => ({ time: Date.parse(d.date_time), wm2: d.value }))
    .filter((d) => Number.isFinite(d.time) && Number.isFinite(d.wm2));
}

/**
 * Integrate hourly W/m² samples into total kWh/m² over the series. Each hourly sample is
 * treated as the average power for that hour, so energy ≈ Σ (W/m²) × 1 h / 1000.
 */
export function irradianceKwhPerM2(points: StrangPoint[]): number {
  return points.reduce((sum, p) => sum + p.wm2 / 1000, 0);
}

/**
 * Build a set of "exportable" (sunlit) hour keys from STRÅNG points: every hour with
 * irradiance > 0. STRÅNG timestamps are UTC; the analysis works in Europe/Stockholm
 * wall-clock, so each point is converted to a local "YYYY-MM-DDTHH" key (matching how the
 * engine keys price intervals). Used to average the daily spot price over only the hours the
 * sun is actually up — i.e. when you could export.
 */
export function sunlitHourKeysStockholm(points: StrangPoint[]): Set<string> {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const keys = new Set<string>();
  for (const p of points) {
    if (!(p.wm2 > 0)) continue;
    const parts = fmt.formatToParts(new Date(p.time));
    const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
    let h = get("hour");
    if (h === "24") h = "00"; // some locales emit 24 for midnight
    keys.add(`${get("year")}-${get("month")}-${get("day")}T${h}`);
  }
  return keys;
}

/**
 * Rough PV potential energy (kWh) from plane irradiation: kWh ≈ irradiation(kWh/m²) × kWp × PR.
 * Uses global *horizontal* irradiance (so it ignores panel tilt/orientation) and a default
 * performance ratio of 0.82 — an estimate, not a guarantee.
 */
export function potentialProductionKwh(kwhPerM2: number, kwp: number, performanceRatio = 0.82): number {
  return kwhPerM2 * kwp * performanceRatio;
}
