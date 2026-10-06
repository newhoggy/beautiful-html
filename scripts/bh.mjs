#!/usr/bin/env node
// beautiful-html CLI — zero dependencies, Node ≥ 20.
//
//   node scripts/bh.mjs new <template> <slug> "<Title>" ["<description>"]
//   node scripts/bh.mjs index                 regenerate index.html list + theme/{glossary,site,search-index}.js
//   node scripts/bh.mjs check                 lint docs/ and index.html
//   node scripts/bh.mjs bundle <page|--all>   inline theme → dist/<name>.html (single file)
//   node scripts/bh.mjs serve [port]          static server (pages also work from file://)

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execSync } from "node:child_process";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");
const TEMPLATES = path.join(ROOT, "templates");
const DIST = path.join(ROOT, "dist");
const INDEX = path.join(ROOT, "index.html");
const GLOSSARY_SRC = path.join(DOCS, "glossary.html");
const GLOSSARY_OUT = path.join(ROOT, "theme", "glossary.js");
const SITE_OUT = path.join(ROOT, "theme", "site.js");
const SEARCH_OUT = path.join(ROOT, "theme", "search-index.js");

const KIND_LABELS = {
  explainer: "Explainer",
  design: "Design doc",
  decision: "Decision",
  incident: "Incident",
  review: "Review",
  reference: "Reference",
};

const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

// ---- HTML helpers (regex-based; fine for the files we author) ------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

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

function docFiles() {
  if (!fs.existsSync(DOCS)) return [];
  return fs.readdirSync(DOCS).filter((f) => f.endsWith(".html")).sort().map((f) => path.join(DOCS, f));
}

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
    // Lifecycle links (relative to the doc in the source; root-relative here).
    supersedes: resolveDocLink(file, getMeta(html, "bh:supersedes")),
    supersededBy: resolveDocLink(file, getMeta(html, "bh:superseded-by")),
  };
}

/** A doc-relative link from a meta tag as a root-relative path ("docs/x.html"), or "". */
function resolveDocLink(file, value) {
  if (!value) return "";
  return path.relative(ROOT, path.resolve(path.dirname(file), value)).split(path.sep).join("/");
}

// ---- new --------------------------------------------------------------------------

function cmdNew([template, slug, title, description]) {
  const templates = fs.readdirSync(TEMPLATES).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, ""));
  if (!template || !slug || !title) {
    console.error(`Usage: bh new <template> <slug> "<Title>" ["<description>"]\nTemplates: ${templates.join(", ")}`);
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
  const out = path.join(DOCS, `${slug}.html`);
  if (fs.existsSync(out)) {
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
  const html = fs.readFileSync(path.join(TEMPLATES, `${template}.html`), "utf8")
    .replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(out, html);
  console.log(c.green(`Created ${path.relative(ROOT, out)}`));
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

function buildSiteData() {
  const docs = docFiles().map((f) => ({ ...readDoc(f), html: fs.readFileSync(f, "utf8") }));
  const known = new Set(docs.map((d) => d.href));
  const pages = docs.map(({ href, title, kind, status, date, description, supersedes, supersededBy }) => ({ href, title, kind, status, date, description, supersedes, supersededBy }));
  const backlinks = {};
  const search = [];
  for (const d of docs) {
    const sections = extractSections(d.html);
    search.push({ href: d.href, title: d.title, kind: d.kind, sections: sections.map(({ id, heading, text }) => ({ id, heading, text })).filter((x) => x.text || x.heading) });
    for (const sec of sections) {
      for (const m of sec.html.matchAll(/\shref="([^"#?]+\.html)(?:[#?][^"]*)?"/g)) {
        if (/^[a-z]+:/i.test(m[1])) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(d.href), m[1]));
        if (target === d.href || !known.has(target)) continue;
        const list = (backlinks[target] = backlinks[target] || []);
        const from = d.href + (sec.id ? "#" + sec.id : "");
        if (!list.some((b) => b.href === from)) list.push({ href: from, title: d.title, section: sec.heading });
      }
    }
  }
  for (const e of compileGlossary().entries) {
    search.push({ href: e.href, title: e.term, kind: "glossary", sections: [{ id: "", heading: e.aliases.join(", "), text: decodeEntities(e.html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() }] });
  }
  const header = "/* GENERATED by `npm run index` from docs/. Do not edit. */\n";
  return {
    site: header + "window.BH_SITE = " + JSON.stringify({ pages, backlinks }, null, 1) + ";\n",
    search: header + "window.BH_SEARCH = " + JSON.stringify(search) + ";\n",
    counts: { pages: pages.length, links: Object.values(backlinks).reduce((a, b) => a + b.length, 0), entries: search.length },
  };
}

// ---- index ------------------------------------------------------------------------

function cmdIndex() {
  const docs = docFiles().map(readDoc)
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.title.localeCompare(b.title));
  const titles = new Map(docs.map((d) => [d.href, d.title]));
  const cards = docs.map((d) => {
    const search = [d.title, d.description, d.tags, d.kind].join(" ").toLowerCase();
    const replaced = d.supersededBy ? `\n        <p class="card-replaced">Replaced by <a href="${escapeHtml(d.supersededBy)}">${escapeHtml(titles.get(d.supersededBy) || d.supersededBy)}</a></p>` : "";
    return `      <li class="card doc-card${d.supersededBy ? " is-superseded" : ""}" data-kind="${escapeHtml(d.kind)}" data-search="${escapeHtml(search)}">
        <a class="card-link" href="${escapeHtml(d.href)}">
          <span class="eyebrow">${escapeHtml(KIND_LABELS[d.kind] || d.kind)}</span>
          <h3>${escapeHtml(d.title)}</h3>
          <p>${escapeHtml(d.description)}</p>
        </a>
        <span class="card-meta">${d.status ? `<span class="badge ${escapeHtml(d.status.toLowerCase())}">${escapeHtml(d.status)}</span>` : ""}${d.date ? `<time datetime="${escapeHtml(d.date)}">${escapeHtml(d.date)}</time>` : ""}</span>${replaced}
      </li>`;
  }).join("\n");
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

  const g = compileGlossary();
  const prev = fs.existsSync(GLOSSARY_OUT) ? fs.readFileSync(GLOSSARY_OUT, "utf8") : "";
  if (prev !== g.js) fs.writeFileSync(GLOSSARY_OUT, g.js);
  console.log(c.green(`Compiled ${g.entries.length} glossary term${g.entries.length === 1 ? "" : "s"} → theme/glossary.js`));

  const site = buildSiteData();
  for (const [file, text] of [[SITE_OUT, site.site], [SEARCH_OUT, site.search]]) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) fs.writeFileSync(file, text);
  }
  console.log(c.green(`Built search index (${site.counts.entries} entries) and ${site.counts.links} backlinks → theme/site.js, theme/search-index.js`));
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

function reviewProblems() {
  const out = [];
  for (const file of reviewFiles()) {
    const rel = path.relative(ROOT, file);
    let r;
    try { r = readReview(file); } catch (e) { out.push(`${rel}: not readable JSON (${e.message})`); continue; }
    if (r.format !== "bh-review/1") { out.push(`${rel}: format must be "bh-review/1"`); continue; }
    if (!r.document || !fs.existsSync(path.join(ROOT, r.document))) out.push(`${rel}: document "${r.document}" doesn't exist`);
    if (!Array.isArray(r.comments)) { out.push(`${rel}: comments must be an array`); continue; }
    r.comments.forEach((cm, i) => {
      const where = `${rel}: comment ${i + 1}`;
      if (!cm.id || !cm.body || !cm.target) out.push(`${where} needs id, body and target`);
      else if (!["comment", "suggestion", "question", "blocker"].includes(cm.kind)) out.push(`${where}: kind "${cm.kind}" is unknown`);
      else if (cm.target.quote && typeof cm.target.quote.exact !== "string") out.push(`${where}: target.quote.exact must be text`);
    });
  }
  return out;
}

// ---- check ------------------------------------------------------------------------

function cmdCheck() {
  let errors = 0, warnings = 0;
  const templates = fs.readdirSync(TEMPLATES).filter((f) => f.endsWith(".html")).sort().map((f) => path.join(TEMPLATES, f));
  const files = [INDEX, ...docFiles(), ...templates];

  // Theme: stylesheet import order and token contrast in both themes.
  {
    const problems = [
      ...fs.readdirSync(path.join(ROOT, "theme")).filter((f) => f.endsWith(".css")).flatMap((f) => cssImportProblems(path.join(ROOT, "theme", f))),
      ...contrastProblems(),
    ];
    console.log((problems.length ? c.red("✗ ") : c.green("✓ ")) + "theme (import order, token contrast)");
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
    for (const [file, text] of [[SITE_OUT, site.site], [SEARCH_OUT, site.search]]) {
      if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) problems.push(`${path.relative(ROOT, file)} is stale: run \`npm run index\``);
    }
    // Decision lifecycle: supersedes / superseded-by must agree in both directions.
    const all = docFiles().map(readDoc);
    const byHref = new Map(all.map((d) => [d.href, d]));
    for (const d of all) {
      if (d.status.toLowerCase() === "superseded" && !d.supersededBy) problems.push(`${d.href}: status "superseded" needs <meta name="bh:superseded-by">`);
      if (d.supersededBy && d.status.toLowerCase() !== "superseded") problems.push(`${d.href}: has bh:superseded-by, so bh:status must be "superseded"`);
      for (const [rel, back, target] of [["bh:superseded-by", "supersedes", d.supersededBy], ["bh:supersedes", "supersededBy", d.supersedes]]) {
        if (!target) continue;
        const t = byHref.get(target);
        if (target === d.href) problems.push(`${d.href}: ${rel} points at itself`);
        else if (!t) problems.push(`${d.href}: ${rel} → ${target} does not exist`);
        else if (t[back] !== d.href) problems.push(`${d.href}: ${rel} → ${target}, but that page's ${back === "supersedes" ? "bh:supersedes" : "bh:superseded-by"} doesn't point back`);
      }
    }
    console.log((problems.length ? c.red("✗ ") : c.green("✓ ")) + `generated data & decision links (${glossary.entries.length} glossary terms)`);
    problems.forEach((p) => console.log(c.red("  error  ") + p));
    errors += problems.length;
  }
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
    if (abs === path.join(ROOT, "theme", "bh.js") && fs.existsSync(GLOSSARY_OUT)) {
      scripts.push(fs.readFileSync(GLOSSARY_OUT, "utf8").replace(/<\/script/gi, "<\\/script"));
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
  const files = target === "--all" ? docFiles() : [path.resolve(process.cwd(), target)];
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error(c.red(`No such file: ${f}`)); process.exit(1); }
    bundleOne(f);
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
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".woff2": "font/woff2", ...MIME };
  http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/theme/build.js") {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-cache" }).end(buildScript(buildInfo()));
      return;
    }
    let file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    fs.readFile(file, (e, data) => {
      if (e) { res.writeHead(404, { "content-type": "text/plain" }).end("Not found"); return; }
      res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" }).end(data);
    });
  }).listen(+port, () => console.log(`Serving ${ROOT} at ${c.green(`http://localhost:${port}/`)}`));
}

// ---- main -------------------------------------------------------------------------

const [cmd, ...args] = process.argv.slice(2);
const commands = { new: cmdNew, index: cmdIndex, check: cmdCheck, bundle: cmdBundle, serve: cmdServe };
if (!commands[cmd]) {
  console.log(`beautiful-html

  new <template> <slug> "<Title>" ["<desc>"]  create docs/<slug>.html from templates/<template>.html
  index                                        regenerate the document list in index.html
  check                                        lint docs/ and index.html (links, ids, stepper refs, a11y)
  bundle <page | --all>                        inline the theme → dist/<page>.html (one shareable file)
  serve [port]                                 static server on http://localhost:8000/`);
  process.exit(cmd ? 2 : 0);
}
commands[cmd](args);
