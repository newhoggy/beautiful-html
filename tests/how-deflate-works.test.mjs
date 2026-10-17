// docs/how-deflate-works.html quotes real numbers. These tests make sure they stay real:
// the page's own encoder must write streams zlib can inflate, and every figure the page
// quotes about zlib (or about that encoder) must match a live run.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { EXAMPLE, PARAGRAPH as RECORDED_PARAGRAPH, REFERENCE, GZIP_OVERHEAD, isReferenceZlib, noise, trace, example } from "../scripts/deflate-example.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = fs.readFileSync(path.join(ROOT, "docs/how-deflate-works.html"), "utf8");

/** The encoder lives in the page script between two markers, so the reader runs exactly what is tested. */
function loadEncoder() {
  const m = PAGE.match(/\/\* deflate-encoder:start \*\/([\s\S]*?)\/\* deflate-encoder:end \*\//);
  assert.ok(m, "encoder markers are in the page");
  // In this realm, so its arrays compare equal to ours.
  return vm.runInThisContext(`(() => {${m[1]}\nreturn Deflate;\n})`, { filename: "how-deflate-works.html" })();
}
const Deflate = loadEncoder();
const utf8 = (s) => new TextEncoder().encode(s);
const text = (html) => html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const byId = (id) => {
  const m = PAGE.match(new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</`));
  assert.ok(m, `#${id} is on the page`);
  return text(m[1]);
};
const PARAGRAPH = (() => {
  const m = PAGE.match(/data-preset="(DEFLATE is [^"]+)"/);
  assert.ok(m, "the paragraph preset is on the page");
  return text(m[1]);
})();

test("every block type the encoder writes inflates back to its input", () => {
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const fib = [];
  for (let s = 0, a = 1, b = 1; s < 22; s++, [a, b] = [b, a + b]) fib.push(...new Array(a).fill(65 + s));
  const corpus = [
    new Uint8Array(0), utf8("a"), utf8("ab"), utf8(EXAMPLE), utf8(PARAGRAPH),
    utf8("a".repeat(1000)), utf8("ab".repeat(700)), utf8("x".repeat(258 * 3 + 7)),
    Uint8Array.from({ length: 256 }, (_, i) => i),
    noise(), noise(70000, 3),
    Uint8Array.from({ length: 5000 }, () => (rnd() * 4) | 0),
    Uint8Array.from(fib.sort(() => rnd() - 0.5)), // Fibonacci counts force the 15-bit length limit
    utf8("€ and ✓ are multi-byte in UTF-8: €€€ ✓✓✓"),
  ];
  for (const data of corpus) {
    const r = Deflate.encode(data);
    for (const type of ["stored", "fixed", "dynamic"]) {
      const stream = r.streams[type];
      assert.deepEqual(new Uint8Array(zlib.inflateRawSync(stream)), data, `${type} block for ${data.length} bytes`);
      assert.equal(stream.length, Math.ceil(r.bits[type] / 8), `${type} bit count matches the bytes written`);
    }
    assert.deepEqual(new Uint8Array(zlib.inflateRawSync(r.bytes)), data);
    assert.equal(r.bytes.length, Math.min(...Object.values(r.streams).map((s) => s.length)), "the smallest block wins");
    assert.equal(r.tokens.reduce((n, t) => n + (t.lit === undefined ? t.len : 1), 0), data.length, "tokens cover the input");
  }
});

test("the worked example's figures are what the encoder produces", () => {
  const r = Deflate.encode(utf8(EXAMPLE));
  const labels = r.tokens.map((t) => (t.lit !== undefined ? (t.lit === 32 ? "␣" : String.fromCharCode(t.lit)) : `(${t.len},${t.dist})`));
  assert.deepEqual(labels, ["a", "b", "r", "a", "c", "a", "d", "(4,7)", "␣", "(23,12)"]);
  const windowTokens = [...PAGE.match(/<figure[^>]*id="window"[\s\S]*?<\/figure>/)[0].matchAll(/<g class="node tok [^"]*" data-id="t\d+">.*?<text[^>]*>([^<]*)<\/text><\/g>/g)].map((m) => m[1]);
  assert.deepEqual(windowTokens, labels, "the window figure shows the encoder's tokens");
  assert.equal(r.bits.fixed, 103);
  assert.equal(r.bytes.length, 13);
  assert.match(PAGE, /<text x="360" y="216">13 bytes<\/text><text class="sub" x="360" y="236">103 bits, 37% of the input<\/text>/);
  assert.match(PAGE, /seen an encoder that does it in 13\./);
});

test("the recorded zlib streams are what this zlib writes, where it is the reference zlib", (t) => {
  if (!isReferenceZlib()) {
    t.skip(`zlib ${process.versions.zlib} is not the reference zlib ${REFERENCE.zlib} (Chromium's fork writes other, equally valid streams)`);
    return;
  }
  assert.equal(zlib.deflateRawSync(Buffer.from(EXAMPLE), { level: 9 }).toString("hex"), REFERENCE.example);
  assert.equal(zlib.gzipSync(Buffer.from(EXAMPLE), { level: 9 }).length, 33);
  // "zlib 1.2.12 switches from fixed to dynamic once the text is 74 bytes long."
  const types = [];
  for (let n = 1; n <= PARAGRAPH.length; n++) types.push(trace(zlib.deflateRawSync(Buffer.from(PARAGRAPH.slice(0, n)), { level: 9 })).blocks.map((b) => b.type).join("+"));
  assert.equal(types.indexOf("dynamic") + 1, 74);
  assert.ok(types.slice(0, 73).every((t) => t === "fixed"));
  assert.match(PAGE, /zlib 1\.2\.12 switches from fixed to dynamic once the text is 74 bytes long/);
});

test("the recorded streams are valid DEFLATE for the page's inputs", () => {
  assert.equal(PARAGRAPH, RECORDED_PARAGRAPH, "the page's paragraph preset is the recorded paragraph");
  assert.equal(zlib.inflateRawSync(Buffer.from(REFERENCE.example, "hex")).toString(), EXAMPLE);
  assert.equal(zlib.inflateRawSync(Buffer.from(REFERENCE.paragraph, "hex")).toString(), PARAGRAPH);
  // The gzip wrapper costs the same 18 bytes whichever zlib wrote the stream inside it.
  assert.equal(zlib.gzipSync(Buffer.from(EXAMPLE), { level: 9 }).length - zlib.deflateRawSync(Buffer.from(EXAMPLE), { level: 9 }).length, GZIP_OVERHEAD);
});

test("the join figure's bits are the encoder's fixed-Huffman stream, in read order", () => {
  const fig = PAGE.match(/<figure[^>]*id="join"[\s\S]*?<\/figure>/)[0];
  const shown = [...fig.matchAll(/data-id="b\d+"><rect [^>]*\/><text class="mono"[^>]*>([01]+)<\/text>/g)].map((m) => m[1]).join("");
  const stream = Deflate.encode(utf8(EXAMPLE)).streams.fixed;
  const read = Array.from({ length: stream.length * 8 }, (_, i) => (stream[i >> 3] >> (i & 7)) & 1).join("");
  assert.equal(shown.length, 103);
  assert.equal(shown, read.slice(0, 103));
  assert.match(fig, />103 bits: 3 of header, 64 for 8 literals, 29 for 2 back-references, 7 to end the block</);
  const toks = [...fig.matchAll(/class="node c[12] tok" data-id="k\d+"><rect [^>]*\/><text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  assert.deepEqual(toks, ["a", "b", "r", "a", "c", "a", "d", "(4,7)", "␣", "(23,12)"]);
});

test("the opening answer and the bit walk match the recorded zlib stream", () => {
  const ex = example();
  assert.equal(ex.gzipBytes, 33);
  assert.equal(ex.bytes, 15);
  assert.equal(ex.bitsUsed, 119);
  assert.equal(new TextDecoder().decode(ex.output), EXAMPLE, "the tracer decodes it to the input");
  assert.match(PAGE, /<strong>33 bytes\.<\/strong>/);
  assert.match(PAGE, /The DEFLATE stream inside is <strong>15 bytes<\/strong>, 43% of the input/);
  assert.ok(PAGE.includes(`<code>${ex.raw.toString("hex").match(/../g).join(" ")}</code>`), "hex of zlib's output");
  assert.match(PAGE, /That makes 119 bits; one more bit of padding fills the 15th byte\./);
  assert.match(PAGE, /zlib wrote 119 bits; the parse in the <a href="#window">window figure<\/a> needs 103\./);

  const walk = text(PAGE.match(/<bh-codewalk[^>]*id="bit-walk"[\s\S]*?<code>([\s\S]*?)<\/code>/)[1]).split("\n");
  assert.equal(walk.length, 20, "one line per field");
  const shown = walk.map((l) => l.split(/\s+/)[0]);
  shown.forEach((b) => assert.match(b, /^[01]+$/));
  const read = ex.fields.flatMap((f) => [f.bits, f.extraBits].filter(Boolean));
  assert.deepEqual(shown, read, "the walk shows every field, in the order the decoder reads it");
  // Each codewalk step's line range names the right fields.
  const at = (n) => walk[n - 1];
  assert.match(at(1), /BFINAL = 1/);
  assert.match(at(11), /length symbol 257: length 3/);
  assert.match(at(13), /distance 7$/);
  assert.match(at(17), /length 22$/);
  assert.match(at(19), /distance 12$/);
  assert.match(at(20), /end of block/);
});

test("the block-type chart and the dynamic-header numbers match the recorded zlib streams", () => {
  const pct = (bytes, n) => (Math.round((bytes / n) * 1000) / 10).toFixed(1);
  const rowFor = (label) => {
    const m = PAGE.match(new RegExp(`<tr><td>${label.replace(/[()×]/g, "\\$&")}</td>((?:<td>[^<]*</td>){4})</tr>`));
    assert.ok(m, `chart row ${label}`);
    return [...m[1].matchAll(/<td>([^<]*)<\/td>/g)].map((c) => c[1]);
  };
  const zlibBytes = [REFERENCE.example.length / 2, REFERENCE.paragraph.length / 2, REFERENCE.noise];
  for (const [i, [label, data]] of [["abracadabra ×3 (35 B)", utf8(EXAMPLE)], [`A paragraph (${utf8(PARAGRAPH).length} B)`, utf8(PARAGRAPH)], ["Random bytes (1 KiB)", noise()]].entries()) {
    const r = Deflate.encode(data);
    const want = [r.bits.stored, r.bits.fixed, r.bits.dynamic].map((b) => pct(Math.ceil(b / 8), data.length));
    want.push(pct(zlibBytes[i], data.length));
    assert.deepEqual(rowFor(label), want, label);
  }

  const t = trace(Buffer.from(REFERENCE.paragraph, "hex"));
  assert.equal(t.blocks.length, 1);
  const { type, hlit, hdist, hclen, headerBits } = t.blocks[0];
  assert.equal(type, "dynamic");
  assert.ok(PAGE.includes(`(<code>HLIT</code> = ${hlit}, <code>HDIST</code> = ${hdist}, <code>HCLEN</code> = ${hclen}, then the lengths) is ${headerBits} bits, about ${Math.round(headerBits / 8)} bytes.`));
});

test("the playground's no-JavaScript state is the encoder's result for its default text", () => {
  const input = byId("lab-text");
  assert.equal(input, EXAMPLE);
  const data = utf8(input), r = Deflate.encode(data), nf = (n) => n.toLocaleString("en");
  assert.equal(byId("lab-raw"), nf(r.rawBits));
  assert.equal(byId("lab-huff"), nf(r.huffmanOnlyBits));
  assert.equal(byId("lab-lz"), nf(r.bits.fixed));
  assert.equal(byId("lab-both"), nf(r.bits.dynamic));
  assert.equal(byId("lab-header"), nf(r.headerBits));
  assert.equal(byId("lab-out"), nf(r.bytes.length));
  assert.equal(byId("lab-type"), r.best);
  assert.equal(byId("lab-summary"), Deflate.summary(r, data.length));
  const rows = PAGE.match(/<tbody id="lab-table">([\s\S]*?)<\/tbody>/)[1].match(/<tr>/g).length;
  assert.equal(rows, r.tokens.length);
});

test("the alphabet table's examples are the encoder's own mapping", () => {
  const table = text(PAGE.match(/<div class="table-wrap wide" id="alphabets"[\s\S]*?<\/table>/)[0]);
  const len = (n) => Deflate.lengthSymbol(n), dist = (n) => Deflate.distanceCode(n);
  assert.deepEqual([len(4).sym, len(4).nExtra], [258, 0]);
  assert.match(table, /length 4 → 258/);
  assert.deepEqual([len(23).sym, len(23).nExtra, len(26).sym, len(27).sym], [270, 2, 270, 271]);
  assert.match(table, /length 23 → 270 \(23–26\) \+ 2 bits/);
  assert.deepEqual([dist(7).code, dist(7).nExtra, dist(8).code, dist(12).code, dist(12).nExtra, dist(9).code], [5, 1, 5, 6, 2, 6]);
  assert.match(table, /distance 7 → d5 \(7–8\) \+ 1 bit; 12 → d6 \(9–12\) \+ 2 bits/);
  // The ranges in the table: exact symbols up to length 10 and distance 4, then buckets.
  assert.deepEqual([len(3).sym, len(10).sym, len(10).nExtra, len(11).sym, len(11).nExtra, len(257).sym, len(257).nExtra, len(258).sym, len(258).nExtra], [257, 264, 0, 265, 1, 284, 5, 285, 0]);
  assert.deepEqual([dist(4).code, dist(4).nExtra, dist(5).code, dist(5).nExtra, dist(32768).code, dist(32768).nExtra], [3, 0, 4, 1, 29, 13]);
});

test("the alphabet explorer's strips and default state are the encoder's mapping", () => {
  const lab = PAGE.match(/<bh-playground class="wide" id="alphabet-lab">[\s\S]*?<\/bh-playground>/)[0];
  const boxes = [...lab.matchAll(/data-sym="(\d+|d\d+)" title="[^:]+: (length|distance) ([\d,]+)(?:–([\d,]+))?(?:, (\d+) extra bits?)?"/g)];
  assert.equal(boxes.length, 29 + 30, "29 length symbols and 30 distance symbols");
  const num = (t) => +t.replace(/,/g, "");
  for (const [, sym, kind, lo, hi = lo, n = "0"] of boxes) {
    for (const v of [num(lo), num(hi)]) {
      const r = kind === "length" ? Deflate.lengthSymbol(v) : Deflate.distanceCode(v);
      assert.equal(kind === "length" ? String(r.sym) : `d${r.code}`, sym, `${kind} ${v}`);
      assert.equal(r.nExtra, +n, `${sym} extra bits`);
    }
    // The range is exactly the values that map to this symbol: one below and one above map elsewhere.
    const map = (v) => (kind === "length" ? String(Deflate.lengthSymbol(v).sym) : `d${Deflate.distanceCode(v).code}`);
    if (num(lo) > (kind === "length" ? 3 : 1)) assert.notEqual(map(num(lo) - 1), sym);
    if (num(hi) < (kind === "length" ? 258 : 32768)) assert.notEqual(map(num(hi) + 1), sym);
  }
  // Without JavaScript the explorer shows length 23, the worked example's long copy.
  assert.match(lab, /<code id="al-naive">w23<\/code>/);
  assert.match(lab, /<code id="al-symbol">270<\/code>/);
  assert.match(lab, /<code id="al-extra">0<\/code>/);
  assert.match(lab, /data-sym="270" title="[^"]*" aria-current="true"/);
});

test("the bit walk's output figure is what zlib's stream decodes to", () => {
  // Replay the recorded stream's tokens: which bytes are literals, which are copies, and which
  // bytes a copy reads after writing them itself.
  const kinds = [], copies = [];
  let len = 0;
  for (const f of example().fields) {
    if (f.kind === "literal") kinds.push("c2");
    if (f.kind === "length") len = f.length;
    if (f.kind === "distance") { copies.push({ at: kinds.length, len, dist: f.distance }); for (let k = 0; k < len; k++) kinds.push("c1"); }
  }
  assert.deepEqual(copies, [{ at: 8, len: 3, dist: 7 }, { at: 13, len: 22, dist: 12 }]);
  const last = copies[1], selfRead = new Set();
  for (let k = 0; k < last.len; k++) if (last.at + k - last.dist >= last.at) selfRead.add(last.at + k - last.dist);
  assert.deepEqual([...selfRead], [13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);

  const fig = PAGE.match(/<figure class="diagram wide" id="bit-output"[\s\S]*?<\/figure>/)[0];
  const cells = [...fig.matchAll(/<g class="node (c[12])( overlap)?" data-id="o(\d+)"><rect [^>]*\/><text[^>]*>([^<]*)<\/text><\/g>/g)];
  assert.equal(cells.length, EXAMPLE.length);
  cells.forEach(([, tone, overlap, i, ch]) => {
    assert.equal(tone, kinds[+i], `byte ${i} kind`);
    assert.equal(!!overlap, selfRead.has(+i), `byte ${i} striping`);
    assert.equal(ch === "␣" ? " " : ch, EXAMPLE[+i]);
  });
  // The arc runs from the copy's first write back to its first read; the brackets span both ranges.
  assert.match(fig, /data-id="copy2" d="M270 36 C270 0 34 0 34 25"/);
  assert.match(fig, />copied from: bytes 1–22</);
  assert.match(fig, />written to: bytes 13–34</);
});

test("the plain-field table's widths are the ones that decode real streams", () => {
  const table = text(PAGE.match(/<div class="table-wrap wide" id="plain-fields"[\s\S]*?<\/table>/)[0]);
  const rows = Object.fromEntries([...PAGE.match(/<div class="table-wrap wide" id="plain-fields"[\s\S]*?<\/tbody>/)[0]
    .matchAll(/<tr><td>(.*?)<\/td><td class="num">(.*?)<\/td>/g)].map((m) => [text(m[1]), m[2]]));
  assert.deepEqual(rows, {
    BFINAL: "1", BTYPE: "2", "length extra bits": "0–5", "distance extra bits": "0–13",
    HLIT: "5", HDIST: "5", HCLEN: "4", "code-length-code lengths": "3 each", "run extra bits": "2, 3 or 7",
    alignment: "0–7", "LEN, NLEN": "16 each", "stored bytes": "8 each", "final padding": "0–7",
  });
  assert.match(table, /the run's count, minus 3, 3 or 11/);

  // The tracer reads a dynamic header with exactly these widths (5, 5, 4, 3 each, run extras 2/3/7):
  // decoding zlib's real dynamic block back to the paragraph proves them.
  const dyn = trace(Buffer.from(REFERENCE.paragraph, "hex"));
  assert.equal(dyn.blocks[0].type, "dynamic");
  assert.equal(new TextDecoder().decode(dyn.output), PARAGRAPH);

  // Extra-bit widths over every length and distance.
  const lenExtra = new Set(), distExtra = new Set();
  for (let n = 3; n <= 258; n++) lenExtra.add(Deflate.lengthSymbol(n).nExtra);
  for (let n = 1; n <= 32768; n++) distExtra.add(Deflate.distanceCode(n).nExtra);
  assert.deepEqual([Math.min(...lenExtra), Math.max(...lenExtra)], [0, 5]);
  assert.deepEqual([Math.min(...distExtra), Math.max(...distExtra)], [0, 13]);

  // A stored block, byte by byte: BFINAL 1 and BTYPE 00 in the first 3 bits, 5 bits of alignment,
  // then LEN and NLEN (low byte first), then the data.
  const stored = zlib.deflateRawSync(Buffer.from("hello"), { level: 0 });
  assert.deepEqual([...stored], [0b001, 5, 0, 0xfa, 0xff, ...Buffer.from("hello")]);
  assert.equal(new TextDecoder().decode(trace(stored).output), "hello");

  // Final padding: the worked example uses 119 of its 120 bits.
  assert.equal(example().bytes * 8 - example().bitsUsed, 1);
});

test("the fixed code's lengths, budget and the playground's default stream", () => {
  const FIXED = Array.from({ length: 288 }, (_, s) => (s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8));
  const codes = Deflate.canonicalCodes(FIXED);
  assert.equal(codes[97].toString(2).padStart(8, "0"), "10010001", "a is 10010001 in the fixed code");
  assert.equal(codes[0].toString(2).padStart(8, "0"), "00110000");
  const budget = FIXED.reduce((sum, l) => sum + 2 ** -l, 0);
  assert.equal(budget, 1, "the fixed code spends the whole budget");
  const box = PAGE.match(/<details class="disclosure" id="fixed-lengths"[\s\S]*?<\/details>/)[0];
  for (const [label, count, bits] of [["bytes 0–143", 144, 8], ["bytes 144–255", 112, 9], ["256–279", 24, 7], ["280–287", 8, 8]]) {
    const row = text(box.match(new RegExp(`<tr><td>${label}[\\s\\S]*?</tr>`))[0]);
    assert.match(row, new RegExp(`${count}\\s*${bits}`), label);
  }
  // Without JavaScript the playground shows the encoder's own stream for its default text.
  const r = Deflate.encode(utf8(EXAMPLE));
  assert.equal(byId("lab-hex"), Array.from(r.bytes, (b) => b.toString(16).padStart(2, "0")).join(" "));
  assert.equal(byId("lab-stream-bits"), String(r.bits[r.best]));
  assert.equal(byId("lab-stream-type"), r.best);
});

test("the BTYPE table matches what zlib accepts", () => {
  // First byte: BFINAL in bit 0, BTYPE in bits 1–2 (read low bit first).
  assert.equal(zlib.inflateRawSync(Buffer.from([0b001, 0x00, 0x00, 0xff, 0xff])).length, 0, "00: an empty stored block");
  assert.equal(zlib.inflateRawSync(Buffer.from([0b011, 0x00])).length, 0, "01: a fixed block holding only end-of-block");
  assert.throws(() => zlib.inflateRawSync(Buffer.from([0b111, 0x00, 0x00, 0x00])), /invalid block type/, "11 is reserved");
  const btype = example().fields.find((f) => f.kind === "btype");
  assert.deepEqual([btype.bits, btype.value], ["10", 1], "fixed (01) arrives as 1, then 0");
  const table = text(PAGE.match(/<div class="table-wrap" id="btype"[\s\S]*?<\/table>/)[0]);
  assert.match(table, /01\s*1, then 0\s*fixed Huffman codes/);
  assert.match(table, /11\s*1, then 1\s*reserved: invalid/);
});

test("the Huffman and canonical-code figures agree with the algorithm", () => {
  const counts = new Array(256).fill(0);
  for (const ch of "abracadabra") counts[ch.charCodeAt(0)]++;
  const lengths = Deflate.codeLengths(counts, 15);
  const total = [..."abracadabra"].reduce((n, ch) => n + lengths[ch.charCodeAt(0)], 0);
  assert.equal(total, 23, "any optimal tie-break costs 23 bits");
  const canon = Deflate.canonicalCodes([1, 3, 3, 3, 3]); // a, b, c, d, r
  assert.deepEqual(canon.map((c, i) => c.toString(2).padStart([1, 3, 3, 3, 3][i], "0")), ["0", "100", "101", "110", "111"]);
});

test("the page has no audio, video or external media", () => {
  assert.doesNotMatch(PAGE, /<(audio|video|iframe|embed|object)\b/i);
  for (const m of PAGE.matchAll(/\ssrc="([^"]+)"/g)) assert.doesNotMatch(m[1], /^(https?:)?\/\//, `external src ${m[1]}`);
});
