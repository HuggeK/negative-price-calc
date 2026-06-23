"use client";

import { useCallback, useState } from "react";
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sourceful-energy/ui";
import { MapPin, LocateFixed, Sun, Loader2 } from "lucide-react";
import {
  fetchStrangGlobalRadiation,
  irradianceKwhPerM2,
  potentialProductionKwh,
  withinStrangCoverage,
} from "@/lib/strang";

interface LocationPickerProps {
  lat: string;
  lon: string;
  onChange: (lat: string, lon: string) => void;
  /** Installed PV capacity (kWp), used to estimate potential production from the irradiance. */
  kwp?: number;
  /** Optional analysis period; if absent the test fetch uses the last ~12 months. */
  periodStartMs?: number;
  periodEndMs?: number;
}

/** A few Swedish reference points (per elområde) to pick from quickly. */
const PRESETS: Array<{ name: string; lat: number; lon: number }> = [
  { name: "Luleå (SE1)", lat: 65.584, lon: 22.156 },
  { name: "Umeå (SE1)", lat: 63.825, lon: 20.263 },
  { name: "Östersund (SE2)", lat: 63.179, lon: 14.636 },
  { name: "Sundsvall (SE2)", lat: 62.39, lon: 17.306 },
  { name: "Stockholm (SE3)", lat: 59.329, lon: 18.069 },
  { name: "Karlstad (SE3)", lat: 59.404, lon: 13.511 },
  { name: "Göteborg (SE3)", lat: 57.709, lon: 11.974 },
  { name: "Visby (SE3)", lat: 57.637, lon: 18.296 },
  { name: "Kalmar (SE4)", lat: 56.661, lon: 16.364 },
  { name: "Malmö (SE4)", lat: 55.605, lon: 13.003 },
];

interface FetchState {
  loading: boolean;
  error?: string;
  kwhPerM2?: number;
  potentialKwh?: number;
  from?: string;
  to?: string;
}

export function LocationPicker({ lat, lon, onChange, kwp, periodStartMs, periodEndMs }: LocationPickerProps) {
  const [state, setState] = useState<FetchState>({ loading: false });

  const latN = parseFloat(lat.replace(",", "."));
  const lonN = parseFloat(lon.replace(",", "."));
  const hasCoords = Number.isFinite(latN) && Number.isFinite(lonN);
  const inCoverage = hasCoords && withinStrangCoverage(latN, lonN);

  const useMyLocation = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setState((s) => ({ ...s, error: "Din webbläsare stöder inte platsbestämning." }));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onChange(pos.coords.latitude.toFixed(4), pos.coords.longitude.toFixed(4));
        setState({ loading: false });
      },
      () => setState((s) => ({ ...s, error: "Kunde inte hämta din plats (nekad eller otillgänglig)." })),
      { enableHighAccuracy: false, timeout: 10000 }
    );
  }, [onChange]);

  const fetchIrradiance = useCallback(async () => {
    if (!hasCoords) return;
    setState({ loading: true });
    try {
      const now = Date.now();
      // STRÅNG data lags reality by a day or two; default to a recent ~12-month window.
      const toMs = periodEndMs ?? now - 2 * 86_400_000;
      const fromMs = periodStartMs ?? toMs - 365 * 86_400_000;
      const points = await fetchStrangGlobalRadiation(latN, lonN, fromMs, toMs);
      const kwhPerM2 = irradianceKwhPerM2(points);
      const potentialKwh = kwp && kwp > 0 ? potentialProductionKwh(kwhPerM2, kwp) : undefined;
      setState({
        loading: false,
        kwhPerM2,
        potentialKwh,
        from: new Date(fromMs).toISOString().slice(0, 10),
        to: new Date(toMs).toISOString().slice(0, 10),
      });
    } catch (e) {
      setState({ loading: false, error: e instanceof Error ? e.message : "Hämtningen misslyckades." });
    }
  }, [hasCoords, latN, lonN, kwp, periodStartMs, periodEndMs]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <MapPin className="h-4 w-4 text-primary" />
        <h5 className="text-sm font-medium text-foreground">Plats för solinstrålning (SMHI STRÅNG)</h5>
      </div>

      <div className="space-y-2">
        <Label>Välj en ort</Label>
        <Select
          value={PRESETS.find((p) => p.lat.toFixed(4) === latN.toFixed(4) && p.lon.toFixed(4) === lonN.toFixed(4))?.name ?? ""}
          onValueChange={(name) => {
            const p = PRESETS.find((x) => x.name === name);
            if (p) onChange(p.lat.toFixed(4), p.lon.toFixed(4));
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="Välj närmaste ort…" />
          </SelectTrigger>
          <SelectContent>
            {PRESETS.map((p) => (
              <SelectItem key={p.name} value={p.name}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="lat">Latitud</Label>
          <Input id="lat" inputMode="decimal" value={lat} onChange={(e) => onChange(e.target.value, lon)} placeholder="59.33" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="lon">Longitud</Label>
          <Input id="lon" inputMode="decimal" value={lon} onChange={(e) => onChange(lat, e.target.value)} placeholder="18.07" />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={useMyLocation}>
          <LocateFixed className="mr-2 h-4 w-4" />
          Använd min plats
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={fetchIrradiance} disabled={!inCoverage || state.loading}>
          {state.loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sun className="mr-2 h-4 w-4" />}
          Hämta solinstrålning
        </Button>
      </div>

      {hasCoords && !inCoverage && (
        <p className="text-xs text-destructive">
          Platsen ligger utanför STRÅNG-modellens täckning (Norden). Välj en plats inom Sverige/Norden.
        </p>
      )}
      {state.error && <p className="text-xs text-destructive">{state.error}</p>}
      {state.kwhPerM2 != null && (
        <div className="rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-sm">
          <p className="text-muted-foreground">
            Solinstrålning {state.from} → {state.to}:{" "}
            <span className="font-mono font-semibold text-foreground">{state.kwhPerM2.toFixed(0)} kWh/m²</span>
          </p>
          {state.potentialKwh != null ? (
            <p className="text-muted-foreground">
              Uppskattad potentiell produktion vid {kwp} kWp:{" "}
              <span className="font-mono font-semibold text-foreground">{state.potentialKwh.toFixed(0)} kWh</span>{" "}
              <span className="text-xs">(global horisontell instrålning × kWp × 0,82 – grov uppskattning)</span>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Fyll i installerad effekt (kWp) ovan för att uppskatta potentiell produktion.</p>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        STRÅNG är SMHI:s modell för historisk solinstrålning (inte mätvärden på din exakta punkt). Endast position och
        datumintervall skickas till SMHI – ingen av dina data lämnar webbläsaren.
      </p>
    </div>
  );
}
