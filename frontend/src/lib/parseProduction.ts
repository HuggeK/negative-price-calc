// Client-side production-file parsing (CSV / text). Handles the common Swedish meter
// export quirks: semicolon delimiters, decimal commas, thousands separators, and
// hourly / 15-minute / daily granularity. Excel (.xlsx) is detected and rejected with
// a clear message (export as CSV) to keep the static bundle dependency-free.

import type { Granularity, ParsedProduction, ProductionInterval } from "./types";

const DATE_HINTS = /(datum|date|tid|time|timestamp|från|start|period|hour|timme)/i;
const PROD_HINTS =
  /(produktion|production|export|inmatning|inmatad|levererad|kwh|mwh|energi|förbrukning|consumption|effekt|power|värde|value|netto)/i;
const PREFERRED_PROD = /(export|inmat|produktion|production|kwh)/i;

/** Parse a Swedish/European or plain number string into a float, or NaN. */
export function parseNumber(raw: string): number {
  if (raw == null) return NaN;
  let s = String(raw).trim().replace(/ /g, "").replace(/\s/g, "");
  if (s === "") return NaN;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // Both present: assume "." thousands, "," decimal (European).
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    s = s.replace(",", ".");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Parse a timestamp string into a local Europe/Stockholm wall-clock number (ms).
 * Offsets are intentionally dropped so production lines up with price wall-clock.
 */
export function parseTimestamp(raw: string): number | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s === "") return null;

  // ISO-ish with optional offset/zone: 2025-11-03T00:00:00+01:00 / with space separator.
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  }
  // Date only: 2025-11-03 (or with / )
  m = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (m) {
    return Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0, 0);
  }
  // European D.M.Y or D/M/Y with optional time.
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[ T](\d{2}):(\d{2}))?/);
  if (m) {
    return Date.UTC(+m[3], +m[2] - 1, +m[1], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, 0);
  }
  // Fallback: let the engine try, then re-interpret as local wall-clock.
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return Date.UTC(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      d.getHours(),
      d.getMinutes(),
      d.getSeconds()
    );
  }
  return null;
}

function detectDelimiter(headerLine: string): string {
  const candidates = [";", "\t", ","];
  let best = ",";
  let bestCount = -1;
  for (const c of candidates) {
    const count = headerLine.split(c).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = c;
    }
  }
  return best;
}

function splitLine(line: string, delim: string): string[] {
  // Minimal CSV split with quote support.
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delim && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function granularityFromMinutes(step: number): Granularity {
  if (step <= 0) return "unknown";
  if (step <= 20) return "15min";
  if (step <= 90) return "hourly";
  return "daily";
}

export function parseProductionCsv(text: string, filename = ""): ParsedProduction {
  if (/\.xlsx?$/i.test(filename) && /PK/.test(text.slice(0, 4))) {
    throw new Error(
      "Excel-filer (.xlsx) stöds inte i webbversionen. Exportera som CSV och försök igen."
    );
  }

  const rawLines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (rawLines.length < 2) throw new Error("Filen verkar tom eller saknar datarader.");

  const delim = detectDelimiter(rawLines[0]);
  const header = splitLine(rawLines[0], delim);

  // Locate columns by header hints.
  let dtIdx = header.findIndex((h) => DATE_HINTS.test(h));
  let prodIdx = -1;
  // Prefer columns whose header clearly means exported energy.
  for (let i = 0; i < header.length; i++) {
    if (i === dtIdx) continue;
    if (PREFERRED_PROD.test(header[i])) {
      prodIdx = i;
      break;
    }
  }
  if (prodIdx === -1) prodIdx = header.findIndex((h, i) => i !== dtIdx && PROD_HINTS.test(h));

  // Fallback: first column is datetime, first numeric column is production.
  if (dtIdx === -1) dtIdx = 0;
  if (prodIdx === -1) {
    const probe = splitLine(rawLines[1], delim);
    prodIdx = probe.findIndex((v, i) => i !== dtIdx && Number.isFinite(parseNumber(v)));
  }
  if (prodIdx === -1) throw new Error("Hittade ingen produktions-/exportkolumn i filen.");

  const isMwh = /mwh/i.test(header[prodIdx]) && !/kwh/i.test(header[prodIdx]);

  // Parse rows.
  const points: { start: number; kwh: number }[] = [];
  for (let r = 1; r < rawLines.length; r++) {
    const cols = splitLine(rawLines[r], delim);
    if (cols.length <= Math.max(dtIdx, prodIdx)) continue;
    const ts = parseTimestamp(cols[dtIdx]);
    const val = parseNumber(cols[prodIdx]);
    if (ts == null || !Number.isFinite(val)) continue;
    points.push({ start: ts, kwh: isMwh ? val * 1000 : val });
  }

  if (points.length === 0) throw new Error("Kunde inte tolka några giltiga rader (datum + värde).");
  points.sort((a, b) => a.start - b.start);

  // Infer the interval length from spacing between consecutive timestamps.
  const diffsMin: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const d = (points[i].start - points[i - 1].start) / 60000;
    if (d > 0) diffsMin.push(d);
  }
  const stepMinutes = diffsMin.length ? median(diffsMin) : 60;
  const stepMs = stepMinutes * 60000;

  // How regular is the spacing? (share of gaps equal to the dominant step, within 10%).
  const tol = Math.max(1, stepMinutes * 0.1);
  const matching = diffsMin.filter((d) => Math.abs(d - stepMinutes) <= tol).length;
  const stepConsistencyPct = diffsMin.length
    ? Math.round((matching / diffsMin.length) * 1000) / 10
    : 100;

  const rows: ProductionInterval[] = points.map((p, i) => {
    const next = i + 1 < points.length ? points[i + 1].start : p.start + stepMs;
    // Guard against gaps: cap an interval at the inferred step length.
    const end = Math.min(next, p.start + stepMs);
    return { start: p.start, end: end > p.start ? end : p.start + stepMs, kwh: p.kwh };
  });

  return {
    rows,
    granularity: granularityFromMinutes(stepMinutes),
    stepMinutes,
    stepConsistencyPct,
    datetimeColumn: header[dtIdx] || `col${dtIdx}`,
    productionColumn: header[prodIdx] || `col${prodIdx}`,
  };
}

/** Result of validating that a parsed file is in 15-minute (quarter-hour) resolution. */
export interface ResolutionAssessment {
  granularity: Granularity;
  stepMinutes: number;
  consistencyPct: number;
  /** True when the data is in 15-minute (quarter-hour) resolution. */
  isQuarterHour: boolean;
  /** "ok" when it's clean 15-min data, otherwise "warning". */
  level: "ok" | "warning";
  message: string;
}

/**
 * Validate that production data is in 15-minute (quarter-hour) resolution.
 *
 * The analysis is interval-aware and still works for hourly/daily input, but the
 * Swedish market moved to 15-minute settlement on 2025-10-01 and quarter-hour data
 * is required to see negative-price quarters and short export peaks. This surfaces a
 * clear message the UI (and CLI) can show.
 */
export function assessResolution(parsed: ParsedProduction): ResolutionAssessment {
  const { granularity, stepMinutes, stepConsistencyPct } = parsed;
  const base = { granularity, stepMinutes, consistencyPct: stepConsistencyPct };

  if (granularity === "15min") {
    if (stepConsistencyPct < 90) {
      return {
        ...base,
        isQuarterHour: true,
        level: "warning",
        message:
          `Datan ser ut att vara 15-minutersdata, men bara ${stepConsistencyPct}% av intervallen ` +
          `är exakt 15 minuter (ojämn tidsstämpling). Kontrollera filen om resultatet ser fel ut.`,
      };
    }
    return {
      ...base,
      isQuarterHour: true,
      level: "ok",
      message: "Upplösning bekräftad: 15-minutersdata (kvart).",
    };
  }

  const what =
    granularity === "hourly"
      ? "timupplösning (60 minuter)"
      : granularity === "daily"
        ? "dygnsupplösning"
        : `okänd upplösning (~${stepMinutes} min mellan rader)`;
  return {
    ...base,
    isQuarterHour: false,
    level: "warning",
    message:
      `Filen är i ${what}, inte 15-minutersdata. Analysen körs ändå (intervallmedveten), ` +
      `men för att fånga negativa kvartar och korta effekttoppar rekommenderas 15-minutersdata.`,
  };
}

/**
 * Combine several parsed production files into one continuous series. Swedish grid companies
 * often cap 15-minute export downloads at ~3 months at a time, so users have to stitch several
 * chunks together. Rows are merged, sorted by start time, and de-duplicated by start timestamp
 * (chunk boundaries may overlap by a row or two). Granularity/columns are taken from the file
 * with the most rows. `granularitiesMatch` is false if the files weren't all the same resolution.
 */
export function combineProduction(
  parts: ParsedProduction[]
): ParsedProduction & { filesCombined: number; duplicatesRemoved: number; granularitiesMatch: boolean } {
  if (parts.length === 0) throw new Error("Inga filer att kombinera.");
  if (parts.length === 1) {
    return { ...parts[0], filesCombined: 1, duplicatesRemoved: 0, granularitiesMatch: true };
  }
  const all: ProductionInterval[] = parts
    .flatMap((p) => p.rows)
    .sort((a, b) => a.start - b.start);
  const rows: ProductionInterval[] = [];
  let duplicatesRemoved = 0;
  for (const r of all) {
    const prev = rows[rows.length - 1];
    if (prev && prev.start === r.start) {
      duplicatesRemoved += 1; // same interval coming from an overlapping chunk — keep the first
      continue;
    }
    rows.push(r);
  }
  // Use the dominant (most rows) file for granularity/columns; they're the same export type.
  const dominant = [...parts].sort((a, b) => b.rows.length - a.rows.length)[0];
  const granularitiesMatch = parts.every((p) => p.granularity === parts[0].granularity);
  return {
    rows,
    granularity: dominant.granularity,
    stepMinutes: dominant.stepMinutes,
    stepConsistencyPct: dominant.stepConsistencyPct,
    datetimeColumn: dominant.datetimeColumn,
    productionColumn: dominant.productionColumn,
    filesCombined: parts.length,
    duplicatesRemoved,
    granularitiesMatch,
  };
}
