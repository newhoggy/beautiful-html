import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import http from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { preparePublishedSite } from "../scripts/publish.mjs";
import { encryptCard, renderCardsFile } from "../scripts/private-cards.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bh-publication-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source"), stage = path.join(temp, "stage");
  fs.mkdirSync(source); fs.mkdirSync(stage);
  for (const entry of ["scripts", "theme", "docs", "reviews", "package.json", "index.html"]) {
    fs.cpSync(path.join(ROOT, entry), path.join(source, entry), { recursive: true });
  }
  return { source, stage, assemble() {
    for (const entry of ["index.html", "docs", "theme"]) fs.cpSync(path.join(source, entry), path.join(stage, entry), { recursive: true });
  } };
}
function data(stage, file, global) {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(stage, "theme", file), "utf8"), { window });
  return window[global];
}
const example = "docs/token-bucket-rate-limiting.html";
const post = "docs/announcing-patchcov.html";
// Unlisted pages the repo itself already has: the fixtures add their own on top of these.
const REPO_UNLISTED = new Set(data(ROOT, "unlisted-slugs.js", "BH_UNLISTED_SLUGS"));
const added = (list) => list.filter((p) => !REPO_UNLISTED.has(typeof p === "string" ? p : p.href));

test("published artifact omits examples, keeps posts and local source, and serves 404", async (t) => {
  const f = fixture(t);
  // Exercise reviews and backlinks even when the real repository has no review threads.
  const exampleFile = path.join(f.source, example);
  let html = fs.readFileSync(exampleFile, "utf8");
  fs.writeFileSync(exampleFile, html.replace("</article>", `<p><a href="announcing-patchcov.html">Post</a></p></article>`));
  const postFile = path.join(f.source, post);
  html = fs.readFileSync(postFile, "utf8");
  const links = ['token-bucket-rate-limiting.html#implementation', '/docs/token-bucket-rate-limiting.html?examples',
    'https://bitwise.john-ky.io/docs/token-bucket-rate-limiting.html', '%74oken-bucket-rate-limiting.html'];
  fs.writeFileSync(postFile, html.replace("</article>", links.map((href) => `<p><a href="${href}"><em>Example words</em></a></p>`).join("") +
    '<a href="https://elsewhere.test/docs/token-bucket-rate-limiting.html">External</a></article>'));
  for (const document of [example, post]) {
    fs.writeFileSync(path.join(f.source, "reviews", path.basename(document) + ".json"), JSON.stringify({
      format: "bh-review/1", document, reviewer: "Reader", comments: [{ id: document, kind: "comment", text: "Review words", created: "2026-10-13T00:00:00Z", target: { quote: "words" } }],
    }));
  }
  const original = fs.readFileSync(exampleFile);
  const originalIndex = fs.readFileSync(path.join(f.source, "index.html"));
  f.assemble();
  const removed = preparePublishedSite(f.stage, f.source);
  assert.equal(removed.length, 4);
  assert.deepEqual(fs.readFileSync(exampleFile), original);
  assert.deepEqual(fs.readFileSync(path.join(f.source, "index.html")), originalIndex);
  for (const href of removed) {
    assert.equal(fs.existsSync(path.join(f.stage, href)), false);
    assert.equal(fs.existsSync(path.join(f.stage, href.replace('docs/', 'docs/assets/og/').replace('.html', '.png'))), false);
  }
  const site = data(f.stage, "site.js", "BH_SITE");
  const search = data(f.stage, "search-index.js", "BH_SEARCH");
  const reviews = data(f.stage, "reviews.js", "BH_REVIEWS");
  // Every listed page of the repo except the removed examples: no more, no fewer.
  const listed = [...data(ROOT, "site.js", "BH_SITE").pages].map((p) => p.href).filter((href) => !removed.includes(href));
  assert.ok(listed.length >= 3);
  assert.deepEqual([...site.pages.map((p) => p.href)].sort(), listed.sort());
  assert.ok(site.pages.some((p) => p.href === post));
  assert.ok(search.some((p) => p.href === post));
  assert.ok(search.some((p) => p.kind === "glossary"));
  assert.ok((site.backlinks[post] || []).every((b) => !removed.includes(b.href.split("#")[0])), "removed examples cannot backlink into posts");
  assert.ok(reviews[post]?.length > 0);
  assert.ok(site.reviews[post]?.threads > 0);
  for (const href of removed) {
    assert.equal(site.pages.some((p) => p.href === href), false);
    assert.equal(search.some((p) => p.href === href), false);
    assert.equal(site.backlinks[href], undefined);
    assert.equal(site.reviews[href], undefined);
    assert.equal(reviews[href], undefined);
    assert.ok(!fs.readFileSync(path.join(f.stage, "index.html"), "utf8").includes(href));
  }
  const publishedPost = fs.readFileSync(path.join(f.stage, post), "utf8");
  for (const href of links) assert.ok(!publishedPost.includes(`href="${href}"`));
  assert.ok(publishedPost.includes('<em>Example words</em>'));
  assert.ok(publishedPost.includes('href="https://elsewhere.test/'));
  assert.ok(!fs.readFileSync(path.join(f.stage, "docs/glossary.html"), "utf8").includes('href="token-bucket-rate-limiting.html"'));
  assert.ok(!fs.readFileSync(path.join(f.stage, "theme/glossary.js"), "utf8").includes(example));
  const server = http.createServer((req, res) => {
    const file = path.join(f.stage, new URL(req.url, "http://local").pathname);
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/`;
    assert.equal((await fetch(base + example)).status, 404);
    assert.equal((await fetch(base + post)).status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("publication fails loudly for no active markers, mismatched pages and missing cards", (t) => {
  for (const fault of ["zero", "missing-page", "missing-card"]) {
    const f = fixture(t);
    if (fault === "zero") {
      for (const file of fs.readdirSync(path.join(f.source, "docs")).filter((f) => f.endsWith(".html"))) {
        const p = path.join(f.source, "docs", file), old = fs.readFileSync(p, "utf8");
        fs.writeFileSync(p, old.replace(/<meta name="bh:example" content="true">/g, '<!-- <meta name="bh:example" content="true"> -->'));
      }
    }
    f.assemble();
    if (fault === "missing-page") fs.unlinkSync(path.join(f.stage, example));
    if (fault === "missing-card") fs.unlinkSync(path.join(f.stage, "docs/assets/og/token-bucket-rate-limiting.png"));
    assert.throws(() => preparePublishedSite(f.stage, f.source), /Expected example|do not match/);
    assert.ok(fs.existsSync(path.join(f.stage, "docs/adr-002-rate-limit-at-the-edge.html")), "failure before pruning");
  }
  assert.throws(() => preparePublishedSite(ROOT), /source checkout/);
});


test("project subpaths normalize a missing trailing slash and preserve unrelated anchor attributes", (t) => {
  const f = fixture(t);
  const pkgPath = path.join(f.source, "package.json"), pkg = JSON.parse(fs.readFileSync(pkgPath));
  pkg.homepage = "https://fork.example/blog";
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  const file = path.join(f.source, post), original = fs.readFileSync(file, "utf8");
  const links = ["token-bucket-rate-limiting.html", "/blog/docs/token-bucket-rate-limiting.html",
    "https://fork.example/blog/docs/token-bucket-rate-limiting.html#implementation"];
  const injected = original.replace("</article>", links.map((href) => `<a href='${href}'>Removed link</a>`).join("") +
    '<a data-href="token-bucket-rate-limiting.html" href="glossary.html">Kept link</a></article>');
  assert.notEqual(injected, original);
  fs.writeFileSync(file, injected);
  f.assemble();
  preparePublishedSite(f.stage, f.source);
  const result = fs.readFileSync(path.join(f.stage, post), "utf8");
  for (const href of links) assert.ok(!result.includes(`href='${href}'`), href);
  assert.ok(result.includes('<a data-href="token-bucket-rate-limiting.html" href="glossary.html">Kept link</a>'));
});

test("published artifact keeps unlisted pages and their cards, and leaves them out of the rebuilt index, search and backlinks", async (t) => {
  const f = fixture(t);
  const marker = '<meta name="bh:unlisted" content="true">';
  // An unlisted page of its own (a copy of a post) and an unlisted page that is also an example.
  const quiet = "docs/quiet-demo.html", quietExample = "docs/quiet-example.html";
  const original = fs.readFileSync(path.join(f.source, post), "utf8");
  const withMarker = (html, extra = "") => html.replace(/^(  <meta name="bh:tags" content="[^"]*">\n)/m, `$1  ${marker}\n${extra}`).replace(/<title>[^<]*<\/title>/, "<title>Quiet words</title>");
  fs.writeFileSync(path.join(f.source, quiet), withMarker(original));
  fs.writeFileSync(path.join(f.source, quietExample), withMarker(original, '  <meta name="bh:example" content="true">\n').replace("<title>Quiet words</title>", "<title>Quiet example</title>"));
  for (const page of [quiet, quietExample]) {
    fs.copyFileSync(path.join(f.source, "docs/assets/og/announcing-patchcov.png"), path.join(f.source, page.replace("docs/", "docs/assets/og/").replace(".html", ".png")));
  }
  // A listed post links to the unlisted one, and the unlisted one links back.
  fs.writeFileSync(path.join(f.source, post), original.replace("</article>", '<p><a href="quiet-demo.html">Quiet link</a></p></article>'));
  fs.writeFileSync(path.join(f.source, quiet), fs.readFileSync(path.join(f.source, quiet), "utf8").replace("</article>", '<p><a href="glossary.html">Glossary</a></p></article>'));
  for (const document of [quiet, quietExample]) {
    fs.writeFileSync(path.join(f.source, "reviews", path.basename(document) + ".json"), JSON.stringify({
      format: "bh-review/1", document, reviewer: "Reader", comments: [{ id: document, kind: "comment", body: "Quiet words", created: "2026-10-13T00:00:00Z", target: { quote: { exact: "words" } } }],
    }));
  }
  f.assemble();
  const removed = preparePublishedSite(f.stage, f.source);
  assert.ok(removed.includes(quietExample), "an unlisted example is still an example, and the stricter rule wins");
  assert.equal(fs.existsSync(path.join(f.stage, quietExample)), false);
  assert.equal(fs.existsSync(path.join(f.stage, "docs/assets/og/quiet-example.png")), false);
  // The unlisted page and its card are published at their normal address.
  assert.equal(fs.existsSync(path.join(f.stage, quiet)), true);
  assert.equal(fs.existsSync(path.join(f.stage, "docs/assets/og/quiet-demo.png")), true);
  const published = fs.readFileSync(path.join(f.stage, quiet), "utf8");
  assert.ok(published.includes(marker));
  // The rebuilt default data does not mention it; the unlisted data does, and lacks the removed example.
  for (const file of ["index.html", "theme/site.js", "theme/search-index.js"]) {
    assert.ok(!fs.readFileSync(path.join(f.stage, file), "utf8").includes("quiet-demo"), `${file} must not mention the unlisted page`);
    assert.ok(!fs.readFileSync(path.join(f.stage, file), "utf8").includes("Quiet words"), `${file} must not carry its title`);
  }
  const unlisted = data(f.stage, "unlisted-pages.js", "BH_UNLISTED");
  assert.deepEqual([...added(unlisted.pages).map((p) => p.href)], [quiet]);
  assert.ok(unlisted.search.some((p) => p.href === quiet));
  assert.deepEqual([...unlisted.backlinks[quiet].map((b) => b.href.split("#")[0])], [post]);
  assert.deepEqual([...added(data(f.stage, "unlisted-slugs.js", "BH_UNLISTED_SLUGS"))], [quiet]);
  // …and the repo's own unlisted pages are still published and still listed as unlisted.
  for (const href of REPO_UNLISTED) {
    assert.ok(fs.existsSync(path.join(f.stage, href)), `${href} is published`);
    assert.ok(data(f.stage, "unlisted-slugs.js", "BH_UNLISTED_SLUGS").includes(href), `${href} stays unlisted`);
  }
  // Review threads on the unlisted page ship in their own file; the removed example's do not.
  assert.deepEqual(added(Object.keys(data(f.stage, "unlisted-reviews.js", "BH_REVIEWS"))), [quiet]);
  assert.ok(!fs.readFileSync(path.join(f.stage, "theme/reviews.js"), "utf8").includes("quiet-"));
  for (const file of ["unlisted-pages.js", "unlisted-slugs.js", "unlisted-reviews.js"]) assert.ok(!fs.readFileSync(path.join(f.stage, "theme", file), "utf8").includes("quiet-example"));
  // The published post keeps its link to the unlisted page in the HTML; the browser makes it inert.
  assert.ok(fs.readFileSync(path.join(f.stage, post), "utf8").includes('href="quiet-demo.html"'));
  const site = data(f.stage, "site.js", "BH_SITE");
  assert.equal(site.pages.some((p) => p.href === quiet), false);
  assert.equal(site.backlinks[quiet], undefined);
  const server = http.createServer((req, res) => {
    const file = path.join(f.stage, new URL(req.url, "http://local").pathname);
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/`;
    assert.equal((await fetch(base + quiet)).status, 200);
    assert.equal((await fetch(base + quietExample)).status, 404);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("publication ships the encrypted card file and its module unchanged", (t) => {
  const f = fixture(t);
  const card = { title: "Hidden", description: "", kind: "explainer", status: "", date: "", tags: [] };
  fs.writeFileSync(path.join(f.source, "theme/private-cards.js"), renderCardsFile([{ slug: "some-page", blob: encryptCard(card, "A".repeat(43), "some-page") }]));
  f.assemble();
  preparePublishedSite(f.stage, f.source);
  for (const file of ["theme/private-cards.js", "theme/modules/private-cards.js"]) {
    assert.deepEqual(fs.readFileSync(path.join(f.stage, file)), fs.readFileSync(path.join(f.source, file)), file);
  }
  assert.match(fs.readFileSync(path.join(f.stage, "index.html"), "utf8"), /<ul[^>]*id="doc-list"[^>]*data-private-cards/);
});
