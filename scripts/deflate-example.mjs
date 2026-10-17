#!/usr/bin/env node
// Authoring-time helper for docs/how-deflate-works.html: every number that page quotes about
// zlib comes from here, and tests/how-deflate-works.test.mjs checks the page against it.
//
//   node scripts/deflate-example.mjs            print the worked example, bit by bit, the zlib sizes,
//                                               and whether this Node's zlib reproduces REFERENCE
//
// It needs nothing beyond Node's own zlib. The page's interactive has its own small encoder
// (in the page script), which the test round-trips through zlib's inflate.
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

export const EXAMPLE = "abracadabra abracadabra abracadabra";
export const PARAGRAPH = "DEFLATE is the compression format inside gzip, zlib, PNG and ZIP. It finds repeated strings and replaces each repeat with a short pointer back to an earlier copy of the same bytes. Then it gives the symbols that remain short codes if they are common and long codes if they are rare. The decoder undoes both steps, one symbol at a time, and gets back exactly the bytes that went in.";

/**
 * What the reference zlib (madler/zlib 1.2.12: macOS, Homebrew's Node and most Linux
 * distributions) writes at level 9. The page quotes these streams. Different zlib builds
 * make different, equally valid choices: Chromium's fork, which Chrome and Node's official
 * binaries ship, writes 17 bytes for EXAMPLE. So the test always checks the page against
 * this record and checks that the record inflates to its input, and checks the record
 * against a live run wherever the reference zlib is installed (see `isReferenceZlib`).
 */
export const REFERENCE = {
  zlib: "1.2.12",
  example: "4b4c2a4a4c4e4c4904520a89d8d900",
  paragraph: "6d90c16ec4200c447f653e20ca3f54eab65aa9aaf6b0a7de08388955c008bbdd66bfbe846c6fbd20640f336f783ebdbc3d5d4f6085ad042fa9545265c998a52667e0ac1c08cb9dcb807be469c0e5fd152e077c9c2f23ce86997350542ae48c02d42ae745bba40da3f3a420e7d7870437b6150eba4a3514e16c543139ff0993f6aa696be436f25236c8dcc9d425c2b419e988eb4a196c58f89b0e6eddd22471bf37fb4ac9717ed87b094dc3dd6483abbd636af576ba2879f94751dbd1531068df567ce5204d34490357a3a20324ffc5a2653a18271abaeb42a6471dfa71dee2d6113bfb0178a3bcffebf80b",
  noise: 1029, // bytes at level 9: zlib stores it (1,024 bytes + 5 of stored-block overhead)
};
/** A gzip file wraps the DEFLATE stream in a 10-byte header and an 8-byte CRC-32 + length trailer (no file name). */
export const GZIP_OVERHEAD = 18;
const live = (data) => zlib.deflateRawSync(data, { level: 9 });
/** Whether this Node's zlib writes exactly the recorded streams. */
export function isReferenceZlib() {
  return live(Buffer.from(EXAMPLE)).toString("hex") === REFERENCE.example
    && live(Buffer.from(PARAGRAPH)).toString("hex") === REFERENCE.paragraph
    && live(noise()).length === REFERENCE.noise;
}

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

/** The recorded example stream, traced field by field. */
export function example() {
  const raw = Buffer.from(REFERENCE.example, "hex");
  return { raw, gzipBytes: raw.length + GZIP_OVERHEAD, ...trace(raw) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`zlib ${process.versions.zlib}: ${isReferenceZlib() ? "reproduces" : "does NOT reproduce"} REFERENCE (recorded with ${REFERENCE.zlib})`);
  const ex = example();
  console.log(`${JSON.stringify(EXAMPLE)}: ${EXAMPLE.length} bytes → DEFLATE ${ex.bytes} bytes (${ex.bitsUsed} bits used), gzip ${ex.gzipBytes} bytes`);
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
  console.log("text   ", sizes(Buffer.from(PARAGRAPH)), trace(live(Buffer.from(PARAGRAPH))).blocks);
}
