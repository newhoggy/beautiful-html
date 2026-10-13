#!/usr/bin/env node
// beautiful-html CLI — zero dependencies, Node ≥ 20.
//
//   node scripts/bh.mjs new [--private] [--example] [--unlisted] <template> <slug> "<Title>" ["<description>"]
//   node scripts/bh.mjs index                 regenerate index.html list, social meta, theme/{glossary,site,search-index,unlisted-pages,unlisted-slugs}.js
//   node scripts/bh.mjs check                 lint docs/ and index.html
//   node scripts/bh.mjs cards                 render docs/assets/og/<slug>.png (needs Chrome; see scripts/cards.mjs)
//   node scripts/bh.mjs bundle <page|--all>   inline theme → dist/<name>.html (single file)
//   node scripts/bh.mjs seal [--show-links|--reshell]   encrypt docs/*.private.html → docs/<slug>.html (see "Private pages")
//   node scripts/bh.mjs unseal [slug…]        decrypt docs/<slug>.html → docs/<slug>.private.html
//   node scripts/bh.mjs serve [port]          static server (pages also work from file://)

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execSync, execFileSync } from "node:child_process";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  KIND_LABELS, escapeHtml, CARD_FILE, KEY_RE, GROUP_RE, cardFromDoc, tryDecryptCard, buildBlob,
  renderCardsFile, parseCardsFile, validateCardsFile, mergeEntries, docCardHtml,
} from "./private-cards.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");
const TEMPLATES = path.join(ROOT, "templates");
const DIST = path.join(ROOT, "dist");
const INDEX = path.join(ROOT, "index.html");
const GLOSSARY_SRC = path.join(DOCS, "glossary.html");
const GLOSSARY_OUT = path.join(ROOT, "theme", "glossary.js");
const SITE_OUT = path.join(ROOT, "theme", "site.js");
const SEARCH_OUT = path.join(ROOT, "theme", "search-index.js");
const REVIEWS_OUT = path.join(ROOT, "theme", "reviews.js");
// Unlisted pages (bh:unlisted): published and readable by direct link, but off the home page,
// search, backlinks and in-site links unless the reader opened a page with #unlisted=true.
// Everything about them lives in UNLISTED_OUT, which a page loads only when that flag is on;
// UNLISTED_SLUGS_OUT holds their paths alone, so links to them can be made inert by default.
const UNLISTED_OUT = path.join(ROOT, "theme", "unlisted-pages.js");
const UNLISTED_SLUGS_OUT = path.join(ROOT, "theme", "unlisted-slugs.js");
// An unlisted page's published review threads: theme/reviews.js (loaded by listed pages) must not
// carry their text, so they are in a file that only the unlisted page itself loads.
const UNLISTED_REVIEWS_OUT = path.join(ROOT, "theme", "unlisted-reviews.js");
// Private pages: plaintext in docs/<slug>.private.html (git-ignored), published only as an
// encrypted docs/<slug>.html that decrypts in the browser with the key in the URL fragment.
// Keys live in 1Password (vault $BH_OP_VAULT, default "Private"), never in the repo.
const PRIVATE_EXT = ".private.html";
const OP_VAULT = process.env.BH_OP_VAULT || "Private";

const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

// ---- HTML helpers (regex-based; fine for the files we author) ------------------

function getMeta(html, name) {
  const re = new RegExp(`<meta\\s+name="${name.replace(":", "\\:")}"\\s+content="([^"]*)"`, "i");
  return (html.match(re) || [])[1]?.trim() ?? "";
}

function getTitle(html) {
  return (html.match(/<title>([^<]*)<\/title>/i) || [])[1]?.trim() ?? "";
}

function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

function allDocFiles() {
  if (!fs.existsSync(DOCS)) return [];
  return fs.readdirSync(DOCS).filter((f) => f.endsWith(".html")).sort().map((f) => path.join(DOCS, f));
}

const isPrivateSource = (file) => file.endsWith(PRIVATE_EXT);
const isSealed = (file) => !isPrivateSource(file) && /<meta\s+name="bh:sealed"/i.test(fs.readFileSync(file, "utf8"));

/** Public documents only: every page that is published, unlisted ones included. */
function docFiles() {
  return allDocFiles().filter((f) => !isPrivateSource(f) && !isSealed(f));
}
/** Public documents the site surfaces: what the catalogue, search, backlinks and `bundle --all` see.
    An unlisted page is published and checked like any other but is not in this list. */
function listedDocFiles() {
  return docFiles().filter((f) => !readDoc(f).unlisted);
}
const privateSources = () => allDocFiles().filter(isPrivateSource);
const sealedFiles = () => allDocFiles().filter(isSealed);

function readDoc(file) {
  const html = stripComments(fs.readFileSync(file, "utf8")); // example <meta> in comments must not count
  return {
    file,
    href: path.relative(ROOT, file).split(path.sep).join("/"),
    title: getTitle(html),
    description: getMeta(html, "description"),
    kind: getMeta(html, "bh:kind") || "explainer",
    status: getMeta(html, "bh:status"),
    date: getMeta(html, "bh:date"),
    tags: getMeta(html, "bh:tags"),
    // Pages that only demonstrate the theme and templates: shown on a local host, hidden on the
    // published domain (theme/examples.js decides in the browser).
    example: getMeta(html, "bh:example") === "true",
    // Published but not surfaced: off the home page, search and backlinks, and links to it are inert,
    // unless the reader opened a page with #unlisted=true (theme/unlisted.js decides in the browser).
    unlisted: getMeta(html, "bh:unlisted") === "true",
    authors: getMeta(html, "bh:authors"),
    // Lifecycle links (relative to the doc in the source; root-relative here).
    supersedes: resolveDocLink(file, getMeta(html, "bh:supersedes")),
    supersededBy: resolveDocLink(file, getMeta(html, "bh:superseded-by")),
  };
}

/** The page's topics, lowercase. An example page is also under "examples". */
function docTopics(d) {
  const tags = (d.tags || "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  return d.example && !tags.includes("examples") ? ["examples", ...tags] : tags;
}

/** A doc-relative link from a meta tag as a root-relative path ("docs/x.html"), or "". */
function resolveDocLink(file, value) {
  if (!value) return "";
  return path.relative(ROOT, path.resolve(path.dirname(file), value)).split(path.sep).join("/");
}

// ---- social cards: the managed <head> block and the card images --------------------------------
//
// Every public page carries Open Graph / Twitter tags between two markers. `npm run index`
// writes them from the page's own title, description and bh:* metas, and `check` fails when
// they are missing or stale. Each page also has a 1200×630 card, docs/assets/og/<slug>.png,
// rendered by scripts/cards.mjs from a visual chosen out of the page itself. The home page uses
// the shared site card. Absolute URLs come from one place: package.json `homepage`, or the
// BH_SITE_URL environment variable (for forks).

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const SITE_URL = String(process.env.BH_SITE_URL || PKG.homepage || "").replace(/\/*$/, "/");
const SITE_NAME = PKG.bh?.siteName || "Bitwise Engineering";
const SHARED_CARD = "theme/logo/og.png"; // the home page's card, and the fallback for every other
const SHARED_CARD_ALT = "Bitwise Engineering: functional programming, succinct data structures and AI workflows";
const LOGO_TILE = path.join(ROOT, "theme", "logo", "mark-tile.svg");
const CARD_DIR = path.join(DOCS, "assets", "og");
const CARD_W = 1200, CARD_H = 630;
const SOCIAL_START = "<!-- bh:social:start (generated by `npm run index`; do not edit) -->";
const SOCIAL_END = "<!-- bh:social:end -->";
const ROBOTS_NOINDEX = '<meta name="robots" content="noindex, nofollow">';
const SOCIAL_RE = /[ \t]*<!-- bh:social:start\b[\s\S]*?<!-- bh:social:end -->/;
const DESCRIPTION_MAX = 200; // chat apps and crawlers truncate beyond about this

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const attr = (s) => String(s).replace(/"/g, "&quot;");

/** HTML text → plain text, for drawing a title on a card. One pass, so "&amp;#65;" stays "&#65;". */
function decodeHtml(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", times: "×", middot: "·" };
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) =>
    dec ? String.fromCodePoint(+dec) : hex ? String.fromCodePoint(parseInt(hex, 16)) : named[name] ?? m);
}

/**
 * The block of social tags for `m`: { type, title, description, url, image, alt, published?, authors?, tags? }.
 * title, description, alt, authors and tags are HTML text as written in the page; urls and the site name are plain.
 */
function socialBlock(m) {
  const tag = (k, v, a = "property") => `  <meta ${a}="${k}" content="${attr(v)}">`;
  return [
    `  ${SOCIAL_START}`,
    `  <link rel="canonical" href="${escapeHtml(m.url)}">`,
    tag("og:type", m.type),
    tag("og:site_name", escapeHtml(SITE_NAME)),
    tag("og:title", m.title),
    tag("og:description", m.description),
    tag("og:url", escapeHtml(m.url)),
    tag("og:image", escapeHtml(m.image)),
    tag("og:image:type", "image/png"),
    tag("og:image:width", String(CARD_W)),
    tag("og:image:height", String(CARD_H)),
    tag("og:image:alt", m.alt),
    ...(m.published ? [tag("article:published_time", m.published)] : []),
    ...(m.authors || []).map((a) => tag("article:author", a)),
    ...(m.tags || []).map((t) => tag("article:tag", t)),
    tag("twitter:card", "summary_large_image", "name"),
    // An unlisted page asks crawlers to leave it out. It is the author's marker that decides, not a tag they write.
    ...(m.noindex ? [`  ${ROBOTS_NOINDEX}`] : []),
    `  ${SOCIAL_END}`,
  ].join("\n");
}

const pageUrl = (href) => SITE_URL + href;
const cardPath = (file) => path.join(CARD_DIR, path.basename(file, ".html") + ".png");
const cardHref = (file) => path.relative(ROOT, cardPath(file)).split(path.sep).join("/");

/** The block a public page (or index.html) must carry. */
function expectedSocial(file) {
  if (file === INDEX) {
    const html = stripComments(fs.readFileSync(INDEX, "utf8"));
    return socialBlock({ type: "website", title: getTitle(html), description: getMeta(html, "description"), url: SITE_URL, image: SITE_URL + SHARED_CARD, alt: SHARED_CARD_ALT });
  }
  const d = readDoc(file);
  const sel = chooseVisual(file);
  const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
  return socialBlock({
    type: "article", title: d.title, description: d.description, url: pageUrl(d.href), image: SITE_URL + cardHref(file),
    alt: escapeHtml(sel.label ? `${decodeHtml(d.title)}: ${sel.label}` : `${decodeHtml(d.title)} (${KIND_LABELS[d.kind] || d.kind}, ${SITE_NAME})`),
    published: d.date, authors: list(d.authors), tags: list(d.tags), noindex: d.unlisted,
  });
}

/** `raw` with its social block replaced, or inserted (before the theme script) when it has none. */
function withSocial(raw, block) {
  if (SOCIAL_RE.test(raw)) return raw.replace(SOCIAL_RE, () => block);
  // First time: tags written by hand move into the block.
  const stripped = raw
    .replace(/^[ \t]*<meta\s+(?:property="(?:og|article):|name="twitter:)[^>]*>\n/gm, "")
    .replace(/^[ \t]*<link\s+rel="canonical"[^>]*>\n/gm, "");
  const at = stripped.search(/^[ \t]*<script>try\{var t=localStorage/m);
  if (at >= 0) return stripped.slice(0, at) + block + "\n" + stripped.slice(at);
  return stripped.replace(/^[ \t]*<\/head>/m, (m) => block + "\n" + m);
}

// -- choosing the card's visual: static, so `check` needs no browser -----------------------------

/**
 * The visual a page's card shows, first match wins:
 *   1. <meta name="bh:image">: "#element-id" on the page, or a path to an image file
 *   2. the first <figure> holding an <svg>, <img>, <bh-sequence> or <bh-chart>
 *   3. a standalone <img> in the article
 *   4. the hero glyph (.bh-hero-mark / [data-bh-logo])
 *   5. the logo tile
 * Returns { tier, css, index } (an element of the page, found with querySelectorAll(css)[index])
 * or { tier, image } (a file), plus `label` (its aria-label/alt), `source` and `files`
 * (what the card's staleness key hashes) and `problem` when an override can't be resolved.
 */
const visuals = new Map();
function chooseVisual(file) {
  const raw = fs.readFileSync(file, "utf8");
  const hit = visuals.get(file);
  if (hit?.raw === raw) return hit.result; // `index` and `check` ask twice per page
  const result = pickVisual(file, raw);
  visuals.set(file, { raw, result });
  return result;
}

function pickVisual(file, raw) {
  const { root, src } = parseTree(raw);
  const dir = path.dirname(file);
  const article = findNode(root, (n) => hasClass(n, "bh-article"));
  const inner = (n) => (VOID_TAGS.has(n.tag) ? "" : src.slice(n.start, n.end));
  const markup = (n) => `<${n.tag}${n.attrs}>${inner(n)}`;
  const VIS = /<(svg|img|bh-sequence|bh-chart)\b/;
  const label = (n) => {
    const t = markup(n);
    return decodeHtml((t.match(/aria-label="([^"]+)"/) || t.match(/\balt="([^"]+)"/) || [])[1] || "");
  };
  const files = (n) => [...markup(n).matchAll(/<img\b[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1])
    .filter((u) => !/^(https?:|data:|\/\/)/.test(u)).map((u) => path.resolve(dir, decodeURI(u.split(/[?#]/)[0])));
  const element = (n, tier, css, index) => ({ tier, css, index, label: label(n), source: markup(n), files: files(n) });
  const byId = (id) => `[id="${id}"]`;

  const override = getMeta(stripComments(raw), "bh:image");
  if (override.startsWith("#")) {
    const n = findNode(root, (x) => nodeAttr(x, "id") === override.slice(1));
    if (!n) return { tier: "override", image: null, label: "", source: "", files: [], problem: `bh:image="${override}": no element with that id` };
    return element(n, "override", byId(override.slice(1)), 0);
  }
  if (override) {
    const image = path.resolve(dir, override);
    const problem = !fs.existsSync(image) ? `bh:image="${override}": no such file` : !MIME[path.extname(image).toLowerCase()] ? `bh:image="${override}": not an image file` : undefined;
    return { tier: "override", image, label: "", source: "", files: [image], problem };
  }
  if (article) {
    let figures = -1, hit = null;
    walkTree(article, (n) => { if (n.tag === "figure") { figures++; if (!hit && VIS.test(markup(n))) hit = { n, index: figures }; } });
    if (hit) {
      const id = nodeAttr(hit.n, "id");
      return id ? element(hit.n, "figure", byId(id), 0) : element(hit.n, "figure", ".bh-article figure", hit.index);
    }
    const img = findNode(article, (n) => n.tag === "img");
    if (img) return element(img, "image", ".bh-article img", 0);
    const glyph = findNode(article, (n) => hasClass(n, "bh-hero-mark") || /\sdata-bh-logo\b/.test(n.attrs));
    if (glyph) return { tier: "glyph", image: LOGO_TILE, label: "", source: "glyph", files: [LOGO_TILE] };
  }
  return { tier: "logo", image: LOGO_TILE, label: "", source: "logo", files: [LOGO_TILE] };
}

/** Hash of the shared files every card is drawn from: the card layout, the logo, the theme CSS and bh.js (which adds a diagram's arrowhead markers). */
let sharedCardInputs = null;
const cardInputsHash = (withModules) => {
  sharedCardInputs ??= sha256(["scripts/cards.mjs", "theme/logo/mark.svg", "theme/bh.js", ...["tokens", "base", "layout", "components", "diagrams"].map((f) => `theme/${f}.css`)]
    .map((f) => fs.readFileSync(path.join(ROOT, f))).join("\0"));
  if (!withModules) return sharedCardInputs;
  // <bh-…> components (charts, sequences, …) are drawn by the on-demand modules.
  const dir = path.join(ROOT, "theme", "modules");
  return sha256(sharedCardInputs + fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort().map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\0"));
};

/** Everything that decides how a page's card looks. Any change here makes the card stale. */
function cardJob(file) {
  const d = readDoc(file);
  const sel = chooseVisual(file);
  const styles = [...stripComments(fs.readFileSync(file, "utf8")).matchAll(/<style\b[\s\S]*?<\/style>/g)].map((m) => m[0]).join("\n");
  const kind = KIND_LABELS[d.kind] || d.kind;
  const bytes = (f) => (fs.existsSync(f) ? sha256(fs.readFileSync(f)) : "missing");
  const key = sha256(JSON.stringify([
    cardInputsHash(/<bh-/.test(sel.source)), d.title, kind, d.date, SITE_NAME, sel.tier, sel.css, sel.index, sel.source, styles, sel.files.map(bytes),
  ]));
  return {
    slug: path.basename(file, ".html"), href: d.href, out: cardPath(file), key, selection: sel,
    frame: { title: decodeHtml(d.title), kind, date: d.date, siteName: SITE_NAME },
  };
}

/** { width, height, card } of a PNG: its size and the `bh-card` key recorded in it (or null). */
function readPng(file) {
  const b = fs.readFileSync(file);
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) return null;
  let card = null;
  for (let p = 8; p + 12 <= b.length;) {
    const len = b.readUInt32BE(p), kind = b.toString("ascii", p + 4, p + 8);
    if (kind === "tEXt") {
      const t = b.toString("latin1", p + 8, p + 8 + len), i = t.indexOf("\0");
      if (t.slice(0, i) === "bh-card") card = t.slice(i + 1);
    }
    if (kind === "IEND") break;
    p += 12 + len;
  }
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), card };
}

function orphanCards() {
  const slugs = new Set(docFiles().map((f) => path.basename(f, ".html")));
  return fs.existsSync(CARD_DIR) ? fs.readdirSync(CARD_DIR).filter((f) => f.endsWith(".png") && !slugs.has(f.slice(0, -4))) : [];
}

/** Problems with the site base: it has to be an absolute http(s) URL, since crawlers need that. */
function siteUrlProblems() {
  return /^https?:\/\/[^/\s]+\/(\S*\/)?$/.test(SITE_URL) ? [] : [`site base "${SITE_URL}" must be an absolute http(s) URL: set "homepage" in package.json (or BH_SITE_URL)`];
}

async function cmdCards(argv) {
  const force = argv.includes("--force");
  for (const f of orphanCards()) {
    fs.rmSync(path.join(CARD_DIR, f));
    console.log(c.dim(`Removed docs/assets/og/${f} (no public page has that name)`));
  }
  const jobs = docFiles().map(cardJob);
  for (const j of jobs) if (j.selection.problem) throw new Error(`${j.href}: ${j.selection.problem}`);
  const todo = jobs.filter((j) => force || !fs.existsSync(j.out) || readPng(j.out)?.card !== j.key);
  if (!todo.length) { console.log(c.green(`All ${jobs.length} cards are up to date.`)); return; }
  const { renderCards } = await import("./cards.mjs");
  const r = await renderCards(todo, { sharedCard: path.join(ROOT, SHARED_CARD), systemFonts: argv.includes("--system-fonts") });
  console.log(c.green(`Rendered ${r.rendered} card${r.rendered === 1 ? "" : "s"}`) + (r.fallback ? c.yellow(`, ${r.fallback} fell back to the shared card`) : "") + c.dim(`, ${jobs.length - todo.length} already up to date`));
  if (r.failed.length) throw new Error(`could not render the card of ${r.failed.join(", ")}`);
}

// ---- new --------------------------------------------------------------------------

function cmdNew(argv) {
  const isPrivate = argv.includes("--private");
  const isExample = argv.includes("--example");
  const isUnlisted = argv.includes("--unlisted");
  const [template, slug, title, description] = argv.filter((a) => a !== "--private" && a !== "--example" && a !== "--unlisted");
  const templates = fs.readdirSync(TEMPLATES).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, ""));
  if (!template || !slug || !title) {
    console.error(`Usage: bh new [--private] [--example] [--unlisted] <template> <slug> "<Title>" ["<description>"]\nTemplates: ${templates.join(", ")}`);
    process.exit(2);
  }
  if (isPrivate && isExample) {
    console.error(c.red("--private and --example don't combine: a private page is never listed, so it is never an example."));
    process.exit(2);
  }
  if (isPrivate && isUnlisted) {
    console.error(c.red("--private and --unlisted don't combine: a private page already stays off the site, and is never listed."));
    process.exit(2);
  }
  if (!templates.includes(template)) {
    console.error(c.red(`Unknown template "${template}". Choose one of: ${templates.join(", ")}`));
    process.exit(2);
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    console.error(c.red(`Slug must be kebab-case: "${slug}"`));
    process.exit(2);
  }
  const out = path.join(DOCS, `${slug}${isPrivate ? PRIVATE_EXT : ".html"}`);
  if (fs.existsSync(out) || fs.existsSync(path.join(DOCS, `${slug}${isPrivate ? ".html" : PRIVATE_EXT}`))) {
    console.error(c.red(`Refusing to overwrite ${path.relative(ROOT, out)}`));
    process.exit(1);
  }
  let author = "";
  try { author = execSync("git config user.name", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
  const vars = {
    title: escapeHtml(title),
    description: escapeHtml(description || "One sentence: what the reader will understand by the end."),
    date: new Date().toISOString().slice(0, 10),
    author: escapeHtml(author),
    slug,
  };
  let html = fs.readFileSync(path.join(TEMPLATES, `${template}.html`), "utf8")
    .replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  if (isExample) {
    const marked = html.replace(/^(  <meta name="bh:tags" content="[^"]*">\n)/m, `$1  <meta name="bh:example" content="true">\n`);
    if (marked === html) { console.error(c.red(`templates/${template}.html has no bh:tags line to add the example marker after`)); process.exit(1); }
    html = marked;
  }
  if (isUnlisted) {
    const marked = html.replace(/^(  <meta name="bh:tags" content="[^"]*">\n)/m, `$1  <meta name="bh:unlisted" content="true">\n`);
    if (marked === html) { console.error(c.red(`templates/${template}.html has no bh:tags line to add the unlisted marker after`)); process.exit(1); }
    html = marked;
  }
  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(out, html);
  console.log(c.green(`Created ${path.relative(ROOT, out)}`));
  if (isPrivate) console.log(c.dim("Private page: it is git-ignored. Run `npm run seal` to publish an encrypted copy."));
  else {
    if (isExample) console.log(c.dim("Example page: shown on a local host, hidden on the published site."));
    if (isUnlisted) console.log(c.dim("Unlisted page: published, but off the home page, search and links unless a page is opened with #unlisted=true. Not private: anyone with the link can read it."));
    console.log(c.dim("When the page is written, run `npm run cards` to render its social card."));
  }
  cmdIndex();
}

// ---- glossary ---------------------------------------------------------------------
//
// docs/glossary.html is the single source: <dl class="glossary"> with
// <dt id="…" data-aliases="a, b">Term</dt><dd>…html…</dd>. It compiles to
// theme/glossary.js, which bh.js loads on every page (works from file://, unlike fetch).
// Relative links in definitions are rebased to the site root.

function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " })[e]);
}

function attrOf(attrs, name) {
  return (attrs.match(new RegExp(`\\s${name}="([^"]*)"`)) || [])[1];
}

/** Entries from every <dl class="glossary"> in an HTML string (comments stripped). */
function parseGlossary(html) {
  const entries = [];
  for (const dl of stripComments(html).matchAll(/<dl\b[^>]*\sclass="[^"]*\bglossary\b[^"]*"[^>]*>([\s\S]*?)<\/dl>/g)) {
    for (const m of dl[1].matchAll(/<dt\b([^>]*)>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/g)) {
      entries.push({
        id: attrOf(m[1], "id"),
        term: decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim(),
        aliases: (attrOf(m[1], "data-aliases") || "").split(",").map((a) => decodeEntities(a).trim()).filter(Boolean),
        html: m[3].trim().replace(/\s+\n/g, "\n"),
      });
    }
  }
  return entries;
}

function compileGlossary() {
  const header = "/* GENERATED by `npm run index` from docs/glossary.html. Edit that page, not this file. */\n";
  if (!fs.existsSync(GLOSSARY_SRC)) return { entries: [], js: header + "window.BH_GLOSSARY = [];\n" };
  const rebase = (html) => html.replace(/(\s(?:href|src)=")([^"]+)(")/g, (m, a, url, b) => {
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return m;
    if (url.startsWith("#")) return a + "docs/glossary.html" + url + b;
    return a + path.posix.normalize(path.posix.join("docs", url)) + b;
  });
  const entries = parseGlossary(fs.readFileSync(GLOSSARY_SRC, "utf8"))
    .map((e) => ({ id: e.id, term: e.term, aliases: e.aliases, html: rebase(e.html), href: `docs/glossary.html#${e.id}` }));
  return { entries, js: header + "window.BH_GLOSSARY = " + JSON.stringify(entries, null, 2) + ";\n" };
}

/** Problems in a list of glossary entries: missing ids, duplicate ids/names. */
function glossaryProblems(entries) {
  const out = [], ids = new Set(), names = new Map();
  for (const e of entries) {
    if (!e.id) { out.push(`glossary term "${e.term}" has no id`); continue; }
    if (ids.has(e.id)) out.push(`duplicate glossary id "${e.id}"`);
    ids.add(e.id);
    if (!e.html.replace(/<[^>]+>/g, "").trim()) out.push(`glossary term "${e.id}" has an empty definition`);
    for (const n of [e.term, ...e.aliases]) {
      const k = n.toLowerCase();
      if (names.has(k) && names.get(k) !== e.id) out.push(`"${n}" names both "${names.get(k)}" and "${e.id}"`);
      names.set(k, e.id);
    }
  }
  return out;
}

// ---- site data: search index & backlinks ---------------------------------------------
//
// theme/site.js (every page): page metadata + "referenced by" backlinks.
// theme/search-index.js (loaded on first search): section-level text of every doc and
// every glossary entry. Both are generated by `npm run index`; `check` fails when stale.

const SECTION_TEXT_MAX = 4000;

/** The article split at h2/h3 ids: [{ id, heading, html, text }]. The part before the
    first heading (hero, TL;DR) has id "". */
function extractSections(html) {
  const art = stripComments(html).match(/<article\b[^>]*class="[^"]*\bbh-article\b[^"]*"[^>]*>([\s\S]*)<\/article>/);
  if (!art) return [];
  const body = art[1]
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ");
  return body.split(/(?=<h[23]\b[^>]*\sid="[^"]+"[^>]*>)/).map((part) => {
    const h = part.match(/^<h[23]\b[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/h[23]>/);
    const rest = h ? part.slice(h[0].length) : part;
    const text = decodeEntities(rest.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, SECTION_TEXT_MAX);
    return { id: h ? h[1] : "", heading: h ? decodeEntities(h[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : "", html: part, text };
  });
}

/** The card markup for one page of the home list. `titles` maps hrefs to titles for "Replaced by".
    theme/modules/unlisted-cards.js builds the same card in the browser (tests/unlisted.test.mjs compares them). */
const cardHtml = (d, titles, tags = docTopics(d)) => docCardHtml(d, tags, titles);

const byDateThenTitle = (a, b) => (b.date || "").localeCompare(a.date || "") || a.title.localeCompare(b.title);

function buildSiteData() {
  const docs = docFiles().map((f) => ({ ...readDoc(f), html: fs.readFileSync(f, "utf8") }));
  const known = new Set(docs.map((d) => d.href));
  const hidden = new Set(docs.filter((d) => d.unlisted).map((d) => d.href)); // unlisted pages
  const titles = new Map(docs.map((d) => [d.href, d.title]));
  const pageOf = ({ href, title, kind, status, date, description, supersedes, supersededBy, example }) => ({ href, title, kind, status, date, description, supersedes, supersededBy, ...(example ? { example: true } : {}) });
  const pages = docs.filter((d) => !hidden.has(d.href)).map(pageOf);
  // What the site leaves out unless the reader opts in: unlisted pages, their search text, and any
  // backlink that starts or ends at one. Kept apart so the default page load never fetches them.
  const backlinks = {}, unlistedBacklinks = {};
  const search = [], unlistedSearch = [];
  for (const d of docs) {
    const sections = extractSections(d.html);
    const entry = { href: d.href, title: d.title, kind: d.kind, ...(d.example ? { example: true } : {}), sections: sections.map(({ id, heading, text }) => ({ id, heading, text })).filter((x) => x.text || x.heading) };
    (hidden.has(d.href) ? unlistedSearch : search).push(entry);
    for (const sec of sections) {
      for (const m of sec.html.matchAll(/\shref="([^"#?]+\.html)(?:[#?][^"]*)?"/g)) {
        if (/^[a-z]+:/i.test(m[1])) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(d.href), m[1]));
        if (target === d.href || !known.has(target)) continue;
        const into = hidden.has(d.href) || hidden.has(target) ? unlistedBacklinks : backlinks;
        const list = (into[target] = into[target] || []);
        const from = d.href + (sec.id ? "#" + sec.id : "");
        if (!list.some((b) => b.href === from)) list.push({ href: from, title: d.title, section: sec.heading });
      }
    }
  }
  for (const e of compileGlossary().entries) {
    search.push({ href: e.href, title: e.term, kind: "glossary", sections: [{ id: "", heading: e.aliases.join(", "), text: decodeEntities(e.html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() }] });
  }
  const header = "/* GENERATED by `npm run index` from docs/. Do not edit. */\n";
  const reviews = {}; // threads per document, so pages load review only when needed
  for (const [href, summary] of Object.entries(compileReviews().summary)) if (!hidden.has(href)) reviews[href] = summary;
  const unlisted = docs.filter((d) => hidden.has(d.href)).sort(byDateThenTitle).map((d) => ({
    slug: path.posix.basename(d.href, ".html"), ...pageOf(d), kindLabel: KIND_LABELS[d.kind] || d.kind, tags: docTopics(d), unlisted: true,
    ...(d.supersededBy ? { replacedBy: { href: d.supersededBy, title: titles.get(d.supersededBy) || d.supersededBy } } : {}),
  }));
  return {
    site: header + "window.BH_SITE = " + JSON.stringify({ pages, backlinks, reviews }, null, 1) + ";\n",
    search: header + "window.BH_SEARCH = " + JSON.stringify(search) + ";\n",
    unlisted: header + "window.BH_UNLISTED = " + JSON.stringify({ v: 1, pages: unlisted, backlinks: unlistedBacklinks, search: unlistedSearch }, null, 1) + ";\n",
    unlistedSlugs: header + "window.BH_UNLISTED_SLUGS = " + JSON.stringify(unlisted.map((p) => p.href), null, 1) + ";\n",
    counts: { pages: pages.length, links: Object.values(backlinks).reduce((a, b) => a + b.length, 0), entries: search.length, unlisted: unlisted.length },
  };
}

// ---- index ------------------------------------------------------------------------

function cmdIndex() {
  const docs = docFiles().map(readDoc).filter((d) => !d.unlisted).sort(byDateThenTitle);
  const titles = new Map(docs.map((d) => [d.href, d.title]));
  const cards = docs.map((d) => cardHtml(d, titles)).join("\n");
  const html = fs.readFileSync(INDEX, "utf8");
  const start = "<!-- bh:index:start -->";
  const end = "<!-- bh:index:end -->";
  const i = html.indexOf(start), j = html.indexOf(end);
  if (i < 0 || j < 0) {
    console.error(c.red(`index.html is missing the ${start} … ${end} markers`));
    process.exit(1);
  }
  const next = html.slice(0, i + start.length) + "\n" + cards + "\n      " + html.slice(j);
  if (next !== html) fs.writeFileSync(INDEX, next);
  console.log(c.green(`Indexed ${docs.length} document${docs.length === 1 ? "" : "s"} → index.html`));

  // Social meta (Open Graph / Twitter) for the home page and every public page.
  let social = 0;
  for (const file of [INDEX, ...docFiles()]) {
    const raw = fs.readFileSync(file, "utf8"), next = withSocial(raw, expectedSocial(file));
    if (next !== raw) { fs.writeFileSync(file, next); social++; }
  }
  console.log(c.green(`Social meta written for ${docFiles().length + 1} pages`) + c.dim(` (${social} updated)`));

  const g = compileGlossary();
  const prev = fs.existsSync(GLOSSARY_OUT) ? fs.readFileSync(GLOSSARY_OUT, "utf8") : "";
  if (prev !== g.js) fs.writeFileSync(GLOSSARY_OUT, g.js);
  console.log(c.green(`Compiled ${g.entries.length} glossary term${g.entries.length === 1 ? "" : "s"} → theme/glossary.js`));

  const site = buildSiteData();
  const reviews = compileReviews();
  for (const [file, text] of [[SITE_OUT, site.site], [SEARCH_OUT, site.search], [REVIEWS_OUT, reviews.js], [UNLISTED_REVIEWS_OUT, reviews.unlistedJs], [UNLISTED_OUT, site.unlisted], [UNLISTED_SLUGS_OUT, site.unlistedSlugs]]) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) fs.writeFileSync(file, text);
  }
  console.log(c.green(`Built search index (${site.counts.entries} entries) and ${site.counts.links} backlinks → theme/site.js, theme/search-index.js`));
  console.log(c.green(`Set aside ${site.counts.unlisted} unlisted page${site.counts.unlisted === 1 ? "" : "s"}`) + c.dim(" → theme/unlisted-pages.js, theme/unlisted-slugs.js"));
}

// ---- SVG edge geometry ---------------------------------------------------------------
//
// Arrowheads (bh.js) are 10 units long. The head's BASE centre sits on the path end and the
// head points along the path's final direction, so the line stops at the base (square-on,
// centred) and never runs under the head to blunt its tip. A path therefore ends ARROW_LEN
// short of where the tip should land. The same applies to the START of `.edge.both` paths.
// The checker projects each tip and verifies it lands on the target node's outline.

const ARROW_LEN = 10;      // head length in user units (must match bh.js markers)
const TIP_GAP_MAX = 2;     // tip may stop up to this far outside a node's outline

function parsePath(d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) || [];
  const arity = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  const segs = [];
  let i = 0, cmd = null, x = 0, y = 0, sx = 0, sy = 0;
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    if (!cmd) break;
    const up = cmd.toUpperCase(), rel = cmd !== up, n = arity[up];
    if (n === undefined) throw new Error(`unsupported path command "${cmd}"`);
    const a = tokens.slice(i, i + n).map(Number);
    i += n;
    const from = [x, y];
    const pt = (px, py) => (rel ? [x + px, y + py] : [px, py]);
    let to, ctrl = null;
    switch (up) {
      case "M": to = pt(a[0], a[1]); sx = to[0]; sy = to[1]; cmd = rel ? "l" : "L"; break;
      case "L": case "T": to = pt(a[0], a[1]); break;
      case "H": to = [rel ? x + a[0] : a[0], y]; break;
      case "V": to = [x, rel ? y + a[0] : a[0]]; break;
      case "C": ctrl = [pt(a[0], a[1]), pt(a[2], a[3])]; to = pt(a[4], a[5]); break;
      case "S": case "Q": ctrl = [pt(a[0], a[1])]; to = pt(a[2], a[3]); break;
      case "A": to = pt(a[5], a[6]); break;
      case "Z": to = [sx, sy]; break;
    }
    if (up !== "M") segs.push({ type: up, from, to, ctrl });
    [x, y] = to;
    if (up === "Z") break;
  }
  return segs;
}

/** Unit direction the path travels at one end ("end" or "start", pointing outward). */
function endDirection(segs, end) {
  const ordered = end === "end" ? segs : [...segs].reverse().map((s) => ({
    ...s, from: s.to, to: s.from, ctrl: s.ctrl && [...s.ctrl].reverse(),
  }));
  for (let k = ordered.length - 1; k >= 0; k--) {
    const s = ordered[k];
    // Tangent at the end point: from the nearest distinct control point, else the segment start.
    const candidates = [...(s.ctrl ? [...s.ctrl].reverse() : []), s.from];
    for (const p of candidates) {
      const v = [s.to[0] - p[0], s.to[1] - p[1]], len = Math.hypot(...v);
      if (len > 1e-6) return { point: ordered[ordered.length - 1].to, dir: [v[0] / len, v[1] / len] };
    }
  }
  return null;
}

/** Node rectangles in an <svg> block (first rect inside each <g class="node …">). */
function nodeRects(svg) {
  const rects = [];
  for (const g of svg.matchAll(/<g\b[^>]*\sclass="[^"]*\bnode\b[^"]*"[^>]*>([\s\S]*?)<\/g>/g)) {
    const id = (g[0].match(/\sdata-id="([^"]*)"/) || [])[1] || "?";
    const r = g[1].match(/<rect\b[^>]*>/);
    if (!r) continue;
    const num = (name) => +((r[0].match(new RegExp(`\\s${name}="([-\\d.]+)"`)) || [])[1] ?? 0);
    rects.push({ id, x: num("x"), y: num("y"), w: num("width"), h: num("height") });
  }
  return rects;
}

/** Signed distance from a point to a rect outline: > 0 outside, < 0 inside (penetration). */
function rectDistance([px, py], r) {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.w)), dy = Math.max(r.y - py, 0, py - (r.y + r.h));
  if (dx || dy) return Math.hypot(dx, dy);
  return -Math.min(px - r.x, r.x + r.w - px, py - r.y, r.y + r.h - py);
}

/** Distance along a ray (origin o, unit dir d) to where it enters rect r, or Infinity. */
function rayToRect(o, d, r) {
  let t0 = -Infinity, t1 = Infinity;
  for (const [oi, di, lo, hi] of [[o[0], d[0], r.x, r.x + r.w], [o[1], d[1], r.y, r.y + r.h]]) {
    if (Math.abs(di) < 1e-9) { if (oi < lo || oi > hi) return Infinity; continue; }
    const a = (lo - oi) / di, b = (hi - oi) / di;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t1 >= Math.max(t0, 0) ? Math.max(t0, 0) : Infinity;
}

/** Problems with where an arrowhead's tip lands: on the outline of the node it points at. */
function tipProblems(segs, end, rects) {
  const e = endDirection(segs, end);
  if (!e) return [`has no direction at its ${end}`];
  const tip = [e.point[0] + e.dir[0] * ARROW_LEN, e.point[1] + e.dir[1] * ARROW_LEN];
  const at = `${tip[0].toFixed(1)},${tip[1].toFixed(1)}`;
  const fix = `end the path ${ARROW_LEN} + 1 before the outline`;
  for (const r of rects) {
    const d = rectDistance(tip, r);
    if (d < -0.5) return [`${end} arrow tip (${at}) pokes ${(-d).toFixed(1)} into node "${r.id}"; ${fix}`];
  }
  // The node the head points at: first rect the ray from the tip runs into.
  const hit = rects.map((r) => ({ r, t: rayToRect(tip, e.dir, r) })).sort((a, b) => a.t - b.t)[0];
  if (hit && isFinite(hit.t) && hit.t > TIP_GAP_MAX) {
    return [`${end} arrow tip (${at}) stops ${hit.t.toFixed(1)} short of node "${hit.r.id}"; ${fix}`];
  }
  return []; // touching its node, or aimed at a non-rect shape (not verifiable)
}

// ---- HTML element tree (tolerant; enough for nesting-aware lint rules) -------------

const VOID_TAGS = new Set("area base br col embed hr img input link meta source track wbr".split(" "));
const AUTO_CLOSE = { p: ["p"], li: ["li"], dt: ["dt", "dd"], dd: ["dt", "dd"], tr: ["tr", "td", "th"], td: ["td", "th"], th: ["td", "th"], option: ["option"] };
// A start tag whose quoted attribute values may contain ">" (e.g. data-bind expressions).
const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;

function parseTree(html) {
  const src = stripComments(html).replace(/<(script|style)\b([^>]*)>[\s\S]*?<\/\1>/gi, "<$1$2></$1>");
  const root = { tag: "#root", attrs: "", children: [], parent: null, start: 0, end: src.length };
  let cur = root;
  for (const m of src.matchAll(TAG_RE)) {
    const [, closing, name, attrs, selfClosing] = m;
    const tag = name.toLowerCase();
    if (closing) {
      let n = cur;
      while (n !== root && n.tag !== tag) n = n.parent;
      if (n !== root) { n.end = m.index; cur = n.parent; }
      continue;
    }
    if (AUTO_CLOSE[tag]) while (cur !== root && AUTO_CLOSE[tag].includes(cur.tag)) { cur.end = m.index; cur = cur.parent; }
    const node = { tag, attrs, children: [], parent: cur, start: m.index + m[0].length, end: src.length };
    cur.children.push(node);
    if (!selfClosing && !VOID_TAGS.has(tag)) cur = node;
  }
  return { root, src };
}

const nodeAttr = (n, name) => (n.attrs.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`)) || [])[1];
const hasClass = (n, c) => (nodeAttr(n, "class") || "").split(/\s+/).includes(c);
function walkTree(n, fn) { for (const c of n.children) { fn(c); walkTree(c, fn); } }
function findNode(n, pred) { let hit = null; walkTree(n, (c) => { if (!hit && pred(c)) hit = c; }); return hit; }
const nodeText = (src, n) => src.slice(n.start, n.end).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Every link target must carry an explicit, stable, kebab-case id: section headings
 * (h2–h4 directly in the article), every figure, every glossary entry, and any
 * [data-linkable] block. Auto-generated ids would change whenever the text changes.
 */
function linkTargetProblems(html) {
  const { root, src } = parseTree(html);
  const article = findNode(root, (n) => hasClass(n, "bh-article"));
  if (!article) return [];
  const out = [];
  const require = (n, what) => {
    const id = nodeAttr(n, "id");
    if (!id) out.push(`${what} has no id, so it can't be linked to; add a stable kebab-case id`);
    else if (!KEBAB.test(id)) out.push(`${what} id="${id}" must be kebab-case (a-z, 0-9, hyphens)`);
  };
  const short = (t) => (t.length > 50 ? t.slice(0, 47) + "…" : t);
  for (const c of article.children) {
    if (/^h[2-4]$/.test(c.tag)) require(c, `<${c.tag}> "${short(nodeText(src, c))}"`);
  }
  walkTree(article, (n) => {
    if (n.tag === "figure") {
      const cap = findNode(n, (x) => x.tag === "figcaption");
      require(n, `<figure>${cap ? ` "${short(nodeText(src, cap))}"` : ""}`);
    }
    if (n.tag === "dt" && n.parent.tag === "dl" && hasClass(n.parent, "glossary")) require(n, `glossary entry "${short(nodeText(src, n))}"`);
    if (/\sdata-linkable\b/.test(n.attrs)) require(n, `<${n.tag} data-linkable>`);
    if (n.tag === "bh-versions") {
      const figs = n.children.filter((c) => c.tag === "figure");
      if (figs.length < 2) out.push("<bh-versions> needs at least two <figure> versions");
      for (const f of figs) if (!nodeAttr(f, "data-label")) out.push(`<bh-versions> figure id="${nodeAttr(f, "id") || "?"}" needs data-label (e.g. "Current", "Proposed")`);
    }
    {
      const change = nodeAttr(n, "data-change");
      if (change !== undefined && !["added", "changed", "removed"].includes(change)) out.push(`data-change="${change}" must be added, changed or removed`);
    }
    if (n.tag === "bh-sequence") {
      const actors = new Set(n.children.filter((c) => c.tag === "bh-actor").map((c) => nodeAttr(c, "data-id")));
      if (!actors.size) out.push("<bh-sequence> has no <bh-actor data-id=…>");
      if (actors.has(undefined)) out.push("every <bh-actor> needs a data-id");
      if (n.parent.tag !== "figure") out.push("<bh-sequence> must sit inside a <figure class=\"diagram\" id=…> so it can be linked and captioned");
      for (const c of n.children) {
        const refs = c.tag === "bh-msg" ? [nodeAttr(c, "from"), nodeAttr(c, "to")] : c.tag === "bh-note" ? (nodeAttr(c, "over") || "").split(/[\s,]+/) : [];
        for (const a of refs) if (!actors.has(a)) out.push(`<${c.tag}> refers to unknown actor "${a}"`);
      }
    }
    if (n.tag === "bh-codewalk") {
      require(n, "<bh-codewalk>");
      const code = src.slice(n.start, n.end).match(/<code\b[^>]*>([\s\S]*?)<\/code>/);
      const lines = code ? decodeEntities(code[1].replace(/<[^>]+>/g, "")).replace(/\n$/, "").split("\n").length : 0;
      if (!code) out.push("<bh-codewalk> needs a <pre><code> block");
      for (const st of n.children.filter((c) => c.tag === "bh-cw-step")) {
        const spec = nodeAttr(st, "lines") || "";
        if (!/^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/.test(spec)) { out.push(`<bh-cw-step lines="${spec}"> must look like "3-8, 12"`); continue; }
        for (const part of spec.split(",")) {
          const [a, b = a] = part.split("-").map((x) => +x.trim());
          if (a < 1 || b < a || b > lines) out.push(`<bh-cw-step lines="${spec}"> is outside the code (1–${lines})`);
        }
      }
    }
    if (n.tag === "bh-matrix") {
      require(n, "<bh-matrix>");
      const table = findNode(n, (x) => x.tag === "table");
      const headRow = table && findNode(table, (x) => x.tag === "thead");
      const heads = headRow ? findNode(headRow, (x) => x.tag === "tr").children.filter((c) => c.tag === "th" || c.tag === "td") : [];
      const options = heads.length - 2;
      if (options < 2) out.push("<bh-matrix> header needs: Criterion, Weight, then at least two options");
      const body = table && findNode(table, (x) => x.tag === "tbody");
      for (const tr of body ? body.children.filter((c) => c.tag === "tr") : []) {
        const cells = tr.children.filter((c) => c.tag === "th" || c.tag === "td");
        const name = nodeText(src, cells[0] || tr);
        if (cells.length !== options + 2) { out.push(`<bh-matrix> row "${name}" has ${cells.length - 2} scores for ${options} options`); continue; }
        cells.slice(1).forEach((c, k) => {
          const v = nodeText(src, c);
          if (!/^[0-5]$/.test(v)) out.push(`<bh-matrix> row "${name}": ${k === 0 ? "weight" : "score"} "${v}" must be a whole number 0–5`);
        });
      }
    }
    if (n.tag === "bh-chart") {
      const type = nodeAttr(n, "type") || "line";
      if (!["line", "bar"].includes(type)) out.push(`<bh-chart type="${type}"> must be line or bar`);
      if (n.parent.tag !== "figure") out.push("<bh-chart> must sit inside a <figure id=…> so it can be linked and captioned");
      const table = findNode(n, (x) => x.tag === "table");
      const thead = table && findNode(table, (x) => x.tag === "thead");
      const heads = thead ? findNode(thead, (x) => x.tag === "tr").children.filter((c) => c.tag === "th" || c.tag === "td").map((c) => nodeText(src, c)) : [];
      const seriesCount = heads.length - 1;
      if (seriesCount < 1) out.push("<bh-chart> table needs a header row: x label, then one column per series");
      if (seriesCount > 6) out.push(`<bh-chart> has ${seriesCount} series; past 6, fold the tail into "Other" or use small multiples`);
      const emph = nodeAttr(n, "emphasis");
      if (emph && !heads.slice(1).includes(emph)) out.push(`<bh-chart emphasis="${emph}"> is not a series name`);
      const tbody = table && findNode(table, (x) => x.tag === "tbody");
      for (const tr of tbody ? tbody.children.filter((c) => c.tag === "tr") : []) {
        const cells = tr.children.filter((c) => c.tag === "th" || c.tag === "td").map((c) => nodeText(src, c));
        if (cells.length !== heads.length) { out.push(`<bh-chart> row "${cells[0]}" has ${cells.length - 1} values for ${seriesCount} series`); continue; }
        for (const v of cells.slice(1)) if (v !== "" && !/^-?[\d,]*\.?\d+$/.test(v)) out.push(`<bh-chart> row "${cells[0]}": "${v}" is not a number`);
      }
    }
    if (n.tag === "bh-stepper" && !nodeAttr(n, "id") && !nodeAttr(n, "for")) {
      out.push("<bh-stepper> needs for=\"figure-id\" (or an id) so its steps can be linked to");
    }
  });
  return out;
}

// ---- theme checks: stylesheet import order, token contrast -------------------------

/** @import must come before every rule except @charset and @layer statements placed before
    the first import; anything else in between makes later imports silently ignored. */
function cssImportProblems(file) {
  const css = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  let phase = 0; // 0 = before imports, 1 = in imports, 2 = after
  for (const m of css.matchAll(/@(charset|import|layer)\b[^;{]*(;|\{)|[^\s@][^{]*\{/g)) {
    const kind = m[1], statement = m[2] === ";";
    if (kind === "import") {
      if (phase === 2) out.push(`${path.relative(ROOT, file)}: @import after other rules is ignored by browsers: ${m[0].trim().slice(0, 60)}`);
      const local = m[0].match(/url\(\s*["']?([^"')]+)["']?\s*\)/);
      if (local && !/^https?:/.test(local[1]) && !fs.existsSync(path.resolve(path.dirname(file), local[1]))) out.push(`${path.relative(ROOT, file)}: @import of missing file ${local[1]}`);
      phase = phase === 2 ? 2 : 1;
    } else if (kind === "charset" || (kind === "layer" && statement && phase === 0)) {
      // allowed before imports
    } else {
      phase = 2;
    }
  }
  return out;
}

/** WCAG contrast for every text/background token pair, in both themes (from light-dark()). */
const CONTRAST_PAIRS = [
  // [foreground, [backgrounds], minimum ratio]
  ["text", ["bg", "surface", "surface-2", "code-bg"], 4.5],
  ["text-muted", ["bg", "surface", "surface-2", "code-bg"], 4.5],
  ["accent", ["bg", "surface", "accent-soft"], 4.5],
  ["accent-contrast", ["accent"], 4.5],
  ["info", ["info-soft", "surface"], 4.5],
  ["ok", ["ok-soft", "surface"], 4.5],
  ["warn", ["warn-soft", "surface"], 4.5],
  ["danger", ["danger-soft", "surface"], 4.5],
  // c1–c5 colour syntax-highlighted code (text); c6 only strokes (non-text, 3:1).
  // Review pins and count badges: --surface text on the kind/status colours.
  ["surface", ["accent", "ok", "info", "warn", "danger"], 4.5],
  ["c1", ["code-bg", "surface"], 4.5], ["c2", ["code-bg", "surface"], 4.5], ["c3", ["code-bg", "surface"], 4.5],
  ["c4", ["code-bg", "surface"], 4.5], ["c5", ["code-bg", "surface"], 4.5], ["c6", ["surface"], 3],
];

function contrastProblems() {
  const css = fs.readFileSync(path.join(ROOT, "theme", "tokens.css"), "utf8");
  const tok = {};
  for (const m of css.matchAll(/--([\w-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi)) tok[m[1]] = { light: m[2], dark: m[3] };
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const out = [];
  for (const [fg, bgs, min] of CONTRAST_PAIRS) for (const bg of bgs) for (const mode of ["light", "dark"]) {
    if (!tok[fg] || !tok[bg]) { out.push(`tokens.css: --${fg} or --${bg} is not a light-dark() hex pair`); continue; }
    const r = ratio(tok[fg][mode], tok[bg][mode]);
    if (r < min) out.push(`tokens.css: --${fg} on --${bg} is ${r.toFixed(2)}:1 in ${mode} mode (needs ${min}:1)`);
  }
  return out;
}

// ---- diagram labels: no collisions -------------------------------------------------------
//
// Free-standing labels (<text> outside a .node) must not touch an edge, an arrowhead, a
// node, or another label; text inside a node must fit its box. Sizes are estimated from
// the theme (node text 14px, labels 12px, zone labels 11px; ~0.58em per character), so
// keep a little air. Opt one label out with data-overlap-ok.

const CHAR_W = 0.58;

function labelBox(n, src, inNode) {
  const cls = (nodeAttr(n, "class") || "").split(/\s+/);
  const size = cls.includes("zone-label") ? 11 : cls.includes("label") || cls.includes("sub") || cls.includes("mono") ? 12 : 14;
  const text = nodeText(src, n);
  const w = text.length * size * CHAR_W;
  const x = +nodeAttr(n, "x") || 0, y = +nodeAttr(n, "y") || 0;
  const anchor = nodeAttr(n, "text-anchor") || (inNode ? "middle" : "start");
  const left = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
  // Zone labels hang from y (top); everything else is vertically centred on y.
  const top = cls.includes("zone-label") ? y - size * 0.8 : y - size / 2;
  return { text, left, right: left + w, top, bottom: top + size };
}

function samplePath(segs) {
  const pts = [];
  for (const s of segs) {
    if (s.type === "C" && s.ctrl && s.ctrl.length === 2) {
      const [p0, p1, p2, p3] = [s.from, s.ctrl[0], s.ctrl[1], s.to];
      for (let i = 0; i <= 24; i++) {
        const t = i / 24, u = 1 - t;
        pts.push([0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]));
      }
    } else {
      for (let i = 0; i <= 12; i++) pts.push([0, 1].map((k) => s.from[k] + ((s.to[k] - s.from[k]) * i) / 12));
    }
  }
  return pts;
}

function arrowPoints(segs, end) {
  const e = endDirection(segs, end);
  if (!e) return [];
  const [px, py] = e.point, [dx, dy] = e.dir, [nx, ny] = [-dy, dx];
  const tip = [px + dx * ARROW_LEN, py + dy * ARROW_LEN], a = [px + nx * 5, py + ny * 5], b = [px - nx * 5, py - ny * 5];
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  return [tip, a, b, mid(tip, a), mid(tip, b), [(tip[0] + a[0] + b[0]) / 3, (tip[1] + a[1] + b[1]) / 3]];
}

const inside = (p, box, pad) => p[0] >= box.left - pad && p[0] <= box.right + pad && p[1] >= box.top - pad && p[1] <= box.bottom + pad;
const boxesOverlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function diagramLabelProblems(html) {
  const out = [];
  for (const m of stripComments(html).matchAll(/<svg\b[\s\S]*?<\/svg>/g)) {
    if (/\stransform=/.test(m[0])) continue; // estimates don't follow transforms
    const { root: tree, src } = parseTree(m[0]);
    const labels = [], nodes = [], edges = [];
    walkTree(tree, (n) => {
      const nodeG = n.parent && (function up(p) { return p && p.tag !== "#root" ? (p.tag === "g" && hasClass(p, "node") ? p : up(p.parent)) : null; })(n.parent);
      if (n.tag === "text") {
        const box = labelBox(n, src, !!nodeG);
        if (nodeG) {
          const r = findNode(nodeG, (x) => x.tag === "rect");
          if (r && !/\sdata-overlap-ok\b/.test(n.attrs)) {
            const w = +nodeAttr(r, "width");
            if (box.right - box.left > w - 8) out.push(`node text "${box.text}" (~${Math.round(box.right - box.left)}px) doesn't fit its ${w}px box`);
          }
        } else if (!/\sdata-overlap-ok\b/.test(n.attrs)) labels.push(box);
      }
      if (n.tag === "rect" && nodeG && nodeG.children.find((c) => c.tag === "rect") === n) {
        const x = +nodeAttr(n, "x") || 0, y = +nodeAttr(n, "y") || 0;
        nodes.push({ left: x, top: y, right: x + (+nodeAttr(n, "width") || 0), bottom: y + (+nodeAttr(n, "height") || 0), id: nodeAttr(nodeG, "data-id") || "?" });
      }
      if (n.tag === "path" && hasClass(n, "edge")) {
        let segs;
        try { segs = parsePath(nodeAttr(n, "d") || ""); } catch { return; }
        const arrows = hasClass(n, "no-arrow") ? [] : [...arrowPoints(segs, "end"), ...(hasClass(n, "both") ? arrowPoints(segs, "start") : [])];
        edges.push({ id: nodeAttr(n, "data-id") || nodeAttr(n, "d"), line: samplePath(segs), arrows });
      }
    });
    for (const l of labels) {
      for (const e of edges) {
        if (e.line.some((p) => inside(p, l, 1.5))) out.push(`label "${l.text}" touches edge "${e.id}"`);
        else if (e.arrows.some((p) => inside(p, l, 1))) out.push(`label "${l.text}" touches the arrowhead of "${e.id}"`);
      }
      for (const nd of nodes) if (boxesOverlap(l, nd)) out.push(`label "${l.text}" overlaps node "${nd.id}"`);
    }
    labels.forEach((a, i) => labels.slice(i + 1).forEach((b) => { if (boxesOverlap(a, b)) out.push(`labels "${a.text}" and "${b.text}" overlap`); }));
  }
  return out;
}

// ---- review files ---------------------------------------------------------------------

function reviewFiles(dir = path.join(ROOT, "reviews")) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? reviewFiles(p) : /\.json(\.gz)?$/.test(e.name) && e.name !== "schema.json" ? [p] : [];
  });
}

/** Read a review file (plain or gzipped JSON). */
function readReview(file) {
  const buf = fs.readFileSync(file);
  return JSON.parse((file.endsWith(".gz") ? zlib.gunzipSync(buf) : buf).toString("utf8"));
}

/** A review's `document` as a clean site-root path ("docs/x.html"), so "./docs/x.html" and "/docs/x.html" key the same thread list. */
function canonicalDocument(document) {
  return typeof document === "string" ? path.posix.normalize(document.replace(/\\/g, "/")).replace(/^\/+/, "") : document;
}

/**
 * True when a review's `document` is a private page: its plaintext source
 * (docs/<slug>.private.html, whether or not it exists here) or the sealed shell
 * (docs/<slug>.html carrying bh:sealed). Both repo and Pages site are public, so
 * nothing about such a page, quotes and comment bodies included, may be published.
 */
function isPrivateDocument(document) {
  if (typeof document !== "string") return false;
  const rel = path.posix.normalize(document.replace(/\\/g, "/"));
  if (rel.endsWith(PRIVATE_EXT)) return true;
  const file = path.join(ROOT, rel);
  return file.startsWith(DOCS + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile() && isSealed(file);
}

/** Export-time location status is not part of a message; attribution is. */
function reviewRecord(cm, review) {
  const { outdated, ...keep } = cm;
  void outdated;
  return { ...keep, author: cm.author || review.reviewer || null };
}

function sameReviewMessage(a, b) {
  return a.document === b.document && isDeepStrictEqual(a.record, b.record);
}

/** Every merged comment and reply, grouped by document, oldest first → theme/reviews.js. */
function compileReviews() {
  const byDoc = {}, ids = new Map();
  for (const file of reviewFiles().sort()) {
    let r;
    try { r = readReview(file); } catch { continue; } // reported by reviewProblems()
    if (r.format !== "bh-review/1" || !Array.isArray(r.comments)) continue;
    if (isPrivateDocument(r.document)) continue; // reported by reviewProblems(); never published
    const docKey = canonicalDocument(r.document);
    for (const cm of r.comments) {
      const record = reviewRecord(cm, r);
      const message = { document: docKey, record };
      if (cm.id && ids.has(cm.id) && sameReviewMessage(ids.get(cm.id), message)) continue;
      if (cm.id && !ids.has(cm.id)) ids.set(cm.id, message);
      (byDoc[docKey] = byDoc[docKey] || []).push({ ...record, file: path.relative(ROOT, file).split(path.sep).join("/") });
    }
  }
  for (const list of Object.values(byDoc)) list.sort((a, b) => String(a.created).localeCompare(String(b.created)));
  const summary = {};
  for (const [docPath, list] of Object.entries(byDoc)) {
    const byId = new Map(list.map((m) => [m.id, m]));
    const rootOf = (m) => { let r = m, guard = 0; while (r.inReplyTo && byId.has(r.inReplyTo) && guard++ < 50) r = byId.get(r.inReplyTo); return r; };
    const roots = list.filter((m) => !m.inReplyTo);
    const resolved = roots.filter((rt) => {
      const replies = list.filter((m) => m.inReplyTo && typeof m.resolves === "boolean" && rootOf(m).id === rt.id);
      return replies.length && replies[replies.length - 1].resolves;
    });
    summary[docPath] = { threads: roots.length, open: roots.length - resolved.length };
  }
  const header = "/* GENERATED by `npm run index` from reviews/. Do not edit. */\n";
  const hidden = new Set(docFiles().map(readDoc).filter((d) => d.unlisted).map((d) => d.href));
  const split = (keep) => Object.fromEntries(Object.entries(byDoc).filter(([href]) => hidden.has(href) === keep));
  return {
    byDoc, summary,
    js: header + "window.BH_REVIEWS = " + JSON.stringify(split(false), null, 1) + ";\n",
    unlistedJs: header + "window.BH_REVIEWS = " + JSON.stringify(split(true), null, 1) + ";\n",
  };
}

function reviewProblems() {
  const out = [];
  const ids = new Map(), replies = [];
  for (const file of reviewFiles().sort()) {
    const rel = path.relative(ROOT, file);
    let r;
    try { r = readReview(file); } catch (e) { out.push(`${rel}: not readable JSON (${e.message})`); continue; }
    if (r.format !== "bh-review/1") { out.push(`${rel}: format must be "bh-review/1"`); continue; }
    if (isPrivateDocument(r.document)) {
      out.push(`${rel}: reviews "${r.document}", a private page. The repo and the published site are public, so keep this review file out of the repo (send it to the author privately)`);
      continue;
    }
    if (!r.document || !fs.existsSync(path.join(ROOT, r.document))) out.push(`${rel}: document "${r.document}" doesn't exist`);
    else if (canonicalDocument(r.document) !== r.document) out.push(`${rel}: document "${r.document}" should be written as "${canonicalDocument(r.document)}" (a path from the site root)`);
    if (!Array.isArray(r.comments)) { out.push(`${rel}: comments must be an array`); continue; }
    r.comments.forEach((cm, i) => {
      const where = `${rel}: comment ${i + 1}`;
      if (!cm.id || !cm.body) out.push(`${where} needs id and body`);
      else if (!cm.inReplyTo && !cm.target) out.push(`${where} needs a target (or inReplyTo for a reply)`);
      else if (!["comment", "suggestion", "question", "blocker"].includes(cm.kind)) out.push(`${where}: kind "${cm.kind}" is unknown`);
      else if (cm.target && cm.target.quote && typeof cm.target.quote.exact !== "string") out.push(`${where}: target.quote.exact must be text`);
      if (typeof cm.created !== "string" || Number.isNaN(Date.parse(cm.created))) out.push(`${where}: created must be an ISO date-time`);
      if (cm.id) {
        const message = { rel, document: canonicalDocument(r.document), record: reviewRecord(cm, r) };
        if (ids.has(cm.id)) {
          if (!sameReviewMessage(ids.get(cm.id), message)) out.push(`${where}: id "${cm.id}" is also used in ${ids.get(cm.id).rel} with different content or document`);
        } else ids.set(cm.id, message);
      }
      if (cm.inReplyTo) replies.push([where, cm.inReplyTo, canonicalDocument(r.document)]);
    });
  }
  for (const [where, parent, document] of replies) {
    if (!ids.has(parent)) out.push(`${where}: replies to "${parent}", which isn't in any review file`);
    else if (ids.get(parent).document !== document) out.push(`${where}: replies to "${parent}", which is a comment on ${ids.get(parent).document}, not ${document}`);
  }
  return out;
}

// ---- check ------------------------------------------------------------------------

// ---- logo: the inline mark in bh.js must match the self-contained SVG ------------------------

const LOGO_DIR = path.join(ROOT, "theme", "logo");

/** theme/logo/mark.svg is the source of truth for the mark's geometry; bh.js inlines the same paths. */
function logoProblems() {
  const problems = [];
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);
  const mark = read(path.join(LOGO_DIR, "mark.svg")), js = read(path.join(ROOT, "theme", "bh.js"));
  if (!mark) return ["theme/logo/mark.svg is missing"];
  const paths = [...mark.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
  if (!paths.length) problems.push("theme/logo/mark.svg has no <path> to compare");
  for (const d of paths) if (!js.includes(`d="${d}"`)) problems.push("theme/bh.js LOGO_SVG has drifted from theme/logo/mark.svg: copy the paths across");
  const tokens = read(path.join(ROOT, "theme", "tokens.css")) || "";
  const accent = tokens.match(/--accent:\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/i);
  for (const f of ["mark.svg", "mark-tile.svg", "lockup.svg", "og-card.svg"]) {
    const t = read(path.join(LOGO_DIR, f));
    if (!t) { problems.push(`theme/logo/${f} is missing`); continue; }
    for (const d of paths) if (!t.includes(`d="${d}"`)) problems.push(`theme/logo/${f} has drifted from theme/logo/mark.svg: copy the paths across`);
    if (f !== "og-card.svg" && accent && !(t.includes(accent[1]) && t.includes(accent[2]))) problems.push(`theme/logo/${f} does not use the --accent values from tokens.css (${accent[1]} / ${accent[2]})`);
    if (!/role="img"/.test(t) || !/<title\b/.test(t)) problems.push(`theme/logo/${f} needs role="img" and a <title>`);
    if (/<(image|text)\b|font-family|@import|url\(\s*["']?https?:/.test(t)) problems.push(`theme/logo/${f} must be self-contained: no raster, <text>, fonts or remote references`);
  }
  // The PNGs are renders: check their size (IHDR width/height), which og:image:width/height in index.html declare.
  for (const [f, w, h] of [["apple-touch-icon.png", 180, 180], ["og.png", 1200, 630]]) {
    const file = path.join(LOGO_DIR, f);
    if (!fs.existsSync(file)) { problems.push(`theme/logo/${f} is missing`); continue; }
    const b = fs.readFileSync(file);
    if (b.readUInt32BE(16) !== w || b.readUInt32BE(20) !== h) problems.push(`theme/logo/${f} must be ${w}x${h}px (is ${b.readUInt32BE(16)}x${b.readUInt32BE(20)})`);
  }
  return problems;
}

function cmdCheck() {
  let errors = 0, warnings = 0;
  const templates = fs.readdirSync(TEMPLATES).filter((f) => f.endsWith(".html")).sort().map((f) => path.join(TEMPLATES, f));
  const files = [INDEX, ...docFiles(), ...privateSources(), ...templates];
  const publicDocs = docFiles().map(readDoc);

  // Theme: stylesheet import order and token contrast in both themes.
  {
    const problems = [
      ...fs.readdirSync(path.join(ROOT, "theme")).filter((f) => f.endsWith(".css")).flatMap((f) => cssImportProblems(path.join(ROOT, "theme", f))),
      ...contrastProblems(),
      ...logoProblems(),
      ...siteUrlProblems(),
      ...orphanCards().map((f) => `docs/assets/og/${f} belongs to no public page: run \`npm run cards\` to remove it`),
    ];
    console.log((problems.length ? c.red("✗ ") : c.green("✓ ")) + "theme (import order, token contrast, logo, site base, card files)");
    problems.forEach((p) => console.log(c.red("  error  ") + p));
    errors += problems.length;
  }

  // Review files (reviews/**/*.json[.gz]) are well-formed and point at real documents.
  {
    const problems = reviewProblems();
    const n = reviewFiles().length;
    if (n || problems.length) {
      console.log((problems.length ? c.red("✗ ") : c.green("✓ ")) + `reviews (${n} file${n === 1 ? "" : "s"})`);
      problems.forEach((p) => console.log(c.red("  error  ") + p));
      errors += problems.length;
    }
  }

  // Glossary: compiled data must be fresh and entries well-formed.
  const glossary = compileGlossary();
  const globalTerms = new Set(glossary.entries.map((e) => e.id));
  {
    const problems = glossaryProblems(glossary.entries);
    const current = fs.existsSync(GLOSSARY_OUT) ? fs.readFileSync(GLOSSARY_OUT, "utf8") : "";
    if (current !== glossary.js) problems.push("theme/glossary.js is stale: run `npm run index`");
    const site = buildSiteData();
    for (const [file, text] of [[SITE_OUT, site.site], [SEARCH_OUT, site.search], [REVIEWS_OUT, compileReviews().js], [UNLISTED_REVIEWS_OUT, compileReviews().unlistedJs], [UNLISTED_OUT, site.unlisted], [UNLISTED_SLUGS_OUT, site.unlistedSlugs]]) {
      if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) problems.push(`${path.relative(ROOT, file)} is stale: run \`npm run index\``);
    }
    // Decision lifecycle: supersedes / superseded-by must agree in both directions.
    const all = publicDocs;
    const byHref = new Map(all.map((d) => [d.href, d]));
    for (const d of all) {
      if (d.status.toLowerCase() === "superseded" && !d.supersededBy) problems.push(`${d.href}: status "superseded" needs <meta name="bh:superseded-by">`);
      if (d.supersededBy && d.status.toLowerCase() !== "superseded") problems.push(`${d.href}: has bh:superseded-by, so bh:status must be "superseded"`);
      for (const [rel, back, target] of [["bh:superseded-by", "supersedes", d.supersededBy], ["bh:supersedes", "supersededBy", d.supersedes]]) {
        if (!target) continue;
        const t = byHref.get(target);
        if (t && t.unlisted !== d.unlisted && rel === "bh:superseded-by") problems.push(`${d.href}: ${rel} → ${target}, but one is unlisted and the other is not: a decision chain must be all listed or all unlisted`);
        if (target === d.href) problems.push(`${d.href}: ${rel} points at itself`);
        else if (!t) problems.push(`${d.href}: ${rel} → ${target} does not exist`);
        else if (t[back] !== d.href) problems.push(`${d.href}: ${rel} → ${target}, but that page's ${back === "supersedes" ? "bh:supersedes" : "bh:superseded-by"} doesn't point back`);
      }
    }
    console.log((problems.length ? c.red("✗ ") : c.green("✓ ")) + `generated data & decision links (${glossary.entries.length} glossary terms)`);
    problems.forEach((p) => console.log(c.red("  error  ") + p));
    errors += problems.length;
  }
  // Private pages: every plaintext is sealed and current; sealed shells are well-formed.
  const privateSlugs = new Set([...privateSources().map((f) => path.basename(f, PRIVATE_EXT)), ...sealedFiles().map((f) => path.basename(f, ".html"))]);
  {
    const problems = [];
    for (const shell of sealedFiles()) {
      const slug = path.basename(shell, ".html"), text = fs.readFileSync(shell, "utf8");
      if (!/id="sealed-payload">\s*[A-Za-z0-9+/=\s]{40,}<\/script>/.test(text)) problems.push(`docs/${slug}.html: sealed payload is missing or malformed`);
      if (!/name="robots" content="noindex/.test(text)) problems.push(`docs/${slug}.html: sealed page must be noindex`);
      if (getMeta(text, "bh:sealed-shell") !== SHELL_VERSION()) problems.push(`docs/${slug}.html uses an outdated shell: run \`npm run seal -- --reshell\``);
      // Everything outside the ciphertext must be the generic shell, so a title, description or tag can't leak.
      else if (text !== sealedShell(sealedPayload(text), getMeta(text, "bh:sealed-digest"))) problems.push(`docs/${slug}.html differs from the generic sealed shell: only the payload and digest may vary`);
      // The icons name the site, not the page, so the shell may carry them (and the tab shouldn't show a default icon).
      for (const [rel, file] of [["icon", "mark-tile.svg"], ["apple-touch-icon", "apple-touch-icon.png"]]) {
        const link = text.match(new RegExp(`<link\\b[^>]*\\brel="${rel}"[^>]*>`));
        const href = link && (link[0].match(/\bhref="([^"]+)"/) || [])[1];
        if (!href) problems.push(`docs/${slug}.html is missing <link rel="${rel}">: run \`npm run seal -- --reshell\``);
        else if (!fs.existsSync(path.resolve(DOCS, href))) problems.push(`docs/${slug}.html: ${rel} ${href} does not exist`);
      }
      const source = path.join(DOCS, slug + PRIVATE_EXT);
      if (fs.existsSync(source)) {
        const plain = stripComments(fs.readFileSync(source, "utf8"));
        const generic = sealedShell("", "", "");
        for (const [what, value] of [["title", getTitle(plain)], ["description", getMeta(plain, "description")], ["group name", getMeta(plain, "bh:group")]]) {
          // A value the generic shell already contains (a title like "Private") can't be told apart; the exact comparison above covers it.
          for (const v of new Set([value, decodeHtml(value)])) if (v && !generic.includes(v) && text.includes(v)) problems.push(`docs/${slug}.html leaks the page's ${what}`);
        }
      }
    }
    // The encrypted cards for the home page: structure everywhere, content where the keys are.
    const cardsFile = path.join(ROOT, CARD_FILE);
    let cardsText = null;
    if (!fs.existsSync(cardsFile)) problems.push(`${CARD_FILE} is missing: run \`npm run seal\``);
    else {
      cardsText = fs.readFileSync(cardsFile, "utf8");
      for (const p of validateCardsFile(cardsText, new Set(sealedFiles().map((f) => path.basename(f, ".html"))))) problems.push(`${CARD_FILE} ${p}`);
    }
    const cards = cardsText ? parseCardsFile(cardsText).entries : [];
    for (const src of privateSources()) {
      const slug = path.basename(src, PRIVATE_EXT), out = path.join(DOCS, `${slug}.html`);
      if (fs.existsSync(out) && !isSealed(out)) { problems.push(`docs/${slug}.html is public but docs/${slug}${PRIVATE_EXT} also exists`); continue; }
      const group = getMeta(stripComments(fs.readFileSync(src, "utf8")), "bh:group");
      if (group && !GROUP_RE.test(group)) problems.push(`docs/${slug}${PRIVATE_EXT}: bh:group "${group}" must be kebab-case`);
      if (group && cardsText && cardsText.includes(group) && !sealedShell("", "", "").includes(group)) problems.push(`${CARD_FILE} leaks the group name of ${slug}`);
      let keyText = null;
      try { keyText = readKey(slug); } catch (e) { problems.push(`can't read the key for ${slug} from 1Password: ${e.message}`); continue; }
      if (!keyText || !fs.existsSync(out)) { problems.push(`docs/${slug}${PRIVATE_EXT} has never been sealed: run \`npm run seal\``); continue; }
      const digest = sealDigest(Buffer.from(keyText, "base64url"), fs.readFileSync(src));
      if (getMeta(fs.readFileSync(out, "utf8"), "bh:sealed-digest") !== digest) problems.push(`docs/${slug}.html is stale: run \`npm run seal\``);
      const blob = cards.find((e) => e.slug === slug)?.blob;
      if (blob && !isDeepStrictEqual(tryDecryptCard(blob, keyText, slug), sourceCard(src))) problems.push(`private card for ${slug} is stale: run \`npm run seal\``);
    }
    console.log((problems.length ? c.red("✗ ") : c.green("✓ ")) + `private pages (${privateSlugs.size} sealed)`);
    problems.forEach((p) => console.log(c.red("  error  ") + p));
    errors += problems.length;
  }

  const exampleHrefs = new Set(publicDocs.filter((d) => d.example).map((d) => d.href));
  const unlistedHrefs = new Set(publicDocs.filter((d) => d.unlisted).map((d) => d.href));
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const raw = fs.readFileSync(file, "utf8");
    const html = stripComments(raw);
    const isTemplate = file.startsWith(TEMPLATES + path.sep);
    const isDoc = file !== INDEX;
    const problems = [];
    const err = (m) => { problems.push(c.red("  error  ") + m); errors++; };
    const warn = (m) => { problems.push(c.yellow("  warn   ") + m); warnings++; };

    if (!getTitle(html)) err("missing <title>");
    if (!getMeta(html, "description")) err('missing <meta name="description">');
    if (!isTemplate && /\{\{\w+\}\}/.test(html)) err("unfilled {{placeholder}} left from template");
    if (!/<html[^>]*\slang=/.test(html)) err("<html> is missing lang");
    if (!/name="viewport"/.test(html)) err("missing viewport meta");
    // Favicon and touch icon: present, and the files exist (bundle inlines them).
    const iconLinks = [...html.matchAll(/<link\b[^>]*\brel="([^"]*)"[^>]*>/g)].filter((m) => /(^|\s)(icon|apple-touch-icon)(\s|$)/.test(m[1]));
    if (!iconLinks.some((m) => /(^|\s)icon(\s|$)/.test(m[1]))) err('missing <link rel="icon"> (see theme/logo/)');
    for (const m of iconLinks) {
      const href = (m[0].match(/\bhref="([^"]+)"/) || [])[1];
      if (href && !/^(https?:|data:)/.test(href) && !fs.existsSync(path.resolve(path.dirname(file), href))) err(`icon ${href} does not exist`);
    }

    // Example pages are shown or hidden by theme/examples.js, which must run in <head> before first paint.
    {
      const head = html.split("</head>")[0];
      const script = head.search(/<script\s+src="[^"]*theme\/examples\.js"\s*><\/script>/);
      if (script < 0) err('missing <script src="…/theme/examples.js"></script> in <head> (synchronous, after the theme script)');
      // The script reads the marker as it runs, so the marker must come first.
      else if (head.search(/<meta\s+name="bh:example"/) > script) err('<meta name="bh:example"> must come before the theme/examples.js script in <head>');
      // Unlisted pages: the same, with theme/unlisted.js, which must follow examples.js.
      const unlistedScript = head.search(/<script\s+src="[^"]*theme\/unlisted\.js"\s*><\/script>/);
      if (unlistedScript < 0) err('missing <script src="…/theme/unlisted.js"></script> in <head> (synchronous, after theme/examples.js)');
      else {
        if (script >= 0 && unlistedScript < script) err("theme/unlisted.js must come after theme/examples.js in <head>");
        if (head.search(/<meta\s+name="bh:unlisted"/) > unlistedScript) err('<meta name="bh:unlisted"> must come before the theme/unlisted.js script in <head>');
      }
    }

    // The home page lists unlisted pages (when the reader opts in) into this list, in the browser.
    if (file === INDEX && !/<ul\b(?=[^>]*\sid="doc-list")[^>]*\sdata-unlisted-cards[\s>=]/.test(html)) err('the <ul id="doc-list"> needs the data-unlisted-cards attribute, which loads the module that lists unlisted pages');

    // A group name is secret while the page is: it may only sit in a private source, and so is encrypted once sealed.
    if (!isPrivateSource(file) && /<meta\s+name="bh:group"/i.test(html)) err('<meta name="bh:group"> is only valid in docs/*.private.html: a public page has no key to share');
    // The catalogue's marker: without it the home page never looks for private cards.
    if (file === INDEX && !/<ul\b[^>]*\bid="doc-list"[^>]*\bdata-private-cards\b/.test(html)) err('the #doc-list needs the data-private-cards attribute');

    // Social meta: generated, so it must be present and current (templates carry the empty markers).
    if (!isPrivateSource(file)) {
      const block = raw.match(SOCIAL_RE);
      if (isTemplate) {
        if (!block || block[0] !== `  ${SOCIAL_START}\n  ${SOCIAL_END}`) err(`must hold the empty social markers:\n  ${SOCIAL_START}\n  ${SOCIAL_END}`);
      } else {
        if (!block) err("missing the social meta block: run `npm run index`");
        else if (block[0] !== expectedSocial(file)) err("social meta block is stale: run `npm run index`");
        const outside = stripComments(raw.replace(SOCIAL_RE, ""));
        if (/<meta\s+(?:property="(?:og|article):|name="twitter:)|<link\s+rel="canonical"/.test(outside)) err("social tags written by hand: delete them, `npm run index` generates them");
        if (getMeta(html, "description").length > DESCRIPTION_MAX) warn(`description is ${getMeta(html, "description").length} characters; link previews cut it off near ${DESCRIPTION_MAX}`);
      }
    }

    if (isDoc && !isTemplate && !isPrivateSource(file)) {
      // The card image: one per public page, current for the visual and the text it shows.
      const job = cardJob(file);
      if (job.selection.problem) err(job.selection.problem);
      const png = fs.existsSync(job.out) ? readPng(job.out) : undefined;
      if (png === undefined) err(`no social card ${path.relative(ROOT, job.out)}: run \`npm run cards\``);
      else if (!png || png.width !== CARD_W || png.height !== CARD_H) err(`social card ${path.relative(ROOT, job.out)} must be a ${CARD_W}x${CARD_H} PNG`);
      else if (png.card === "fallback") (process.env.CI ? err : warn)("social card is the shared site card (rendered without Chrome): run `npm run cards` where Chrome is installed");
      else if (png.card !== job.key) err(`social card ${path.relative(ROOT, job.out)} is stale: run \`npm run cards\``);
    }

    if (isDoc) {
      const kind = getMeta(html, "bh:kind");
      if (!kind) err('missing <meta name="bh:kind">');
      else if (!KIND_LABELS[kind]) warn(`unknown bh:kind "${kind}" (known: ${Object.keys(KIND_LABELS).join(", ")})`);
      const date = getMeta(html, "bh:date");
      if (!isTemplate && !/^\d{4}-\d{2}-\d{2}$/.test(date)) err(`bh:date must be YYYY-MM-DD (got "${date}")`);
      const h1s = (html.match(/<h1[\s>]/g) || []).length;
      if (h1s !== 1) err(`expected exactly one <h1>, found ${h1s}`);
      if (!/class="bh-article"/.test(html)) err('missing <article class="bh-article">');
      if (!/theme\/bh\.css/.test(html)) err("does not link theme/bh.css");
      for (const p of linkTargetProblems(raw)) err(p);

      // Example pages: a dedicated marker, never the `examples` tag (a tag is a topic).
      const example = getMeta(html, "bh:example");
      if (example && example !== "true") err(`bh:example must be "true" (got "${example}")`);
      if (!isTemplate && getMeta(html, "bh:tags").split(",").some((t) => t.trim().toLowerCase() === "examples")) {
        err('the "examples" tag is reserved: mark an example page with <meta name="bh:example" content="true"> instead (the index adds the topic)');
      }
      // Unlisted pages: a dedicated marker; the tag would only be a topic. Public pages only.
      const unlisted = getMeta(html, "bh:unlisted");
      if (unlisted && unlisted !== "true") err(`bh:unlisted must be "true" (got "${unlisted}")`);
      if (!isTemplate && getMeta(html, "bh:tags").split(",").some((t) => t.trim().toLowerCase() === "unlisted")) {
        err('the "unlisted" tag is reserved: mark an unlisted page with <meta name="bh:unlisted" content="true"> instead');
      }
      if (unlisted && isPrivateSource(file)) err("a private page cannot be unlisted: it is already off the site, and only a sealed copy is published");
      // An unlisted page's address works, but a link to it from a listed page is inert unless the reader opted in.
      if (!isTemplate && !unlisted && file !== GLOSSARY_SRC) {
        const seenLinks = new Set();
        for (const m of html.matchAll(/<a\b[^>]*?\shref="([^"#?]+\.html)(?:[#?][^"]*)?"/g)) {
          if (/^[a-z]+:/i.test(m[1])) continue;
          const target = path.relative(ROOT, path.resolve(path.dirname(file), m[1])).split(path.sep).join("/");
          if (unlistedHrefs.has(target) && !seenLinks.has(target)) { seenLinks.add(target); warn(`links to unlisted page ${m[1]}: the link is inert unless the page is opened with #unlisted=true`); }
        }
      }
      // Off the local machine, links to example pages become plain text. Glossary definitions point at them by design.
      if (!isTemplate && !example && file !== GLOSSARY_SRC) {
        const seenLinks = new Set();
        for (const m of html.matchAll(/<a\b[^>]*?\shref="([^"#?]+\.html)(?:[#?][^"]*)?"/g)) {
          if (/^[a-z]+:/i.test(m[1])) continue;
          const target = path.relative(ROOT, path.resolve(path.dirname(file), m[1])).split(path.sep).join("/");
          if (exampleHrefs.has(target) && !seenLinks.has(target)) { seenLinks.add(target); warn(`links to example page ${m[1]}: on the published site the link becomes plain text`); }
        }
      }
    }

    // Duplicate ids
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const seen = new Set();
    for (const id of ids) { if (seen.has(id)) err(`duplicate id="${id}"`); seen.add(id); }

    // Prose ↔ diagram references point at a real figure and real parts of it.
    {
      const { root: tree, src } = parseTree(raw);
      for (const m of html.matchAll(/\sdata-ref="([^"]*)"/g)) {
        const i = m[1].indexOf(":");
        if (i < 1) { err(`data-ref="${m[1]}" must be "figure-id:part-id [part-id…]"`); continue; }
        const figId = m[1].slice(0, i).trim();
        const fig = findNode(tree, (n) => nodeAttr(n, "id") === figId);
        if (!fig) { err(`data-ref="${m[1]}": no element with id="${figId}"`); continue; }
        const parts = new Set([...src.slice(fig.start, fig.end).matchAll(/\sdata-id="([^"]+)"/g)].map((x) => x[1]));
        for (const id of m[1].slice(i + 1).split(/[\s,]+/).filter(Boolean)) {
          if (!parts.has(id)) err(`data-ref="${m[1]}": #${figId} has no part with data-id="${id}"`);
        }
      }
    }

    // Ids bh.js generates at runtime: stepper steps (#<for or id>-step-N).
    for (const m of html.matchAll(/<bh-stepper\b([^>]*)>([\s\S]*?)<\/bh-stepper>/g)) {
      const base = attrOf(m[1], "id") || attrOf(m[1], "for");
      const steps = (m[2].match(/<bh-step\b/g) || []).length;
      for (let i = 1; base && i <= steps; i++) seen.add(`${base}-step-${i}`);
    }

    // In-page anchors (heading ids may also be generated at runtime: warn, not error)
    for (const m of html.matchAll(/href="#([^"]+)"/g)) {
      if (!seen.has(m[1])) warn(`link to #${m[1]} has no matching id in the source`);
    }

    // Public pages never link to private ones: the link would either break or reveal the page.
    if (!isPrivateSource(file)) for (const m of html.matchAll(/\s(?:href|src)="([^"#?]+\.html)(?:[#?][^"]*)?"/g)) {
      if (/^[a-z]+:/i.test(m[1])) continue;
      const slug = path.basename(m[1]).replace(PRIVATE_EXT, ".html").replace(/\.html$/, "");
      if (path.resolve(path.dirname(file), m[1]).startsWith(DOCS + path.sep) && privateSlugs.has(slug)) err(`links to private page ${m[1]}`);
    }

    // Relative links and assets exist
    for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      const url = m[1];
      if (/^(https?:|mailto:|tel:|data:|#|\/\/)/.test(url)) continue;
      const target = path.resolve(path.dirname(file), decodeURI(url.split(/[?#]/)[0]));
      if (!fs.existsSync(target)) err(`broken link: ${url}`);
    }

    // Images need alt; diagrams need an accessible name
    for (const m of html.matchAll(/<img\b[^>]*>/g)) if (!/\balt=/.test(m[0])) err(`<img> without alt: ${m[0].slice(0, 60)}…`);
    for (const m of html.matchAll(/<figure[^>]*class="[^"]*\bdiagram\b[^"]*"[^>]*>\s*<svg\b([^>]*)>/g)) {
      if (!/role="img"/.test(m[1]) || !/aria-label(ledby)?=/.test(m[1])) warn('diagram <svg> should have role="img" and aria-label');
    }

    // Arrowed edges: tips must land on their target node's outline (see ARROW_LEN).
    for (const svg of html.matchAll(/<svg\b[\s\S]*?<\/svg>/g)) {
    const rects = nodeRects(svg[0]);
    for (const m of svg[0].matchAll(/<path\b[^>]*>/g)) {
      const cls = (m[0].match(/\sclass="([^"]*)"/) || [])[1] || "";
      const classes = cls.split(/\s+/);
      if (!classes.includes("edge") || classes.includes("no-arrow")) continue;
      const d = (m[0].match(/\sd="([^"]*)"/) || [])[1];
      const name = (m[0].match(/\sdata-id="([^"]*)"/) || [])[1] || d;
      if (!d) { err(`edge "${name}" has no d attribute`); continue; }
      let segs;
      try { segs = parsePath(d); } catch (e) { err(`edge "${name}": ${e.message}`); continue; }
      const ends = classes.includes("both") ? ["end", "start"] : ["end"];
      for (const end of ends) for (const p of tipProblems(segs, end, rects)) err(`edge "${name}" ${p}`);
    }
    }

    // Diagram labels never collide with edges, arrowheads, nodes or each other.
    for (const p of diagramLabelProblems(raw)) err(p);

    // Glossary references resolve to a global or page-local term.
    const localTerms = parseGlossary(html);
    if (file !== GLOSSARY_SRC) for (const p of glossaryProblems(localTerms)) err(p);
    for (const m of html.matchAll(/\sdata-term="([^"]*)"/g)) {
      if (!globalTerms.has(m[1]) && !localTerms.some((e) => e.id === m[1])) err(`data-term="${m[1]}" is not in the glossary`);
    }

    // Stepper targets & highlight ids
    const dataIds = new Set([...html.matchAll(/\sdata-id="([^"]+)"/g)].map((m) => m[1]));
    for (const m of html.matchAll(/<bh-stepper\b[^>]*\sfor="([^"]+)"/g)) {
      if (!seen.has(m[1])) err(`<bh-stepper for="${m[1]}"> — no element with that id`);
    }
    for (const m of html.matchAll(/<bh-step\b[^>]*\shighlight="([^"]*)"/g)) {
      for (const id of m[1].split(/[\s,]+/).filter(Boolean)) {
        if (!dataIds.has(id)) err(`<bh-step highlight> references unknown data-id "${id}"`);
      }
    }
    for (const m of html.matchAll(/<bh-filter\b[^>]*\sfor="([^"]+)"/g)) {
      if (!seen.has(m[1])) err(`<bh-filter for="${m[1]}"> — no element with that id`);
    }

    console.log((problems.length ? (problems.some((p) => p.includes("error")) ? c.red("✗ ") : c.yellow("! ")) : c.green("✓ ")) + rel);
    problems.forEach((p) => console.log(p));
  }
  console.log(`\n${files.length} files · ${errors ? c.red(errors + " errors") : "0 errors"} · ${warnings ? c.yellow(warnings + " warnings") : "0 warnings"}`);
  if (errors) process.exit(1);
}

// ---- bundle -----------------------------------------------------------------------

function inlineCss(file, remote, seen = new Set()) {
  if (seen.has(file)) return "";
  seen.add(file);
  const css = fs.readFileSync(file, "utf8");
  return css.replace(/@import\s+url\(\s*["']?([^"')]+)["']?\s*\)\s*(?:layer\(([^)]+)\))?\s*;/g, (m, href, layer) => {
    if (/^https?:/.test(href)) { remote.add(m.trim()); return ""; }
    const body = inlineCss(path.resolve(path.dirname(file), href), remote, seen);
    return layer ? `@layer ${layer} {\n${body}\n}` : body;
  });
}

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".avif": "image/avif" };

function bundleOne(file) {
  const dir = path.dirname(file);
  let html = fs.readFileSync(file, "utf8");
  const scripts = [];

  html = html.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>/g, (m, href) => {
    if (/^https?:/.test(href)) return m;
    const remote = new Set();
    const css = inlineCss(path.resolve(dir, href), remote);
    return `<style>\n${[...remote].join("\n")}\n${css}\n</style>`;
  });

  html = html.replace(/<script\s+src="([^"]+)"[^>]*><\/script>/g, (m, src) => {
    if (/^https?:/.test(src)) return m;
    const abs = path.resolve(dir, src);
    // bh.js loads the glossary at runtime; a standalone file must carry it inline, first.
    if (abs === path.join(ROOT, "theme", "bh.js")) {
      if (fs.existsSync(GLOSSARY_OUT)) scripts.push(fs.readFileSync(GLOSSARY_OUT, "utf8").replace(/<\/script/gi, "<\\/script"));
      // Only this page's threads: a standalone file leaves the repo, so it must not carry other pages' comments.
      const mine = path.relative(ROOT, file).split(path.sep).join("/");
      const own = { [mine]: compileReviews().byDoc[mine] || [] };
      if (own[mine].length) scripts.push(`window.BH_REVIEWS = ${JSON.stringify(own)};`.replace(/<\/script/gi, "<\\/script"));
    }
    scripts.push(fs.readFileSync(abs, "utf8").replace(/<\/script/gi, "<\\/script"));
    // On-demand modules can't be fetched from a standalone file: inline them all after bh.js.
    if (abs === path.join(ROOT, "theme", "bh.js")) {
      const dir = path.join(ROOT, "theme", "modules");
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js")).sort()) {
        scripts.push(fs.readFileSync(path.join(dir, f), "utf8").replace(/<\/script/gi, "<\\/script"));
      }
    }
    return "";
  });

  html = html.replace(/(<img\b[^>]*\ssrc=")([^"]+)(")/g, (m, a, src, b) => {
    if (/^(https?:|data:)/.test(src)) return m;
    const p = path.resolve(dir, src);
    const mime = MIME[path.extname(p).toLowerCase()];
    if (!mime || !fs.existsSync(p)) return m;
    return a + `data:${mime};base64,${fs.readFileSync(p).toString("base64")}` + b;
  });

  // A standalone file has no theme/ beside it: carry the favicon and touch icon inside it.
  html = html.replace(/<link\b[^>]*\brel="(?:[^"]*\s)?(?:icon|apple-touch-icon)(?:\s[^"]*)?"[^>]*>/g, (tag) => tag.replace(/(\bhref=")([^"]+)(")/, (m, a, href, b) => {
    if (/^(https?:|data:)/.test(href)) return m;
    const p = path.resolve(dir, href);
    const mime = MIME[path.extname(p).toLowerCase()];
    if (!mime || !fs.existsSync(p)) return m;
    return a + `data:${mime};base64,${fs.readFileSync(p).toString("base64")}` + b;
  }));

  // A standalone file has no URL of its own and no card beside it: keep the title and description
  // tags, drop the canonical URL, the image and the Twitter card, which would point at the site.
  html = html.replace(/^[ \t]*<link\s+rel="canonical"[^>]*>\n/gm, "")
    .replace(/^[ \t]*<meta\s+(?:property="og:(?:url|image[^"]*)"|name="twitter:[^"]*")[^>]*>\n/gm, "");

  // Links back into the site don't exist in a standalone file.
  html = html.replace(/<html\b/, "<html data-bundled");
  // Reviews made on a standalone file still know which document and commit they're about.
  const source = path.relative(ROOT, file).split(path.sep).join("/");
  html = html.replace("</head>", `  <meta name="bh:source" content="${escapeHtml(source)}">\n</head>`);
  scripts.unshift(buildScript(buildInfo()));
  html = html.replace(/<a href="\.\.\/index\.html">← All documents<\/a>/g, "");
  html = html.replace("</body>", scripts.map((s) => `<script>\n${s}\n</script>`).join("\n") + "\n</body>");

  fs.mkdirSync(DIST, { recursive: true });
  const out = path.join(DIST, path.basename(file));
  fs.writeFileSync(out, html);
  console.log(c.green(`Bundled ${path.relative(ROOT, file)} → ${path.relative(ROOT, out)}`) + c.dim(` (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`));
}

function cmdBundle([target]) {
  if (!target) {
    console.error("Usage: bh bundle <docs/page.html | --all>");
    process.exit(2);
  }
  const files = target === "--all" ? listedDocFiles() : [path.resolve(process.cwd(), target)];
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error(c.red(`No such file: ${f}`)); process.exit(1); }
    bundleOne(f);
  }
}

// ---- seal / unseal (private pages) ---------------------------------------------------
//
// The repo and its Pages site are public, so hiding a page means never committing its
// plaintext. docs/<slug>.private.html is git-ignored; `seal` gzips it, encrypts it with
// AES-256-GCM under a per-page key kept in 1Password, and writes docs/<slug>.html: a small
// shell that decrypts itself in the browser when opened as
//   docs/<slug>.html#k=<key>            (optionally #k=<key>&<section-id>)
// The fragment is never sent to the server. Without the key the shell shows only a notice.
// The sealed file is the copy of record: `unseal` recreates the plaintext from it.

const opTitle = (slug) => `beautiful-html private page: ${slug}`;
const opGroupTitle = (name) => `beautiful-html private group: ${name}`;
const itemCache = new Map();

/** Run the 1Password CLI. Secrets only ever travel on stdin/stdout, never in argv. */
function op(args, input) {
  try {
    if (input == null) return execFileSync("op", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    // Node's stdin "pipe" is a socket, which op doesn't treat as piped input (it then creates an
    // empty item). `cat |` hands op a real pipe; the secret still never appears in argv.
    return execFileSync("/bin/sh", ["-c", 'cat | op "$@"', "sh", ...args], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    if (e.code === "ENOENT") throw new Error("the 1Password CLI (`op`) is not installed: `brew install 1password-cli`");
    throw new Error(String(e.stderr || e.message).trim().replace(/^\[ERROR\]\s*\S+\s+\S+\s*/, ""));
  }
}

/** A 1Password item as { id, group, password } (empty strings for absent fields), or null if there is none. */
function readItem(title) {
  if (!itemCache.has(title)) {
    let item = null;
    try {
      item = JSON.parse(op(["item", "get", title, "--vault", OP_VAULT, "--format", "json", "--reveal"]));
    } catch (e) {
      if (!/isn't an item|not found/i.test(e.message)) throw e;
    }
    const field = (label) => String((item?.fields || []).find((f) => f.label === label)?.value ?? "");
    itemCache.set(title, item && { id: item.id, group: field("group"), password: field("password") });
  }
  return itemCache.get(title);
}

const validKey = (key) => (key && KEY_RE.test(key) ? key : null);

/** The key that opens a page, or null if it has none yet. A grouped page's item names its group; the group's item holds the key. */
function readKey(slug) {
  const item = readItem(opTitle(slug));
  if (!item) return null;
  if (item.group) return validKey(readItem(opGroupTitle(item.group))?.password);
  return validKey(item.password);
}

/** Create a 1Password item from the given fields; read it back, because a key hasn't reached 1Password until it can be fetched again. */
function createItem(title, category, fields, verify) {
  const created = JSON.parse(op(["item", "create", "--vault", OP_VAULT, "--format", "json", "-"], JSON.stringify({ title, category, fields })));
  itemCache.delete(title);
  if (!verify(readItem(title))) throw new Error(`1Password item ${created.id} doesn't hold what was sent; archive it and retry`);
}

const notes = (value) => ({ id: "notesPlain", type: "STRING", purpose: "NOTES", label: "notesPlain", value });
const secret = (key) => ({ id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password", value: key });

/** Store a new key as a 1Password Password item. */
function storeKey(slug, key = crypto.randomBytes(32).toString("base64url")) {
  createItem(opTitle(slug), "PASSWORD", [secret(key),
    notes(`Decryption key for docs/${slug}.html in beautiful-html.\nShare as: docs/${slug}.html#k=<this password>\nRecreate the plaintext with: npm run unseal -- ${slug}`)],
  (item) => item?.password === key);
  return key;
}

/** Store a new group key. Every page in the group is opened by it, and so is the home-page card of each. */
function storeGroupKey(name, key = crypto.randomBytes(32).toString("base64url")) {
  createItem(opGroupTitle(name), "PASSWORD", [secret(key),
    notes(`Decryption key shared by every private page in the group "${name}" (<meta name="bh:group">) in beautiful-html.\nShare as: docs/<slug>.html#k=<this password>, or index.html#k=<this password> for the home-page cards.\nAnyone with it opens every page in the group. Archive this item only once no page uses the group.`)],
  (item) => item?.password === key);
  return key;
}

/** Point a page at its group: the page's item keeps no key, only the group's name. */
function storePageGroup(slug, group) {
  createItem(opTitle(slug), "SECURE_NOTE", [{ id: "group", type: "STRING", label: "group", value: group },
    notes(`The key for docs/${slug}.html is the password of "${opGroupTitle(group)}".\nRecreate the plaintext with: npm run unseal -- ${slug}`)],
  (item) => item?.group === group);
}

function archiveItem(title) {
  op(["item", "delete", title, "--vault", OP_VAULT, "--archive"]);
  itemCache.delete(title);
}

/**
 * Make the page's 1Password items match its `bh:group` (or lack of one), creating whatever is
 * missing. Returns the key before and after: they differ when the page's group changed, which
 * re-keys it. An item whose mode changed is archived, not edited, so no secret passes through argv.
 */
function ensureKey(slug, group) {
  const before = readKey(slug), title = opTitle(slug), item = readItem(title);
  if (group) {
    if (!validKey(readItem(opGroupTitle(group))?.password)) { storeGroupKey(group); console.log(c.green(`Created a group key in 1Password: "${opGroupTitle(group)}" (vault ${OP_VAULT})`)); }
    if (item?.group !== group) { if (item) archiveItem(title); storePageGroup(slug, group); }
  } else if (!(item && !item.group && validKey(item.password))) {
    if (item) archiveItem(title);
    storeKey(slug);
    console.log(c.green(`Created a key in 1Password: "${title}" (vault ${OP_VAULT})`));
  }
  return { before, key: readKey(slug) };
}

/** Identifies the sealed plaintext without revealing anything about it (keyed MAC). */
const sealDigest = (key, plain) => crypto.createHmac("sha256", key).update(plain).digest("hex");

/** The base64 ciphertext inside a sealed page, whitespace removed. */
const sealedPayload = (text) => ((text.match(/id="sealed-payload">([\s\S]*?)<\/script>/) || [])[1] || "").replace(/\s+/g, "");

function sealedShell(payload, digest, shell = SHELL_VERSION()) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="referrer" content="no-referrer">
  <!-- A link preview must reveal nothing: this card is the same for every private page. -->
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
  <meta property="og:title" content="Private page">
  <meta property="og:description" content="This page is private. Open it with the full link you were given.">
  <meta property="og:image" content="${escapeHtml(SITE_URL + SHARED_CARD)}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="${CARD_W}">
  <meta property="og:image:height" content="${CARD_H}">
  <meta property="og:image:alt" content="${escapeHtml(SHARED_CARD_ALT)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="bh:sealed" content="aes-256-gcm+gzip">
  <meta name="bh:sealed-digest" content="${digest}">
  <meta name="bh:sealed-shell" content="${shell}">
  <title>Private page</title>
  <link rel="icon" type="image/svg+xml" href="../theme/logo/mark-tile.svg">
  <link rel="apple-touch-icon" href="../theme/logo/apple-touch-icon.png">
  <!-- GENERATED by \`npm run seal\` from a git-ignored docs/*.private.html. Do not edit. -->
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: light-dark(#f6f7f9, #0c0e12); color: light-dark(#15181e, #e7e9ee); }
    main { max-width: 32rem; padding: 2rem 1rem; }
    h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
    p { line-height: 1.6; color: light-dark(#596173, #9ba3b4); }
  </style>
</head>
<body>
<main>
  <h1>Private page</h1>
  <p id="sealed-message">This page is encrypted. Open it with the full link you were given, including the part after <code>#</code>.</p>
</main>
<script type="application/octet-stream" id="sealed-payload">
${(payload.match(/.{1,120}/g) || []).join("\n")}
</script>
<script>
const message = document.getElementById("sealed-message");
const store = "bh-sealed-key:" + location.pathname;
async function unseal(fromStorage) {
  const m = location.hash.match(/^#k=([A-Za-z0-9_-]{43})(?:&(.*))?$/);
  let key = m ? m[1] : null, anchor = m ? m[2] || "" : location.hash.slice(1);
  if (!key && fromStorage) { try { key = sessionStorage.getItem(store); } catch {} }
  if (!key) return;
  const bytes = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  try {
    const raw = bytes(document.getElementById("sealed-payload").textContent.replace(/\\s+/g, ""));
    const k = await crypto.subtle.importKey("raw", bytes(key.replace(/-/g, "+").replace(/_/g, "/") + "="), "AES-GCM", false, ["decrypt"]);
    const gz = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, k, raw.slice(12));
    const html = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    try { sessionStorage.setItem(store, key); } catch {}
    // Keep the key out of the address bar, copied section links and screenshots.
    history.replaceState(null, "", location.pathname + location.search + (anchor ? "#" + anchor : ""));
    document.open();
    document.write(html);
    document.close();
  } catch {
    try { sessionStorage.removeItem(store); } catch {}
    message.textContent = "This link's key doesn't open this page. Check that you copied the whole link.";
  }
}
// A link pasted into a tab already showing this notice only changes the fragment.
addEventListener("hashchange", () => unseal(false));
unseal(true);
</script>
</body>
</html>
`;
}

/** Changes whenever the shell's markup or script changes, so stale shells get re-sealed. */
function SHELL_VERSION() {
  return crypto.createHash("sha256").update(sealedShell("", "", "")).digest("hex").slice(0, 16);
}

/** Rewrap sealed pages in the current shell, keeping each payload as it is. Needs no key. */
function reshell() {
  for (const file of sealedFiles()) {
    const text = fs.readFileSync(file, "utf8"), rel = path.relative(ROOT, file);
    const next = sealedShell(sealedPayload(text), getMeta(text, "bh:sealed-digest"));
    if (next === text) { console.log(c.dim(`${rel} is up to date`)); continue; }
    fs.writeFileSync(file, next);
    console.log(c.green(`Rewrapped ${rel} in the current shell`));
  }
}

/** The page's `bh:group` from its plaintext ("" for none); exits on a name that isn't kebab-case. */
function sourceGroup(src) {
  const group = getMeta(stripComments(fs.readFileSync(src, "utf8")), "bh:group");
  if (group && !GROUP_RE.test(group)) { console.error(c.red(`${path.relative(ROOT, src)}: bh:group "${group}" must be kebab-case (a-z, 0-9, hyphens)`)); process.exit(1); }
  return group;
}

/** The card a private source would show: what `readDoc` extracts, as plain data. */
const sourceCard = (src) => { const d = readDoc(src); return cardFromDoc(d, docTopics(d)); };

function cmdSeal(argv = []) {
  if (argv.includes("--reshell")) return reshell();
  const showLinks = argv.includes("--show-links");
  const sources = privateSources();
  const cardsFile = path.join(ROOT, CARD_FILE);
  const existing = fs.existsSync(cardsFile) ? parseCardsFile(fs.readFileSync(cardsFile, "utf8")).entries : [];
  const fresh = {}, groups = new Map();
  for (const src of sources) {
    const slug = path.basename(src, PRIVATE_EXT);
    const group = sourceGroup(src);
    const out = path.join(DOCS, `${slug}.html`);
    const rel = path.relative(ROOT, out);
    if (fs.existsSync(out) && !isSealed(out)) { console.error(c.red(`Refusing to overwrite public page ${rel}`)); process.exit(1); }
    const { before, key: keyText } = ensureKey(slug, group);
    if (fs.existsSync(out) && before !== keyText) {
      console.warn(c.yellow(`⚠ ${slug}: its key changed${group ? ` (now in the group "${group}")` : " (it left its group)"}. The page is re-encrypted, so every old #k= link to ${rel} stops working: share the new link.`));
    }
    const key = Buffer.from(keyText, "base64url");
    const plain = fs.readFileSync(src);
    const digest = sealDigest(key, plain);
    // Re-sealing unchanged plaintext would only change the IV, so leave the file alone.
    const current = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
    if (getMeta(current, "bh:sealed-digest") === digest && getMeta(current, "bh:sealed-shell") !== SHELL_VERSION()) {
      // Same plaintext, older shell: keep the ciphertext (a new IV would only add churn).
      fs.writeFileSync(out, sealedShell(sealedPayload(current), digest));
      console.log(c.green(`Rewrapped ${rel} in the current shell`));
    } else if (!(getMeta(current, "bh:sealed-digest") === digest && getMeta(current, "bh:sealed-shell") === SHELL_VERSION())) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const sealed = Buffer.concat([iv, cipher.update(zlib.gzipSync(plain, { level: 9 })), cipher.final(), cipher.getAuthTag()]);
      fs.writeFileSync(out, sealedShell(sealed.toString("base64"), digest));
      console.log(c.green(`Sealed ${path.relative(ROOT, src)} → ${rel}`));
    } else console.log(c.dim(`${rel} is up to date`));
    console.log(`  link: ${rel}#k=${showLinks ? keyText : `<password of "${group ? opGroupTitle(group) : opTitle(slug)}">`}`);
    fresh[slug] = buildBlob(existing.find((e) => e.slug === slug)?.blob, sourceCard(src), keyText, slug);
    if (group) groups.set(group, keyText);
  }
  // The card file follows the sealed pages: a blob each, those without local plaintext kept, orphans dropped.
  const text = renderCardsFile(mergeEntries(existing, fresh, new Set(sealedFiles().map((f) => path.basename(f, ".html")))));
  if (!fs.existsSync(cardsFile) || fs.readFileSync(cardsFile, "utf8") !== text) {
    fs.writeFileSync(cardsFile, text);
    console.log(c.green(`Updated ${CARD_FILE}`));
  } else if (sources.length) console.log(c.dim(`${CARD_FILE} is up to date`));
  if (!sources.length) { console.log(c.dim("No docs/*.private.html to seal.")); return; }
  for (const [name, keyText] of [...groups].sort()) console.log(`  home page, group "${name}": index.html#k=${showLinks ? keyText : `<password of "${opGroupTitle(name)}">`}`);
  if (!showLinks) console.log(c.dim("Run `npm run seal -- --show-links` to print the full links."));
}

/** Decrypt a sealed page with its key; the inverse of the encryption in cmdSeal. */
function unsealFile(file, keyText) {
  const text = fs.readFileSync(file, "utf8");
  const b64 = (text.match(/id="sealed-payload">([\s\S]*?)<\/script>/) || [])[1];
  if (!b64) throw new Error(`${path.relative(ROOT, file)} has no sealed payload`);
  const raw = Buffer.from(b64.replace(/\s+/g, ""), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(keyText, "base64url"), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return zlib.gunzipSync(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]));
}

function cmdUnseal(argv) {
  const force = argv.includes("--force");
  const wanted = argv.filter((a) => a !== "--force");
  const shells = sealedFiles().filter((f) => !wanted.length || wanted.includes(path.basename(f, ".html")));
  if (!shells.length) { console.log(c.dim(wanted.length ? `No sealed page named ${wanted.join(", ")}.` : "No sealed pages.")); return; }
  for (const shell of shells) {
    const slug = path.basename(shell, ".html");
    const out = path.join(DOCS, slug + PRIVATE_EXT), rel = path.relative(ROOT, out);
    const keyText = readKey(slug);
    if (!keyText) { console.error(c.red(`No key for ${slug} in 1Password (vault ${OP_VAULT}, item "${opTitle(slug)}")`)); process.exitCode = 1; continue; }
    let plain;
    try { plain = unsealFile(shell, keyText); } catch (e) { console.error(c.red(`Can't decrypt docs/${slug}.html: ${e.message}`)); process.exitCode = 1; continue; }
    if (fs.existsSync(out)) {
      if (fs.readFileSync(out).equals(plain)) { console.log(c.dim(`${rel} is up to date`)); continue; }
      if (!force) { console.error(c.red(`${rel} has edits that aren't sealed yet; run \`npm run seal\`, or \`unseal -- --force\` to discard them`)); process.exitCode = 1; continue; }
    }
    fs.writeFileSync(out, plain);
    console.log(c.green(`Unsealed docs/${slug}.html → ${rel}`));
  }
}

// ---- serve ------------------------------------------------------------------------

/** What review comments are made against: repo, commit and whether the tree had edits.
    On GitHub Pages the deploy writes theme/build.js; `serve` and `bundle` compute it here. */
function buildInfo() {
  const git = (args) => { try { return execSync(`git ${args}`, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const repo = String(pkg.repository || "").replace(/^github:/, "");
  return { repo, commit: git("rev-parse HEAD") || null, dirty: git("status --porcelain -- docs theme index.html") !== "", builtAt: new Date().toISOString() };
}
const buildScript = (info) => `/* Review build stamp (generated, not committed). */\nwindow.BH_BUILD = ${JSON.stringify(info)};\n`;

function cmdServe([port = "8000"]) {
  const root = fs.realpathSync(ROOT);
  const contains = (file) => file === root || file.startsWith(root + path.sep);
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".woff2": "font/woff2", ...MIME };
  http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400).end(); return; }
    if (p === "/theme/build.js") {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-cache" }).end(buildScript(buildInfo()));
      return;
    }
    let file = path.join(root, p), target;
    if (!contains(file)) { res.writeHead(403).end(); return; }
    try {
      target = fs.realpathSync(file);
      if (!contains(target)) { res.writeHead(403).end(); return; }
      if (fs.statSync(target).isDirectory()) {
        file = path.join(file, "index.html");
        target = fs.realpathSync(path.join(target, "index.html"));
        if (!contains(target)) { res.writeHead(403).end(); return; }
      }
    } catch { res.writeHead(404, { "content-type": "text/plain" }).end("Not found"); return; }
    fs.readFile(target, (e, data) => {
      if (e) { res.writeHead(404, { "content-type": "text/plain" }).end("Not found"); return; }
      res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" }).end(data);
    });
  }).listen(+port, () => {
    console.log(`Serving ${ROOT} at ${c.green(`http://localhost:${port}/`)}`);
    console.log(c.dim(`Unlisted pages stay hidden here, as for readers: open any page with #unlisted=true to see them (http://localhost:${port}/#unlisted=true).`));
  });
}

// ---- main -------------------------------------------------------------------------

const [cmd, ...args] = process.argv.slice(2);
const commands = { new: cmdNew, index: cmdIndex, check: cmdCheck, cards: cmdCards, bundle: cmdBundle, seal: cmdSeal, unseal: cmdUnseal, serve: cmdServe };
if (!commands[cmd]) {
  console.log(`beautiful-html

  new [--private] [--example] [--unlisted] <template> <slug> "<Title>" ["<desc>"]
                                               create docs/<slug>.html (or a git-ignored <slug>.private.html);
                                               --unlisted publishes it off the site's listings (see CLAUDE.md)
  index                                        regenerate the document list in index.html
  check                                        lint docs/ and index.html (links, ids, stepper refs, a11y)
  cards [--force] [--system-fonts]             render the social card of every page whose card is missing or stale
  bundle <page | --all>                        inline the theme → dist/<page>.html (one shareable file)
  seal [--show-links | --reshell]              encrypt docs/*.private.html → docs/<slug>.html (keys in 1Password);
                                               --reshell rewraps sealed pages in the current shell, no key needed
  unseal [slug…] [--force]                     recreate docs/<slug>.private.html from the sealed page and its key
  serve [port]                                 static server on http://localhost:8000/`);
  process.exit(cmd ? 2 : 0);
}
try { await commands[cmd](args); } catch (e) { console.error(c.red(`bh ${cmd}: ${e.message}`)); process.exit(1); }
