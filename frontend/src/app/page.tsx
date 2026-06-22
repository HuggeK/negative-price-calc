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
import { X, Sparkles, Loader2, ChevronDown } from "lucide-react";
import { Header } from "@/components/header";
import { FileUpload } from "@/components/file-upload";
import { StreamingTerminal, LogEntry } from "@/components/streaming-terminal";
import { AnalysisResults } from "@/components/analysis-results";
import { parseProductionCsv, assessResolution } from "@/lib/parseProduction";
import { fetchPrices } from "@/lib/prices";
import { analyze } from "@/lib/analyze";
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
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
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
  const abortControllerRef = useRef<AbortController | null>(null);

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

  const handleAnalyze = useCallback(async (fileArg?: File) => {
    const file = fileArg ?? selectedFile;
    if (!file) {
      toast.error("Välj en fil först");
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
      addLog("info", `Läser in ${file.name}...`);
      const text = await file.text();

      addLog("info", "Tolkar produktionsdata...");
      const parsed = parseProductionCsv(text, file.name);
      addLog(
        "success",
        `Tolkade ${parsed.rows.length} rader (${GRANULARITY_LABEL[parsed.granularity] ?? parsed.granularity}) ` +
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
          `Nätanslutning: ${analysis.natanslutning.timmar_vid_max} h vid max (säkring ${fuseAmps}A ≈ ${analysis.natanslutning.sakring_kw} kW).`
        );
      }
      setResult(analysis);
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
  }, [selectedFile, selectedArea, fuseAmps, vatRate, gridFixedOre, gridPct, traderFixedOre, traderPct, gridMonthlyFee, traderMonthlyFee, energyTaxOre, gridFeeOre, traderQuarterPrice, aiInsights, aiKey, addLog]);

  // Run analysis immediately (report shown in-browser). Subscription is optional and,
  // when opted in, submitted best-effort without blocking the analysis.
  const handleRun = useCallback(() => {
    if (!selectedFile) {
      toast.error("Välj en fil först");
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
  }, [selectedFile, subscribe, email, handleAnalyze]);

  // Load the bundled 15-minute sample file and run the analysis on it directly.
  const handleTryExample = useCallback(async () => {
    setIsLoadingExample(true);
    try {
      const res = await fetch(EXAMPLE_FILE_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const file = new File([blob], EXAMPLE_FILE_NAME, { type: "text/csv" });
      setSelectedFile(file);
      await handleAnalyze(file);
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
    setLogs([]);
    setHasError(false);
  }, []);

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
    setTraderMonthlyFee(DEFAULT_SETTINGS.traderMonthlyFee);
    setEnergyTaxOre(DEFAULT_SETTINGS.energyTaxOre);
    setGridFeeOre(DEFAULT_SETTINGS.gridFeeOre);
    setTraderQuarterPrice(DEFAULT_SETTINGS.traderQuarterPrice);
    setAiInsights(DEFAULT_SETTINGS.aiInsights);
    toast.success("Sparade värden rensade");
  }, []);

  const handleDownloadJson = useCallback(() => {
    if (!result) return;
    const payload = aiSummary ? { ...result, ai_explanation_sv: aiSummary } : result;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    triggerDownload(blob, `prisanalys_${selectedArea}.json`);
  }, [result, aiSummary, selectedArea]);

  const handleDownloadCsv = useCallback(() => {
    if (!result) return;
    const header = "period;production_kwh;revenue_sek;avg_price_sek_per_kwh;negative_hours;negative_kwh;negative_value_sek";
    const lines = result.aggregates.monthly.map((m) =>
      [m.period, m.production_kwh, m.revenue_sek, m.avg_price_sek_per_kwh, m.negative_hours, m.negative_kwh, m.negative_value_sek].join(";")
    );
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    triggerDownload(blob, `prisanalys_${selectedArea}.csv`);
  }, [result, selectedArea]);

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
                filename: selectedFile?.name ?? "",
                area: selectedArea,
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
                <h2 className="text-xl font-semibold">Analyserar {selectedFile?.name}</h2>
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
              <FileUpload selectedFile={selectedFile} onFileSelect={setSelectedFile} />

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
                    <h5 className="text-sm font-medium text-foreground">Elnätsbolag – förlustersättning</h5>
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
                      Den rörliga delen är <span className="text-foreground">förlustersättningen</span> – oftast ca 5 % av spotpriset.
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
                    Fasta delar anges i öre/kWh (kan vara negativa), rörliga delar i % av spotpriset. Effektivt pris = (spot + förlustersättning [elnät] + påslag/avdrag [elhandel]) × (1 + moms).
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

              <Button className="w-full" size="lg" onClick={handleRun} disabled={!selectedFile || isAnalyzing || isLoadingExample}>
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
              {!selectedFile && (
                <p className="text-center text-sm text-muted-foreground">
                  Välj en fil ovan, eller klicka på <span className="text-foreground">Prova med exempeldata</span> för att testa direkt.
                </p>
              )}
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
