// Shared types for the in-browser electricity price / production analysis.
// Everything runs client-side so the tool can be served statically (GitHub Pages).

/** A single price interval. Times are local Europe/Stockholm wall-clock. */
export interface PriceInterval {
  /** Local wall-clock start (ms since epoch, treated as naive local time). */
  start: number;
  /** Local wall-clock end (exclusive). */
  end: number;
  /** Price in SEK per kWh. */
  sekPerKwh: number;
  /** Price in EUR per kWh (kept for reference). */
  eurPerKwh: number;
}

/** A single production interval read from the user's file. */
export interface ProductionInterval {
  /** Local wall-clock start (ms since epoch, treated as naive local time). */
  start: number;
  /** Local wall-clock end (exclusive). */
  end: number;
  /** Exported / produced energy in kWh during this interval. */
  kwh: number;
}

export type Granularity = "15min" | "hourly" | "daily" | "unknown";

export interface ParsedProduction {
  rows: ProductionInterval[];
  granularity: Granularity;
  /** Median interval length in minutes (used to detect granularity). */
  stepMinutes: number;
  /** % of consecutive intervals whose spacing equals the dominant step (data regularity). */
  stepConsistencyPct: number;
  datetimeColumn: string;
  productionColumn: string;
}

/** Result object shaped to match the existing <AnalysisResults> component. */
export interface AnalysisResult {
  hero: {
    produktion: {
      total_kwh: number;
      totala_intakter_sek: number;
      genomsnittspris_erhållet_sek_per_kwh: number;
      enkelt_snitt_pris_sek_per_kwh: number;
      timing_förlust_pct: number;
    };
    export_förluster: {
      timmar_som_kostat_dig: number;
      kwh_exporterat_med_förlust: number;
      andel_olönsam_export_pct: number;
      kostnad_negativ_export_sek: number;
    };
    tidsanalys: {
      totala_timmar: number;
      produktionstimmar: number;
      negativa_timmar_totalt: number;
      negativa_timmar_under_produktion: number;
    };
  };
  input: {
    date_range: { start: string; end: string };
    granularity: Granularity;
  };
  aggregates: {
    monthly: Array<{
      period: string;
      production_kwh: number;
      revenue_sek: number;
      avg_price_sek_per_kwh: number;
      negative_hours: number;
      negative_kwh: number;
      negative_value_sek: number;
    }>;
  };
  /** Self-consumption valuation (payment/VAT settings). Present when any cost input is given. */
  sjalvkonsumtion?: {
    vat_pct: number;
    energiskatt_sek_per_kwh: number;
    natavgift_sek_per_kwh: number;
    varde_self_sek_per_kwh: number;
    spot_netto_sek_per_kwh: number;
    spot_brutto_sek_per_kwh: number;
    undvikna_avgifter_sek_per_kwh: number;
    okning_vs_export_sek_per_kwh: number;
  };
  /** Grid-connection (main fuse) peak analysis. Only present when a fuse size is given. */
  natanslutning?: {
    sakring_amp: number;
    sakring_kw: number;
    hogsta_effekt_kw: number;
    timmar_vid_max: number;
    andel_tid_vid_max_pct: number;
    energi_vid_max_kwh: number;
    antal_toppar: number;
  };
  meta: {
    price_granularity: Granularity;
    price_intervals: number;
    production_intervals: number;
    matched_kwh_pct: number;
  };
}
