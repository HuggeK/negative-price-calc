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

/** Nominal interval length (minutes) per granularity — used to label "kvartar" etc. */
const GRAN_MINUTES: Record<string, number> = { "15min": 15, hourly: 60, daily: 1440, unknown: 60 };

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
  /** VAT rate, accepted as a fraction (0.25) or a percentage (25). Used by both valuations. */
  vatRate?: number;
  /** Elnätsbolag (grid): fixed förlustersättning in SEK/kWh (may be negative). */
  gridFixed?: number;
  /** Elnätsbolag (grid): variable förlustersättning as a percentage of spot (e.g. 5). */
  gridPct?: number;
  /** Elhandelsbolag (trader): fixed påslag/avdrag in SEK/kWh (may be negative). */
  traderFixed?: number;
  /** Elhandelsbolag (trader): variable påslag/avdrag as a percentage of spot. */
  traderPct?: number;
  /** Self-consumption: energy tax in SEK/kWh (avoided when self-consuming). */
  selfEnergyTax?: number;
  /** Self-consumption: grid/transmission fee in SEK/kWh (avoided when self-consuming). */
  selfGridFee?: number;
  /**
   * Self-consumption: true if your elhandel contract is priced per quarter (15-min spot).
   * true -> value self-use at the per-quarter (production-weighted) spot; false -> at the
   * period's simple average spot. Default true.
   */
  selfQuarterPrice?: boolean;
  /** Elnätsbolag fixed monthly fee in SEK/month (grid subscription; varies by fuse class). */
  gridMonthlyFee?: number;
  /** Elhandelsbolag fixed monthly fee in SEK/month. */
  traderMonthlyFee?: number;
}

/** Normalize a VAT input: 25 -> 0.25, 0.25 -> 0.25. */
function normalizeVat(v: number | undefined): number {
  if (v == null) return 0;
  return v > 1 ? v / 100 : v;
}

/**
 * Effective export price per kWh, combining both companies that pay you:
 *   spot
 *   + elnätsbolag:   gridFixed + spot·gridPct%   (förlustersättning, fast + rörlig)
 *   + elhandelsbolag: traderFixed + spot·traderPct% (påslag/avdrag, fast + rörlig)
 *   then × (1 + moms).
 * Used for the export-compensation block and as the self-consumption baseline. Affine in
 * spot, so applying it to the energy-weighted average spot equals a per-interval result.
 */
function effectiveExportPrice(spot: number, opts: AnalyzeOptions): number {
  const vat = normalizeVat(opts.vatRate);
  const gridFixed = opts.gridFixed ?? 0;
  const gridPct = opts.gridPct ?? 0;
  const traderFixed = opts.traderFixed ?? 0;
  const traderPct = opts.traderPct ?? 0;
  const beforeVat =
    spot + gridFixed + spot * (gridPct / 100) + traderFixed + spot * (traderPct / 100);
  return beforeVat * (1 + vat);
}

/** Export-compensation block (what you actually get paid), split per company. */
function analyzeExportCompensation(
  spotWavg: number,
  spotTotal: number,
  totalKwh: number,
  opts: AnalyzeOptions
): NonNullable<AnalysisResult["exportersattning"]> {
  const vat = normalizeVat(opts.vatRate);
  const gridFixed = opts.gridFixed ?? 0;
  const gridPct = opts.gridPct ?? 0;
  const traderFixed = opts.traderFixed ?? 0;
  const traderPct = opts.traderPct ?? 0;

  const elnatRorlig = spotWavg * (gridPct / 100);
  const elnatTotal = gridFixed + elnatRorlig;
  const elhandelRorlig = spotWavg * (traderPct / 100);
  const elhandelTotal = traderFixed + elhandelRorlig;

  const beforeVat = spotWavg + elnatTotal + elhandelTotal;
  const effective = beforeVat * (1 + vat);
  const effectiveTotal = effective * totalKwh;
  return {
    moms_pct: round(vat * 100, 1),
    spot_sek_per_kwh: round(spotWavg, 4),
    elnat_fast_sek_per_kwh: round(gridFixed, 4),
    elnat_pct: round(gridPct, 2),
    elnat_rorlig_sek_per_kwh: round(elnatRorlig, 4),
    elnat_total_sek_per_kwh: round(elnatTotal, 4),
    elhandel_fast_sek_per_kwh: round(traderFixed, 4),
    elhandel_pct: round(traderPct, 2),
    elhandel_rorlig_sek_per_kwh: round(elhandelRorlig, 4),
    elhandel_total_sek_per_kwh: round(elhandelTotal, 4),
    pris_innan_moms_sek_per_kwh: round(beforeVat, 4),
    effektivt_pris_sek_per_kwh: round(effective, 4),
    spot_total_sek: round(spotTotal, 2),
    effektiv_total_sek: round(effectiveTotal, 2),
    skillnad_mot_spot_sek: round(effectiveTotal - spotTotal, 2),
  };
}

/**
 * Self-consumption valuation. Value of using a kWh yourself instead of exporting it:
 *   value_self = (spot + energy_tax + grid_fee) × (1 + moms),
 * compared to the effective export compensation. "Increment vs export" is how much more
 * a self-consumed kWh is worth than an exported one.
 */
function analyzeSelfConsumption(
  realizedSpot: number,
  avgSpot: number,
  opts: AnalyzeOptions
): NonNullable<AnalysisResult["sjalvkonsumtion"]> {
  const vat = normalizeVat(opts.vatRate);
  const tax = opts.selfEnergyTax ?? 0;
  const fee = opts.selfGridFee ?? 0;
  const quarter = opts.selfQuarterPrice !== false; // default true
  // With quarter pricing the avoided purchase is the per-quarter spot (≈ production-weighted,
  // since self-use happens while producing); otherwise it's the period's average spot.
  const selfSpot = quarter ? realizedSpot : avgSpot;
  const valueSelf = (selfSpot + tax + fee) * (1 + vat);
  // Export is always realized at the quarter you export (production-weighted spot).
  const exportValue = effectiveExportPrice(realizedSpot, opts);
  return {
    moms_pct: round(vat * 100, 1),
    kvartpris: quarter,
    spot_sek_per_kwh: round(selfSpot, 4),
    energiskatt_sek_per_kwh: round(tax, 4),
    natavgift_sek_per_kwh: round(fee, 4),
    varde_self_sek_per_kwh: round(valueSelf, 4),
    export_varde_sek_per_kwh: round(exportValue, 4),
    okning_vs_export_sek_per_kwh: round(valueSelf - exportValue, 4),
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

  const zeroAcc = (): MonthAcc => ({
    production_kwh: 0,
    revenue_sek: 0,
    priceTimesHours: 0,
    hours: 0,
    negative_hours: 0,
    negative_kwh: 0,
    negative_value_sek: 0,
  });

  const months = new Map<string, MonthAcc>();
  const getMonth = (ms: number): MonthAcc => {
    const k = monthKey(ms);
    let m = months.get(k);
    if (!m) {
      m = zeroAcc();
      months.set(k, m);
    }
    return m;
  };

  const days = new Map<string, MonthAcc>();
  const getDay = (ms: number): MonthAcc => {
    const k = dateStr(ms);
    let d = days.get(k);
    if (!d) {
      d = zeroAcc();
      days.set(k, d);
    }
    return d;
  };

  // Effective export price per kWh for a given spot, using the configured offsets
  // (förlustersättning % + fast påslag/avdrag, then VAT). A quarter is "exported at a
  // loss" when this is below zero — you pay to export. Records each such segment.
  const vatFrac = normalizeVat(opts.vatRate);
  const totalPctFrac = ((opts.gridPct ?? 0) + (opts.traderPct ?? 0)) / 100;
  const totalFixed = (opts.gridFixed ?? 0) + (opts.traderFixed ?? 0);
  const effPrice = (spot: number) => (spot + spot * totalPctFrac + totalFixed) * (1 + vatFrac);

  interface LossSeg {
    start: number;
    spot: number;
    eff: number;
    kwh: number;
    loss: number; // positive money paid (SEK)
  }
  const lossSegs: LossSeg[] = [];
  let lossKwh = 0;
  let lossSek = 0;
  const lossByDay = new Map<string, number>();

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
      const d = getDay(p.start);
      m.production_kwh += energy;
      m.revenue_sek += value;
      m.priceTimesHours += q.sekPerKwh * hours;
      m.hours += hours;
      d.production_kwh += energy;
      d.revenue_sek += value;
      d.priceTimesHours += q.sekPerKwh * hours;
      d.hours += hours;

      if (q.sekPerKwh < 0) {
        negKwh += energy;
        negValueSek += value; // negative
        if (energy > 0) negProducingHours += hours;
        m.negative_kwh += energy;
        m.negative_value_sek += value;
        if (energy > 0) m.negative_hours += hours;
        d.negative_kwh += energy;
        d.negative_value_sek += value;
        if (energy > 0) d.negative_hours += hours;
      }

      // Quarters exported at a loss: effective price below zero while exporting.
      if (energy > 0) {
        const eff = effPrice(q.sekPerKwh);
        if (eff < 0) {
          const segStart = Math.max(p.start, q.start);
          const lossAbs = -(energy * eff); // positive money paid
          lossSegs.push({ start: segStart, spot: q.sekPerKwh, eff, kwh: energy, loss: lossAbs });
          lossKwh += energy;
          lossSek += lossAbs;
          const d = dateStr(segStart);
          lossByDay.set(d, (lossByDay.get(d) ?? 0) + lossAbs);
        }
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

  const daily = [...days.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, d]) => ({
      date,
      production_kwh: round(d.production_kwh, 3),
      revenue_sek: round(d.revenue_sek, 2),
      negative_kwh: round(d.negative_kwh, 3),
      negative_value_sek: round(d.negative_value_sek, 2),
    }));

  // Monthly forecast: for each month with FULL data coverage, project what to expect.
  // Effective compensation aggregates affinely from the month's spot revenue and energy;
  // net subtracts the fixed monthly fees (elnät subscription + elhandel monthly fee).
  const gridMonthlyFee = opts.gridMonthlyFee ?? 0;
  const traderMonthlyFee = opts.traderMonthlyFee ?? 0;
  const fixedMonthly = gridMonthlyFee + traderMonthlyFee;
  const fullMonths = [...months.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, mm]) => {
      const [y, mo] = period.split("-").map(Number);
      const firstOfMonth = Date.UTC(y, mo - 1, 1);
      const firstOfNext = Date.UTC(y, mo, 1);
      const complete = prodStart <= firstOfMonth && prodEnd >= firstOfNext;
      const effective = (1 + vatFrac) * ((1 + totalPctFrac) * mm.revenue_sek + totalFixed * mm.production_kwh);
      return { period, complete, production_kwh: mm.production_kwh, effective, net: effective - fixedMonthly };
    })
    .filter((m) => m.complete);

  const manads_prognos =
    fullMonths.length > 0
      ? {
          fullstandiga_manader: fullMonths.length,
          elnat_avgift_sek_per_man: round(gridMonthlyFee, 2),
          elhandel_avgift_sek_per_man: round(traderMonthlyFee, 2),
          fasta_avgifter_sek_per_man: round(fixedMonthly, 2),
          manader: fullMonths.map((m) => ({
            period: m.period,
            production_kwh: round(m.production_kwh, 1),
            effektiv_ersattning_sek: round(m.effective, 2),
            fasta_avgifter_sek: round(fixedMonthly, 2),
            netto_sek: round(m.net, 2),
          })),
          snitt_production_kwh: round(fullMonths.reduce((s, m) => s + m.production_kwh, 0) / fullMonths.length, 1),
          snitt_effektiv_ersattning_sek: round(fullMonths.reduce((s, m) => s + m.effective, 0) / fullMonths.length, 2),
          snitt_netto_sek: round(fullMonths.reduce((s, m) => s + m.net, 0) / fullMonths.length, 2),
        }
      : undefined;

  const natanslutning =
    opts.fuseAmps && opts.fuseAmps > 0
      ? analyzeFusePeaks(sortedProd, opts.fuseAmps, opts.voltage ?? 400)
      : undefined;

  // Quarters exported at a loss (effective price < 0), with the spot break-even threshold,
  // a daily loss series for charting, and the worst occasions for a table.
  const segMinutes = Math.min(
    GRAN_MINUTES[opts.productionGranularity ?? "unknown"] ?? 60,
    GRAN_MINUTES[opts.priceGranularity ?? "unknown"] ?? 60
  );
  const breakEvenSpot = 1 + totalPctFrac !== 0 ? -totalFixed / (1 + totalPctFrac) : 0;
  const forlust_export =
    lossSegs.length > 0
      ? {
          antal: lossSegs.length,
          intervall_minuter: segMinutes,
          troskel_spot_sek_per_kwh: round(breakEvenSpot, 4),
          total_kwh: round(lossKwh, 3),
          total_forlust_sek: round(lossSek, 2),
          poster: [...lossSegs]
            .sort((a, b) => b.loss - a.loss)
            .slice(0, 50)
            .map((s) => ({
              start: new Date(s.start).toISOString(),
              spot_sek_per_kwh: round(s.spot, 4),
              effektivt_pris_sek_per_kwh: round(s.eff, 4),
              kwh: round(s.kwh, 3),
              forlust_sek: round(s.loss, 2),
            })),
          serie: [...lossByDay.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([date, loss]) => ({ date, forlust_sek: round(loss, 2) })),
        }
      : undefined;

  const hasExportInputs =
    opts.vatRate != null ||
    opts.gridFixed != null ||
    opts.gridPct != null ||
    opts.traderFixed != null ||
    opts.traderPct != null;
  const exportersattning =
    hasExportInputs && totalMatchedKwh > 0
      ? analyzeExportCompensation(realizedPrice, revenueSek, totalMatchedKwh, opts)
      : undefined;

  const hasSelfInputs = opts.selfEnergyTax != null || opts.selfGridFee != null;
  const sjalvkonsumtion =
    hasSelfInputs && totalMatchedKwh > 0
      ? analyzeSelfConsumption(realizedPrice, avgPrice, opts)
      : undefined;

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
    aggregates: { monthly, daily },
    manads_prognos,
    exportersattning,
    sjalvkonsumtion,
    forlust_export,
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
