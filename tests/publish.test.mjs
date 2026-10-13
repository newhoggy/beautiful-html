import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import http from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { preparePublishedSite } from "../scripts/publish.mjs";

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
  assert.equal(site.pages.length, 3);
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
