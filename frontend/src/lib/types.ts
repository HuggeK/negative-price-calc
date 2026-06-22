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
  /** Per-interval (15-minute) producing series, for CSV/JSON export. */
  series: Array<{
    start: string;
    production_kwh: number;
    spot_sek_per_kwh: number;
    effektivt_pris_sek_per_kwh: number;
    varde_sek: number;
  }>;
  /** Echo of the settings used (display units), attached by the UI for export/display. */
  parametrar?: {
    elomrade?: string;
    huvudsakring_a?: string;
    moms_pct?: string;
    elnat_fast_ore_per_kwh?: string;
    elnat_rorlig_pct?: string;
    elhandel_fast_ore_per_kwh?: string;
    elhandel_rorlig_pct?: string;
    elnat_manadsavgift_kr?: string;
    elhandel_manadsavgift_kr?: string;
    energiskatt_ore_per_kwh?: string;
    natavgift_ore_per_kwh?: string;
    kvartspris_elhandel?: boolean;
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
    /** Per-day aggregation (higher-resolution chart). */
    daily: Array<{
      date: string;
      production_kwh: number;
      revenue_sek: number;
      negative_kwh: number;
      negative_value_sek: number;
    }>;
  };
  /**
   * Monthly forecast over months with full data coverage — "what to expect" per month:
   * effective export compensation minus the fixed monthly fees, plus averages.
   */
  manads_prognos?: {
    antal_manader: number;
    fullstandiga_manader: number;
    elnat_avgift_sek_per_man: number;
    elhandel_avgift_sek_per_man: number;
    fasta_avgifter_sek_per_man: number;
    manader: Array<{
      period: string;
      /** True if the month had full data; false if scaled up from a partial month. */
      complete: boolean;
      dagar_med_data: number;
      dagar_i_manad: number;
      production_kwh: number;
      effektiv_ersattning_sek: number;
      fasta_avgifter_sek: number;
      netto_sek: number;
    }>;
    snitt_production_kwh: number;
    snitt_effektiv_ersattning_sek: number;
    snitt_netto_sek: number;
  };
  /**
   * Effective export compensation: what you actually get paid for exported energy.
   * Model: (spot + förlustersättning[% av spot] + fast påslag/avdrag) × (1 + moms).
   * Present when any export-compensation setting (fixed / loss% / VAT) is given.
   */
  exportersattning?: {
    moms_pct: number;
    spot_sek_per_kwh: number;
    /** Elnätsbolag (grid): fixed + variable (% of spot) förlustersättning. */
    elnat_fast_sek_per_kwh: number;
    elnat_pct: number;
    elnat_rorlig_sek_per_kwh: number;
    elnat_total_sek_per_kwh: number;
    /** Elhandelsbolag (trader): fixed + variable (% of spot) påslag/avdrag. */
    elhandel_fast_sek_per_kwh: number;
    elhandel_pct: number;
    elhandel_rorlig_sek_per_kwh: number;
    elhandel_total_sek_per_kwh: number;
    pris_innan_moms_sek_per_kwh: number;
    effektivt_pris_sek_per_kwh: number;
    spot_total_sek: number;
    effektiv_total_sek: number;
    skillnad_mot_spot_sek: number;
  };
  /**
   * Self-consumption valuation: what a kWh is worth if you use it yourself instead of
   * exporting it. value_self = (spot + energiskatt + nätavgift) × (1 + moms); compared
   * to the effective export compensation. Present when energy tax / grid fee is given.
   */
  sjalvkonsumtion?: {
    moms_pct: number;
    /** True if valued at the per-quarter spot; false if at the period's average spot. */
    kvartpris: boolean;
    spot_sek_per_kwh: number;
    energiskatt_sek_per_kwh: number;
    natavgift_sek_per_kwh: number;
    varde_self_sek_per_kwh: number;
    export_varde_sek_per_kwh: number;
    okning_vs_export_sek_per_kwh: number;
    /** Per-month saving from self-consuming vs exporting, on the actual production. */
    manader: Array<{
      period: string;
      production_kwh: number;
      varde_self_sek_per_kwh: number;
      export_varde_sek_per_kwh: number;
      besparing_sek: number;
    }>;
    total_besparing_sek: number;
  };
  /**
   * Quarters exported "at a loss": the effective export price (after offsets + VAT) was
   * below zero, i.e. you paid to export. Present when any such interval exists.
   */
  forlust_export?: {
    /** Number of intervals (quarters) exported at a loss. */
    antal: number;
    /** Nominal interval length in minutes (15 = quarters). */
    intervall_minuter: number;
    /** Spot price (SEK/kWh) below which export becomes a loss, given the offsets. */
    troskel_spot_sek_per_kwh: number;
    total_kwh: number;
    total_forlust_sek: number;
    /** Worst occasions (up to 50), for the table. */
    poster: Array<{
      start: string;
      spot_sek_per_kwh: number;
      effektivt_pris_sek_per_kwh: number;
      kwh: number;
      forlust_sek: number;
    }>;
    /** Daily total loss (SEK), for the chart. */
    serie: Array<{ date: string; forlust_sek: number }>;
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
