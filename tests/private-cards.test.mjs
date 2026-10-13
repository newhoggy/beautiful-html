import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { site } from "./support/private-site.mjs";
import {
  CARD_FILE_HEADER, buildBlob, cardFromDoc, decryptCard, docCardHtml, encryptCard, escapeHtml, mergeEntries,
  parseCardsFile, renderCardsFile, tryDecryptCard, validateCardsFile,
} from "../scripts/private-cards.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const newKey = () => crypto.randomBytes(32).toString("base64url");
const card = { title: "Family trip", description: "Where we are going & why", kind: "explainer", status: "draft", date: "2026-10-12", tags: ["travel", "plans"] };

// ---- blobs ---------------------------------------------------------------------------------

test("a blob round-trips under its key and slug", () => {
  const key = newKey();
  assert.deepEqual(decryptCard(encryptCard(card, key, "family-trip"), key, "family-trip"), card);
});

test("a blob does not open under the wrong key or the wrong slug", () => {
  const key = newKey(), blob = encryptCard(card, key, "family-trip");
  assert.equal(tryDecryptCard(blob, newKey(), "family-trip"), null);
  assert.equal(tryDecryptCard(blob, key, "other-page"), null);
  assert.equal(tryDecryptCard("AAAA", key, "family-trip"), null);
});

test("a card is not a page payload, and a page payload is not a card", () => {
  const key = newKey(), kb = Buffer.from(key, "base64url");
  // A page payload as `bh seal` writes it: no AAD.
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", kb, iv);
  const page = Buffer.concat([iv, cipher.update(zlib.gzipSync("<html></html>")), cipher.final(), cipher.getAuthTag()]).toString("base64");
  assert.equal(tryDecryptCard(page, key, "family-trip"), null);
  const raw = Buffer.from(encryptCard(card, key, "family-trip"), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", kb, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  assert.throws(() => Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]));
});

test("an unchanged card keeps its blob, a changed card or key gets a new one", () => {
  const key = newKey(), blob = encryptCard(card, key, "family-trip");
  assert.equal(buildBlob(blob, { ...card }, key, "family-trip"), blob);
  assert.notEqual(buildBlob(blob, { ...card, title: "Other" }, key, "family-trip"), blob);
  assert.notEqual(buildBlob(blob, card, newKey(), "family-trip"), blob);
  assert.notEqual(buildBlob(undefined, card, key, "family-trip"), blob);
});

test("two pages of a group open under one key, a page of another group does not", () => {
  const group = newKey(), other = newKey();
  const blobs = { a: encryptCard(card, group, "a"), b: encryptCard(card, group, "b"), c: encryptCard(card, other, "c") };
  assert.ok(tryDecryptCard(blobs.a, group, "a") && tryDecryptCard(blobs.b, group, "b"));
  assert.equal(tryDecryptCard(blobs.c, group, "c"), null);
  assert.ok(tryDecryptCard(blobs.c, other, "c"));
});

test("cardFromDoc carries what a public card shows", () => {
  const d = { title: "T", description: "D", kind: "decision", status: "accepted", date: "2026-01-02", supersededBy: "docs/new-one.html", example: false };
  assert.deepEqual(cardFromDoc(d, ["a", "b"]), { title: "T", description: "D", kind: "decision", status: "accepted", date: "2026-01-02", tags: ["a", "b"], supersededBy: "new-one" });
  assert.equal("supersededBy" in cardFromDoc({ ...d, supersededBy: "" }, []), false);
});

// ---- the card file -------------------------------------------------------------------------

const entry = (slug) => ({ slug, blob: encryptCard(card, newKey(), slug) });

test("the card file renders sorted and parses back", () => {
  const entries = [entry("b-page"), entry("a-page")];
  const text = renderCardsFile(entries);
  assert.ok(text.startsWith(CARD_FILE_HEADER));
  const parsed = parseCardsFile(text);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.entries.map((e) => e.slug), ["a-page", "b-page"]);
  assert.equal(renderCardsFile(parsed.entries), text);
  assert.equal(renderCardsFile([]), `${CARD_FILE_HEADER}\nwindow.BH_PRIVATE = { v: 1, cards: [] };\n`);
  assert.deepEqual(validateCardsFile(renderCardsFile([]), new Set()), []);
});

test("the card file is validated against the sealed pages", () => {
  const [a, b] = [entry("a-page"), entry("b-page")];
  const ok = renderCardsFile([a, b]);
  assert.deepEqual(validateCardsFile(ok, new Set(["a-page", "b-page"])), []);
  const has = (problems, re) => assert.ok(problems.some((p) => re.test(p)), `${re}: ${problems.join(" | ")}`);
  const line = (e) => `  { slug: "${e.slug}", blob: "${e.blob}" }`;
  const mutate = (from, to) => { const t = ok.replace(from, to); assert.notEqual(t, ok, "the injection changed nothing"); return t; };
  has(validateCardsFile(mutate(line(a) + ",\n" + line(b), line(b) + ",\n" + line(a)), new Set(["a-page", "b-page"])), /not sorted/);
  has(validateCardsFile(mutate(line(b), line(a)), new Set(["a-page", "b-page"])), /duplicate entry for a-page/);
  has(validateCardsFile(ok, new Set(["a-page"])), /blob for b-page, which has no sealed page/);
  has(validateCardsFile(ok, new Set(["a-page", "b-page", "c-page"])), /sealed page c-page has no private card/);
  has(validateCardsFile(mutate(a.blob, "!!!!"), new Set(["a-page", "b-page"])), /blob for a-page is not valid base64/);
  has(validateCardsFile(mutate(a.blob, a.blob.slice(0, 8)), new Set(["a-page", "b-page"])), /blob for a-page is not valid base64/);
  has(validateCardsFile(mutate("v: 1", "v: 2"), new Set(["a-page", "b-page"])), /`v` must be 1/);
  has(validateCardsFile(ok + "alert(1);\n", new Set(["a-page", "b-page"])), /unrecognised line/);
  has(validateCardsFile("window.x = 1;\n", new Set()), /generated-file header|no window.BH_PRIVATE/);
});

test("merging keeps blobs of pages without plaintext and drops orphans", () => {
  const kept = entry("kept"), orphan = entry("orphan"), old = entry("fresh");
  const merged = mergeEntries([kept, orphan, old], { fresh: "NEW", added: "ADDED" }, new Set(["kept", "fresh", "added"]));
  assert.deepEqual(merged, [{ slug: "added", blob: "ADDED" }, { slug: "fresh", blob: "NEW" }, { slug: "kept", blob: kept.blob }]);
  assert.deepEqual(mergeEntries([], {}, new Set(["unsealed-yet"])), []);
});

// ---- the card markup: the browser builds what `npm run index` writes ----------------------

function moduleApi() {
  const bh = {};
  const context = { window: { bhModules: {} }, document: {}, location: {}, atob, Response, Blob, TextEncoder };
  context.window.bh = bh;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "theme/modules/private-cards.js"), "utf8"), context);
  assert.equal(context.window.bhModules["private-cards.js"], true);
  return bh.privateCards;
}

const serialise = (n) => typeof n === "string" ? escapeHtml(n)
  : `<${n.tag}${n.attrs.map(([k, v]) => (v === "" && k === "data-example" ? ` ${k}` : ` ${k}="${escapeHtml(v)}"`)).join("")}>${n.children.map(serialise).join("")}</${n.tag}>`;
const squash = (html) => html.replace(/>\s+</g, "><").trim();

test("the browser's card equals the one npm run index writes", () => {
  const { cardSpec } = moduleApi();
  const titles = new Map([["docs/new-one.html", "The new one"]]);
  const fixtures = [
    { href: "docs/a.html", title: 'Q&A: "quotes" <b>', description: "Plain", kind: "explainer", status: "draft", date: "2026-10-11", supersededBy: "", example: false, tags: ["ai workflows", "testing"] },
    { href: "docs/b.html", title: "Old", description: "Replaced", kind: "decision", status: "Superseded", date: "2026-01-02", supersededBy: "docs/new-one.html", example: false, tags: [] },
    { href: "docs/c.html", title: "No meta", description: "", kind: "custom-kind", status: "", date: "", supersededBy: "", example: false, tags: ["x"] },
    { href: "docs/d.html", title: "An example", description: "Shown locally", kind: "design", status: "accepted", date: "2026-03-04", supersededBy: "", example: true, tags: ["examples"] },
  ];
  for (const d of fixtures) {
    const { tags, ...doc } = d;
    assert.equal(serialise(cardSpec(doc, tags, titles, false)), squash(docCardHtml(doc, tags, titles)), d.title);
  }
});

test("a private card adds a lock and the word Private, and nothing else", () => {
  const { cardSpec } = moduleApi();
  const doc = { href: "docs/a.html#k=x", title: "T", description: "D", kind: "explainer", status: "draft", date: "2026-10-11", supersededBy: "", example: false };
  const html = serialise(cardSpec(doc, ["t"], new Map(), true));
  assert.match(html, /<span class="card-meta"><span class="card-private"><svg [^>]*aria-hidden="true"[^>]*>.*<\/svg>Private<\/span><span class="badge draft">/);
  assert.equal(html.replace(/<span class="card-private">.*?<\/svg>Private<\/span>/, ""), serialise(cardSpec(doc, ["t"], new Map(), false)));
});

// ---- seal and check, with a fake 1Password CLI ---------------------------------------------

const errorsOf = (out) => (out.match(/(\d+) errors?/) || [])[1];

test("grouped pages share one key, and sealing is idempotent", (t) => {
  const s = site(t);
  s.newPrivate("alpha-plan", "Alpha plan", "kin-circle");
  s.newPrivate("beta-plan", "Beta plan", "kin-circle");
  s.newPrivate("solo-note", "Solo note");
  const sealed = s.run(["seal"]);
  assert.equal(sealed.code, 0, sealed.out);
  assert.match(sealed.out, /Created a group key in 1Password: "beautiful-html private group: kin-circle"/);
  assert.ok(!/[A-Za-z0-9_-]{43}/.test(sealed.out.replace(/beautiful-html private (page|group): [a-z-]+/g, "")), "seal printed a key without --show-links");

  // Items: one group key, grouped pages hold only the group's name, the solo page its own key.
  const groupKey = s.field("beautiful-html private group: kin-circle", "password");
  assert.match(groupKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(s.field("beautiful-html private page: alpha-plan", "group"), "kin-circle");
  assert.equal(s.field("beautiful-html private page: alpha-plan", "password"), undefined);
  const soloKey = s.field("beautiful-html private page: solo-note", "password");
  assert.match(soloKey, /^[A-Za-z0-9_-]{43}$/);

  // Cards: the group key opens the group's two cards and not the solo page's.
  const blobs = Object.fromEntries(s.entries().map((e) => [e.slug, e.blob]));
  assert.deepEqual(Object.keys(blobs), ["alpha-plan", "beta-plan", "solo-note"]);
  assert.equal(tryDecryptCard(blobs["alpha-plan"], groupKey, "alpha-plan").title, "Alpha plan");
  assert.equal(tryDecryptCard(blobs["beta-plan"], groupKey, "beta-plan").title, "Beta plan");
  assert.equal(tryDecryptCard(blobs["solo-note"], groupKey, "solo-note"), null);
  assert.equal(tryDecryptCard(blobs["solo-note"], soloKey, "solo-note").title, "Solo note");
  assert.equal(JSON.stringify(s.read("docs/alpha-plan.html")).includes("kin-circle"), false, "the group name reached a sealed file");
  assert.equal(s.read("theme/private-cards.js").includes("Alpha"), false);

  // A second run changes nothing: sealed pages and the card file are byte-identical.
  const before = Object.fromEntries(["docs/alpha-plan.html", "docs/beta-plan.html", "docs/solo-note.html", "theme/private-cards.js"].map((f) => [f, s.read(f)]));
  const again = s.run(["seal"]);
  assert.equal(again.code, 0, again.out);
  for (const [f, text] of Object.entries(before)) assert.equal(s.read(f), text, f);
  assert.match(again.out, /private-cards\.js is up to date/);

  // --show-links prints the group's home page link.
  const links = s.run(["seal", "--show-links"]);
  assert.match(links.out, new RegExp(`home page, group "kin-circle": index\\.html#k=${groupKey}`));
  assert.match(links.out, new RegExp(`docs/alpha-plan\\.html#k=${groupKey}`));
});

test("changing bh:group re-keys the page and says so", (t) => {
  const s = site(t);
  s.newPrivate("alpha-plan", "Alpha plan", "kin-circle");
  s.newPrivate("beta-plan", "Beta plan", "kin-circle");
  assert.equal(s.run(["seal"]).code, 0);
  const familyKey = s.field("beautiful-html private group: kin-circle", "password");

  s.setGroup("beta-plan", "work");
  const moved = s.run(["seal"]);
  assert.equal(moved.code, 0, moved.out);
  assert.match(moved.out, /beta-plan: its key changed \(now in the group "work"\)/);
  assert.ok(!/alpha-plan: its key changed/.test(moved.out));
  const workKey = s.field("beautiful-html private group: work", "password");
  assert.notEqual(workKey, familyKey);
  const blobs = Object.fromEntries(s.entries().map((e) => [e.slug, e.blob]));
  assert.equal(tryDecryptCard(blobs["beta-plan"], familyKey, "beta-plan"), null);
  assert.equal(tryDecryptCard(blobs["beta-plan"], workKey, "beta-plan").title, "Beta plan");
  assert.equal(tryDecryptCard(blobs["alpha-plan"], familyKey, "alpha-plan").title, "Alpha plan");

  // Leaving the group gives the page its own key.
  s.setGroup("beta-plan", "");
  const left = s.run(["seal"]);
  assert.match(left.out, /beta-plan: its key changed \(it left its group\)/);
  const own = s.field("beautiful-html private page: beta-plan", "password");
  assert.match(own, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(tryDecryptCard(Object.fromEntries(s.entries().map((e) => [e.slug, e.blob]))["beta-plan"], own, "beta-plan").title, "Beta plan");
  assert.equal(s.run(["check"]).code, 0);
});

test("unseal finds a grouped page's key through its group", (t) => {
  const s = site(t);
  s.newPrivate("alpha-plan", "Alpha plan", "kin-circle");
  assert.equal(s.run(["seal"]).code, 0);
  const plain = s.read("docs/alpha-plan.private.html");
  fs.rmSync(path.join(s.root, "docs/alpha-plan.private.html"));
  const r = s.run(["unseal", "alpha-plan"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(s.read("docs/alpha-plan.private.html"), plain);
});

test("an invalid bh:group is refused", (t) => {
  const s = site(t);
  s.newPrivate("alpha-plan", "Alpha plan", "Not Kebab");
  const r = s.run(["seal"]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /bh:group "Not Kebab" must be kebab-case/);
});

test("check accepts a clean site and fails each injected fault", { timeout: 240000 }, (t) => {
  const s = site(t);
  s.newPrivate("alpha-plan", "Alpha plan", "kin-circle");
  s.newPrivate("beta-plan", "Beta plan", "kin-circle");
  assert.equal(s.run(["seal"]).code, 0);
  assert.equal(s.run(["index"]).code, 0);
  const clean = s.run(["check"]);
  assert.equal(clean.code, 0, clean.out);

  const original = { cards: s.read("theme/private-cards.js"), alpha: s.read("docs/alpha-plan.html"), index: s.read("index.html") };
  const inject = (rel, from, to) => {
    const before = s.read(rel), after = before.replace(from, to);
    assert.notEqual(after, before, `the injection into ${rel} changed nothing`);
    s.write(rel, after);
  };
  const restore = () => { s.write("theme/private-cards.js", original.cards); s.write("docs/alpha-plan.html", original.alpha); s.write("index.html", original.index); };
  const fails = (re, opts) => {
    const r = s.run(["check"], opts);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, re);
    restore();
  };
  const blobOf = (slug) => s.entries().find((e) => e.slug === slug).blob;

  // A blob that is valid base64 but no longer the page's card (local check, where keys exist).
  inject("theme/private-cards.js", blobOf("alpha-plan"), blobOf("alpha-plan").replace(/^(.{20})./, (m, p) => p + (m.endsWith("A") ? "B" : "A")));
  fails(/private card for alpha-plan is stale: run `npm run seal`/);
  const [a, b] = s.entries();
  inject("theme/private-cards.js", `  { slug: "${a.slug}", blob: "${a.blob}" },\n  { slug: "${b.slug}", blob: "${b.blob}" }`, `  { slug: "${b.slug}", blob: "${b.blob}" },\n  { slug: "${a.slug}", blob: "${a.blob}" }`);
  fails(/not sorted by slug/);
  inject("theme/private-cards.js", `slug: "${b.slug}"`, `slug: "${a.slug}"`);
  fails(/duplicate entry for alpha-plan/);
  inject("theme/private-cards.js", "\n] };", `,\n  { slug: "zeta-plan", blob: "${a.blob}" }\n] };`);
  fails(/blob for zeta-plan, which has no sealed page/);
  inject("theme/private-cards.js", `  { slug: "${b.slug}", blob: "${b.blob}" }`, "");
  s.write("theme/private-cards.js", s.read("theme/private-cards.js").replace(",\n\n", "\n"));
  fails(/sealed page beta-plan has no private card/);
  inject("docs/token-bucket-rate-limiting.html", '<meta name="bh:kind"', '<meta name="bh:group" content="kin-circle">\n  <meta name="bh:kind"');
  fails(/bh:group.*only valid in docs\/\*\.private\.html/);
  s.write("docs/token-bucket-rate-limiting.html", fs.readFileSync(path.join(ROOT, "docs/token-bucket-rate-limiting.html"), "utf8"));
  inject("docs/alpha-plan.html", "</body>", "<!-- kin-circle --></body>");
  fails(/leaks the page's group name/);
  inject("index.html", " data-private-cards", "");
  fails(/data-private-cards/);

  assert.equal(s.run(["check"]).code, 0, "restoring the injected files did not give a clean site");

  // CI has neither `op` nor plaintext: the structural checks alone pass on a clean checkout.
  for (const f of fs.readdirSync(path.join(s.root, "docs")).filter((f) => f.endsWith(".private.html"))) fs.rmSync(path.join(s.root, "docs", f));
  const ci = s.run(["check"], { withOp: false });
  assert.equal(ci.code, 0, ci.out);
  assert.equal(errorsOf(ci.out), "0");
});
