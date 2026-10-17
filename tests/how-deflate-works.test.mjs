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
