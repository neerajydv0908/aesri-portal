/**
 * Checks an uploaded .xlsx (a zip archive) BEFORE it is opened with ExcelJS,
 * so a "zip bomb" — a small file that unzips to gigabytes — can't exhaust
 * the server's memory. The sizes a zip declares can't be trusted, so every
 * part is actually unzipped here (with zlib's maxOutputLength as a hard cap)
 * and its real size and CRC-32 compared with what the headers say.
 *
 * It reads the archive the way ExcelJS's unzipper (JSZip) does — the central
 * directory decides where each part's data is and how long it is; the local
 * header decides the name — and refuses anything where the two could
 * disagree. Refused:
 *   - not a zip, or bytes before, between or after the zip's own records
 *     (only a part's data descriptor may follow its data);
 *   - ZIP64 (never needed for a workbook this size), several disks;
 *   - encrypted parts, compression other than "stored" or "deflate";
 *   - headers that disagree with each other (names, methods, sizes, CRCs),
 *     duplicate names, overlapping parts;
 *   - more than `maxEntries` parts (default 2,000) or more than
 *     `maxTotalBytes` unzipped in all (default 60 MB);
 *   - with `maxRowsPerSheet`, a worksheet with more rows than that (a file of
 *     a million empty rows is small, but ExcelJS would need gigabytes for it).
 *
 * Pure Node (Buffer + zlib), no "server-only": usable from scripts and tests.
 */
import zlib from "node:zlib";

export type XlsxZipCheck = { ok: true } | { ok: false; reason: string };

export const XLSX_GUARD_DEFAULTS = { maxTotalBytes: 60 * 1024 * 1024, maxEntries: 2000 } as const;

const SIG = { eocd: 0x06054b50, zip64Locator: 0x07064b50, central: 0x02014b50, local: 0x04034b50, descriptor: 0x08074b50 } as const;

/** A problem found while reading: becomes { ok: false, reason }. */
class Refused extends Error {}

function refuse(reason: string): never {
  throw new Refused(reason);
}

/* CRC-32 (zip's checksum). Node 22 has zlib.crc32; older Node uses the table. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data: Buffer): number {
  const native = (zlib as unknown as { crc32?: (d: Buffer) => number }).crc32;
  if (native) return native(data) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

type Entry = {
  name: Buffer;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
};

/** Does an extra field hold a ZIP64 record (header id 0x0001)? */
function hasZip64Extra(extra: Buffer): boolean {
  for (let p = 0; p + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (id === 0x0001) return true;
    p += 4 + len;
  }
  return false;
}

function findEndRecord(buf: Buffer): number {
  // The end record is 22 bytes plus a comment of at most 65,535 bytes, so it is near the end.
  const lowest = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === SIG.eocd) return i;
  }
  return -1;
}

function readCentralDirectory(buf: Buffer, maxEntries: number): { entries: Entry[]; cdStart: number } {
  const eocd = findEndRecord(buf);
  if (eocd < 0) refuse("This isn't an Excel workbook (.xlsx): it isn't a zip archive.");
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entriesHere = buf.readUInt16LE(eocd + 8);
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const commentLength = buf.readUInt16LE(eocd + 20);
  if ([disk, cdDisk, entriesHere, entries].includes(0xffff) || cdSize === 0xffffffff || cdOffset === 0xffffffff) refuse("The file uses the ZIP64 format, which an Excel workbook of this size never needs.");
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG.zip64Locator) refuse("The file uses the ZIP64 format, which an Excel workbook of this size never needs.");
  if (disk !== 0 || cdDisk !== 0 || entriesHere !== entries) refuse("The file is split across several zip disks.");
  if (eocd + 22 + commentLength !== buf.length) refuse("The file's zip headers don't match each other (extra bytes after the end record).");
  if (cdOffset + cdSize !== eocd) refuse("The file's zip headers don't match each other (the central directory isn't where the end record says).");
  if (entries === 0) refuse("The zip archive is empty.");
  if (entries > maxEntries) refuse(`The file has more than ${maxEntries.toLocaleString("en-IN")} parts.`);

  const out: Entry[] = [];
  const names = new Set<string>();
  let p = cdOffset;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== SIG.central) refuse("The file's zip headers don't match each other (a central directory record is missing).");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const startDisk = buf.readUInt16LE(p + 34);
    const localOffset = buf.readUInt32LE(p + 42);
    const end = p + 46 + nameLength + extraLength + commentLen;
    if (end > eocd) refuse("The file's zip headers don't match each other (a central directory record runs past its end).");
    const name = buf.subarray(p + 46, p + 46 + nameLength);
    const extra = buf.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff || startDisk === 0xffff || hasZip64Extra(extra)) {
      refuse("The file uses the ZIP64 format, which an Excel workbook of this size never needs.");
    }
    if (startDisk !== 0) refuse("The file is split across several zip disks.");
    if (flags & 0x0001 || flags & 0x0040) refuse("The file has encrypted parts (it is protected with a password).");
    if (method !== 0 && method !== 8) refuse("The file uses a compression method Excel doesn't use.");
    const key = name.toString("latin1");
    if (!nameLength || names.has(key)) refuse("The file's zip headers don't match each other (a part is missing its name, or two parts have the same name).");
    names.add(key);
    out.push({ name, flags, method, crc, compressedSize, size, localOffset });
    p = end;
  }
  if (p !== eocd) refuse("The file's zip headers don't match each other (the central directory has extra records).");
  return { entries: out, cdStart: cdOffset };
}

/** How many <row> elements a worksheet's XML has (counting stops just past `max`). */
function countRows(xml: Buffer, max: number): number {
  let n = 0;
  for (const tag of ["<row ", "<row>", "<row/"]) {
    for (let at = xml.indexOf(tag); at !== -1 && n <= max; at = xml.indexOf(tag, at + tag.length)) n++;
  }
  return n;
}

/**
 * Check an .xlsx before opening it. Returns { ok: true } only when every part
 * unzips cleanly, matches its headers, and the parts add up to no more than
 * `maxTotalBytes`.
 */
export function checkXlsxZip(buf: Buffer, opts: { maxTotalBytes?: number; maxEntries?: number; maxRowsPerSheet?: number } = {}): XlsxZipCheck {
  const maxTotal = opts.maxTotalBytes ?? XLSX_GUARD_DEFAULTS.maxTotalBytes;
  const maxEntries = opts.maxEntries ?? XLSX_GUARD_DEFAULTS.maxEntries;
  const tooLarge = `Unzipped, the file would be larger than ${Math.round(maxTotal / 1024 / 1024)} MB.`;
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 22) refuse("This isn't an Excel workbook (.xlsx): it isn't a zip archive.");
    const { entries, cdStart } = readCentralDirectory(buf, maxEntries);

    // Cheap first: what the headers claim.
    if (entries.reduce((a, e) => a + e.size, 0) > maxTotal) refuse(tooLarge);

    // Where each part's bytes are (from its local header), checked against the central directory.
    const spans: { start: number; end: number; e: Entry }[] = [];
    const located = entries.map((e) => {
      const h = e.localOffset;
      if (h + 30 > cdStart || buf.readUInt32LE(h) !== SIG.local) refuse("The file's zip headers don't match each other (a part's local header is missing).");
      const flags = buf.readUInt16LE(h + 6);
      const method = buf.readUInt16LE(h + 8);
      const crc = buf.readUInt32LE(h + 14);
      const compressedSize = buf.readUInt32LE(h + 18);
      const size = buf.readUInt32LE(h + 22);
      const nameLength = buf.readUInt16LE(h + 26);
      const extraLength = buf.readUInt16LE(h + 28);
      const dataStart = h + 30 + nameLength + extraLength;
      const dataEnd = dataStart + e.compressedSize;
      if (dataEnd > cdStart) refuse("The file's zip headers don't match each other (a part runs into the central directory).");
      const name = buf.subarray(h + 30, h + 30 + nameLength);
      const extra = buf.subarray(h + 30 + nameLength, dataStart);
      if (compressedSize === 0xffffffff || size === 0xffffffff || hasZip64Extra(extra)) refuse("The file uses the ZIP64 format, which an Excel workbook of this size never needs.");
      if (!name.equals(e.name)) refuse("The file's zip headers don't match each other (a part has two different names).");
      if (method !== e.method || (flags & 0x0041) !== (e.flags & 0x0041) || (flags & 0x0008) !== (e.flags & 0x0008)) {
        refuse("The file's zip headers don't match each other (a part's local and central headers differ).");
      }
      // Without a data descriptor (flag 3) the local header repeats the checksum and sizes.
      if (!(flags & 0x0008) && (crc !== e.crc || compressedSize !== e.compressedSize || size !== e.size)) {
        refuse("The file's zip headers don't match each other (a part's sizes differ between headers).");
      }
      spans.push({ start: h, end: dataEnd, e });
      return { e, data: buf.subarray(dataStart, dataEnd) };
    });
    // The parts must follow one another from the first byte to the central directory, with nothing
    // between them but a part's data descriptor (flag 3): no hidden or shared bytes.
    spans.sort((a, b) => a.start - b.start);
    let next = 0;
    for (const s of spans) {
      if (s.start < next) refuse("The file's zip headers don't match each other (two parts share the same bytes).");
      if (s.start > next) refuse("The file's zip headers don't match each other (there are bytes outside the parts).");
      next = s.end;
      if (s.e.flags & 0x0008) {
        const signed = next + 4 <= cdStart && buf.readUInt32LE(next) === SIG.descriptor;
        const at = signed ? next + 4 : next;
        if (at + 12 > cdStart) refuse("The file's zip headers don't match each other (a part's data descriptor is missing).");
        if (buf.readUInt32LE(at) !== s.e.crc || buf.readUInt32LE(at + 4) !== s.e.compressedSize || buf.readUInt32LE(at + 8) !== s.e.size) {
          refuse("The file's zip headers don't match each other (a part's data descriptor differs).");
        }
        next = at + 12;
      }
    }
    if (next !== cdStart) refuse("The file's zip headers don't match each other (there are bytes outside the parts).");

    // Now unzip every part for real, never producing more than what's left of the allowance.
    let total = 0;
    for (const { e, data } of located) {
      const left = maxTotal - total;
      if (e.size > left) refuse(tooLarge);
      let out: Buffer;
      if (e.method === 0) {
        if (e.compressedSize !== e.size) refuse("The file's zip headers don't match each other (a stored part's sizes differ).");
        out = data;
      } else {
        try {
          // One byte more than the part says it holds: enough to notice that it holds more.
          out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, Math.min(left, e.size) + 1) });
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) {
            refuse(e.size >= left ? tooLarge : "The file's zip headers don't match each other (a part unzips to more than it says).");
          }
          refuse(`Part of the file is damaged and can't be unzipped (${e.name.toString("utf8").slice(0, 80)}).`);
        }
      }
      if (out.length !== e.size) refuse("The file's zip headers don't match each other (a part unzips to a different size than it says).");
      if (crc32(out) !== e.crc) refuse(`Part of the file is damaged: its checksum doesn't match (${e.name.toString("utf8").slice(0, 80)}).`);
      if (opts.maxRowsPerSheet && /^xl\/worksheets\/[^/]+\.xml$/.test(e.name.toString("utf8")) && countRows(out, opts.maxRowsPerSheet) > opts.maxRowsPerSheet) {
        refuse(`A sheet in the file has more than ${opts.maxRowsPerSheet.toLocaleString("en-IN")} rows.`);
      }
      total += out.length;
      if (total > maxTotal) refuse(tooLarge);
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.message };
    if (err instanceof RangeError) return { ok: false, reason: "The file's zip headers don't match each other (a record points outside the file)." };
    throw err;
  }
}
