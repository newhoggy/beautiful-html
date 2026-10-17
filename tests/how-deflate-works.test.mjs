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

test("the dynamic bit walk is every bit of the encoder's dynamic block, in read order", () => {
  const stream = Deflate.encode(utf8(EXAMPLE)).streams.dynamic;
  assert.equal(new TextDecoder().decode(zlib.inflateRawSync(stream)), EXAMPLE, "zlib reads it back");
  const all = Array.from({ length: stream.length * 8 }, (_, i) => (stream[i >> 3] >> (i & 7)) & 1).join("");
  const walk = text(PAGE.match(/<bh-codewalk[^>]*id="dyn-walk"[\s\S]*?<code>([\s\S]*?)<\/code>/)[1]).split("\n");
  assert.equal(walk.length, 56);
  const shown = walk.map((l) => l.slice(0, 13).trim().replace(" +", ""));
  shown.forEach((b) => assert.match(b, /^[01]+$/));
  assert.equal(shown.join(""), all, "the walk shows all 208 bits, padding included");

  // Each line names what the tracer decodes there.
  const t = trace(Buffer.from(stream));
  const fields = t.fields.filter((f) => f.kind !== "bfinal" && f.kind !== "btype");
  const desc = walk.slice(2, 2 + fields.length).map((l) => l.slice(13));
  fields.forEach((f, i) => {
    const d = desc[i];
    const rev = [...f.bits].reverse().join(""); // a plain number, shown the usual way round
    const off = { hlit: 257, hdist: 1, hclen: 4 }[f.kind];
    if (off) {
      assert.equal(d, `${f.kind.toUpperCase()}: ${rev} = ${f.value - off}, + ${off} = ${f.value}`);
      assert.equal(parseInt(rev, 2), f.value - off);
    }
    if (f.kind === "cllen") {
      assert.equal(d, f.value ? `CL symbol ${f.symbol}: ${rev} = ${f.value} bits` : `CL symbol ${f.symbol}: 000 = 0, unused`);
      assert.equal(parseInt(rev, 2), f.value);
    }
    if (f.kind === "clsym") assert.match(d, new RegExp(`^${f.symbol}: `), d);
    if (f.kind === "clsym" && f.symbol >= 16) assert.match(d, new RegExp(`: ${f.count} zeros, `), d);
    if (f.kind === "clsym" && f.symbol < 16 && f.value) assert.match(d, new RegExp(`gets ${f.value} bits?$`), d);
    if (f.kind === "literal") assert.match(d, new RegExp(`^literal .* \\(${f.value}\\)$`), d);
    if (f.kind === "length") assert.equal(d, `length symbol ${f.value} → ${f.length}`);
    if (f.kind === "distance") assert.equal(d, `distance d${f.value} → ${f.distance}`);
    if (f.kind === "end") assert.equal(d, "end of block (256)");
  });

  assert.equal(walk[1].slice(13), "BTYPE: 10 = 2, dynamic");

  // The first byte, most significant bit on the left: HLIT | BTYPE | BFINAL.
  assert.equal(stream[0], 0x75);
  assert.deepEqual([stream[0] >> 3, (stream[0] >> 1) & 3, stream[0] & 1], [14, 2, 1]);
  assert.match(PAGE, /<code>0 1 1 1 0 \| 1 0   \| 1\nHLIT      \| BTYPE \| BFINAL\n= 14      \| = 2   \| = 1<\/code>/);

  // "Isn't sending all those zeros wasteful?": the literal/length list's zeros and used lengths.
  const lit = fields.filter((f) => f.kind === "clsym" && f.at < f.hlit);
  const zeros = lit.filter((f) => f.value === 0), used = lit.filter((f) => f.value > 0);
  const bitsOf = (list) => list.reduce((sum, f) => sum + f.bits.length + (f.extraBits || "").length, 0);
  assert.equal(zeros.reduce((sum, f) => sum + f.count, 0), 262);
  assert.deepEqual([zeros.filter((f) => f.count > 1).length, zeros.filter((f) => f.count === 1).length], [6, 1]);
  assert.deepEqual([bitsOf(zeros), bitsOf(used), used.length], [56, 21, 9]);
  assert.equal(9 * (Math.ceil(Math.log2(286)) + 4), 117);
  const note = text(PAGE.match(/<details class="disclosure" id="zero-lengths"[\s\S]*?<\/details>/)[0]);
  assert.match(note, /271 symbols in 77 bits: its 262 zeros take 56 bits, as 6 runs and one lone zero, and the 9 used lengths take 21/);
  assert.match(note, /117 bits/);
  // Every bit that says "unused": the code-length code's zeros (3 bits each), and the zero runs of both lists.
  const cl = fields.filter((f) => f.kind === "cllen"), dist = fields.filter((f) => f.kind === "clsym" && f.at >= f.hlit);
  const clZero = cl.filter((f) => f.value === 0), distZero = dist.filter((f) => f.value === 0);
  assert.deepEqual([clZero.length, cl.length, bitsOf(clZero)], [11, 18, 33]);
  assert.equal(bitsOf(distZero), 6);
  assert.equal(bitsOf(clZero) + bitsOf(zeros) + bitsOf(distZero), 95);
  assert.equal(t.blocks[0].headerBits, 159);
  assert.match(note, /saying "unused" is most of the header: 95 of its 159 bits\. Besides those 56, 6 bits mark d0–d4 as unused, and 33 go on the code-length code's own list, where 11 of the 18 lengths are 0 at 3 bits each/);
  assert.match(text(PAGE.match(/<bh-cw-step lines="6-23">[\s\S]*?<\/bh-cw-step>/)[0]), /11 of these 18 lengths are 0, and each costs the full 3 bits: 33 bits/);

  // The two levels: which symbols each alphabet uses, their code lengths, and the walk lines.
  const litUsed = lit.filter((f) => f.value > 0), distUsed = dist.filter((f) => f.value > 0), clUsed = cl.filter((f) => f.value > 0);
  assert.deepEqual(litUsed.map((f) => f.at).sort((x, y) => x - y), [32, 97, 98, 99, 100, 114, 256, 258, 270]);
  assert.deepEqual([...new Set(litUsed.map((f) => f.value))].sort(), [2, 3, 4]);
  assert.deepEqual(distUsed.map((f) => [f.at - f.hlit, f.value]), [[5, 1], [6, 1]]);
  assert.deepEqual(clUsed.map((f) => f.symbol).sort((x, y) => x - y), [0, 1, 2, 3, 4, 17, 18]);
  assert.deepEqual([Math.min(...clUsed.map((f) => f.value)), Math.max(...clUsed.map((f) => f.value))], [2, 5]);
  const levels = text(PAGE.match(/<div class="table-wrap wide" id="dynamic-levels"[\s\S]*?<\/table>/)[0]);
  assert.match(levels, /literal\/length\s*9: a, b, r, c, d, ␣, 256, 258, 270\s*2, 3 or 4 bits\s*24–39\s*43–55/);
  assert.match(levels, /distance\s*2: d5, d6\s*1 bit each\s*40–42\s*51, 54/);
  assert.match(levels, /code-length \(CL\)\s*7: 1, 2, 3, 4 \(the lengths above\), 0, 17, 18 \(for zeros\)\s*2 to 5 bits\s*6–23\s*24–42/);
  // Those line ranges really hold those parts of the walk.
  assert.ok(walk.slice(5, 23).every((l) => l.includes("CL symbol")));
  assert.ok(walk.slice(23, 39).every((l) => !/^[01 +]+\s+d/.test(l.slice(13))) && walk[39].includes("d0–d4"));
  assert.match(walk[50], /distance d5/);
  assert.match(walk[53], /distance d6/);

  // The fixed order: 16, 17, 18, then 0, then outward from 8, then 15. For the paragraph zlib cuts the last three.
  const ORDER = fields.filter((f) => f.kind === "cllen").map((f) => f.symbol).concat(15);
  assert.deepEqual(ORDER, [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
  const outward = [8]; for (let k = 1; k <= 7; k++) outward.push(8 - k, 8 + k);
  assert.deepEqual(ORDER.slice(4, 18), outward.slice(0, 14));
  const para = trace(Buffer.from(REFERENCE.paragraph, "hex"));
  assert.equal(para.blocks[0].hclen, 16);
  assert.deepEqual(ORDER.slice(16), [14, 1, 15]);
  const paraLengths = para.fields.filter((f) => f.kind === "clsym" && f.symbol >= 1 && f.symbol <= 15).map((f) => f.symbol);
  assert.deepEqual([Math.min(...paraLengths), Math.max(...paraLengths)], [2, 8]);
  assert.match(PAGE, /For the paragraph, zlib's codes use lengths 2 to 8, so <code>HCLEN<\/code> is 16 and the last three, 14, 1 and 15, are never sent\./);

  // The hex, and where the bits go.
  assert.ok(PAGE.includes(`<code>${Array.from(stream, (b) => b.toString(16).padStart(2, "0")).join(" ")}</code>`));
  const n = (kinds) => fields.filter((f) => kinds.includes(f.kind)).reduce((sum, f) => sum + f.bits.length + (f.extraBits || "").length, 0);
  const parts = [3, n(["hlit", "hdist", "hclen"]), n(["cllen"]), n(["clsym"]), n(["literal", "length", "distance", "end"])];
  assert.deepEqual(parts, [3, 14, 54, 91, 41]);
  assert.equal(parts.reduce((a, b) => a + b), t.bitsUsed);
  const table = text(PAGE.match(/<div class="table-wrap" id="dynamic-bits"[\s\S]*?<\/table>/)[0]);
  assert.match(table, /HLIT, HDIST and HCLEN\s*14\s*0/);
  assert.match(table, /code-length-code lengths\s*54/);
  assert.match(table, /the code lengths themselves\s*91/);
  assert.match(table, /to end of block\s*41\s*100/);
  assert.match(table, /total\s*203\s*103/);
  assert.equal(Deflate.encode(utf8(EXAMPLE)).bits.fixed - 3, 100);
});

test("the page's own glossary: A–Z, no clash with the site glossary, every link resolves", () => {
  const terms = (html) => [...html.matchAll(/<dt id="([^"]+)"(?: data-aliases="([^"]*)")?>([^<]+)<\/dt>/g)]
    .map(([, id, aliases = "", term]) => ({ id, names: [term, ...aliases.split(",").map((x) => x.trim()).filter(Boolean)].map((n) => n.toLowerCase()), term }));
  const local = terms(PAGE.match(/<dl class="glossary wide">[\s\S]*?<\/dl>/)[0]);
  const site = terms(fs.readFileSync(path.join(ROOT, "docs/glossary.html"), "utf8"));
  assert.equal(local.length, 19);
  const sorted = [...local].sort((x, y) => x.term.localeCompare(y.term, "en", { sensitivity: "base" }));
  assert.deepEqual(local.map((e) => e.id), sorted.map((e) => e.id), "kept A–Z");
  const siteNames = new Map(site.flatMap((e) => e.names.map((n) => [n, e.id])));
  for (const e of local) for (const n of e.names) assert.ok(!siteNames.has(n), `"${n}" is already the site glossary's "${siteNames.get(n)}"`);
  const ids = new Set([...PAGE.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const box = PAGE.match(/<h2 id="terms">[\s\S]*?<\/dl>/)[0];
  for (const [, href] of box.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(href), `#${href}`);
  const siteIds = new Set(site.map((e) => e.id));
  for (const [, href] of box.matchAll(/href="glossary\.html#([^"]+)"/g)) assert.ok(siteIds.has(href), `glossary.html#${href}`);
});

test("the code-length alphabet table holds for every run symbol in real dynamic blocks", () => {
  const table = PAGE.match(/<div class="table-wrap" id="cl-alphabet"[\s\S]*?<\/table>/)[0];
  const rows = Object.fromEntries([...table.matchAll(/<tr><td>(\d+)<\/td><td>[^<]*<\/td><td class="num">(\d+)<\/td><td>(.*?)<\/td><\/tr>/g)]
    .map(([, sym, n, count]) => [sym, { n: +n, count: text(count) }]));
  assert.deepEqual(rows, { 16: { n: 2, count: "3–6 times" }, 17: { n: 3, count: "3–10" }, 18: { n: 7, count: "11–138" } });
  // Each range is its minimum plus every value the extra bits can hold.
  for (const [sym, min] of [[16, 3], [17, 3], [18, 11]]) assert.match(rows[sym].count, new RegExp(`^${min}–${min + 2 ** rows[sym].n - 1}`));
  let seen = 0;
  for (const stream of [Deflate.encode(utf8(EXAMPLE)).streams.dynamic, Buffer.from(REFERENCE.paragraph, "hex")]) {
    for (const f of trace(Buffer.from(stream)).fields.filter((x) => x.kind === "clsym" && x.symbol >= 16)) {
      const { n } = rows[f.symbol], min = f.symbol === 18 ? 11 : 3;
      assert.equal(f.extraBits.length, n, `symbol ${f.symbol} carries ${n} extra bits`);
      assert.ok(f.count >= min && f.count <= min + 2 ** n - 1, `symbol ${f.symbol} count ${f.count}`);
      seen++;
    }
  }
  assert.ok(seen >= 10);
});

test("the four steps to sending a dynamic code cost what the page says", () => {
  // Each step's header cost, computed from the real blocks' code lengths and run symbols.
  const steps = (buf) => {
    const tr = trace(buf), b = tr.blocks[0], runs = tr.fields.filter((f) => f.kind === "clsym");
    const data = tr.fields.filter((f) => ["literal", "length", "distance", "end"].includes(f.kind)).reduce((s, f) => s + f.bits.length + (f.extraBits || "").length, 0);
    return {
      data,
      naive: (286 + 30) * 4,                                                    // 1. every length, 4 bits
      counts: 5 + 5 + (b.hlit + b.hdist) * 4,                                   // 2. counts, then lengths up to the highest used
      runs: 5 + 5 + runs.length * 5 + runs.reduce((s, f) => s + f.extraBits.length, 0), // 3. run symbols as plain 5-bit numbers
      coded: b.headerBits,                                                      // 4. DEFLATE's scheme
      runSymbols: runs.length,
    };
  };
  const ex = steps(Buffer.from(Deflate.encode(utf8(EXAMPLE)).streams.dynamic)), para = steps(Buffer.from(REFERENCE.paragraph, "hex"));
  assert.deepEqual([ex.naive, ex.counts, ex.runs, ex.coded, ex.data, ex.runSymbols], [1264, 1122, 146, 159, 41, 19]);
  assert.deepEqual([para.naive, para.counts, para.runs, para.coded, para.data], [1264, 1158, 443, 352, 1521]);
  const chart = PAGE.match(/<figure class="frame wide" id="header-steps">[\s\S]*?<\/figure>/)[0];
  const rows = [...chart.matchAll(/<tr><td>[^<]*<\/td><td>(\d+)<\/td><td>(\d+)<\/td><\/tr>/g)].map((m) => [+m[1], +m[2]]);
  assert.deepEqual(rows, [[ex.naive, para.naive], [ex.counts, para.counts], [ex.runs, para.runs], [ex.coded, para.coded]]);
  const prose = text(PAGE.match(/<h2 id="dynamic-header">[\s\S]*?<figure class="frame wide" id="header-steps">/)[0]);
  assert.match(prose, /That is 1,264 bits, 158 bytes/);
  assert.match(prose, /The example's data is only 41 bits, so its code table would cost 30 times as much/);
  assert.equal(Math.floor(ex.naive / ex.data), 30);
  assert.match(prose, /Even the paragraph's data, 1,521 bits/);
  assert.match(prose, /1,122 bits for the example and 1,158 for the paragraph/);
  assert.match(prose, /The header drops to 146 bits for the example \(step 3 in the figure\) and 443 for the paragraph/);
  assert.match(prose, /it costs 159 bits for the example \(step 4 in the figure\) and 352 for the paragraph\. For the paragraph, coding the run symbols saved another 91 bits\. For the tiny example it cost 13 more: describing the small code took more than it saved on just 19 run symbols/);
  assert.equal(para.runs - para.coded, 91);
  assert.equal(ex.coded - ex.runs, 13);
  // "the example's 262 unused literal/length symbols take just 7"
  const exRuns = trace(Buffer.from(Deflate.encode(utf8(EXAMPLE)).streams.dynamic)).fields.filter((f) => f.kind === "clsym" && f.at < f.hlit && f.value === 0);
  assert.deepEqual([exRuns.reduce((s, f) => s + f.count, 0), exRuns.length], [262, 7]);
  assert.match(prose, /the example's 262 unused literal\/length symbols take just 7/);
});

test("the page finishes the fixed scheme before building up to the dynamic one", () => {
  const order = [...PAGE.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["question", "two-ideas", "lz77", "huffman", "joining", "join-example", "two-alphabets",
    "block-types", "one-block", "fixed-limits",                   // the fixed code, its bit walk, and where it falls short
    "example-code", "canonical", "dynamic-header", "dynamic-runs", "dynamic-block", // the build-up to a dynamic block, then its walk
    "choosing", "not-symbols", "try-it", "serial", "edge-cases", "terms", "further-reading"]);
});

test("where the fixed code falls short: the paragraph's fitted codes and totals", () => {
  const tr = trace(Buffer.from(REFERENCE.paragraph, "hex")), b = tr.blocks[0];
  const lengths = []; for (const f of tr.fields.filter((x) => x.kind === "clsym")) for (let k = 0; k < f.count; k++) lengths.push(f.value);
  const fixedLen = (sym) => (sym < 144 ? 8 : sym < 256 ? 9 : sym < 280 ? 7 : 8);
  const data = tr.fields.filter((f) => ["literal", "length", "distance", "end"].includes(f.kind));
  const lits = data.filter((f) => f.kind === "literal");
  const counts = new Map(); for (const f of lits) counts.set(f.value, (counts.get(f.value) || 0) + 1);
  const extra = (f) => (f.extraBits || "").length;
  const fitted = data.reduce((s, f) => s + f.bits.length + extra(f), 0);
  const fixed = data.reduce((s, f) => s + (f.kind === "distance" ? 5 : fixedLen(f.value)) + extra(f), 0);
  const litFitted = lits.reduce((s, f) => s + f.bits.length, 0);
  assert.deepEqual([lits.length, counts.size, lits.length * 8, litFitted, fixed, fitted, b.headerBits, 3 + fixed, 3 + b.headerBits + fitted],
    [233, 38, 1864, 1108, 2375, 1521, 352, 2378, 1876]);
  assert.ok(lits.every((f) => fixedLen(f.value) === 8), "every literal here costs 8 bits in the fixed code");
  const table = text(PAGE.match(/<div class="table-wrap" id="fitted-codes"[\s\S]*?<\/table>/)[0]);
  for (const [ch, times, bits] of [[" ", 32, 3], ["e", 20, 4], ["i", 16, 4], ["s", 15, 4], ["t", 15, 4], ["o", 14, 4], ["k", 1, 8], ["u", 1, 8], ["v", 1, 8], ["x", 1, 8]]) {
    const v = ch.charCodeAt(0);
    assert.equal(counts.get(v), times, `${ch} count`);
    assert.equal(lengths[v], bits, `${ch} fitted length`);
  }
  assert.match(table, /space\s*32\s*8 bits\s*3 bits/);
  assert.match(table, /k, u, v, x\s*1 each\s*8 bits\s*8 bits/);
  const prose = text(PAGE.match(/<h2 id="fixed-limits">[\s\S]*?<h2 id="canonical">/)[0]);
  assert.match(prose, /233 literals, using 38 different bytes/);
  assert.match(prose, /the fixed code spends 1,864 bits and the fitted code 1,108, about 4\.8 bits a literal/);
  assert.equal((litFitted / lits.length).toFixed(1), "4.8");
  assert.match(prose, /the data takes 2,375 bits with the fixed code and 1,521 with the fitted one/);
  assert.match(prose, /for this block that costs 352 bits\. Even so, the block comes to 1,876 bits instead of 2,378, about a fifth smaller/);
  assert.equal(Math.round((1 - 1876 / 2378) * 100), 21);
});

test("the bridges between sections quote real numbers", () => {
  const tr = trace(Buffer.from(REFERENCE.paragraph, "hex"));
  const data = tr.fields.filter((f) => ["literal", "length", "distance", "end"].includes(f.kind));
  const fixedLen = (sym) => (sym < 144 ? 8 : sym < 256 ? 9 : sym < 280 ? 7 : 8), extra = (f) => (f.extraBits || "").length;
  const saved = data.reduce((s, f) => s + (f.kind === "distance" ? 5 : fixedLen(f.value)) + extra(f), 0) - data.reduce((s, f) => s + f.bits.length + extra(f), 0);
  assert.equal(saved, 854);
  assert.match(PAGE, /the fitted code saved 854 bits on the data, and sending it cost 352 of them/);
  // Step 3 → 4: how unequal the paragraph's run symbols are.
  const runs = tr.fields.filter((f) => f.kind === "clsym"), n = (sym) => runs.filter((f) => f.symbol === sym).length;
  assert.deepEqual([runs.length, n(8), n(5), n(0), n(2), n(16)], [78, 14, 14, 12, 1, 0]);
  assert.ok(Math.max(...[...Array(19).keys()].map(n)) === 14, "8 and 5 are the most common");
  assert.match(PAGE, /Of the paragraph's 78, the lengths 8 and 5 appear 14 times each and 0 appears 12 times, while 2 appears once and 16 not at all/);
  // Choosing: the example's dynamic block is twice its fixed one; random bytes grow under both codes.
  const ex = Deflate.encode(utf8(EXAMPLE)), rn = Deflate.encode(noise());
  assert.deepEqual([ex.streams.dynamic.length, ex.streams.fixed.length], [26, 13]);
  assert.ok(rn.streams.fixed.length > 1024 && rn.streams.dynamic.length > 1024);
  assert.match(PAGE, /The example's dynamic block is twice the size of its fixed one, while the paragraph's dynamic block is a fifth smaller than its fixed one/);
});

test("the send-steps figure is the example's real code-length list", () => {
  const tr = trace(Buffer.from(Deflate.encode(utf8(EXAMPLE)).streams.dynamic)), b = tr.blocks[0];
  const runs = tr.fields.filter((f) => f.kind === "clsym");
  const fig = PAGE.match(/<figure class="diagram wide" id="send-steps">[\s\S]*?<\/bh-stepper>/)[0];
  const chips = [...fig.matchAll(/data-id="(r\d+)"><rect [^>]*\/><text[^>]*>(\d+)<\/text><\/g>/g)].map((m) => m[2]);
  const sub = (k) => text(fig.match(new RegExp(`data-id="r${k}-sub"[^>]*>([^<]*)<`))[1]);
  const code = (k) => fig.match(new RegExp(`data-id="r${k}-code"[^>]*>([^<]*)<`))[1];
  const cost = (k) => fig.match(new RegExp(`data-id="r${k}-cost"[^>]*>([^<]*)<`))[1];
  assert.deepEqual(chips, runs.map((f) => String(f.symbol)), "one chip per run symbol, in order");
  runs.forEach((f, k) => {
    assert.equal(code(k), f.bits, `chip ${k} code`);
    assert.equal(cost(k), f.extraBits ? `${f.bits.length}+${f.extraBits.length}` : String(f.bits.length));
    if (f.symbol >= 16) assert.equal(sub(k), `×${f.count}`);
  });
  // Each step's total, as the counter shows it.
  const used = runs.filter((f) => f.value > 0).length, extra = runs.reduce((s, f) => s + f.extraBits.length, 0);
  const cl = tr.fields.filter((f) => f.kind === "cllen").length;
  assert.deepEqual([316 * 4, 10 + (b.hlit + b.hdist) * 4, 10 + runs.length * 5 + extra, b.headerBits], [1264, 1122, 146, 159]);
  assert.deepEqual([used, 286 - b.hlit + 30 - b.hdist, runs.length, extra, cl * 3, b.headerBits - 14 - cl * 3], [11, 38, 19, 41, 54, 91]);
  assert.match(PAGE, /const TOTAL = \[1264, 1122, 146, 159\];/);
  assert.match(PAGE, /const NOTE = \["316 slots × 4 bits", "10 \+ 278 × 4", "10 \+ 19 × 5 \+ 41 extra bits", "14 \+ 54 \+ 91"\];/);
  assert.match(fig, /Only the 11 marked slots are not zero\. 1,264 bits/);
  assert.match(fig, /so 38 slots go\. 1,122 bits/);
  assert.match(fig, /19 symbols at 5 bits each, plus their extra bits: 146 bits/);
  assert.match(fig, /With the 54 bits that describe this code, that makes 159 bits: for this short list, 13 more than step 3/);
});

test("the example's tree is the encoder's Huffman code for its LZ77 symbols", () => {
  const tr = trace(Buffer.from(Deflate.encode(utf8(EXAMPLE)).streams.dynamic));
  const counts = new Map();
  for (const f of tr.fields) if (["literal", "length", "end"].includes(f.kind)) counts.set(f.value, (counts.get(f.value) || 0) + 1);
  const lengths = Deflate.codeLengths(Array.from({ length: 286 }, (_, s) => counts.get(s) || 0), 15);
  const fig = PAGE.match(/<figure class="diagram wide" id="example-tree">[\s\S]*?<\/figure>/)[0];
  const SYM = { "x-sp": 32, "x-b": 98, "x-c": 99, "x-d": 100, "x-r": 114, "x-end": 256, "x-258": 258, "x-270": 270, "x-a": 97 };
  // The drawn tree, from its edges: each leaf's depth must be its code length.
  const parent = new Map([...fig.matchAll(/data-id="e-(x-n\d+)-(x-[a-z0-9]+)"/g)].map((m) => [m[2], m[1]]));
  const depth = (id) => (parent.has(id) ? 1 + depth(parent.get(id)) : 0);
  assert.equal([...counts.keys()].length, 9);
  for (const [id, sym] of Object.entries(SYM)) {
    assert.equal(depth(id), lengths[sym], `${id} depth`);
    assert.match(fig, new RegExp(`data-id="${id}-len"[^>]*>${lengths[sym]} bits<`));
    assert.match(fig, new RegExp(`data-id="${id}"><rect [^>]*/><text[^>]*>[^<]+</text><text class="sub"[^>]*>×${counts.get(sym)}<`));
  }
  // Each inner node's weight is the sum of its leaves' counts.
  const kids = new Map(); for (const [c, p] of parent) kids.set(p, [...(kids.get(p) || []), c]);
  const weight = (id) => (SYM[id] !== undefined ? counts.get(SYM[id]) : kids.get(id).reduce((s, k) => s + weight(k), 0));
  for (const m of fig.matchAll(/data-id="(x-n\d+)"><rect [^>]*\/><text[^>]*>(\d+)</g)) assert.equal(+m[2], weight(m[1]), m[1]);
  // 85 bits with the fixed code, 34 with these codes.
  const fixedLen = (s) => (s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8);
  let fixed = 0, fitted = 0; for (const [s, n] of counts) { fixed += n * fixedLen(s); fitted += n * lengths[s]; }
  assert.deepEqual([fixed, fitted], [85, 34]);
  assert.match(PAGE, /With the fixed code these 11 symbols cost 85 bits/);
  assert.match(PAGE, /The 11 symbols now cost 34 bits instead of 85/);
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
