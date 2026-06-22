// Interval-aware analysis engine (pure, browser-safe, no React/Next imports so it can
// be unit-tested directly with `node --experimental-strip-types`).
//
// The core idea: production and prices may have *different* resolutions (e.g. hourly
// production vs. 15-minute prices after the 2025-10-01 market switch, or daily production
// vs. hourly prices). Instead of assuming "one row == one hour", every production interval
// is allocated to the price interval(s) it overlaps, proportional to the overlap duration.
// This makes the whole calculation correct for ANY mix of granularities.

import type { AnalysisResult, Granularity, PriceInterval, ProductionInterval } from "./types";

const MS_PER_HOUR = 3_600_000;

function monthKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7); // YYYY-MM (wall-clock)
}

function dateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

interface MonthAcc {
  production_kwh: number;
  revenue_sek: number;
  priceTimesHours: number;
  hours: number;
  negative_hours: number;
  negative_kwh: number;
  negative_value_sek: number;
}

export interface AnalyzeOptions {
  productionGranularity?: Granularity;
  priceGranularity?: Granularity;
  /** Main fuse rating in amperes (huvudsäkring). Enables grid-connection peak analysis. */
  fuseAmps?: number;
  /** Line voltage for the power calculation (default 400 V, Swedish 3-phase). */
  voltage?: number;
  /** VAT rate, accepted as a fraction (0.25) or a percentage (25). */
  vatRate?: number;
  /** Energy tax in SEK/kWh (avoided when self-consuming). */
  energyTax?: number;
  /** Grid transmission fee in SEK/kWh (avoided when self-consuming). */
  transmissionFee?: number;
}

/** Normalize a VAT input: 25 -> 0.25, 0.25 -> 0.25. */
function normalizeVat(v: number | undefined): number {
  if (v == null) return 0;
  return v > 1 ? v / 100 : v;
}

/**
 * Self-consumption valuation (payment/VAT settings). Mirrors the CLI model:
 * value of using a kWh yourself = (spot + energy_tax + transmission_fee) * (1+VAT),
 * while exporting it is valued at the spot price only. The "increment vs export" is
 * therefore how much more a self-consumed kWh is worth than an exported one.
 */
function analyzeSelfConsumption(
  spotWavg: number,
  opts: AnalyzeOptions
): NonNullable<AnalysisResult["sjalvkonsumtion"]> {
  const vat = normalizeVat(opts.vatRate);
  const tax = opts.energyTax ?? 0;
  const fee = opts.transmissionFee ?? 0;
  const spotGross = spotWavg * (1 + vat);
  const avoided = (tax + fee) * (1 + vat);
  const valueSelf = spotGross + avoided;
  return {
    vat_pct: round(vat * 100, 1),
    energiskatt_sek_per_kwh: round(tax, 4),
    natavgift_sek_per_kwh: round(fee, 4),
    varde_self_sek_per_kwh: round(valueSelf, 4),
    spot_netto_sek_per_kwh: round(spotWavg, 4),
    spot_brutto_sek_per_kwh: round(spotGross, 4),
    undvikna_avgifter_sek_per_kwh: round(avoided, 4),
    okning_vs_export_sek_per_kwh: round(valueSelf - spotWavg, 4),
  };
}

/** Maxed-out threshold: count time at/above 98% of the fuse limit as a "flat peak". */
const MAXED_FRACTION = 0.98;
/** √3, for 3-phase power P = √3 · U · I. */
const SQRT3 = Math.sqrt(3);

/**
 * Grid-connection peak analysis: how much time export power sat at the main-fuse
 * limit (visible as flat-topped "peaks" in the curve). Computed from each production
 * interval's average power = energy / duration, so 15-minute data catches short
 * clipping peaks that hourly data averages away.
 */
function analyzeFusePeaks(
  production: ProductionInterval[],
  fuseAmps: number,
  voltage: number
): NonNullable<AnalysisResult["natanslutning"]> {
  const limitKw = (SQRT3 * voltage * fuseAmps) / 1000;
  const threshold = limitKw * MAXED_FRACTION;

  let hoursAtMax = 0;
  let energyAtMax = 0;
  let peakKw = 0;
  let peaks = 0;
  let totalHours = 0;

  for (const p of production) {
    const hours = (p.end - p.start) / MS_PER_HOUR;
    if (hours <= 0) continue;
    totalHours += hours;
    const powerKw = p.kwh / hours;
    if (powerKw > peakKw) peakKw = powerKw;
    if (powerKw >= threshold) {
      hoursAtMax += hours;
      energyAtMax += p.kwh;
      peaks += 1;
    }
  }

  return {
    sakring_amp: fuseAmps,
    sakring_kw: round(limitKw, 2),
    hogsta_effekt_kw: round(peakKw, 2),
    timmar_vid_max: round(hoursAtMax, 2),
    andel_tid_vid_max_pct: round(totalHours > 0 ? (hoursAtMax / totalHours) * 100 : 0, 1),
    energi_vid_max_kwh: round(energyAtMax, 2),
    antal_toppar: peaks,
  };
}

export function analyze(
  production: ProductionInterval[],
  prices: PriceInterval[],
  opts: AnalyzeOptions = {}
): AnalysisResult {
  if (production.length === 0) throw new Error("Ingen produktionsdata att analysera.");
  if (prices.length === 0)
    throw new Error("Inga elpriser kunde hämtas för den valda perioden och elområdet.");

  const sortedProd = [...production].sort((a, b) => a.start - b.start);
  const sortedPrice = [...prices].sort((a, b) => a.start - b.start);

  let totalMatchedKwh = 0;
  let totalProductionKwh = 0;
  let revenueSek = 0;
  let priceTimesHours = 0; // for duration-weighted average price during production
  let coveredHours = 0; // production hours that had price coverage
  let producingHours = 0; // covered hours with energy > 0
  let negKwh = 0;
  let negValueSek = 0;
  let negProducingHours = 0; // hours where price < 0 AND exporting

  const months = new Map<string, MonthAcc>();
  const getMonth = (ms: number): MonthAcc => {
    const k = monthKey(ms);
    let m = months.get(k);
    if (!m) {
      m = {
        production_kwh: 0,
        revenue_sek: 0,
        priceTimesHours: 0,
        hours: 0,
        negative_hours: 0,
        negative_kwh: 0,
        negative_value_sek: 0,
      };
      months.set(k, m);
    }
    return m;
  };

  // Sweep: lo is the first price interval that could overlap the current production row.
  let lo = 0;
  for (const p of sortedProd) {
    totalProductionKwh += p.kwh;
    const span = p.end - p.start;
    if (span <= 0) continue;

    while (lo < sortedPrice.length && sortedPrice[lo].end <= p.start) lo++;

    for (let j = lo; j < sortedPrice.length && sortedPrice[j].start < p.end; j++) {
      const q = sortedPrice[j];
      const overlapMs = Math.min(p.end, q.end) - Math.max(p.start, q.start);
      if (overlapMs <= 0) continue;

      const fraction = overlapMs / span;
      const energy = p.kwh * fraction; // kWh allocated to this price interval
      const hours = overlapMs / MS_PER_HOUR;
      const value = energy * q.sekPerKwh;

      totalMatchedKwh += energy;
      revenueSek += value;
      priceTimesHours += q.sekPerKwh * hours;
      coveredHours += hours;
      if (energy > 0) producingHours += hours;

      const m = getMonth(p.start);
      m.production_kwh += energy;
      m.revenue_sek += value;
      m.priceTimesHours += q.sekPerKwh * hours;
      m.hours += hours;

      if (q.sekPerKwh < 0) {
        negKwh += energy;
        negValueSek += value; // negative
        if (energy > 0) negProducingHours += hours;
        m.negative_kwh += energy;
        m.negative_value_sek += value;
        if (energy > 0) m.negative_hours += hours;
      }
    }
  }

  // Total hours where the market price was negative across the covered range (regardless
  // of whether we were producing) — informative "negativa timmar totalt".
  const prodStart = sortedProd[0].start;
  const prodEnd = sortedProd[sortedProd.length - 1].end;
  let negativeHoursTotal = 0;
  for (const q of sortedPrice) {
    if (q.sekPerKwh >= 0) continue;
    const overlapMs = Math.min(prodEnd, q.end) - Math.max(prodStart, q.start);
    if (overlapMs > 0) negativeHoursTotal += overlapMs / MS_PER_HOUR;
  }

  const realizedPrice = totalMatchedKwh > 0 ? revenueSek / totalMatchedKwh : 0;
  const avgPrice = coveredHours > 0 ? priceTimesHours / coveredHours : 0;
  const timingLossPct = avgPrice !== 0 ? ((avgPrice - realizedPrice) / avgPrice) * 100 : 0;

  const monthly = [...months.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, m]) => ({
      period,
      production_kwh: round(m.production_kwh, 3),
      revenue_sek: round(m.revenue_sek, 2),
      avg_price_sek_per_kwh: round(m.hours > 0 ? m.priceTimesHours / m.hours : 0, 4),
      negative_hours: round(m.negative_hours, 2),
      negative_kwh: round(m.negative_kwh, 3),
      negative_value_sek: round(m.negative_value_sek, 2),
    }));

  const natanslutning =
    opts.fuseAmps && opts.fuseAmps > 0
      ? analyzeFusePeaks(sortedProd, opts.fuseAmps, opts.voltage ?? 400)
      : undefined;

  const hasCostInputs =
    opts.vatRate != null || opts.energyTax != null || opts.transmissionFee != null;
  const sjalvkonsumtion =
    hasCostInputs && totalMatchedKwh > 0 ? analyzeSelfConsumption(realizedPrice, opts) : undefined;

  return {
    hero: {
      produktion: {
        total_kwh: round(totalMatchedKwh, 2),
        totala_intakter_sek: round(revenueSek, 2),
        genomsnittspris_erhållet_sek_per_kwh: round(realizedPrice, 4),
        enkelt_snitt_pris_sek_per_kwh: round(avgPrice, 4),
        timing_förlust_pct: round(timingLossPct, 1),
      },
      export_förluster: {
        timmar_som_kostat_dig: round(negProducingHours, 2),
        kwh_exporterat_med_förlust: round(negKwh, 3),
        andel_olönsam_export_pct: round(totalMatchedKwh > 0 ? (negKwh / totalMatchedKwh) * 100 : 0, 1),
        kostnad_negativ_export_sek: round(Math.abs(negValueSek), 2),
      },
      tidsanalys: {
        totala_timmar: round(coveredHours, 2),
        produktionstimmar: round(producingHours, 2),
        negativa_timmar_totalt: round(negativeHoursTotal, 2),
        negativa_timmar_under_produktion: round(negProducingHours, 2),
      },
    },
    input: {
      date_range: { start: dateStr(prodStart), end: dateStr(prodEnd) },
      granularity: opts.productionGranularity ?? "unknown",
    },
    aggregates: { monthly },
    sjalvkonsumtion,
    natanslutning,
    meta: {
      price_granularity: opts.priceGranularity ?? "unknown",
      price_intervals: sortedPrice.length,
      production_intervals: sortedProd.length,
      matched_kwh_pct: round(totalProductionKwh > 0 ? (totalMatchedKwh / totalProductionKwh) * 100 : 0, 1),
    },
  };
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}
