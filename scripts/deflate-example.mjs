#!/usr/bin/env node
// Authoring-time helper for docs/how-deflate-works.html: every number that page quotes about
// zlib comes from here, and tests/how-deflate-works.test.mjs re-runs it against the page.
//
//   node scripts/deflate-example.mjs            print the worked example, bit by bit, and the chart sizes
//
// It needs nothing beyond Node's own zlib. The page's interactive has its own small encoder
// (in the page script), which the test round-trips through zlib's inflate.
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

export const EXAMPLE = "abracadabra abracadabra abracadabra";

/** 1 KiB of reproducible noise for the "incompressible" column (mulberry32, seed 40). */
export function noise(length = 1024, seed = 40) {
  let a = seed >>> 0;
  return Uint8Array.from({ length }, () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) & 0xff;
  });
}

// RFC 1951 tables, copied on purpose rather than taken from the page's encoder: this decoder checks that
// encoder's output and zlib's, so it must not share their mistakes.
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Canonical decoding table: "bits as read" → symbol, for code lengths `lengths`. */
function decoder(lengths) {
  const max = Math.max(0, ...lengths), count = new Array(max + 1).fill(0), next = [];
  lengths.forEach((l) => { if (l) count[l]++; });
  for (let bits = 1, code = 0; bits <= max; bits++) { code = (code + (count[bits - 1] || 0)) << 1; next[bits] = code; }
  const map = new Map();
  lengths.forEach((l, s) => { if (l) map.set((next[l]++).toString(2).padStart(l, "0"), s); });
  return map;
}

/**
 * Inflate a raw DEFLATE stream and describe every field the decoder reads, in order, with
 * the bits exactly as they arrive. Fields: { kind, bits, ... }.
 */
export function trace(buf) {
  let pos = 0;
  const bit = () => (buf[pos >> 3] >> (pos++ & 7)) & 1;
  const num = (n) => { let v = 0, s = ""; for (let i = 0; i < n; i++) { const b = bit(); v |= b << i; s += b; } return { v, s }; };
  const sym = (map) => { let s = ""; while (s.length < 16) { s += bit(); if (map.has(s)) return { v: map.get(s), s }; } throw new Error("bad code"); };
  const fields = [], out = [];
  const blocks = [];
  for (let last = 0; !last;) {
    const start = pos;
    const f = num(1), t = num(2);
    last = f.v;
    fields.push({ kind: "bfinal", bits: f.s, value: f.v }, { kind: "btype", bits: t.s, value: t.v });
    const block = { type: ["stored", "fixed", "dynamic"][t.v], start };
    if (t.v === 0) {
      pos = (pos + 7) & ~7;
      const len = num(16).v;
      num(16);
      for (let i = 0; i < len; i++) out.push(num(8).v);
      blocks.push({ ...block, bits: pos - start });
      continue;
    }
    let lit, dist;
    if (t.v === 1) {
      lit = decoder(Array.from({ length: 288 }, (_, s) => (s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8)));
      dist = decoder(new Array(30).fill(5));
    } else {
      const hlit = num(5).v + 257, hdist = num(5).v + 1, hclen = num(4).v + 4;
      const clLengths = new Array(19).fill(0);
      for (let i = 0; i < hclen; i++) clLengths[CL_ORDER[i]] = num(3).v;
      const cl = decoder(clLengths), lengths = [];
      while (lengths.length < hlit + hdist) {
        const c = sym(cl).v;
        if (c < 16) lengths.push(c);
        else if (c === 16) { const p = lengths[lengths.length - 1]; for (let n = 3 + num(2).v; n--;) lengths.push(p); }
        else if (c === 17) for (let n = 3 + num(3).v; n--;) lengths.push(0);
        else for (let n = 11 + num(7).v; n--;) lengths.push(0);
      }
      Object.assign(block, { hlit, hdist, hclen, headerBits: pos - start - 3 });
      lit = decoder(lengths.slice(0, hlit));
      dist = decoder(lengths.slice(hlit));
    }
    for (;;) {
      const s = sym(lit);
      if (s.v < 256) { fields.push({ kind: "literal", bits: s.s, value: s.v }); out.push(s.v); continue; }
      if (s.v === 256) { fields.push({ kind: "end", bits: s.s, value: 256 }); break; }
      const i = s.v - 257, le = num(LEXT[i]), length = LBASE[i] + le.v;
      fields.push({ kind: "length", bits: s.s, value: s.v, base: LBASE[i], extraBits: le.s, length });
      const d = sym(dist), de = num(DEXT[d.v]), distance = DBASE[d.v] + de.v;
      fields.push({ kind: "distance", bits: d.s, value: d.v, base: DBASE[d.v], extraBits: de.s, distance });
      for (let k = 0; k < length; k++) out.push(out[out.length - distance]);
    }
    blocks.push({ ...block, bits: pos - start });
  }
  return { fields, blocks, bitsUsed: pos, bytes: buf.length, output: Uint8Array.from(out) };
}

/** zlib's sizes for one input. `best` (level 9) is the chart's "zlib -9" column; `fixed` (Z_FIXED) still
    falls back to a stored block when that is smaller, which is why the chart's own block columns come from
    the page's encoder instead. */
export function sizes(data) {
  return {
    input: data.length,
    stored: zlib.deflateRawSync(data, { level: 0 }).length,
    fixed: zlib.deflateRawSync(data, { level: 9, strategy: zlib.constants.Z_FIXED }).length,
    best: zlib.deflateRawSync(data, { level: 9 }).length,
  };
}

export function example() {
  const raw = zlib.deflateRawSync(Buffer.from(EXAMPLE), { level: 9 });
  return { raw, gzip: zlib.gzipSync(Buffer.from(EXAMPLE), { level: 9 }), ...trace(raw) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ex = example();
  console.log(`${JSON.stringify(EXAMPLE)}: ${EXAMPLE.length} bytes → DEFLATE ${ex.bytes} bytes (${ex.bitsUsed} bits used), gzip ${ex.gzip.length} bytes`);
  console.log(`hex: ${ex.raw.toString("hex")}`);
  for (const f of ex.fields) {
    const extra = f.extraBits !== undefined ? ` +${f.extraBits || "(none)"}` : "";
    const what = f.kind === "literal" ? JSON.stringify(String.fromCharCode(f.value))
      : f.kind === "length" ? `symbol ${f.value} → length ${f.length}`
      : f.kind === "distance" ? `code ${f.value} → distance ${f.distance}` : f.value;
    console.log(`${(f.bits + extra).padEnd(20)} ${f.kind} ${what}`);
  }
  console.log("\nzlib sizes (bytes): input, level 0, Z_FIXED, level 9 (the chart's zlib -9 column)");
  console.log("example", sizes(Buffer.from(EXAMPLE)));
  console.log("noise  ", sizes(noise()));
  if (process.argv[2]) console.log("text   ", sizes(Buffer.from(process.argv[2])), trace(zlib.deflateRawSync(Buffer.from(process.argv[2]), { level: 9 })).blocks);
}
