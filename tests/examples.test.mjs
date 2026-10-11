import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = fs.readFileSync(path.join(source, "theme/examples.js"), "utf8");

/** Run theme/examples.js as a browser would, in a fresh context. Returns what it decided and wrote. */
function load(url, { bundled = false, example = false, store = {}, storageThrows = false } = {}) {
  const u = new URL(url);
  const attrs = new Map(bundled ? [["data-bundled", ""]] : []);
  const storage = storageThrows ? null : {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const context = {
    URLSearchParams,
    location: { protocol: u.protocol, hostname: u.hostname, search: u.search },
    document: {
      documentElement: {
        hasAttribute: (k) => attrs.has(k),
        setAttribute: (k, v) => attrs.set(k, v),
      },
      querySelector: (sel) => (example && sel === 'meta[name="bh:example"]' ? {} : null),
    },
  };
  if (storageThrows) Object.defineProperty(context, "sessionStorage", { get() { throw new Error("blocked"); } });
  else context.sessionStorage = storage;
  context.window = context;
  vm.runInNewContext(script, context);
  return { api: context.bhExamples, attrs, store };
}

const visible = (url, opts) => load(url, opts).api.visible;

test("local hosts show examples", () => {
  for (const url of [
    "http://localhost:8000/",
    "http://LOCALHOST/docs/x.html",
    "http://localhost./",
    "http://127.0.0.1:8000/",
    "http://[::1]:8000/",
    "http://blog.localhost:3000/",
    "http://a.b.localhost/",
    "http://printer.local/",
    "http://my-laptop.local:8080/",
    "file:///Users/me/blog/docs/x.html",
  ]) assert.equal(visible(url), true, url);
});

test("anything else hides them, including look-alikes and LAN addresses", () => {
  for (const url of [
    "https://bitwise.john-ky.io/",
    "https://localhost.evil.com/",
    "https://evil-localhost.com/",
    "https://127.0.0.1.evil.com/",
    "https://notlocal.com/",
    "https://local/",
    "https://local.example/",
    "http://192.168.1.5:8000/",
    "http://10.0.0.7/",
    "http://127.0.0.2/",
    "http://0.0.0.0/",
    "http://blog.dev.test/", // a custom dev domain is not local; use ?examples
  ]) assert.equal(visible(url), false, url);
});

test("the early script marks the document before first paint", () => {
  const off = load("https://bitwise.john-ky.io/docs/x.html", { example: true });
  assert.equal(off.attrs.get("data-examples"), "off");
  assert.equal(off.attrs.has("data-example-page"), true);
  assert.equal(off.api.page, true);
  const on = load("http://localhost:8000/docs/x.html");
  assert.equal(on.attrs.get("data-examples"), "on");
  assert.equal(on.attrs.has("data-example-page"), false);
  assert.equal(on.api.page, false);
});

test("?examples overrides the host and is remembered for the session", () => {
  const store = {};
  assert.equal(visible("https://bitwise.john-ky.io/?examples", { store }), true);
  assert.equal(store["bh-examples"], "on");
  // A later page without the parameter keeps the choice.
  const next = load("https://bitwise.john-ky.io/docs/x.html", { store });
  assert.equal(next.api.visible, true);
  assert.equal(next.api.source, "session");
  // ?examples=off previews the published view locally.
  assert.equal(visible("http://localhost:8000/?examples=off", { store }), false);
  assert.equal(visible("http://localhost:8000/docs/x.html", { store }), false);
  // ?examples=auto forgets the override.
  assert.equal(visible("http://localhost:8000/?examples=auto", { store }), true);
  assert.deepEqual(store, {});
});

test("override spellings", () => {
  for (const [q, want] of [["?examples", "on"], ["?examples=", "on"], ["?examples=on", "on"], ["?examples=1", "on"], ["?examples=TRUE", "on"],
    ["?examples=off", "off"], ["?examples=0", "off"], ["?examples=false", "off"], ["?examples=auto", "auto"],
    ["?examples=maybe", null], ["?other=1", null], ["", null]]) {
    assert.equal(load("http://localhost/").api.parseOverride(q), want, q);
  }
});

test("an unreadable sessionStorage falls back to the host, and an override still applies once", () => {
  assert.equal(visible("https://bitwise.john-ky.io/", { storageThrows: true }), false);
  assert.equal(visible("https://bitwise.john-ky.io/?examples", { storageThrows: true }), true);
  assert.equal(visible("http://localhost/", { storageThrows: true }), true);
});

test("a bundled single file always shows its own content", () => {
  const found = load("https://files.example.com/xyz.html", { bundled: true, example: true });
  assert.equal(found.api.visible, true);
  assert.equal(found.api.source, "bundle");
  assert.equal(found.attrs.get("data-examples"), "on");
  assert.equal(visible("https://files.example.com/xyz.html?examples=off", { bundled: true }), true);
});

// ---- the generated data follows the marker ------------------------------------------------------

const read = (f) => fs.readFileSync(path.join(source, f), "utf8");
const marked = fs.readdirSync(path.join(source, "docs")).filter((f) => f.endsWith(".html"))
  .filter((f) => /<meta\s+name="bh:example"\s+content="true"/.test(read(`docs/${f}`)))
  .map((f) => `docs/${f}`).sort();

test("there are example pages to test against", () => {
  assert.ok(marked.length > 0, "docs/ should keep at least one page marked bh:example");
});

test("index cards, site data and the search index flag exactly the marked pages", () => {
  const index = read("index.html");
  const cards = [...index.matchAll(/<li class="card doc-card[^"]*"( data-example)? data-kind="[^"]*"[^>]*>\s*<a class="card-link" href="([^"]+)"/g)];
  assert.equal(cards.length >= marked.length, true);
  assert.deepEqual(cards.filter((m) => m[1]).map((m) => m[2]).sort(), marked);

  const site = {}; vm.runInNewContext(read("theme/site.js"), { window: site });
  assert.deepEqual(Array.from(site.BH_SITE.pages, (p) => p).filter((p) => p.example).map((p) => p.href).sort(), marked);
  const search = {}; vm.runInNewContext(read("theme/search-index.js"), { window: search });
  assert.deepEqual(Array.from(search.BH_SEARCH, (p) => p).filter((p) => p.example).map((p) => p.href).sort(), marked);
  // Every page and glossary entry that is not an example stays searchable.
  assert.equal(search.BH_SEARCH.some((p) => !p.example && p.kind === "glossary"), true);
});

// ---- `new --example` and the checker ---------------------------------------------------------------

function scratchRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bh-examples-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of ["scripts", "templates", "theme", "docs", "reviews", "package.json", "index.html"]) {
    fs.cpSync(path.join(source, f), path.join(dir, f), { recursive: true });
  }
  return dir;
}

const bh = (dir, ...args) => spawnSync(process.execPath, [path.join(dir, "scripts/bh.mjs"), ...args], { cwd: dir, encoding: "utf8" });

test("`new --example` writes the marker, and a plain `new` does not", (t) => {
  const dir = scratchRepo(t);
  const a = bh(dir, "new", "--example", "explainer", "demo-one", "Demo one", "A demo.");
  assert.equal(a.status, 0, a.stderr);
  assert.match(fs.readFileSync(path.join(dir, "docs/demo-one.html"), "utf8"), /<meta name="bh:example" content="true">/);
  assert.match(fs.readFileSync(path.join(dir, "index.html"), "utf8"), /<li class="card doc-card" data-example data-kind="explainer"[^>]*>\s*<a class="card-link" href="docs\/demo-one\.html"/);
  const b = bh(dir, "new", "explainer", "demo-two", "Demo two", "A demo.");
  assert.equal(b.status, 0, b.stderr);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "docs/demo-two.html"), "utf8"), /^\s*<meta name="bh:example"/m);
  const c = bh(dir, "new", "--example", "--private", "explainer", "demo-three", "Demo three");
  assert.notEqual(c.status, 0);
  assert.equal(fs.existsSync(path.join(dir, "docs/demo-three.private.html")), false);
});

test("check rejects the `examples` tag, a bad marker value and a missing examples.js", (t) => {
  const dir = scratchRepo(t);
  const edit = (file, from, to) => {
    const p = path.join(dir, file), text = fs.readFileSync(p, "utf8");
    assert.ok(text.includes(from), `${file} should contain ${from}`);
    fs.writeFileSync(p, text.replace(from, to));
    assert.notEqual(fs.readFileSync(p, "utf8"), text, "the injection must change the file");
  };
  const errors = () => bh(dir, "check").stdout;
  // Cards are checked against the machine's Chrome render, which is not under test here.
  const others = (out) => out.split("\n").filter((l) => l.includes("  error  ") && !/social card/.test(l));

  assert.deepEqual(others(errors()), []);
  edit("docs/glossary.html", '<meta name="bh:tags" content="glossary, reference">', '<meta name="bh:tags" content="glossary, examples">');
  assert.match(errors(), /"examples" tag is reserved/);
  edit("docs/glossary.html", '<meta name="bh:tags" content="glossary, examples">', '<meta name="bh:tags" content="glossary, reference">');
  edit("docs/token-bucket-rate-limiting.html", 'name="bh:example" content="true"', 'name="bh:example" content="yes"');
  assert.match(errors(), /bh:example must be "true"/);
  edit("docs/token-bucket-rate-limiting.html", 'name="bh:example" content="yes"', 'name="bh:example" content="true"');
  edit("docs/glossary.html", '  <script src="../theme/examples.js"></script>\n', "");
  assert.match(errors(), /theme\/examples\.js/);
});

test("check warns when an ordinary page links to an example page, but not from the glossary", (t) => {
  const dir = scratchRepo(t);
  const p = path.join(dir, "docs/announcing-patchcov.html");
  const text = fs.readFileSync(p, "utf8");
  fs.writeFileSync(p, text.replace("</article>", '<p>See <a href="token-bucket-rate-limiting.html">the explainer</a>.</p></article>'));
  assert.notEqual(fs.readFileSync(p, "utf8"), text, "the injection must change the file");
  const out = bh(dir, "check").stdout;
  assert.match(out, /warn.*links to example page token-bucket-rate-limiting\.html/);
  assert.doesNotMatch(out, /glossary\.html[\s\S]*links to example page/);
});

test("check requires the marker to come before examples.js", (t) => {
  const dir = scratchRepo(t);
  const p = path.join(dir, "docs/token-bucket-rate-limiting.html");
  const text = fs.readFileSync(p, "utf8");
  const marker = '  <meta name="bh:example" content="true">\n', script = '  <script src="../theme/examples.js"></script>\n';
  assert.ok(text.includes(marker) && text.includes(script));
  fs.writeFileSync(p, text.replace(marker, "").replace(script, script + marker));
  assert.notEqual(fs.readFileSync(p, "utf8"), text, "the injection must change the file");
  assert.match(bh(dir, "check").stdout, /bh:example"> must come before the theme\/examples\.js script/);
});
