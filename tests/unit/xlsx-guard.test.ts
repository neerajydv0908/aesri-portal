/**
 * lib/xlsx-guard.ts: real templates pass; bombs, truncated files, non-zips
 * and archives whose headers disagree are refused.
 *
 *   node --import tsx --test tests/unit/xlsx-guard.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import { checkXlsxZip } from "../../lib/xlsx-guard";

const TEMPLATES = path.join(process.cwd(), "public", "templates");

/* ------------------------------------------------------------------ */
/* A tiny zip writer, so each test can bend one rule                    */
/* ------------------------------------------------------------------ */

type Part = {
  name: string;
  /** What the part really holds (before compression). */
  content: Buffer;
  method?: 0 | 8;
  /** Already-compressed bytes to store instead of compressing `content`. */
  raw?: Buffer;
  /** Header values to lie with. */
  claimSize?: number;
  claimCrc?: number;
  flags?: number;
  localName?: string;
  localMethod?: number;
  cdExtra?: Buffer;
  /** Point the central record at another part's local header (index). */
  localOffsetOf?: number;
};

function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * `prefix`: bytes before the zip. With `sfx`, offsets are counted from the
 * zip's own start (a self-extracting archive); otherwise from the file's.
 * `descriptor`: write a signed data descriptor after each part (flag 3).
 */
function zip(parts: Part[], { trailing = Buffer.alloc(0), prefix = Buffer.alloc(0), sfx = false, descriptor = false } = {}): Buffer {
  const locals: Buffer[] = [prefix];
  const centrals: Buffer[] = [];
  const offsets: number[] = [];
  const base = sfx ? prefix.length : 0;
  let offset = prefix.length;
  for (const p of parts) {
    const method = p.method ?? 8;
    const data = p.raw ?? (method === 8 ? zlib.deflateRawSync(p.content) : p.content);
    const size = p.claimSize ?? p.content.length;
    const crc = p.claimCrc ?? crc32(p.content);
    const flags = (p.flags ?? 0) | (descriptor ? 0x0008 : 0);
    const name = Buffer.from(p.name);
    const localName = Buffer.from(p.localName ?? p.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(p.localMethod ?? method, 8);
    lh.writeUInt32LE(descriptor ? 0 : crc, 14);
    lh.writeUInt32LE(descriptor ? 0 : data.length, 18);
    lh.writeUInt32LE(descriptor ? 0 : size, 22);
    lh.writeUInt16LE(localName.length, 26);
    lh.writeUInt16LE(0, 28);
    offsets.push(offset - base);
    locals.push(lh, localName, data);
    let dd = Buffer.alloc(0);
    if (descriptor) {
      dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(data.length, 8);
      dd.writeUInt32LE(size, 12);
      locals.push(dd);
    }
    const extra = p.cdExtra ?? Buffer.alloc(0);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(extra.length, 30);
    centrals.push(ch, name, extra);
    offset += lh.length + localName.length + data.length + dd.length;
  }
  // Local header offsets (possibly pointing at another part's header).
  let ci = 0;
  for (let i = 0; i < parts.length; i++) {
    const ch = centrals[ci];
    ch.writeUInt32LE(offsets[parts[i].localOffsetOf ?? i], 42);
    ci += 3;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset - base, 16);
  return Buffer.concat([...locals, cd, end, trailing]);
}

const small = (name = "xl/workbook.xml") => ({ name, content: Buffer.from("<workbook>hello</workbook>".repeat(20)) });

function refused(r: ReturnType<typeof checkXlsxZip>, pattern: RegExp) {
  assert.equal(r.ok, false, "expected the file to be refused");
  if (!r.ok) assert.match(r.reason, pattern);
}

/* ------------------------------------------------------------------ */

test("the portal's real import templates pass", () => {
  for (const f of fs.readdirSync(TEMPLATES).filter((x) => x.endsWith(".xlsx"))) {
    const r = checkXlsxZip(fs.readFileSync(path.join(TEMPLATES, f)));
    assert.deepEqual(r, { ok: true }, f);
  }
});

test("a well-formed archive built here passes (deflate and stored parts, with and without data descriptors)", () => {
  assert.deepEqual(checkXlsxZip(zip([small(), { ...small("xl/styles.xml"), method: 0 }])), { ok: true });
  assert.deepEqual(checkXlsxZip(zip([small(), small("xl/styles.xml")], { descriptor: true })), { ok: true });
});

test("a bomb that lies about its size is refused without unzipping it all", () => {
  // 200 MB of zeros compresses to about 200 kB; the headers claim 1,000 bytes.
  const huge = zlib.deflateRawSync(Buffer.alloc(200 * 1024 * 1024));
  assert.ok(huge.length < 1024 * 1024);
  const t0 = Date.now();
  const r = checkXlsxZip(zip([{ name: "xl/worksheets/sheet1.xml", content: Buffer.alloc(1000), raw: huge, claimSize: 1000, claimCrc: 0 }]));
  refused(r, /unzips to more than it says/);
  assert.ok(Date.now() - t0 < 2000, "should stop early");
});

test("a bomb that declares its real size is refused by the total limit", () => {
  const content = Buffer.alloc(61 * 1024 * 1024);
  refused(checkXlsxZip(zip([{ name: "xl/worksheets/sheet1.xml", content }])), /larger than 60 MB/);
});

test("many honest parts that add up to too much are refused", () => {
  const parts = Array.from({ length: 8 }, (_, i) => ({ name: `xl/worksheets/sheet${i}.xml`, content: Buffer.alloc(1024 * 1024, 65) }));
  assert.deepEqual(checkXlsxZip(zip(parts)), { ok: true });
  refused(checkXlsxZip(zip(parts), { maxTotalBytes: 5 * 1024 * 1024 }), /larger than 5 MB/);
});

test("more than 2,000 parts are refused", () => {
  const parts = Array.from({ length: 2001 }, (_, i) => ({ name: `p${i}`, content: Buffer.from("x"), method: 0 as const }));
  refused(checkXlsxZip(zip(parts)), /more than 2,000 parts/);
  refused(checkXlsxZip(zip(parts.slice(0, 11)), { maxEntries: 10 }), /more than 10 parts/);
});

test("a truncated file is refused", () => {
  const real = fs.readFileSync(path.join(TEMPLATES, "aryavart-portal-import.xlsx"));
  for (const cut of [real.length - 1, real.length - 30, Math.floor(real.length / 2), 100, 21]) {
    const r = checkXlsxZip(real.subarray(0, cut));
    assert.equal(r.ok, false, `cut at ${cut}`);
  }
});

test("files that aren't zips are refused", () => {
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(4096)]); // old .xls / password-protected
  for (const b of [Buffer.alloc(0), Buffer.from("name,class\nMeena,V\n"), Buffer.from("%PDF-1.7\n" + "x".repeat(500)), ole]) {
    refused(checkXlsxZip(b), /isn't an Excel workbook/);
  }
});

test("encrypted parts are refused", () => {
  refused(checkXlsxZip(zip([{ ...small(), flags: 0x0001 }])), /encrypted/);
});

test("ZIP64 is refused", () => {
  const zip64Extra = Buffer.alloc(20);
  zip64Extra.writeUInt16LE(0x0001, 0);
  zip64Extra.writeUInt16LE(16, 2);
  refused(checkXlsxZip(zip([{ ...small(), cdExtra: zip64Extra }])), /ZIP64/);
  const marked = zip([small()]);
  marked.writeUInt16LE(0xffff, marked.length - 22 + 10); // end record: "see the ZIP64 record"
  refused(checkXlsxZip(marked), /ZIP64/);
});

test("headers that disagree are refused", () => {
  refused(checkXlsxZip(zip([{ ...small(), localName: "xl/other.xml" }])), /two different names/);
  refused(checkXlsxZip(zip([{ ...small(), localMethod: 0 }])), /local and central headers differ/);
  refused(checkXlsxZip(zip([{ ...small(), claimCrc: 12345 }])), /checksum/);
  refused(checkXlsxZip(zip([{ ...small(), claimSize: 10 }])), /more than it says|different size/);
  refused(checkXlsxZip(zip([small(), small()])), /same name/);
  refused(checkXlsxZip(zip([small("a.xml"), { ...small("b.xml"), localOffsetOf: 0 }])), /two different names|share the same bytes/);
  refused(checkXlsxZip(zip([small()], { trailing: Buffer.from("extra") })), /after the end record/);
  refused(checkXlsxZip(zip([small()], { prefix: Buffer.from("MZ-self-extracting"), sfx: true })), /central directory isn't where/);
  refused(checkXlsxZip(zip([small()], { prefix: Buffer.from("hidden bytes") })), /bytes outside the parts/);
  const wrongDescriptor = zip([small()], { descriptor: true });
  wrongDescriptor.writeUInt32LE(7, wrongDescriptor.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08])) + 4);
  refused(checkXlsxZip(wrongDescriptor), /data descriptor differs/);
  refused(checkXlsxZip(zip([{ ...small(), method: 0, claimSize: 3 }])), /stored part's sizes differ|sizes differ/);
});

test("damaged compressed data is refused", () => {
  const content = Buffer.from(Array.from({ length: 4000 }, (_, i) => `<c r="A${i}">${(i * 7919) % 10007}</c>`).join(""));
  const good = zlib.deflateRawSync(content);
  const bad = Buffer.from(good);
  bad.fill(0xff, 20, 60);
  refused(checkXlsxZip(zip([{ name: "xl/worksheets/sheet1.xml", content, raw: bad }])), /damaged|more than it says|different size/);
  refused(checkXlsxZip(zip([{ name: "xl/worksheets/sheet1.xml", content, raw: good.subarray(0, good.length - 50) }])), /damaged|different size/);
});

test("a sheet with an absurd number of rows is refused before ExcelJS opens it", () => {
  const rows = Array.from({ length: 30_001 }, (_, i) => `<row r="${i + 1}"/>`).join("");
  const file = zip([{ name: "xl/worksheets/sheet1.xml", content: Buffer.from(`<worksheet><sheetData>${rows}</sheetData></worksheet>`) }]);
  refused(checkXlsxZip(file, { maxRowsPerSheet: 20_000 }), /more than 20,000 rows/);
  assert.equal(checkXlsxZip(file).ok, true); // without the option, rows aren't counted
  for (const t of ["aryavart-portal-import.xlsx", "aadharshila-portal-import.xlsx"]) {
    assert.equal(checkXlsxZip(fs.readFileSync(path.join(TEMPLATES, t)), { maxRowsPerSheet: 20_000 }).ok, true, t);
  }
});
