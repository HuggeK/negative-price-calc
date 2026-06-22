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
    datetimeColumn: header[dtIdx] || `col${dtIdx}`,
    productionColumn: header[prodIdx] || `col${prodIdx}`,
  };
}
