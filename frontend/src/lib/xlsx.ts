// Dependency-free reader for Excel workbooks (.xlsx / .xlsm / OOXML .xls saved as xlsx).
//
// The deployed app is a static bundle and we intentionally avoid pulling in a heavy
// spreadsheet library. An .xlsx/.xlsm file is just a ZIP of XML parts, so we:
//   1. parse the ZIP container by hand (central directory + local headers), and
//   2. inflate deflated entries with the browser-native `DecompressionStream`
//      ("deflate-raw" — ZIP stores raw DEFLATE, no zlib header), and
//   3. read the shared-string table + each worksheet's cells into a 2-D grid.
//
// Numbers keep their raw textual form (dot decimals) so the existing number parser
// handles them; date-formatted cells are converted from Excel serials to ISO strings
// so the existing timestamp parser handles them.

export interface WorkbookSheet {
  name: string;
  /** Row-major grid of cell text. Empty cells are "". Rows are 0-based and dense. */
  grid: string[][];
}

export interface Workbook {
  sheets: WorkbookSheet[];
}

/** Inflate a raw-DEFLATE byte range using the platform DecompressionStream. */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Webbläsaren saknar stöd för att packa upp Excel-filer (DecompressionStream).");
  }
  const ds = new DecompressionStream("deflate-raw");
  // Copy into a plain ArrayBuffer-backed view so the Blob/BlobPart types line up.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const stream = new Blob([copy]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  offset: number; // offset of the local file header
}

/** Parse a ZIP container into its entries via the End-Of-Central-Directory record. */
function readZipEntries(view: DataView): ZipEntry[] {
  const len = view.byteLength;
  // Find the EOCD signature (0x06054b50), scanning backwards (comment may follow it).
  let eocd = -1;
  const minPos = Math.max(0, len - 22 - 65535);
  for (let i = len - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Ogiltig Excel-fil (hittade inte ZIP-katalogen).");

  const entryCount = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true); // offset of central directory
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break; // central directory header sig
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + p + 46, nameLen));
    entries.push({ name, method, compressedSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Read and decompress a single entry's bytes. */
async function readEntry(view: DataView, entry: ZipEntry): Promise<Uint8Array> {
  // Local file header: name/extra lengths live here (the central-dir copies can differ).
  const lp = entry.offset;
  if (view.getUint32(lp, true) !== 0x04034b50) throw new Error("Ogiltig ZIP-post i Excel-filen.");
  const nameLen = view.getUint16(lp + 26, true);
  const extraLen = view.getUint16(lp + 28, true);
  const dataStart = lp + 30 + nameLen + extraLen;
  const raw = new Uint8Array(view.buffer, view.byteOffset + dataStart, entry.compressedSize);
  if (entry.method === 0) return raw.slice(); // stored
  if (entry.method === 8) return inflateRaw(raw); // deflate
  throw new Error(`Komprimeringsmetod ${entry.method} stöds inte i Excel-filen.`);
}

/** A1-style reference -> 1-based column index (row is ignored here). */
function colFromRef(ref: string): number {
  let col = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) col = col * 26 + (c - 64);
    else break;
  }
  return col;
}

function rowFromRef(ref: string): number {
  const m = /\d+/.exec(ref);
  return m ? parseInt(m[0], 10) : 0;
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** Excel serial date -> "YYYY-MM-DDTHH:MM:SS" wall-clock (1900 date system). */
function serialToIso(serial: number): string {
  // 25569 = days from the Excel 1900 epoch (with its leap-year bug) to 1970-01-01.
  const ms = Math.round((serial - 25569) * 86400000);
  const d = new Date(ms);
  const time =
    d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds()
      ? `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
      : "";
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}${time}`;
}

/** Built-in number-format ids that render as dates/times. */
const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Decode XML entities in shared-string / inline text. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

/** Parse the shared-string table (xl/sharedStrings.xml). */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  // Each <si> may hold a single <t> or several <r><t> runs; concatenate all <t> text.
  const siRe = /<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g;
  const tRe = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml))) {
    let text = "";
    let t: RegExpExecArray | null;
    tRe.lastIndex = 0;
    while ((t = tRe.exec(m[1]))) text += t[1];
    out.push(unescapeXml(text));
  }
  return out;
}

/**
 * Map each cell style index (s="…") to whether it renders as a date, by reading
 * xl/styles.xml: <cellXfs> entries reference a numFmtId, which is either a built-in
 * date id or a custom <numFmt> whose code contains date tokens.
 */
function parseDateStyles(xml: string): Set<number> {
  const dateFmtIds = new Set<number>(BUILTIN_DATE_FMT);
  // Custom number formats.
  const numFmtRe = /<(?:\w+:)?numFmt\b[^>]*\bnumFmtId="(\d+)"[^>]*\bformatCode="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = numFmtRe.exec(xml))) {
    const id = +m[1];
    const code = unescapeXml(m[2]).replace(/\[[^\]]*\]/g, ""); // strip [Red], [$-409] etc.
    if (/[ymdhs]/i.test(code) && !/General/i.test(code)) dateFmtIds.add(id);
  }
  // cellXfs: the s="" index points into this list (in document order).
  const dateXf = new Set<number>();
  const cellXfsBlock = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(xml);
  if (cellXfsBlock) {
    const xfRe = /<(?:\w+:)?xf\b[^>]*>|<(?:\w+:)?xf\b[^>]*\/>/g;
    let idx = 0;
    let x: RegExpExecArray | null;
    while ((x = xfRe.exec(cellXfsBlock[1]))) {
      const idm = /\bnumFmtId="(\d+)"/.exec(x[0]);
      if (idm && dateFmtIds.has(+idm[1])) dateXf.add(idx);
      idx++;
    }
  }
  return dateXf;
}

/** Parse one worksheet's cells into a dense row-major grid of strings. */
function parseSheet(xml: string, shared: string[], dateXf: Set<number>): string[][] {
  const rows: Map<number, Map<number, string>> = new Map();
  let maxCol = 0;
  let maxRow = 0;

  // Match each <c …>…</c> (or self-closed <c …/>).
  const cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(xml))) {
    const attrs = m[1];
    const body = m[2] ?? "";
    const refM = /\br="([A-Z]+\d+)"/.exec(attrs);
    if (!refM) continue;
    const ref = refM[1];
    const col = colFromRef(ref);
    const row = rowFromRef(ref);
    const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
    const sM = /\bs="(\d+)"/.exec(attrs);

    let value = "";
    if (t === "s") {
      const vM = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body);
      if (vM) value = shared[+vM[1]] ?? "";
    } else if (t === "inlineStr") {
      const tM = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/.exec(body);
      if (tM) value = unescapeXml(tM[1]);
    } else if (t === "str") {
      const vM = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body);
      if (vM) value = unescapeXml(vM[1]);
    } else {
      // Numeric (default) or boolean: take the cached <v>.
      const vM = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body);
      if (vM) {
        const raw = vM[1];
        const styleIdx = sM ? +sM[1] : -1;
        const num = Number(raw);
        if (styleIdx >= 0 && dateXf.has(styleIdx) && Number.isFinite(num)) {
          value = serialToIso(num);
        } else {
          value = raw;
        }
      }
    }
    if (value === "") continue;
    let r = rows.get(row);
    if (!r) {
      r = new Map();
      rows.set(row, r);
    }
    r.set(col, value);
    if (col > maxCol) maxCol = col;
    if (row > maxRow) maxRow = row;
  }

  const grid: string[][] = [];
  for (let rr = 1; rr <= maxRow; rr++) {
    const r = rows.get(rr);
    const line: string[] = new Array(maxCol).fill("");
    if (r) for (const [c, v] of r) line[c - 1] = v;
    grid.push(line);
  }
  return grid;
}

/** Parse workbook.xml + its rels into an ordered [sheetName, partPath] list. */
function parseSheetIndex(
  workbookXml: string,
  relsXml: string
): Array<{ name: string; path: string }> {
  const relMap = new Map<string, string>();
  const relRe = /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g;
  let rm: RegExpExecArray | null;
  while ((rm = relRe.exec(relsXml))) {
    let target = rm[2];
    if (!target.startsWith("/")) target = "xl/" + target.replace(/^\.\//, "");
    relMap.set(rm[1], target.replace(/^\//, ""));
  }
  const out: Array<{ name: string; path: string }> = [];
  const sheetRe = /<(?:\w+:)?sheet\b([^>]*)\/?>/g;
  let sm: RegExpExecArray | null;
  while ((sm = sheetRe.exec(workbookXml))) {
    const name = unescapeXml(/\bname="([^"]*)"/.exec(sm[1])?.[1] ?? "");
    const rid = /\br:id="([^"]+)"/.exec(sm[1])?.[1];
    const path = rid ? relMap.get(rid) : undefined;
    if (name && path) out.push({ name, path });
  }
  return out;
}

/** Read an .xlsx / .xlsm workbook from raw bytes into per-sheet string grids. */
export async function readWorkbook(buf: ArrayBuffer): Promise<Workbook> {
  const view = new DataView(buf);
  const entries = readZipEntries(view);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const decoder = new TextDecoder();
  const readText = async (name: string): Promise<string> => {
    const e = byName.get(name);
    if (!e) return "";
    return decoder.decode(await readEntry(view, e));
  };

  const workbookXml = await readText("xl/workbook.xml");
  if (!workbookXml) throw new Error("Ogiltig Excel-fil (saknar xl/workbook.xml).");
  const relsXml = await readText("xl/_rels/workbook.xml.rels");
  const sharedXml = await readText("xl/sharedStrings.xml");
  const stylesXml = await readText("xl/styles.xml");

  const shared = sharedXml ? parseSharedStrings(sharedXml) : [];
  const dateXf = stylesXml ? parseDateStyles(stylesXml) : new Set<number>();
  const index = parseSheetIndex(workbookXml, relsXml);

  const sheets: WorkbookSheet[] = [];
  for (const { name, path } of index) {
    const xml = await readText(path);
    if (!xml) continue;
    sheets.push({ name, grid: parseSheet(xml, shared, dateXf) });
  }
  if (sheets.length === 0) throw new Error("Excel-filen innehåller inga läsbara blad.");
  return { sheets };
}
