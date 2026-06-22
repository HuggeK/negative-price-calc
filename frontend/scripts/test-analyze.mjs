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
  approx(r.hero.tidsanalys.totala_intervaller, 2, "total intervals");
  approx(r.hero.tidsanalys.negativa_intervaller, 1, "negative producing intervals");
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
  approx(r.hero.tidsanalys.totala_intervaller, 4, "total intervals (4 quarters)");
  // 15-min producing series: the hour splits into 4 quarters.
  eq(r.series.length, 4, "series: 4 quarters");
  approx(r.series[2].spot_sek_per_kwh, -2, "series: quarter 3 spot price");
  approx(r.series[2].production_kwh, 1, "series: quarter 3 production");
  approx(r.hero.tidsanalys.produktionsintervaller, 4, "producing intervals (quarters)");
  approx(r.hero.tidsanalys.negativa_intervaller, 1, "negative price quarters");
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
  approx(r.hero.tidsanalys.negativa_intervaller, 2, "negative producing intervals (2 hours)");
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
  approx(n.intervaller_vid_max, 1, "intervals at max (only hour 1)");
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
  approx(e.brytpunkt_spot_sek_per_kwh, -0.15 / 1.1, "export: break-even spot (-totalFixed/(1+loss%))", 1e-4);
  approx(e.spot_total_sek, 6, "export: spot total");
  approx(e.effektiv_total_sek, 9, "export: effective total");
  approx(e.skillnad_mot_spot_sek, 3, "export: uplift vs spot");

  const s = r.sjalvkonsumtion;
  approx(s.spot_sek_per_kwh, 1.5, "self: spot");
  approx(s.varde_self_sek_per_kwh, 3.125, "self: value (spot+tax+fee)*1.25");
  approx(s.export_varde_sek_per_kwh, 2.25, "self: export reference price");
  approx(s.okning_vs_export_sek_per_kwh, 0.875, "self: increment vs export");
  eq(s.manader.length, 1, "self: one month in breakdown");
  approx(s.total_besparing_sek, 3.5, "self: total saving (4 kWh * 0.875)");
  approx(s.manader[0].besparing_sek, 3.5, "self: month saving");
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

// --- Test 9: monthly forecast (full months) + daily aggregate ---
console.log("Test 9: monthly forecast + daily aggregate");
{
  const nov1 = Date.UTC(2025, 10, 1, 0, 0, 0);
  const dec31_23 = Date.UTC(2025, 11, 31, 23, 0, 0);
  const prod = [
    { start: nov1, end: nov1 + H, kwh: 10 },
    { start: dec31_23, end: dec31_23 + H, kwh: 20 },
  ];
  const prices = [
    { start: nov1, end: nov1 + H, sekPerKwh: 1.0, eurPerKwh: 0 },
    { start: dec31_23, end: dec31_23 + H, sekPerKwh: 2.0, eurPerKwh: 0 },
  ];
  // Data spans all of Nov + Dec -> both months are "complete". VAT 25%, fixed fees 120/mån.
  const r = analyze(prod, prices, { vatRate: 25, gridMonthlyFee: 100, traderMonthlyFee: 20 });
  const f = r.manads_prognos;
  approx(f.fullstandiga_manader, 2, "forecast: full months");
  approx(f.fasta_avgifter_sek_per_man, 120, "forecast: fixed monthly fees");
  approx(f.snitt_effektiv_ersattning_sek, 31.25, "forecast: avg effective comp (1.25*(10,40))");
  approx(f.snitt_netto_sek, -88.75, "forecast: avg net after fees");
  approx(f.snitt_production_kwh, 15, "forecast: avg production");
  eq(r.aggregates.daily.length, 2, "daily aggregate has 2 days");
}

// --- Test 10: self-consumption quarter-price toggle (realized vs average spot) ---
console.log("Test 10: self-consumption quarter-price toggle");
{
  const prod = [
    { start: base, end: base + H, kwh: 3 }, // more production in the cheap hour
    { start: base + H, end: base + 2 * H, kwh: 1 },
  ];
  const prices = [
    { start: base, end: base + H, sekPerKwh: 1.0, eurPerKwh: 0 },
    { start: base + H, end: base + 2 * H, sekPerKwh: 3.0, eurPerKwh: 0 },
  ];
  // realized (production-weighted) = 1.5 ; average (time-weighted) = 2.0
  const on = analyze(prod, prices, { vatRate: 25, selfEnergyTax: 0.4, selfGridFee: 0.6, selfQuarterPrice: true });
  eq(on.sjalvkonsumtion.kvartpris, true, "self ON: kvartpris flag");
  approx(on.sjalvkonsumtion.spot_sek_per_kwh, 1.5, "self ON: spot basis = realized");
  approx(on.sjalvkonsumtion.varde_self_sek_per_kwh, 3.125, "self ON: value (1.5+0.4+0.6)*1.25");

  const off = analyze(prod, prices, { vatRate: 25, selfEnergyTax: 0.4, selfGridFee: 0.6, selfQuarterPrice: false });
  eq(off.sjalvkonsumtion.kvartpris, false, "self OFF: kvartpris flag");
  approx(off.sjalvkonsumtion.spot_sek_per_kwh, 2.0, "self OFF: spot basis = average");
  approx(off.sjalvkonsumtion.varde_self_sek_per_kwh, 3.75, "self OFF: value (2.0+0.4+0.6)*1.25");
  approx(off.sjalvkonsumtion.export_varde_sek_per_kwh, 1.875, "self OFF: export ref still realized (1.5*1.25)");
}

// --- Test 11: partial month is normalized to a full month ---
console.log("Test 11: partial month normalized to full month");
{
  const prod = [];
  const prices = [];
  const apr1 = Date.UTC(2025, 3, 1, 0, 0, 0); // April (30 days)
  for (let h = 0; h < 15 * 24; h++) {
    const s = apr1 + h * H; // first 15 days only
    prod.push({ start: s, end: s + H, kwh: 1 });
    prices.push({ start: s, end: s + H, sekPerKwh: 1.0, eurPerKwh: 0 });
  }
  // 15 of 30 days covered -> scale 2. No VAT/offsets; fixed 100/mån.
  const r = analyze(prod, prices, { vatRate: 0, gridMonthlyFee: 100 });
  const f = r.manads_prognos;
  approx(f.antal_manader, 1, "forecast: months included");
  approx(f.fullstandiga_manader, 0, "forecast: complete months (April partial)");
  eq(f.manader[0].complete, false, "forecast: April flagged not complete");
  approx(f.manader[0].dagar_med_data, 15, "forecast: covered days");
  approx(f.manader[0].dagar_i_manad, 30, "forecast: days in month");
  approx(f.manader[0].production_kwh, 720, "forecast: normalized production (360*2)");
  approx(f.manader[0].netto_sek, 620, "forecast: net (720 - 100 fixed)");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
