// Sanity tests for the interval-aware analysis engine.
// Run: node --experimental-strip-types frontend/scripts/test-analyze.mjs
import { analyze } from "../src/lib/analyze.ts";
import { parseProductionCsv, assessResolution } from "../src/lib/parseProduction.ts";

let failures = 0;
function approx(actual, expected, label, eps = 1e-6) {
  const ok = Math.abs(actual - expected) <= eps;
  if (!ok) {
    failures++;
    console.error(`  ✗ ${label}: got ${actual}, expected ${expected}`);
  } else {
    console.log(`  ✓ ${label} = ${actual}`);
  }
}

function eq(actual, expected, label) {
  if (actual !== expected) {
    failures++;
    console.error(`  ✗ ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  } else {
    console.log(`  ✓ ${label} = ${JSON.stringify(actual)}`);
  }
}

const H = 3_600_000;
const base = Date.UTC(2025, 10, 3, 0, 0, 0); // 2025-11-03 00:00 wall-clock

// --- Test 1: hourly production x hourly prices (legacy behaviour) ---
console.log("Test 1: hourly x hourly");
{
  const prod = [
    { start: base, end: base + H, kwh: 2 },
    { start: base + H, end: base + 2 * H, kwh: 3 },
  ];
  const prices = [
    { start: base, end: base + H, sekPerKwh: 1.0, eurPerKwh: 0.09 },
    { start: base + H, end: base + 2 * H, sekPerKwh: -0.5, eurPerKwh: -0.045 },
  ];
  const r = analyze(prod, prices, { productionGranularity: "hourly", priceGranularity: "hourly" });
  approx(r.hero.produktion.total_kwh, 5, "total kWh");
  approx(r.hero.produktion.totala_intakter_sek, 0.5, "revenue SEK");
  approx(r.hero.export_förluster.kwh_exporterat_med_förlust, 3, "negative kWh");
  approx(r.hero.export_förluster.kostnad_negativ_export_sek, 1.5, "negative cost SEK");
  approx(r.hero.tidsanalys.totala_timmar, 2, "total hours");
  approx(r.hero.tidsanalys.negativa_timmar_under_produktion, 1, "negative producing hours");
  approx(r.hero.produktion.genomsnittspris_erhållet_sek_per_kwh, 0.1, "realized price");
  approx(r.hero.produktion.enkelt_snitt_pris_sek_per_kwh, 0.25, "simple avg price");
}

// --- Test 2: hourly production x 15-minute prices (the new market resolution) ---
console.log("Test 2: hourly production x 15-min prices");
{
  const Q = H / 4;
  const prod = [{ start: base, end: base + H, kwh: 4 }];
  const prices = [
    { start: base + 0 * Q, end: base + 1 * Q, sekPerKwh: 1, eurPerKwh: 0 },
    { start: base + 1 * Q, end: base + 2 * Q, sekPerKwh: 1, eurPerKwh: 0 },
    { start: base + 2 * Q, end: base + 3 * Q, sekPerKwh: -2, eurPerKwh: 0 },
    { start: base + 3 * Q, end: base + 4 * Q, sekPerKwh: 1, eurPerKwh: 0 },
  ];
  const r = analyze(prod, prices, { productionGranularity: "hourly", priceGranularity: "15min" });
  approx(r.hero.produktion.total_kwh, 4, "total kWh");
  // 1*1 + 1*1 + 1*(-2) + 1*1 = 1
  approx(r.hero.produktion.totala_intakter_sek, 1, "revenue SEK");
  approx(r.hero.export_förluster.kwh_exporterat_med_förlust, 1, "negative kWh (one quarter)");
  approx(r.hero.export_förluster.kostnad_negativ_export_sek, 2, "negative cost SEK");
  approx(r.hero.tidsanalys.totala_timmar, 1, "total hours");
  approx(r.hero.tidsanalys.negativa_timmar_under_produktion, 0.25, "negative producing hours = 15 min");
}

// --- Test 3: daily production x hourly prices (coarse production, fine prices) ---
console.log("Test 3: daily production x hourly prices");
{
  const D = 24 * H;
  const prod = [{ start: base, end: base + D, kwh: 24 }]; // 24 kWh spread over a day
  const prices = [];
  for (let h = 0; h < 24; h++) {
    prices.push({ start: base + h * H, end: base + (h + 1) * H, sekPerKwh: h < 2 ? -1 : 1, eurPerKwh: 0 });
  }
  const r = analyze(prod, prices, { productionGranularity: "daily", priceGranularity: "hourly" });
  approx(r.hero.produktion.total_kwh, 24, "total kWh");
  // 2 hours negative (1 kWh each) => -2 ; 22 hours positive (1 kWh each) => 22 ; total 20
  approx(r.hero.produktion.totala_intakter_sek, 20, "revenue SEK");
  approx(r.hero.export_förluster.kwh_exporterat_med_förlust, 2, "negative kWh");
  approx(r.hero.tidsanalys.negativa_timmar_under_produktion, 2, "negative producing hours");
}

// --- Test 4: fuse / grid-connection flat-peak analysis ---
console.log("Test 4: fuse flat-peak analysis");
{
  // Hour 1: 12 kWh in 1h -> 12 kW (above 16A limit). Hour 2: 5 kWh -> 5 kW (below).
  const prod = [
    { start: base, end: base + H, kwh: 12 },
    { start: base + H, end: base + 2 * H, kwh: 5 },
  ];
  const prices = [
    { start: base, end: base + H, sekPerKwh: 1, eurPerKwh: 0 },
    { start: base + H, end: base + 2 * H, sekPerKwh: 1, eurPerKwh: 0 },
  ];
  const r = analyze(prod, prices, { fuseAmps: 16 });
  const n = r.natanslutning;
  approx(n.sakring_kw, Math.sqrt(3) * 400 * 16 / 1000, "fuse limit kW", 0.01); // ~11.08
  approx(n.hogsta_effekt_kw, 12, "peak power kW");
  approx(n.timmar_vid_max, 1, "hours at max (only hour 1)");
  approx(n.antal_toppar, 1, "number of peaks");
  approx(n.andel_tid_vid_max_pct, 50, "share of time at max");
}

// --- Test 5: export compensation + self-consumption valuation ---
console.log("Test 5: export compensation + self-consumption");
{
  const prod = [
    { start: base, end: base + H, kwh: 2 },
    { start: base + H, end: base + 2 * H, kwh: 2 },
  ];
  const prices = [
    { start: base, end: base + H, sekPerKwh: 1.0, eurPerKwh: 0 },
    { start: base + H, end: base + 2 * H, sekPerKwh: 2.0, eurPerKwh: 0 },
  ];
  // realized spot = (2*1 + 2*2)/4 = 1.5 ; spot revenue = 6 ; total = 4 kWh
  // elnät: 5 öre fast + 10% rörlig ; elhandel: 10 öre fast + 0% rörlig
  const r = analyze(prod, prices, {
    vatRate: 25,
    gridFixed: 0.05,
    gridPct: 10,
    traderFixed: 0.1,
    traderPct: 0,
    selfEnergyTax: 0.4,
    selfGridFee: 0.6,
  });

  const e = r.exportersattning;
  approx(e.spot_sek_per_kwh, 1.5, "export: spot");
  approx(e.elnat_rorlig_sek_per_kwh, 0.15, "export: elnät rörlig (10% of 1.5)");
  approx(e.elnat_total_sek_per_kwh, 0.2, "export: elnät total (0.05 + 0.15)");
  approx(e.elhandel_total_sek_per_kwh, 0.1, "export: elhandel total (0.10 fast)");
  approx(e.pris_innan_moms_sek_per_kwh, 1.8, "export: price before VAT");
  approx(e.effektivt_pris_sek_per_kwh, 2.25, "export: effective price (incl 25% VAT)");
  approx(e.spot_total_sek, 6, "export: spot total");
  approx(e.effektiv_total_sek, 9, "export: effective total");
  approx(e.skillnad_mot_spot_sek, 3, "export: uplift vs spot");

  const s = r.sjalvkonsumtion;
  approx(s.spot_sek_per_kwh, 1.5, "self: spot");
  approx(s.varde_self_sek_per_kwh, 3.125, "self: value (spot+tax+fee)*1.25");
  approx(s.export_varde_sek_per_kwh, 2.25, "self: export reference price");
  approx(s.okning_vs_export_sek_per_kwh, 0.875, "self: increment vs export");
}

// --- Test 5b: blocks are omitted when their inputs are absent ---
console.log("Test 5b: optional blocks omitted without inputs");
{
  const prod = [{ start: base, end: base + H, kwh: 2 }];
  const prices = [{ start: base, end: base + H, sekPerKwh: 1.0, eurPerKwh: 0 }];
  const r = analyze(prod, prices, {}); // no settings at all
  eq(r.exportersattning, undefined, "no export block without inputs");
  eq(r.sjalvkonsumtion, undefined, "no self-consumption block without inputs");
}

// --- Test 6: 15-minute parsing + resolution validation ---
console.log("Test 6: 15-min parsing + resolution validation");
{
  const lines = ["Datum;Produktion kWh"];
  const t0 = Date.UTC(2026, 4, 1, 0, 0, 0); // 2026-05-01 00:00
  for (let i = 0; i < 12; i++) {
    const d = new Date(t0 + i * 15 * 60000);
    const iso = d.toISOString().slice(0, 16).replace("T", " "); // "2026-05-01 00:15"
    lines.push(`${iso};0,${i}`);
  }
  const parsed = parseProductionCsv(lines.join("\n"), "kvart.csv");
  eq(parsed.granularity, "15min", "granularity detected");
  approx(parsed.stepMinutes, 15, "step minutes");
  approx(parsed.stepConsistencyPct, 100, "step consistency %");
  const a = assessResolution(parsed);
  eq(a.isQuarterHour, true, "assessResolution.isQuarterHour");
  eq(a.level, "ok", "assessResolution.level");
}

// --- Test 7: hourly file is flagged as NOT quarter-hour ---
console.log("Test 7: hourly file flagged as not 15-min");
{
  const lines = ["Datum;Produktion kWh"];
  const t0 = Date.UTC(2026, 4, 1, 0, 0, 0);
  for (let i = 0; i < 6; i++) {
    const d = new Date(t0 + i * 60 * 60000);
    const iso = d.toISOString().slice(0, 16).replace("T", " ");
    lines.push(`${iso};1,5`);
  }
  const parsed = parseProductionCsv(lines.join("\n"), "tim.csv");
  eq(parsed.granularity, "hourly", "granularity detected");
  const a = assessResolution(parsed);
  eq(a.isQuarterHour, false, "assessResolution.isQuarterHour");
  eq(a.level, "warning", "assessResolution.level");
}

// --- Test 8: quarters exported at a loss (offset shifts the threshold) ---
console.log("Test 8: export-at-a-loss quarters");
{
  const Q = H / 4;
  const prod = [{ start: base, end: base + H, kwh: 4 }]; // 1 kWh per quarter
  const prices = [
    { start: base + 0 * Q, end: base + 1 * Q, sekPerKwh: 1.0, eurPerKwh: 0 },
    { start: base + 1 * Q, end: base + 2 * Q, sekPerKwh: -0.5, eurPerKwh: 0 },
    { start: base + 2 * Q, end: base + 3 * Q, sekPerKwh: 0.05, eurPerKwh: 0 },
    { start: base + 3 * Q, end: base + 4 * Q, sekPerKwh: 1.0, eurPerKwh: 0 },
  ];
  // 10 öre avdrag from the trader (no loss%, no VAT): effective = spot - 0.10.
  // Break-even spot = 0.10; q2 (-0.5) and q3 (0.05) fall below it -> losses.
  const r = analyze(prod, prices, {
    productionGranularity: "hourly",
    priceGranularity: "15min",
    traderFixed: -0.1,
  });
  const f = r.forlust_export;
  approx(f.antal, 2, "loss: number of quarters");
  approx(f.intervall_minuter, 15, "loss: interval minutes (kvart)");
  approx(f.troskel_spot_sek_per_kwh, 0.1, "loss: spot break-even threshold");
  approx(f.total_kwh, 2, "loss: kWh exported at a loss");
  approx(f.total_forlust_sek, 0.65, "loss: total loss SEK (0.60 + 0.05)");
  approx(f.poster.length, 2, "loss: table rows");
  approx(f.poster[0].forlust_sek, 0.6, "loss: worst row loss (sorted desc)");
  approx(f.poster[0].effektivt_pris_sek_per_kwh, -0.6, "loss: worst row effective price");
  eq(f.serie.length, 1, "loss: one day in series");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
