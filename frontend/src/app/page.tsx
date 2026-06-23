"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Label,
  Button,
  Input,
  Switch,
  Checkbox,
} from "@sourceful-energy/ui";
import { toast } from "sonner";
import { X, Sparkles, Loader2, ChevronDown, Upload } from "lucide-react";
import { Header } from "@/components/header";
import { FileUpload } from "@/components/file-upload";
import { LocationPicker } from "@/components/location-picker";
import { StreamingTerminal, LogEntry } from "@/components/streaming-terminal";
import { AnalysisResults } from "@/components/analysis-results";
import { parseProductionCsv, assessResolution, combineProduction } from "@/lib/parseProduction";
import { fetchPrices } from "@/lib/prices";
import { analyze, nextFuseStep } from "@/lib/analyze";
import { generateAiSummary } from "@/lib/aiSummary";
import type { AnalysisResult } from "@/lib/types";

const AREA_CODES = {
  SE_1: "Norra Sverige (Luleå)",
  SE_2: "Mellersta Sverige (Sundsvall)",
  SE_3: "Mellersta Sverige (Stockholm)",
  SE_4: "Södra Sverige (Malmö)",
};

const FUSE_SIZES = ["16", "20", "25", "35", "50", "63"];
const AI_KEY_STORAGE = "openrouter_key";
const SETTINGS_STORAGE = "npc:settings:v1";
const FORMSPARK_FORM_ID = "ExsKPPKKy";

/** Default values for the persisted settings fields (single source of truth). */
const DEFAULT_SETTINGS = {
  selectedArea: "SE_4",
  fuseAmps: "",
  vatRate: "25",
  gridFixedOre: "",
  gridPct: "5",
  traderFixedOre: "",
  traderPct: "",
  gridMonthlyFee: "",
  nextFuseFee: "",
  installedKwp: "",
  latitude: "",
  longitude: "",
  traderMonthlyFee: "",
  energyTaxOre: "",
  gridFeeOre: "",
  traderQuarterPrice: false,
  aiInsights: false,
};

const GRANULARITY_LABEL: Record<string, string> = {
  "15min": "kvartsdata (15 min)",
  hourly: "timdata (60 min)",
  daily: "dygnsdata",
  unknown: "okänd upplösning",
};

/** Path to the bundled example file (respects the GitHub Pages base path). */
const EXAMPLE_FILE_URL = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/exempel-15min.csv`;
const EXAMPLE_FILE_NAME = "exempel-15min.csv";

/** Parse a numeric text field; empty -> undefined so the engine treats it as "not set". */
function numOrUndef(s: string): number | undefined {
  const t = s.trim().replace(",", ".");
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse an öre/kWh input into SEK/kWh (÷100); empty -> undefined. */
function oreToSek(s: string): number | undefined {
  const n = numOrUndef(s);
  return n === undefined ? undefined : n / 100;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Best-effort newsletter opt-in (Formspark). Fire-and-forget so analysis isn't blocked. */
async function submitSubscription(email: string): Promise<void> {
  await fetch(`https://submit-form.com/${FORMSPARK_FORM_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      email,
      acceptMarketing: true,
      source: "Negativa Prisanalyseraren",
      timestamp: new Date().toISOString(),
    }),
  });
}

export default function Home() {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [selectedArea, setSelectedArea] = useState(DEFAULT_SETTINGS.selectedArea);
  const [fuseAmps, setFuseAmps] = useState(DEFAULT_SETTINGS.fuseAmps); // "" = Vet ej / skip
  const [vatRate, setVatRate] = useState(DEFAULT_SETTINGS.vatRate);
  // Export compensation, split per company. Fixed parts in öre/kWh, variable in % of spot.
  // Elnätsbolag (grid): förlustersättning.
  const [gridFixedOre, setGridFixedOre] = useState(DEFAULT_SETTINGS.gridFixedOre);
  const [gridPct, setGridPct] = useState(DEFAULT_SETTINGS.gridPct);
  // Elhandelsbolag (trader): påslag/avdrag.
  const [traderFixedOre, setTraderFixedOre] = useState(DEFAULT_SETTINGS.traderFixedOre);
  const [traderPct, setTraderPct] = useState(DEFAULT_SETTINGS.traderPct);
  // Fixed monthly fees (kronor/month, not öre): elnät (per fuse class) + elhandel.
  const [gridMonthlyFee, setGridMonthlyFee] = useState(DEFAULT_SETTINGS.gridMonthlyFee);
  // Monthly grid fee for the NEXT fuse size up (enables the upgrade-worthiness analysis).
  const [nextFuseFee, setNextFuseFee] = useState(DEFAULT_SETTINGS.nextFuseFee);
  // Installed PV capacity (kWp) — bounds the fuse-upgrade estimate.
  const [installedKwp, setInstalledKwp] = useState(DEFAULT_SETTINGS.installedKwp);
  // Position for SMHI STRÅNG solar-irradiance lookups.
  const [latitude, setLatitude] = useState(DEFAULT_SETTINGS.latitude);
  const [longitude, setLongitude] = useState(DEFAULT_SETTINGS.longitude);
  const [traderMonthlyFee, setTraderMonthlyFee] = useState(DEFAULT_SETTINGS.traderMonthlyFee);
  // Self-consumption valuation (separate, optional). Inputs in öre/kWh.
  const [energyTaxOre, setEnergyTaxOre] = useState(DEFAULT_SETTINGS.energyTaxOre);
  const [gridFeeOre, setGridFeeOre] = useState(DEFAULT_SETTINGS.gridFeeOre);
  const [traderQuarterPrice, setTraderQuarterPrice] = useState(DEFAULT_SETTINGS.traderQuarterPrice);
  const [aiInsights, setAiInsights] = useState(DEFAULT_SETTINGS.aiInsights);
  const [aiKey, setAiKey] = useState("");
  const [subscribe, setSubscribe] = useState(false);
  const [email, setEmail] = useState("");
  const [showSelfConsumption, setShowSelfConsumption] = useState(false);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isLoadingExample, setIsLoadingExample] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showTerminal, setShowTerminal] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  // Metadata shown with the result (works for both a fresh analysis and a loaded JSON).
  const [displayMeta, setDisplayMeta] = useState<{ filename: string; area: string } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  // Restore the (device-local) OpenRouter key.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(AI_KEY_STORAGE);
      if (saved) setAiKey(saved);
    } catch {
      /* storage unavailable */
    }
  }, []);

  // Remember the settings fields between visits (not the file or newsletter opt-in).
  const settingsHydrated = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE);
      if (raw) {
        const s = JSON.parse(raw);
        if (typeof s.selectedArea === "string") setSelectedArea(s.selectedArea);
        if (typeof s.fuseAmps === "string") setFuseAmps(s.fuseAmps);
        if (typeof s.vatRate === "string") setVatRate(s.vatRate);
        if (typeof s.gridFixedOre === "string") setGridFixedOre(s.gridFixedOre);
        if (typeof s.gridPct === "string") setGridPct(s.gridPct);
        if (typeof s.traderFixedOre === "string") setTraderFixedOre(s.traderFixedOre);
        if (typeof s.traderPct === "string") setTraderPct(s.traderPct);
        if (typeof s.gridMonthlyFee === "string") setGridMonthlyFee(s.gridMonthlyFee);
        if (typeof s.nextFuseFee === "string") setNextFuseFee(s.nextFuseFee);
        if (typeof s.installedKwp === "string") setInstalledKwp(s.installedKwp);
        if (typeof s.latitude === "string") setLatitude(s.latitude);
        if (typeof s.longitude === "string") setLongitude(s.longitude);
        if (typeof s.traderMonthlyFee === "string") setTraderMonthlyFee(s.traderMonthlyFee);
        if (typeof s.energyTaxOre === "string") setEnergyTaxOre(s.energyTaxOre);
        if (typeof s.gridFeeOre === "string") setGridFeeOre(s.gridFeeOre);
        if (typeof s.traderQuarterPrice === "boolean") setTraderQuarterPrice(s.traderQuarterPrice);
        if (typeof s.aiInsights === "boolean") setAiInsights(s.aiInsights);
      }
    } catch {
      /* ignore corrupt/unavailable storage */
    }
  }, []);

  // Persist settings on change (skip the very first render so we don't clobber the restore).
  useEffect(() => {
    if (!settingsHydrated.current) {
      settingsHydrated.current = true;
      return;
    }
    try {
      localStorage.setItem(
        SETTINGS_STORAGE,
        JSON.stringify({
          selectedArea,
          fuseAmps,
          vatRate,
          gridFixedOre,
          gridPct,
          traderFixedOre,
          traderPct,
          gridMonthlyFee,
          nextFuseFee,
          installedKwp,
          latitude,
          longitude,
          traderMonthlyFee,
          energyTaxOre,
          gridFeeOre,
          traderQuarterPrice,
          aiInsights,
        })
      );
    } catch {
      /* ignore */
    }
  }, [
    selectedArea,
    fuseAmps,
    vatRate,
    gridFixedOre,
    gridPct,
    traderFixedOre,
    traderPct,
    gridMonthlyFee,
    nextFuseFee,
    installedKwp,
    latitude,
    longitude,
    traderMonthlyFee,
    energyTaxOre,
    gridFeeOre,
    traderQuarterPrice,
    aiInsights,
  ]);

  // Auto-expand the self-consumption section if it has values (e.g. restored from storage).
  useEffect(() => {
    if (energyTaxOre.trim() || gridFeeOre.trim()) setShowSelfConsumption(true);
  }, [energyTaxOre, gridFeeOre]);

  const addLog = useCallback((type: LogEntry["type"], message: string) => {
    const timestamp = new Date().toLocaleTimeString("sv-SE", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    setLogs((prev) => [...prev, { timestamp, type, message }]);
  }, []);

  const handleAnalyze = useCallback(async (filesArg?: File[]) => {
    const files = filesArg ?? selectedFiles;
    if (!files.length) {
      toast.error("Välj minst en fil först");
      return;
    }

    setIsAnalyzing(true);
    setShowTerminal(true);
    setResult(null);
    setAiSummary(null);
    setLogs([]);
    setHasError(false);

    if (abortControllerRef.current) abortControllerRef.current.abort();
    abortControllerRef.current = new AbortController();
    const { signal } = abortControllerRef.current;

    try {
      // Parse every uploaded file and combine them — grid companies often cap 15-minute
      // export downloads at ~3 months, so users stitch several chunks together.
      addLog("info", files.length > 1 ? `Läser in ${files.length} filer...` : `Läser in ${files[0].name}...`);
      const parsedParts = [];
      for (const f of files) {
        const text = await f.text();
        const p = parseProductionCsv(text, f.name);
        addLog(
          "success",
          `${f.name}: ${p.rows.length} rader (${GRANULARITY_LABEL[p.granularity] ?? p.granularity}).`
        );
        parsedParts.push(p);
      }
      const parsed = combineProduction(parsedParts);
      if (parsed.filesCombined > 1) {
        if (!parsed.granularitiesMatch) {
          addLog("warning", "Filerna har olika upplösning – kombinerar ändå, men kontrollera resultatet.");
        }
        addLog(
          "info",
          `Kombinerade ${parsed.filesCombined} filer → ${parsed.rows.length} rader` +
            (parsed.duplicatesRemoved > 0 ? ` (${parsed.duplicatesRemoved} överlappande rader togs bort).` : ".")
        );
      }
      addLog(
        "success",
        `Tolkade totalt ${parsed.rows.length} rader (${GRANULARITY_LABEL[parsed.granularity] ?? parsed.granularity}) ` +
          `– kolumner "${parsed.datetimeColumn}" / "${parsed.productionColumn}".`
      );

      // Validate the input is in 15-minute (quarter-hour) resolution.
      const resolution = assessResolution(parsed);
      addLog(resolution.level === "ok" ? "success" : "warning", resolution.message);

      const startMs = parsed.rows[0].start;
      const endMs = parsed.rows[parsed.rows.length - 1].end;
      const startStr = new Date(startMs).toISOString().slice(0, 10);
      const endStr = new Date(endMs).toISOString().slice(0, 10);
      addLog("info", `Hämtar spotpriser för ${selectedArea} (${startStr} → ${endStr})...`);

      let lastPct = -1;
      const priceData = await fetchPrices(selectedArea, startMs, endMs, {
        signal,
        onProgress: ({ done, total }) => {
          const pct = Math.floor((done / total) * 100);
          if (pct >= lastPct + 20 || done === total) {
            lastPct = pct;
            addLog("info", `Prishämtning ${pct}% (${done}/${total} dagar)`);
          }
        },
      });

      if (priceData.intervals.length === 0) {
        throw new Error(
          "Inga spotpriser hittades för perioden. Historiska priser finns från ca oktober 2022 och framåt."
        );
      }
      addLog(
        "success",
        `Hämtade ${priceData.intervals.length} prispunkter (${GRANULARITY_LABEL[priceData.granularity] ?? priceData.granularity}).`
      );

      addLog("info", "Beräknar analys (intervallmedveten)...");
      const analysis = analyze(parsed.rows, priceData.intervals, {
        productionGranularity: parsed.granularity,
        priceGranularity: priceData.granularity,
        fuseAmps: fuseAmps ? Number(fuseAmps) : undefined,
        vatRate: numOrUndef(vatRate),
        gridFixed: oreToSek(gridFixedOre),
        gridPct: numOrUndef(gridPct),
        traderFixed: oreToSek(traderFixedOre),
        traderPct: numOrUndef(traderPct),
        gridMonthlyFee: numOrUndef(gridMonthlyFee),
        nextFuseMonthlyFee: numOrUndef(nextFuseFee),
        installedKwp: numOrUndef(installedKwp),
        traderMonthlyFee: numOrUndef(traderMonthlyFee),
        selfEnergyTax: oreToSek(energyTaxOre),
        selfGridFee: oreToSek(gridFeeOre),
        selfQuarterPrice: traderQuarterPrice,
      });

      if (analysis.meta.matched_kwh_pct < 99.5) {
        addLog(
          "warning",
          `Endast ${analysis.meta.matched_kwh_pct}% av din produktion kunde matchas mot priser (saknad pristäckning för delar av perioden).`
        );
      }
      if (analysis.natanslutning) {
        addLog(
          "info",
          `Nätanslutning: ${analysis.natanslutning.intervaller_vid_max} intervall vid max (säkring ${fuseAmps}A ≈ ${analysis.natanslutning.sakring_kw} kW).`
        );
      }
      // Echo the settings used (display units) into the result for export + display.
      analysis.parametrar = {
        elomrade: selectedArea,
        huvudsakring_a: fuseAmps || undefined,
        moms_pct: vatRate || undefined,
        elnat_fast_ore_per_kwh: gridFixedOre || undefined,
        elnat_rorlig_pct: gridPct || undefined,
        elhandel_fast_ore_per_kwh: traderFixedOre || undefined,
        elhandel_rorlig_pct: traderPct || undefined,
        elnat_manadsavgift_kr: gridMonthlyFee || undefined,
        elnat_manadsavgift_nasta_sakring_kr: nextFuseFee || undefined,
        installerad_kwp: installedKwp || undefined,
        elhandel_manadsavgift_kr: traderMonthlyFee || undefined,
        energiskatt_ore_per_kwh: energyTaxOre || undefined,
        natavgift_ore_per_kwh: gridFeeOre || undefined,
        kvartspris_elhandel: traderQuarterPrice,
      };
      setResult(analysis);
      setDisplayMeta({
        filename: files.length === 1 ? files[0].name : `${files.length} filer (kombinerade)`,
        area: selectedArea,
      });
      addLog("success", "Analys klar!");

      // Optional in-browser AI summary (uses the user's own OpenRouter key).
      if (aiInsights) {
        if (!aiKey.trim()) {
          addLog("warning", "AI-sammanfattning på, men ingen OpenRouter-nyckel angiven – hoppar över.");
        } else {
          addLog("ai", "Genererar AI-sammanfattning...");
          try {
            const summary = await generateAiSummary(analysis, {
              apiKey: aiKey.trim(),
              area: selectedArea,
              signal,
            });
            setAiSummary(summary);
            addLog("success", "AI-sammanfattning klar.");
          } catch (e) {
            const msg = e instanceof Error ? e.message : "AI-sammanfattning misslyckades.";
            addLog("warning", msg);
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        addLog("info", "Analys avbruten");
        return;
      }
      const message = error instanceof Error ? error.message : "Ett fel uppstod";
      addLog("error", message);
      setHasError(true);
    } finally {
      setIsAnalyzing(false);
    }
  }, [selectedFiles, selectedArea, fuseAmps, vatRate, gridFixedOre, gridPct, traderFixedOre, traderPct, gridMonthlyFee, nextFuseFee, installedKwp, traderMonthlyFee, energyTaxOre, gridFeeOre, traderQuarterPrice, aiInsights, aiKey, addLog]);

  // Run analysis immediately (report shown in-browser). Subscription is optional and,
  // when opted in, submitted best-effort without blocking the analysis.
  const handleRun = useCallback(() => {
    if (!selectedFiles.length) {
      toast.error("Välj minst en fil först");
      return;
    }
    if (subscribe && email.trim()) {
      if (!isValidEmail(email)) {
        toast.error("Ange en giltig e-postadress eller avmarkera prenumerationen");
        return;
      }
      submitSubscription(email.trim())
        .then(() => toast.success("Tack för att du prenumererar på Sourceful Energy!"))
        .catch(() => toast.error("Kunde inte registrera prenumerationen (analysen körs ändå)."));
    }
    handleAnalyze();
  }, [selectedFiles, subscribe, email, handleAnalyze]);

  // Load the bundled 15-minute sample file and run the analysis on it directly.
  const handleTryExample = useCallback(async () => {
    setIsLoadingExample(true);
    try {
      const res = await fetch(EXAMPLE_FILE_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const file = new File([blob], EXAMPLE_FILE_NAME, { type: "text/csv" });
      setSelectedFiles([file]);
      await handleAnalyze([file]);
    } catch {
      toast.error("Kunde inte ladda exempelfilen. Försök igen.");
    } finally {
      setIsLoadingExample(false);
    }
  }, [handleAnalyze]);

  const handleReset = useCallback(() => {
    if (abortControllerRef.current) abortControllerRef.current.abort();
    setShowTerminal(false);
    setIsAnalyzing(false);
    setResult(null);
    setAiSummary(null);
    setDisplayMeta(null);
    setLogs([]);
    setHasError(false);
  }, []);

  // Load a previously downloaded result JSON and re-display it (no recompute).
  const handleLoadJson = useCallback(async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (!data || !data.hero || !data.input) {
        throw new Error("Filen ser inte ut som ett sparat analysresultat.");
      }
      setAiSummary(data.ai_explanation_sv ?? null);
      setResult(data as AnalysisResult);
      setDisplayMeta({
        filename: data._metadata?.filename || file.name,
        area: data._metadata?.area || data.parametrar?.elomrade || selectedArea,
      });
      setShowTerminal(false);
      setHasError(false);
      toast.success("Resultat inläst.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Kunde inte läsa JSON-filen.");
    }
  }, [selectedArea]);

  // Clear the remembered settings and reset every field to its default.
  const handleClearSaved = useCallback(() => {
    try {
      localStorage.removeItem(SETTINGS_STORAGE);
    } catch {
      /* ignore */
    }
    setSelectedArea(DEFAULT_SETTINGS.selectedArea);
    setFuseAmps(DEFAULT_SETTINGS.fuseAmps);
    setVatRate(DEFAULT_SETTINGS.vatRate);
    setGridFixedOre(DEFAULT_SETTINGS.gridFixedOre);
    setGridPct(DEFAULT_SETTINGS.gridPct);
    setTraderFixedOre(DEFAULT_SETTINGS.traderFixedOre);
    setTraderPct(DEFAULT_SETTINGS.traderPct);
    setGridMonthlyFee(DEFAULT_SETTINGS.gridMonthlyFee);
    setNextFuseFee(DEFAULT_SETTINGS.nextFuseFee);
    setInstalledKwp(DEFAULT_SETTINGS.installedKwp);
    setLatitude(DEFAULT_SETTINGS.latitude);
    setLongitude(DEFAULT_SETTINGS.longitude);
    setTraderMonthlyFee(DEFAULT_SETTINGS.traderMonthlyFee);
    setEnergyTaxOre(DEFAULT_SETTINGS.energyTaxOre);
    setGridFeeOre(DEFAULT_SETTINGS.gridFeeOre);
    setTraderQuarterPrice(DEFAULT_SETTINGS.traderQuarterPrice);
    setAiInsights(DEFAULT_SETTINGS.aiInsights);
    toast.success("Sparade värden rensade");
  }, []);

  const handleDownloadJson = useCallback(() => {
    if (!result) return;
    const payload = {
      ...result,
      ...(aiSummary ? { ai_explanation_sv: aiSummary } : {}),
      _metadata: {
        filename: displayMeta?.filename ?? selectedFiles[0]?.name ?? "",
        area: displayMeta?.area ?? selectedArea,
        currency: "SEK",
        granularity: result.input.granularity,
        generated_at: new Date().toISOString(),
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    triggerDownload(blob, `prisanalys_${displayMeta?.area ?? selectedArea}.json`);
  }, [result, aiSummary, selectedArea, selectedFiles, displayMeta]);

  // CSV at 15-minute resolution: a header block with the price parameters, then the
  // per-interval producing series.
  const handleDownloadCsv = useCallback(() => {
    if (!result) return;
    const p = result.parametrar ?? {};
    const area = displayMeta?.area ?? selectedArea;
    const paramRows = [
      "# Prisparametrar (inställningar)",
      `# Elområde;${p.elomrade ?? area}`,
      `# Huvudsäkring (A);${p.huvudsakring_a ?? ""}`,
      `# Moms (%);${p.moms_pct ?? ""}`,
      `# Elnät fast (öre/kWh);${p.elnat_fast_ore_per_kwh ?? ""}`,
      `# Elnät rörlig (% av spot);${p.elnat_rorlig_pct ?? ""}`,
      `# Elhandel fast (öre/kWh);${p.elhandel_fast_ore_per_kwh ?? ""}`,
      `# Elhandel rörlig (% av spot);${p.elhandel_rorlig_pct ?? ""}`,
      `# Elnät månadsavgift (kr);${p.elnat_manadsavgift_kr ?? ""}`,
      `# Elnät månadsavgift nästa säkring (kr);${p.elnat_manadsavgift_nasta_sakring_kr ?? ""}`,
      `# Installerad effekt (kWp);${p.installerad_kwp ?? ""}`,
      `# Elhandel månadsavgift (kr);${p.elhandel_manadsavgift_kr ?? ""}`,
      `# Energiskatt (öre/kWh);${p.energiskatt_ore_per_kwh ?? ""}`,
      `# Nätavgift (öre/kWh);${p.natavgift_ore_per_kwh ?? ""}`,
      `# Kvartspris elhandel;${p.kvartspris_elhandel ? "ja" : "nej"}`,
      "#",
    ];
    const header = "tid;produktion_kwh;spotpris_sek_per_kwh;effektivt_pris_sek_per_kwh;varde_sek";
    const lines = (result.series ?? []).map((s) =>
      [s.start, s.production_kwh, s.spot_sek_per_kwh, s.effektivt_pris_sek_per_kwh, s.varde_sek].join(";")
    );
    const blob = new Blob([[...paramRows, header, ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    triggerDownload(blob, `prisanalys_15min_${area}.csv`);
  }, [result, selectedArea, displayMeta]);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      <main className="flex-1 container mx-auto px-4 py-8">
        {result ? (
          <div className="max-w-5xl mx-auto space-y-6">
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={handleReset}>
                <X className="h-4 w-4 mr-2" />
                Ny analys
              </Button>
            </div>
            <AnalysisResults
              data={aiSummary ? { ...result, ai_explanation_sv: aiSummary } : result}
              metadata={{
                filename: displayMeta?.filename ?? selectedFiles[0]?.name ?? "",
                area: displayMeta?.area ?? selectedArea,
                currency: "SEK",
                granularity: result.input.granularity,
              }}
              onDownloadXlsx={handleDownloadCsv}
              onDownloadJson={handleDownloadJson}
            />
          </div>
        ) : showTerminal ? (
          <div className="max-w-3xl mx-auto space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold">
                  Analyserar {selectedFiles.length === 1 ? selectedFiles[0]?.name : `${selectedFiles.length} filer`}
                </h2>
                <p className="text-sm text-muted-foreground">Elområde: {selectedArea}</p>
              </div>
              <Button variant="outline" size="sm" onClick={handleReset} disabled={!isAnalyzing && !hasError}>
                <X className="h-4 w-4 mr-2" />
                {hasError ? "Stäng" : "Avbryt"}
              </Button>
            </div>

            <StreamingTerminal logs={logs} isActive={isAnalyzing} />

            {hasError && (
              <div className="text-center">
                <Button variant="outline" onClick={handleReset}>
                  Försök igen
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="max-w-2xl mx-auto space-y-8">
            <div className="text-center space-y-4">
              <h1 className="text-4xl font-bold tracking-tight">
                <span className="text-foreground">Negativa </span>
                <span className="text-primary">Prisanalyseraren</span>
              </h1>
              <p className="text-lg text-muted-foreground max-w-xl mx-auto">
                Upptäck hur negativa elpriser påverkar din solexport. Allt körs i din
                webbläsare – din fil lämnar aldrig din dator.
              </p>
            </div>

            <div className="space-y-6">
              <FileUpload selectedFiles={selectedFiles} onFilesSelect={setSelectedFiles} />

              <div className="space-y-2">
                <Label>Svenskt elområde</Label>
                <Select value={selectedArea} onValueChange={setSelectedArea}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(AREA_CODES).map(([code, name]) => (
                      <SelectItem key={code} value={code}>
                        {code} - {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Grid connection + payment/VAT settings */}
              <div className="rounded-lg border border-border/50 bg-muted/30 p-4 space-y-4">
                <h3 className="text-sm font-semibold text-foreground">Inställningar</h3>

                <div className="space-y-2">
                  <Label>Huvudsäkring (A)</Label>
                  <Select value={fuseAmps} onValueChange={setFuseAmps}>
                    <SelectTrigger>
                      <SelectValue placeholder="Vet ej / hoppa över" />
                    </SelectTrigger>
                    <SelectContent>
                      {FUSE_SIZES.map((a) => (
                        <SelectItem key={a} value={a}>
                          {a} A (≈ {Math.round((Math.sqrt(3) * 400 * Number(a)) / 100) / 10} kW)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Används för att räkna ut hur ofta din nätanslutning var maxad (3-fas, 400 V).
                  </p>
                </div>

                {fuseAmps && nextFuseStep(Number(fuseAmps)) !== undefined && (
                  <div className="space-y-2">
                    <Label htmlFor="next-fuse-fee">
                      Elnät månadsavgift för nästa säkring – {nextFuseStep(Number(fuseAmps))} A
                      {" "}(≈ {Math.round((Math.sqrt(3) * 400 * Number(nextFuseStep(Number(fuseAmps)))) / 100) / 10} kW) (kr/månad)
                    </Label>
                    <Input
                      id="next-fuse-fee"
                      inputMode="decimal"
                      value={nextFuseFee}
                      onChange={(e) => setNextFuseFee(e.target.value)}
                      placeholder="t.ex. 375"
                      className="max-w-[12rem]"
                    />
                    <p className="text-xs text-muted-foreground">
                      Fyll i för att se om det är värt att uppgradera huvudsäkringen ett steg (jämförs mot elnätets månadsavgift ovan).
                    </p>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="installed-kwp">Installerad effekt (kWp, valfritt)</Label>
                  <Input
                    id="installed-kwp"
                    inputMode="decimal"
                    value={installedKwp}
                    onChange={(e) => setInstalledKwp(e.target.value)}
                    placeholder="t.ex. 12"
                    className="max-w-[12rem]"
                  />
                  <p className="text-xs text-muted-foreground">
                    Solcellsanläggningens toppeffekt. Används för uppskattad potentiell produktion (SMHI) och begränsar
                    säkringsuppgraderingen – en större säkring hjälper bara upp till vad panelerna kan producera.
                  </p>
                </div>

                <div className="border-t border-border/50 pt-3">
                  <LocationPicker
                    lat={latitude}
                    lon={longitude}
                    onChange={(la, lo) => {
                      setLatitude(la);
                      setLongitude(lo);
                    }}
                    kwp={numOrUndef(installedKwp)}
                  />
                </div>

                <div className="space-y-2">
                  <h5 className="text-sm font-medium text-foreground">Fasta månadsavgifter</h5>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="grid-monthly">Elnät (kr/månad)</Label>
                      <Input id="grid-monthly" inputMode="decimal" value={gridMonthlyFee} onChange={(e) => setGridMonthlyFee(e.target.value)} placeholder="t.ex. 250" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="trader-monthly">Elhandel (kr/månad)</Label>
                      <Input id="trader-monthly" inputMode="decimal" value={traderMonthlyFee} onChange={(e) => setTraderMonthlyFee(e.target.value)} placeholder="t.ex. 45" />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Fasta abonnemangsavgifter. Elnätets avgift beror oftast på din säkringsstorlek ovan. Dras av från de uppskattade månadsintäkterna nedan.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="vat">Moms (%)</Label>
                  <Input id="vat" inputMode="decimal" value={vatRate} onChange={(e) => setVatRate(e.target.value)} placeholder="25" className="max-w-[8rem]" />
                  <p className="text-xs text-muted-foreground">Används för både ersättningen nedan och värdet av självkonsumtion.</p>
                </div>

                {/* Export compensation: two companies, each with a fixed + variable part */}
                <div className="space-y-4 border-t border-border/50 pt-4">
                  <div className="space-y-1">
                    <h4 className="text-base font-semibold text-foreground">Ersättning för exporterad el</h4>
                    <p className="text-xs text-muted-foreground">Från både ditt elnätsbolag och elhandelsbolag.</p>
                  </div>

                  <div className="space-y-2">
                    <h5 className="text-sm font-medium text-foreground">Elnätsbolag – nätersättning</h5>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="grid-fixed">Fast (öre/kWh)</Label>
                        <Input id="grid-fixed" inputMode="decimal" value={gridFixedOre} onChange={(e) => setGridFixedOre(e.target.value)} placeholder="t.ex. 3" />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="grid-pct">Rörlig (% av spot)</Label>
                        <Input id="grid-pct" inputMode="decimal" value={gridPct} onChange={(e) => setGridPct(e.target.value)} placeholder="t.ex. 5" />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Nätersättning (förlustersättning). Den rörliga delen är oftast ca 5 % av spotpriset – det motsvarar att
                      elnätsföretagets kostnader minskar när el produceras lokalt (mindre överföringsförluster), så de betalar dig en del av den besparingen.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <h5 className="text-sm font-medium text-foreground">Elhandelsbolag – påslag/avdrag</h5>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="trader-fixed">Fast (öre/kWh)</Label>
                        <Input id="trader-fixed" inputMode="decimal" value={traderFixedOre} onChange={(e) => setTraderFixedOre(e.target.value)} placeholder="t.ex. 8 eller -2" />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="trader-pct">Rörlig (% av spot)</Label>
                        <Input id="trader-pct" inputMode="decimal" value={traderPct} onChange={(e) => setTraderPct(e.target.value)} placeholder="t.ex. 0" />
                      </div>
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Fasta delar anges i öre/kWh, rörliga i % av spotpriset. <span className="text-foreground">Positivt (+)</span> = ersättning, du får mer betalt (påslag); <span className="text-foreground">negativt (−)</span> = avdrag/avgift som sänker din ersättning. Effektivt pris = (spot + förlustersättning [elnät] + påslag/avdrag [elhandel]) × (1 + moms).
                  </p>
                </div>

                {/* Cost of bought electricity → self-consumption valuation */}
                <div className="space-y-3 border-t border-border/50 pt-4">
                  <div className="space-y-1">
                    <h4 className="text-base font-semibold text-foreground">Kostnad för köpt el</h4>
                    <p className="text-xs text-muted-foreground">Vad du betalar när du köper el – grunden för värdet av självkonsumtion.</p>
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowSelfConsumption((v) => !v)}
                    className="flex w-full items-center justify-between text-left"
                    aria-expanded={showSelfConsumption}
                  >
                    <h5 className="text-sm font-medium text-foreground">Värde av självkonsumtion (valfritt)</h5>
                    <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${showSelfConsumption ? "rotate-180" : ""}`} />
                  </button>
                  {showSelfConsumption && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <Label htmlFor="tax">Energiskatt (öre/kWh)</Label>
                          <Input id="tax" inputMode="decimal" value={energyTaxOre} onChange={(e) => setEnergyTaxOre(e.target.value)} placeholder="t.ex. 42,82" />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="fee">Nätavgift (öre/kWh)</Label>
                          <Input id="fee" inputMode="decimal" value={gridFeeOre} onChange={(e) => setGridFeeOre(e.target.value)} placeholder="t.ex. 25" />
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Visar vad en kWh är värd om du använder den själv – (spotpris + energiskatt + nätavgift) × (1 + moms) – jämfört med att exportera den. Lämna tomt för att hoppa över.
                      </p>
                      <div className="flex items-center justify-between gap-3 pt-1">
                        <Label htmlFor="quarter-price" className="text-sm font-normal cursor-pointer">
                          Kvartspris (15-min) hos elhandelsbolaget
                        </Label>
                        <Switch id="quarter-price" checked={traderQuarterPrice} onCheckedChange={setTraderQuarterPrice} />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        På: självkonsumtionen värderas mot spotpriset i varje kvart (när du faktiskt använder elen). Av: mot periodens snittspris.
                      </p>
                    </div>
                  )}
                </div>

                <div className="pt-3 border-t border-border/50 flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">Dina värden sparas i webbläsaren till nästa gång.</p>
                  <Button variant="ghost" size="sm" onClick={handleClearSaved} className="text-muted-foreground hover:text-foreground shrink-0">
                    <X className="h-4 w-4 mr-2" />
                    Rensa sparade värden
                  </Button>
                </div>
              </div>

              {/* AI summarization toggle */}
              <div className="rounded-lg border border-border/50 bg-muted/30 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5 pr-4">
                    <Label htmlFor="ai-insights" className="flex items-center gap-2 cursor-pointer">
                      <Sparkles className="h-4 w-4 text-primary" />
                      AI-sammanfattning
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      Få en AI-genererad sammanfattning på svenska. Körs i din webbläsare med din egen OpenRouter-nyckel.
                    </p>
                  </div>
                  <Switch id="ai-insights" checked={aiInsights} onCheckedChange={setAiInsights} disabled={isAnalyzing} />
                </div>
                {aiInsights && (
                  <div className="space-y-2">
                    <Label htmlFor="ai-key">OpenRouter API-nyckel</Label>
                    <Input
                      id="ai-key"
                      type="password"
                      value={aiKey}
                      placeholder="sk-or-v1-..."
                      onChange={(e) => {
                        setAiKey(e.target.value);
                        try {
                          localStorage.setItem(AI_KEY_STORAGE, e.target.value);
                        } catch {
                          /* ignore */
                        }
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      Nyckeln sparas bara lokalt i din webbläsare och skickas enbart till OpenRouter.
                    </p>
                  </div>
                )}
              </div>

              {/* Optional newsletter opt-in (does not gate the analysis) */}
              <div className="rounded-lg border border-border/50 bg-muted/30 p-4 space-y-3">
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="subscribe"
                    checked={subscribe}
                    onCheckedChange={(c) => setSubscribe(c === true)}
                    disabled={isAnalyzing}
                  />
                  <label htmlFor="subscribe" className="text-sm text-muted-foreground leading-tight cursor-pointer">
                    Prenumerera på nyheter från Sourceful Energy (valfritt)
                  </label>
                </div>
                {subscribe && (
                  <div className="space-y-2">
                    <Label htmlFor="email">E-postadress</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="din@email.se"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={isAnalyzing}
                    />
                  </div>
                )}
              </div>

              <Button className="w-full" size="lg" onClick={handleRun} disabled={!selectedFiles.length || isAnalyzing || isLoadingExample}>
                {isAnalyzing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Analyserar...
                  </>
                ) : (
                  "Analysera"
                )}
              </Button>

              <Button
                variant="outline"
                className="w-full"
                onClick={handleTryExample}
                disabled={isAnalyzing || isLoadingExample}
              >
                {isLoadingExample ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Laddar exempel...
                  </>
                ) : (
                  "Prova med exempeldata (15-min)"
                )}
              </Button>
              {!selectedFiles.length && (
                <p className="text-center text-sm text-muted-foreground">
                  Välj en eller flera filer ovan, eller klicka på <span className="text-foreground">Prova med exempeldata</span> för att testa direkt.
                </p>
              )}

              <div className="pt-2">
                <input
                  ref={jsonInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleLoadJson(f);
                    e.target.value = "";
                  }}
                />
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => jsonInputRef.current?.click()}
                  disabled={isAnalyzing || isLoadingExample}
                >
                  <Upload className="mr-2 h-4 w-4" />
                  Ladda in sparat resultat (JSON)
                </Button>
              </div>
            </div>

            <div className="rounded-lg border border-border/50 bg-muted/30 p-6 space-y-4">
              <h3 className="font-semibold text-foreground">Så här fungerar det</h3>
              <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
                <li>
                  <span className="text-foreground">Hämta din exportdata</span> – Logga in på Mina Sidor hos ditt nätbolag eller elbolag och exportera din mätardata som CSV.
                </li>
                <li>
                  <span className="text-foreground">Ladda upp filen</span> – Välj filen ovan. Bäst resultat med 15-minutersdata (kvart); verktyget tolkar även tim- och dygnsdata automatiskt.
                </li>
                <li>
                  <span className="text-foreground">Få din analys</span> – Vi matchar din export mot historiska spotpriser (15-minuters­upplösning från 1 oktober 2025) och räknar ut vad din solel var värd.
                </li>
              </ol>

              <div className="pt-2 border-t border-border/50 space-y-2 text-sm text-muted-foreground">
                <p>
                  <strong className="text-foreground">Varför är detta viktigt?</strong> Sedan 1 januari 2026 finns inte längre skattereduktionen på 60 öre/kWh för solel.
                  Nu är det spotpriset som avgör vad din export är värd – och vid negativa priser kan du till och med förlora pengar på att exportera.
                </p>
                <p>
                  <strong className="text-foreground">Krav på data:</strong> En kolumn med datum/tid och en kolumn med exporterad energi i kWh. Datan bör vara i <strong className="text-foreground">15-minutersupplösning (kvart)</strong> – så avräknas den svenska elmarknaden sedan 1 oktober 2025. (Excel: exportera som CSV.)
                </p>
                <p>
                  <strong className="text-foreground">Obs om timdata:</strong> Tim- och dygnsdata fungerar tekniskt, men ger <strong className="text-foreground">ingen bra analys</strong> – negativa kvartar och korta effekttoppar jämnas ut och missas, så resultatet blir missvisande. Använd 15-minutersdata för ett rättvisande resultat.
                </p>
                <p className="text-xs italic">
                  Verktyget gör sitt bästa för att tolka olika filformat, men vi tar inget ansvar för analysens exakthet.
                </p>
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-border/40 py-6">
        <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
          <p>
            Made with <span className="text-destructive">♥</span> in Kalmar, Sweden
          </p>
          <p className="mt-1">
            Check out{" "}
            <a href="https://sourceful.energy" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
              Sourceful Energy
            </a>
            {" • "}
            Prisdata från{" "}
            <a href="https://www.elprisetjustnu.se" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
              elprisetjustnu.se
            </a>
          </p>
          <p className="mt-1">
            Öppen källkod på{" "}
            <a href="https://github.com/srcfl/negative-price-calc" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
