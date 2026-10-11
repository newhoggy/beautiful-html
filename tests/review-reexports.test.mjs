import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const document = "docs/edge-rate-limiting-design.html";
const root = { id: "reexport-root", created: "2026-10-11T01:00:00Z", kind: "question", body: "Why?", target: { anchor: "", anchorKind: "top", quote: null } };
const reply = { id: "reexport-reply", created: "2026-10-11T02:00:00Z", kind: "comment", body: "Answered", inReplyTo: root.id, resolves: true };
const review = (comments, extra = {}) => ({ format: "bh-review/1", document, build: {}, reviewer: "Reader", comments, ...extra });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bh-reexports-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ["scripts", "theme", "docs", "templates", "index.html", "package.json"]) fs.cpSync(path.join(source, name), path.join(dir, name), { recursive: true });
  fs.mkdirSync(path.join(dir, "reviews/inbox"), { recursive: true });
  const write = (name, data) => {
    const file = path.join(dir, "reviews/inbox", name);
    const json = JSON.stringify(data);
    fs.writeFileSync(file, name.endsWith(".gz") ? zlib.gzipSync(json) : json);
    assert.ok(fs.statSync(file).size > 0, "fixture was written");
  };
  const run = (...args) => {
    const result = spawnSync(process.execPath, [path.join(dir, "scripts/bh.mjs"), ...args], { cwd: dir, encoding: "utf8" });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const ok = (...args) => { const r = run(...args); assert.equal(r.status, 0, r.output); return r; };
  return { dir, write, run, ok };
}

function published(dir, file) {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(dir, "theme", file), "utf8"), { window: context });
  return context;
}

test("overlapping exports publish roots and replies once, including gzip and export-time differences", (t) => {
  const f = fixture(t);
  f.write("a.json", review([root, reply]));
  // Later export changes its envelope, field order and location observation, then adds a reply.
  const reordered = Object.fromEntries(Object.entries(root).reverse());
  reordered.target = Object.fromEntries(Object.entries(root.target).reverse());
  const followup = { ...reply, id: "reexport-followup", inReplyTo: reply.id, created: "2026-10-11T03:00:00Z", resolves: false };
  f.write("b.json.gz", review([{ ...reordered, author: "Reader", outdated: true }, reply, followup], { exported: "2026-10-11T04:00:00Z", build: { commit: "later" } }));
  f.ok("index");
  f.ok("check");
  const messages = published(f.dir, "reviews.js").BH_REVIEWS[document];
  assert.equal(messages.length, 3);
  assert.equal(new Set(messages.map((m) => m.id)).size, 3);
  assert.equal(messages[0].file, "reviews/inbox/a.json");
  assert.equal(messages[0].author, "Reader");
  assert.equal("outdated" in messages[0], false);
  assert.deepEqual(JSON.parse(JSON.stringify(published(f.dir, "site.js").BH_SITE.reviews[document])), { threads: 1, open: 1 });
  f.ok("bundle", document);
  const bundle = fs.readFileSync(path.join(f.dir, "dist/edge-rate-limiting-design.html"), "utf8");
  const data = bundle.match(/window\.BH_REVIEWS = ([\s\S]*?);/);
  assert.ok(data, "bundle contains published reviews");
  assert.equal(JSON.parse(data[1])[document].length, 3);
});

test("every meaningful difference remains an id collision", (t) => {
  const f = fixture(t);
  f.write("a.json", review([root, reply]));
  const cases = [
    review([{ ...root, body: "Different" }]),
    review([{ ...root, target: { ...root.target, anchor: "other" } }]),
    review([{ ...root, created: "2026-10-11T05:00:00Z" }]),
    review([{ ...root, updated: "2026-10-11T05:00:00Z" }]),
    review([{ ...root, suggestion: "Change this" }]),
    review([root], { reviewer: "Someone else" }),
    review([root], { document: "docs/glossary.html" }),
    review([{ ...reply, resolves: false }]),
    review([{ ...reply, inReplyTo: "missing" }]),
  ];
  for (const data of cases) {
    f.write("b.json", data);
    f.ok("index");
    const result = f.run("check");
    assert.notEqual(result.status, 0);
    assert.match(result.output, /is also used in .* with different content or document/);
  }
});

test("duplicates never suppress validation of invalid records or cross-document replies", (t) => {
  const f = fixture(t);
  f.write("a.json", review([{ ...root, created: "invalid" }]));
  f.write("b.json", review([{ ...root, created: "invalid" }]));
  f.ok("index");
  let result = f.run("check");
  assert.notEqual(result.status, 0);
  assert.equal((result.output.match(/created must be an ISO date-time/g) || []).length, 2);
  f.write("a.json", review([root]));
  f.write("b.json", review([reply], { document: "docs/glossary.html" }));
  f.ok("index");
  result = f.run("check");
  assert.notEqual(result.status, 0);
  assert.match(result.output, /not docs\/glossary.html/);
});
