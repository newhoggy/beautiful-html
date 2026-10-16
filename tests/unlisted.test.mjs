import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = fs.readFileSync(path.join(source, "theme/unlisted.js"), "utf8");
const KEY = "A".repeat(43);

// ---- theme/unlisted.js: the fragment parser and the flag ----------------------------------------

/** Run theme/unlisted.js as a browser would, in a fresh context. */
function load(url, { bundled = false, unlistedPage = false, store = {}, storageThrows = false } = {}) {
  const u = new URL(url);
  const attrs = new Map(bundled ? [["data-bundled", ""]] : []);
  const listeners = [];
  const storage = storageThrows ? null : {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const reloads = [];
  const context = {
    location: { hash: u.hash, reload: () => reloads.push(1) },
    addEventListener: (type, fn) => listeners.push([type, fn]),
    document: {
      documentElement: { hasAttribute: (k) => attrs.has(k), setAttribute: (k, v) => attrs.set(k, v) },
      querySelector: (sel) => (unlistedPage && sel === 'meta[name="bh:unlisted"]' ? {} : null),
    },
  };
  if (storageThrows) Object.defineProperty(context, "sessionStorage", { get() { throw new Error("blocked"); } });
  else context.sessionStorage = storage;
  context.window = context;
  vm.runInNewContext(script, context);
  return { api: context.bhUnlisted, attrs, store, context, listeners, reloads };
}
// Objects made inside the vm context have another realm's prototypes: compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));
const parse = (hash) => plain(load("http://localhost/").api.parseFragment(hash));

test("the fragment is a list of tokens: reserved ones, and the first bare one is the section", () => {
  assert.deepEqual(parse(""), { id: "", unlisted: null, keys: [] });
  assert.deepEqual(parse("#my-section"), { id: "my-section", unlisted: null, keys: [] });
  assert.deepEqual(parse("#unlisted=true"), { id: "", unlisted: "on", keys: [] });
  assert.deepEqual(parse(`#k=${KEY}&unlisted=true&my-section`), { id: "my-section", unlisted: "on", keys: [KEY] });
  // Order of intent does not matter to the parser; a section may come first, and a later flag wins.
  assert.deepEqual(parse("#my-section&unlisted=true&unlisted=false"), { id: "my-section", unlisted: "off", keys: [] });
  assert.deepEqual(parse(`#unlisted=true&k=${KEY}`), { id: "", unlisted: "on", keys: [KEY] });
  assert.deepEqual(parse(`#k=${KEY}&k=${"B".repeat(43)}`).keys, [KEY, "B".repeat(43)]);
  // Unknown "name=value" tokens and bad values are ignored, never taken for a section.
  assert.deepEqual(parse("#other=1&unlisted=maybe&sec"), { id: "sec", unlisted: null, keys: [] });
  assert.equal(parse("#k=short&sec").id, "sec");
  assert.equal(parse("#caf%C3%A9").id, "café");
  assert.equal(parse("#%E0%A4%A").id, "%E0%A4%A", "a malformed escape is kept raw, not thrown");
});

test("value spellings", () => {
  for (const [v, want] of [["true", "on"], ["on", "on"], ["1", "on"], ["YES", "on"], ["false", "off"], ["off", "off"], ["0", "off"], ["no", "off"], ["auto", "auto"], ["", null], ["maybe", null]]) {
    assert.equal(parse(`#unlisted=${v}`).unlisted, want, v);
  }
});

test("the flag is off by default everywhere, local hosts included", () => {
  for (const url of ["http://localhost:8000/", "file:///Users/me/blog/index.html", "https://bitwise.john-ky.io/"]) {
    const found = load(url);
    assert.equal(found.api.visible, false, url);
    assert.equal(found.attrs.get("data-unlisted"), "off", url);
  }
});

test("#unlisted=true turns it on, remembers it for the tab session, and #unlisted=false and auto clear it", () => {
  const store = {};
  const on = load("https://bitwise.john-ky.io/#unlisted=true", { store });
  assert.equal(on.api.visible, true);
  assert.equal(on.attrs.get("data-unlisted"), "on");
  assert.equal(store["bh-unlisted"], "on");
  // A later page without the fragment keeps the choice.
  const next = load("https://bitwise.john-ky.io/docs/x.html", { store });
  assert.equal(next.api.visible, true);
  assert.equal(next.api.source, "session");
  // A new tab has its own sessionStorage: off.
  assert.equal(load("https://bitwise.john-ky.io/docs/x.html").api.visible, false);
  assert.equal(load("https://bitwise.john-ky.io/#unlisted=false", { store }).api.visible, false);
  assert.equal(load("https://bitwise.john-ky.io/docs/x.html", { store }).api.visible, false);
  load("https://bitwise.john-ky.io/#unlisted=true", { store });
  load("https://bitwise.john-ky.io/#unlisted=auto", { store });
  assert.deepEqual(store, {});
});

test("with a key and a section in the fragment the flag still applies", () => {
  assert.equal(load(`https://bitwise.john-ky.io/docs/x.html#k=${KEY}&unlisted=true&sec`).api.visible, true);
});

test("an unreadable sessionStorage falls back to off, and the fragment still applies once", () => {
  assert.equal(load("https://bitwise.john-ky.io/", { storageThrows: true }).api.visible, false);
  assert.equal(load("https://bitwise.john-ky.io/#unlisted=true", { storageThrows: true }).api.visible, true);
});

test("the early script marks the document and the unlisted page", () => {
  const page = load("https://bitwise.john-ky.io/docs/x.html", { unlistedPage: true });
  assert.equal(page.attrs.has("data-unlisted-page"), true);
  assert.equal(page.api.page, true);
  assert.equal(load("https://bitwise.john-ky.io/docs/y.html").attrs.has("data-unlisted-page"), false);
  // A direct link needs neither flag nor key: the page is not hidden from its own reader.
  assert.equal(page.attrs.get("data-unlisted"), "off");
});

test("a bundled single file always shows its own content", () => {
  const found = load("https://files.example.com/xyz.html#unlisted=false", { bundled: true });
  assert.equal(found.api.visible, true);
  assert.equal(found.api.source, "bundle");
  assert.equal(found.attrs.get("data-unlisted"), "on");
  assert.equal(found.listeners.length, 0);
});

test("pasting a new #unlisted into an open tab reloads only when the choice changes", () => {
  const found = load("https://bitwise.john-ky.io/");
  const [type, onChange] = found.listeners[0];
  assert.equal(type, "hashchange");
  found.context.location.hash = "#some-section";
  onChange();
  assert.equal(found.reloads.length, 0);
  found.context.location.hash = "#unlisted=false";
  onChange();
  assert.equal(found.reloads.length, 0);
  found.context.location.hash = "#unlisted=true";
  onChange();
  assert.equal(found.reloads.length, 1);
  // With sessionStorage blocked nothing is remembered; a section link must still not reload.
  const blocked = load("https://bitwise.john-ky.io/#unlisted=true", { storageThrows: true });
  blocked.context.location.hash = "#some-section";
  blocked.listeners[0][1]();
  assert.equal(blocked.reloads.length, 0);
});

// ---- the sealed-page shell reads the same fragment ----------------------------------------------

test("the sealed shell opens #k=<key>&unlisted=true, and leaves the flag and the section for bh.js", () => {
  const bh = fs.readFileSync(path.join(source, "scripts/bh.mjs"), "utf8");
  const literal = bh.match(/location\.hash\.match\((\/\^#k=[^\n]*?\/)\)/);
  assert.ok(literal, "the shell's fragment pattern was not found: update this test with the shell");
  const shell = new Function(`return ${literal[1]}`)();
  const anchorOf = (hash) => { const m = hash.match(shell); return m ? m[2] || "" : null; };
  // After decrypting, the shell keeps what follows the key in the address bar.
  assert.equal(anchorOf(`#k=${KEY}&unlisted=true`), "unlisted=true");
  assert.equal(anchorOf(`#k=${KEY}&unlisted=true&some-section`), "unlisted=true&some-section");
  assert.deepEqual(parse("#unlisted=true&some-section"), { id: "some-section", unlisted: "on", keys: [] });
  assert.equal(parse("#" + anchorOf(`#k=${KEY}&unlisted=true`)).unlisted, "on");
  // Canonical order is key first: the shell does not read `unlisted` before `k`.
  assert.equal(anchorOf(`#unlisted=true&k=${KEY}`), null);
});

// ---- a fixture copy of the repo -----------------------------------------------------------------

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bh-unlisted-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const entry of ["scripts", "theme", "docs", "reviews", "templates", "package.json", "index.html"]) {
    fs.cpSync(path.join(source, entry), path.join(root, entry), { recursive: true });
  }
  // `check` asks 1Password for a private page's key; make that fail at once instead.
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "op"), "#!/bin/sh\necho 'op: unavailable in tests' >&2\nexit 1\n", { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CI: "" };
  const bh = (...args) => spawnSync(process.execPath, [path.join(root, "scripts/bh.mjs"), ...args], { cwd: root, env, encoding: "utf8" });
  const file = (rel) => path.join(root, rel);
  const read = (rel) => fs.readFileSync(file(rel), "utf8");
  const edit = (rel, from, to) => {
    const text = read(rel), next = text.replace(from, to);
    assert.notEqual(next, text, `the injection into ${rel} changed nothing: ${String(from)}`);
    fs.writeFileSync(file(rel), next);
  };
  return { root, bh, file, read, edit };
}
const generated = ["index.html", "theme/site.js", "theme/search-index.js", "theme/unlisted-pages.js", "theme/unlisted-slugs.js", "theme/unlisted-reviews.js", "theme/reviews.js", "theme/glossary.js"];
const TITLE = "Quiet demo page";

test("new --unlisted writes the marker; index keeps the page out of every default file and is idempotent", (t) => {
  const f = fixture(t);
  const made = f.bh("new", "--unlisted", "explainer", "quiet-demo", TITLE, "A page for readers who have the link.");
  assert.equal(made.status, 0, made.stdout + made.stderr);
  const page = f.read("docs/quiet-demo.html");
  assert.match(page, /<meta name="bh:unlisted" content="true">/);
  assert.match(page, /<script src="\.\.\/theme\/unlisted\.js"><\/script>/);
  assert.ok(page.indexOf('name="bh:unlisted"') < page.indexOf("theme/unlisted.js"), "the marker comes before the script that reads it");
  assert.ok(page.indexOf("theme/examples.js") < page.indexOf("theme/unlisted.js"));
  assert.match(page, /<meta name="robots" content="noindex, nofollow">\n {2}<!-- bh:social:end -->/, "the build adds noindex");
  assert.doesNotMatch(f.read("docs/adr-001-rate-limit-in-each-service.html"), /name="robots"/);

  for (const rel of ["index.html", "theme/site.js", "theme/search-index.js"]) {
    assert.ok(!f.read(rel).includes("quiet-demo"), `${rel} must not mention the unlisted page`);
    assert.ok(!f.read(rel).includes(TITLE), `${rel} must not carry its title`);
  }
  const data = {}; vm.runInNewContext(f.read("theme/unlisted-pages.js"), { window: data });
  assert.equal(data.BH_UNLISTED.v, 1);
  assert.deepEqual(plain(data.BH_UNLISTED.pages.map((p) => [p.slug, p.href, p.title, p.kind])), [["quiet-demo", "docs/quiet-demo.html", TITLE, "explainer"]]);
  assert.equal(data.BH_UNLISTED.search[0].href, "docs/quiet-demo.html");
  const slugs = {}; vm.runInNewContext(f.read("theme/unlisted-slugs.js"), { window: slugs });
  assert.deepEqual(plain(slugs.BH_UNLISTED_SLUGS), ["docs/quiet-demo.html"]);
  assert.ok(!f.read("theme/unlisted-slugs.js").includes(TITLE), "the slug list carries paths only");

  const before = Object.fromEntries(generated.concat("docs/quiet-demo.html").map((rel) => [rel, f.read(rel)]));
  const again = f.bh("index");
  assert.equal(again.status, 0, again.stderr);
  for (const [rel, text] of Object.entries(before)) assert.equal(f.read(rel), text, `a second index changed ${rel}`);

  const bad = f.bh("new", "--private", "--unlisted", "explainer", "nope", "Nope");
  assert.notEqual(bad.status, 0);
  assert.ok(!fs.existsSync(f.file("docs/nope.private.html")));
});

test("backlinks and review summaries that touch an unlisted page stay out of site.js", (t) => {
  const f = fixture(t);
  f.bh("new", "--unlisted", "explainer", "quiet-demo", TITLE, "Description.");
  // A listed page links to it, and it links to a listed page.
  f.edit("docs/announcing-patchcov.html", "</article>", '<p><a href="quiet-demo.html">the demo</a></p></article>');
  f.edit("docs/quiet-demo.html", "</article>", '<p><a href="glossary.html">the glossary</a></p></article>');
  fs.writeFileSync(f.file("reviews/quiet-demo.json"), JSON.stringify({
    format: "bh-review/1", document: "docs/quiet-demo.html", reviewer: "Reader",
    comments: [{ id: "c1", kind: "comment", created: "2026-10-13T00:00:00Z", body: "Hi", target: { quote: { exact: "x" } } }],
  }));
  assert.equal(f.bh("index").status, 0);
  const site = {}; vm.runInNewContext(f.read("theme/site.js"), { window: site });
  assert.equal(site.BH_SITE.backlinks["docs/quiet-demo.html"], undefined);
  assert.equal(Object.values(site.BH_SITE.backlinks).flat().some((b) => b.href.includes("quiet-demo")), false);
  assert.equal(site.BH_SITE.reviews["docs/quiet-demo.html"], undefined);
  assert.ok(!site.BH_SITE.pages.some((p) => p.href.includes("quiet-demo")));
  const data = {}; vm.runInNewContext(f.read("theme/unlisted-pages.js"), { window: data });
  assert.deepEqual(plain(data.BH_UNLISTED.backlinks["docs/quiet-demo.html"].map((b) => b.href.split("#")[0])), ["docs/announcing-patchcov.html"]);
  assert.deepEqual(plain(data.BH_UNLISTED.backlinks["docs/glossary.html"].map((b) => b.href.split("#")[0])), ["docs/quiet-demo.html"]);
  // Its threads are in their own file, which only the unlisted page loads: listed pages load reviews.js.
  assert.ok(!f.read("theme/reviews.js").includes("quiet-demo"));
  assert.ok(f.read("theme/unlisted-reviews.js").includes("docs/quiet-demo.html"));
});

test("the client's card is the markup index writes for a listed page", (t) => {
  const f = fixture(t);
  f.bh("new", "--unlisted", "explainer", "quiet-demo", TITLE, "It says <b>so</b> & \"more\".");
  f.edit("docs/quiet-demo.html", '<meta name="bh:tags" content="">', '<meta name="bh:tags" content="Rust, ai workflows">');
  const unlistedMarker = '  <meta name="bh:unlisted" content="true">\n';
  // The record the browser receives.
  assert.equal(f.bh("index").status, 0);
  const data = {}; vm.runInNewContext(f.read("theme/unlisted-pages.js"), { window: data });
  const [record] = data.BH_UNLISTED.pages;
  // What index writes for the same page when it is listed (the marker is the only difference).
  f.edit("docs/quiet-demo.html", unlistedMarker, "");
  assert.equal(f.bh("index").status, 0);
  const card = f.read("index.html").match(/ {6}<li class="card doc-card"[^>]*>\s*<a class="card-link" href="docs\/quiet-demo\.html">[\s\S]*?<\/li>/);
  assert.ok(card, "the listed page has a card in index.html");
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const fakeEl = (tag, attrs = {}, children = []) => {
    let text = "", attributes = "";
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "text") text = esc(v); else attributes += v === true ? ` ${k}` : ` ${k}="${esc(v)}"`;
    }
    const inner = [].concat(children).filter(Boolean).map((c) => (typeof c === "string" ? esc(c) : c.html)).join("");
    return { html: `<${tag}${attributes}>${text}${inner}</${tag}>` };
  };
  const context = { document: { querySelector: () => null }, window: {} };
  context.window = Object.assign(context.window, { bh: { el: fakeEl, settle() {}, unlisted: { visible: false } }, bhModules: {} });
  vm.runInNewContext(f.read("theme/modules/unlisted-cards.js"), context);
  const flat = (html) => html.replace(/>\s+</g, "><").trim();
  // The unlisted card is the same card with the page's own label and flag.
  const expected = flat(card[0])
    .replace('class="card doc-card"', 'class="card doc-card" data-unlisted')
    .replace('<span class="eyebrow">Explainer</span>', '<span class="eyebrow">Unlisted · Explainer</span>');
  assert.equal(flat(context.window.bh.cards.build(record).html), expected);
});

test("a card for an example page and a replaced page carry their labels", () => {
  const context = { document: { querySelector: () => null }, window: {} };
  const esc = (s) => String(s);
  const fakeEl = (tag, attrs = {}, children = []) => {
    let attributes = "", text = "";
    for (const [k, v] of Object.entries(attrs)) { if (v == null || v === false) continue; if (k === "text") text = esc(v); else attributes += v === true ? ` ${k}` : ` ${k}="${esc(v)}"`; }
    return { html: `<${tag}${attributes}>${text}${[].concat(children).filter(Boolean).map((c) => (typeof c === "string" ? c : c.html)).join("")}</${tag}>` };
  };
  context.window = { bh: { el: fakeEl, settle() {}, unlisted: { visible: false } }, bhModules: {} };
  vm.runInNewContext(fs.readFileSync(path.join(source, "theme/modules/unlisted-cards.js"), "utf8"), context);
  const html = context.window.bh.cards.build({ href: "docs/a.html", title: "A", description: "d", kind: "decision", kindLabel: "Decision", status: "Accepted", date: "2026-01-02", tags: ["examples", "x"], example: true, unlisted: true, replacedBy: { href: "docs/b.html", title: "B" } }).html;
  assert.match(html, /class="card doc-card is-superseded" data-example data-unlisted data-kind="decision" data-tags="examples,x"/);
  assert.match(html, /<span class="eyebrow">Example · Unlisted · Decision<\/span>/);
  assert.match(html, /<span class="badge accepted">Accepted<\/span><time datetime="2026-01-02">2026-01-02<\/time>/);
  assert.match(html, /<p class="card-replaced">Replaced by <a href="docs\/b\.html">B<\/a><\/p>/);
});

test("bundle --all leaves out an unlisted page, and naming it bundles it", (t) => {
  const f = fixture(t);
  f.bh("new", "--unlisted", "explainer", "quiet-demo", TITLE, "Description.");
  const all = f.bh("bundle", "--all");
  assert.equal(all.status, 0, all.stderr);
  assert.ok(fs.existsSync(f.file("dist/announcing-patchcov.html")));
  assert.ok(!fs.existsSync(f.file("dist/quiet-demo.html")));
  assert.equal(f.bh("bundle", "docs/quiet-demo.html").status, 0);
  assert.ok(fs.existsSync(f.file("dist/quiet-demo.html")));
});

// ---- check ----------------------------------------------------------------------------------------

const errors = (run) => run.stdout.split("\n").map((l) => l.replace(/\x1b\[\d+m/g, "")).filter((l) => /^\s+(error|warn)\s/.test(l));
const complaint = (run, pattern) => errors(run).some((l) => pattern.test(l));

test("check accepts a well-formed unlisted page, and fails or warns on each fault", (t) => {
  const f = fixture(t);
  f.bh("new", "--unlisted", "explainer", "quiet-demo", TITLE, "Description.");
  // Its card is the only thing missing (no Chrome here): nothing else is wrong.
  const clean = f.bh("check");
  assert.deepEqual(errors(clean).filter((l) => !/social card/.test(l)), [], clean.stdout);

  // Stale generated data.
  f.edit("theme/unlisted-pages.js", '"pages": [', '"pages": [ {"slug": "ghost"},');
  assert.ok(complaint(f.bh("check"), /theme\/unlisted-pages\.js is stale/));
  f.bh("index");
  f.edit("theme/unlisted-slugs.js", '[', '["docs/ghost.html",');
  assert.ok(complaint(f.bh("check"), /theme\/unlisted-slugs\.js is stale/));
  f.bh("index");
  assert.ok(!complaint(f.bh("check"), /is stale: run `npm run index`/));

  // The head script is missing, misplaced, or the marker comes after it.
  const page = f.read("docs/quiet-demo.html");
  f.edit("docs/quiet-demo.html", '  <script src="../theme/unlisted.js"></script>\n', "");
  assert.ok(complaint(f.bh("check"), /missing <script src="…\/theme\/unlisted\.js">/));
  fs.writeFileSync(f.file("docs/quiet-demo.html"), page);
  f.edit("docs/quiet-demo.html", '  <script src="../theme/examples.js"></script>\n  <script src="../theme/unlisted.js"></script>\n', '  <script src="../theme/unlisted.js"></script>\n  <script src="../theme/examples.js"></script>\n');
  assert.ok(complaint(f.bh("check"), /unlisted\.js must come after theme\/examples\.js/));
  fs.writeFileSync(f.file("docs/quiet-demo.html"), page);
  f.edit("docs/quiet-demo.html", '  <meta name="bh:unlisted" content="true">\n', "");
  f.edit("docs/quiet-demo.html", '  <script src="../theme/unlisted.js"></script>', '  <meta name="bh:unlisted" content="true">\n  <script src="../theme/unlisted.js"></script>');
  assert.ok(!complaint(f.bh("check"), /must come before the theme\/unlisted\.js/), "a marker just before the script is fine");
  f.edit("docs/quiet-demo.html", '  <meta name="bh:unlisted" content="true">\n  <script src="../theme/unlisted.js"></script>', '  <script src="../theme/unlisted.js"></script>\n  <meta name="bh:unlisted" content="true">');
  assert.ok(complaint(f.bh("check"), /bh:unlisted"> must come before the theme\/unlisted\.js script/));
  fs.writeFileSync(f.file("docs/quiet-demo.html"), page);

  // Marker value and the reserved tag.
  f.edit("docs/quiet-demo.html", '<meta name="bh:unlisted" content="true">', '<meta name="bh:unlisted" content="yes">');
  assert.ok(complaint(f.bh("check"), /bh:unlisted must be "true" \(got "yes"\)/));
  fs.writeFileSync(f.file("docs/quiet-demo.html"), page);
  f.edit("docs/quiet-demo.html", '<meta name="bh:tags" content="">', '<meta name="bh:tags" content="rust, Unlisted">');
  assert.ok(complaint(f.bh("check"), /the "unlisted" tag is reserved/));
  fs.writeFileSync(f.file("docs/quiet-demo.html"), page);

  // A private page cannot be unlisted.
  assert.equal(f.bh("new", "--private", "explainer", "secret", "Secret", "Hidden.").status, 0);
  f.edit("docs/secret.private.html", '<meta name="bh:tags" content="">', '<meta name="bh:tags" content=""><meta name="bh:unlisted" content="true">');
  assert.ok(complaint(f.bh("check"), /a private page cannot be unlisted/));
  fs.rmSync(f.file("docs/secret.private.html"));

  // A listed page that links to it is warned about; the glossary and an unlisted page are not.
  f.edit("docs/announcing-patchcov.html", "</article>", '<p><a href="quiet-demo.html#x">the demo</a></p></article>');
  f.bh("index");
  const warned = f.bh("check");
  assert.equal(errors(warned).filter((l) => /^\s+warn\s.*links to unlisted page quiet-demo\.html: the link is inert/.test(l)).length, 1, warned.stdout);
  f.edit("docs/quiet-demo.html", "</article>", '<p><a href="quiet-demo.html">itself</a> <a href="glossary.html">glossary</a></p></article>');
  f.bh("index");
  assert.equal(errors(f.bh("check")).filter((l) => /unlisted page/.test(l)).length, 1, "an unlisted page may link freely");
  f.edit("docs/glossary.html", "</article>", '<p><a href="quiet-demo.html">demo</a></p></article>');
  f.bh("index");
  assert.equal(errors(f.bh("check")).filter((l) => /unlisted page/.test(l)).length, 1, "the glossary is exempt");
});

test("check requires the home page's list to load the unlisted cards, and keeps decision chains whole", (t) => {
  const f = fixture(t);
  f.edit("index.html", "id=\"doc-list\" data-unlisted-cards", 'id="doc-list"');
  assert.ok(complaint(f.bh("check"), /data-unlisted-cards/));
  f.edit("index.html", 'id="doc-list"', 'id="doc-list" data-unlisted-cards');
  assert.ok(!complaint(f.bh("check"), /data-unlisted-cards/));
  // A decision superseded by an unlisted page would put the unlisted page's title on a listed page.
  f.edit("docs/adr-002-rate-limit-at-the-edge.html", '<meta name="bh:tags"', '<meta name="bh:unlisted" content="true">\n  <meta name="bh:tags"');
  assert.ok(complaint(f.bh("check"), /one is unlisted and the other is not/));
});
