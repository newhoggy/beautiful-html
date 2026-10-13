#!/usr/bin/env node
// Prepare an assembled Pages artifact. The source/local variant stays untouched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uncomment = (html) => html.replace(/<!--[\s\S]*?-->/g, "");
function examples(root) {
  return fs.readdirSync(path.join(root, "docs")).filter((name) => name.endsWith(".html"))
    .filter((name) => {
      const head = uncomment(fs.readFileSync(path.join(root, "docs", name), "utf8")).match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] || "";
      return /<meta\s+name="bh:example"\s+content="true"/i.test(head);
    }).map((name) => `docs/${name}`).sort();
}
const readData = (root, file, global) => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), { window });
  return window[global];
};
const writeData = (root, file, global, data) => fs.writeFileSync(path.join(root, file),
  `/* GENERATED for publication by scripts/publish.mjs. Do not edit. */\nwindow.${global} = ${JSON.stringify(data, null, 1)};\n`);

export function preparePublishedSite(stage, source = ROOT) {
  stage = path.resolve(stage);
  if (stage === path.resolve(source) || stage === ROOT) {
    throw new Error("Refusing to prune the source checkout");
  }
  const marked = examples(source);
  if (!marked.length) throw new Error("Expected example pages, but found none in the source heads");
  if (JSON.stringify(examples(stage)) !== JSON.stringify(marked)) throw new Error("Assembled example pages do not match the source; refusing to publish");
  // Validate all expected files before deleting any: missing cards must fail loudly too.
  for (const href of marked) {
    const card = href.replace(/\.html$/, ".png").replace(/^docs\//, "docs/assets/og/");
    if (!fs.existsSync(path.join(stage, card))) throw new Error(`Expected example card is missing: ${card}`);
  }
  const removed = new Set(marked);
  const homepage = new URL(String(process.env.BH_SITE_URL || JSON.parse(fs.readFileSync(path.join(source, "package.json"))).homepage).replace(/\/*$/, "/"));
  const isRemoved = (href, page) => {
    try {
      const url = new URL(href.replace(/&amp;/g, "&"), new URL(page, homepage));
      if (url.origin !== homepage.origin || !url.pathname.startsWith(homepage.pathname)) return false;
      return removed.has(decodeURIComponent(url.pathname.slice(homepage.pathname.length)));
    } catch { return false; }
  };
  const sanitize = (html, page) => html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs, inner) => {
    const href = attrs.match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    return href && isRemoved(href[1] ?? href[2], page) ? inner : whole;
  }).replace(/<meta\s+name="bh:(?:supersedes|superseded-by)"\s+content="([^"]*)"[^>]*>/gi,
    (whole, href) => isRemoved(href, page) ? "" : whole);
  for (const href of marked) {
    fs.unlinkSync(path.join(stage, href));
    fs.unlinkSync(path.join(stage, href.replace(/\.html$/, ".png").replace(/^docs\//, "docs/assets/og/")));
  }
  for (const page of ["index.html", ...fs.readdirSync(path.join(stage, "docs")).filter((f) => f.endsWith(".html")).map((f) => `docs/${f}`)]) {
    const file = path.join(stage, page);
    fs.writeFileSync(file, sanitize(fs.readFileSync(file, "utf8"), page));
  }
  // Reuse the existing generators in isolation; tooling and review sources never ship.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bh-publish-"));
  try {
    for (const entry of ["index.html", "docs", "theme"]) fs.cpSync(path.join(stage, entry), path.join(temp, entry), { recursive: true });
    for (const entry of ["scripts", "package.json", "reviews"]) fs.cpSync(path.join(source, entry), path.join(temp, entry), { recursive: true });
    execFileSync(process.execPath, [path.join(temp, "scripts/bh.mjs"), "index"], { cwd: temp, stdio: "pipe" });
    for (const entry of ["index.html", "theme/glossary.js", "theme/site.js", "theme/search-index.js", "theme/reviews.js"]) {
      fs.copyFileSync(path.join(temp, entry), path.join(stage, entry));
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  const reviews = readData(stage, "theme/reviews.js", "BH_REVIEWS");
  const site = readData(stage, "theme/site.js", "BH_SITE");
  for (const href of marked) { delete reviews[href]; delete site.reviews[href]; }
  writeData(stage, "theme/reviews.js", "BH_REVIEWS", reviews);
  writeData(stage, "theme/site.js", "BH_SITE", site);
  console.log(`Removed ${marked.length} example pages and ${marked.length} social cards; rebuilt published index, glossary, search, backlinks and reviews`);
  return marked;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { preparePublishedSite(path.join(ROOT, "_site")); }
  catch (error) { console.error(`Publication failed: ${error.message}`); process.exitCode = 1; }
}
