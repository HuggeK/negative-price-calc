// Sanity tests for the interval-aware analysis engine.
// Run: node --experimental-strip-types frontend/scripts/test-analyze.mjs
import { analyze } from "../src/lib/analyze.ts";

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

// --- Test 5: self-consumption valuation (payment / VAT) ---
console.log("Test 5: VAT / self-consumption valuation");
{
  const prod = [
    { start: base, end: base + H, kwh: 2 },
    { start: base + H, end: base + 2 * H, kwh: 2 },
  ];
  const prices = [
    { start: base, end: base + H, sekPerKwh: 1.0, eurPerKwh: 0 },
    { start: base + H, end: base + 2 * H, sekPerKwh: 2.0, eurPerKwh: 0 },
  ];
  const r = analyze(prod, prices, { vatRate: 25, energyTax: 0.4, transmissionFee: 0.6 });
  const s = r.sjalvkonsumtion;
  // realized spot = (2*1 + 2*2)/4 = 1.5
  approx(s.spot_netto_sek_per_kwh, 1.5, "spot net");
  approx(s.spot_brutto_sek_per_kwh, 1.875, "spot gross (incl 25% VAT)");
  approx(s.undvikna_avgifter_sek_per_kwh, 1.25, "avoided fees+tax incl VAT");
  approx(s.varde_self_sek_per_kwh, 3.125, "self-consumption value");
  approx(s.okning_vs_export_sek_per_kwh, 1.625, "increment vs export");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
