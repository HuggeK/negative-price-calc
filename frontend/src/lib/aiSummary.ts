// Client-side AI summarization via OpenRouter.
//
// The deployed app is static (GitHub Pages) with no backend, so the summary is
// generated directly from the browser using a key the user supplies. OpenRouter
// supports browser/CORS requests, which keeps this possible without a server.
// The key is only sent to OpenRouter and (optionally) cached in localStorage on
// the user's own device.

import type { AnalysisResult } from "./types";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "x-ai/grok-4.1-fast";

export interface AiSummaryOptions {
  apiKey: string;
  model?: string;
  area: string;
  signal?: AbortSignal;
}

/** Build a compact, model-friendly snapshot of the analysis. */
function buildFacts(result: AnalysisResult, area: string): string {
  const p = result.hero.produktion;
  const e = result.hero.export_förluster;
  const t = result.hero.tidsanalys;
  const facts: Record<string, unknown> = {
    elområde: area,
    period: `${result.input.date_range.start} – ${result.input.date_range.end}`,
    upplösning: result.input.granularity,
    total_export_kwh: p.total_kwh,
    total_intäkt_sek: p.totala_intakter_sek,
    realiserat_pris_sek_per_kwh: p.genomsnittspris_erhållet_sek_per_kwh,
    marknadssnitt_pris_sek_per_kwh: p.enkelt_snitt_pris_sek_per_kwh,
    timing_förlust_pct: p.timing_förlust_pct,
    kvartar_med_negativt_pris_under_export: e.intervaller_som_kostat_dig,
    kwh_exporterat_vid_negativt_pris: e.kwh_exporterat_med_förlust,
    kostnad_negativ_export_sek: e.kostnad_negativ_export_sek,
    andel_olönsam_export_pct: e.andel_olönsam_export_pct,
    totala_kvartar: t.totala_intervaller,
  };
  if (result.natanslutning) {
    facts.säkring_amp = result.natanslutning.sakring_amp;
    facts.säkring_effektgräns_kw = result.natanslutning.sakring_kw;
    facts.högsta_effekt_kw = result.natanslutning.hogsta_effekt_kw;
    facts.kvartar_vid_maxad_anslutning = result.natanslutning.intervaller_vid_max;
    facts.andel_tid_vid_max_pct = result.natanslutning.andel_tid_vid_max_pct;
  }
  return JSON.stringify(facts, null, 2);
}

/**
 * Generate a short Swedish summary of the analysis. Throws on HTTP/parse errors so
 * the caller can surface a message without blocking the (already complete) analysis.
 */
export async function generateAiSummary(
  result: AnalysisResult,
  opts: AiSummaryOptions
): Promise<string> {
  const prompt =
    "Du är en svensk energirådgivare. Sammanfatta nedanstående analys av solelexport " +
    "och negativa elpriser i 3–5 meningar på enkel svenska. Lyft fram intäkten, hur mycket " +
    "negativa priser kostade, timing-effekten och (om data finns) hur ofta nätanslutningen " +
    "var maxad. Var konkret med siffror men undvik jargong.\n\nData:\n" +
    buildFacts(result, opts.area);

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model || DEFAULT_MODEL,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`AI-tjänsten svarade ${res.status}. ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  const content: string | undefined = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI-tjänsten returnerade inget svar.");
  return content.trim();
}
