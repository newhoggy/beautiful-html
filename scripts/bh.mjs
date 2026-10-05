#!/usr/bin/env node
// beautiful-html CLI — zero dependencies, Node ≥ 20.
//
//   node scripts/bh.mjs new <template> <slug> "<Title>" ["<description>"]
//   node scripts/bh.mjs index                 regenerate index.html list + theme/glossary.js
//   node scripts/bh.mjs check                 lint docs/ and index.html
//   node scripts/bh.mjs bundle <page|--all>   inline theme → dist/<name>.html (single file)
//   node scripts/bh.mjs serve [port]          static server (pages also work from file://)

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");
const TEMPLATES = path.join(ROOT, "templates");
const DIST = path.join(ROOT, "dist");
const INDEX = path.join(ROOT, "index.html");
const GLOSSARY_SRC = path.join(DOCS, "glossary.html");
const GLOSSARY_OUT = path.join(ROOT, "theme", "glossary.js");

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
  const html = fs.readFileSync(file, "utf8");
  return {
    file,
    href: path.relative(ROOT, file).split(path.sep).join("/"),
    title: getTitle(html),
    description: getMeta(html, "description"),
    kind: getMeta(html, "bh:kind") || "explainer",
    status: getMeta(html, "bh:status"),
    date: getMeta(html, "bh:date"),
    tags: getMeta(html, "bh:tags"),
  };
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

// ---- index ------------------------------------------------------------------------

function cmdIndex() {
  const docs = docFiles().map(readDoc)
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.title.localeCompare(b.title));
  const cards = docs.map((d) => {
    const search = [d.title, d.description, d.tags, d.kind].join(" ").toLowerCase();
    return `      <li class="card doc-card" data-kind="${escapeHtml(d.kind)}" data-search="${escapeHtml(search)}">
        <a class="card-link" href="${escapeHtml(d.href)}">
          <span class="eyebrow">${escapeHtml(KIND_LABELS[d.kind] || d.kind)}</span>
          <h3>${escapeHtml(d.title)}</h3>
          <p>${escapeHtml(d.description)}</p>
        </a>
        <span class="card-meta">${d.status ? `<span class="badge ${escapeHtml(d.status.toLowerCase())}">${escapeHtml(d.status)}</span>` : ""}${d.date ? `<time datetime="${escapeHtml(d.date)}">${escapeHtml(d.date)}</time>` : ""}</span>
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
    if (n.tag === "bh-stepper" && !nodeAttr(n, "id") && !nodeAttr(n, "for")) {
      out.push("<bh-stepper> needs for=\"figure-id\" (or an id) so its steps can be linked to");
    }
  });
  return out;
}

// ---- check ------------------------------------------------------------------------

function cmdCheck() {
  let errors = 0, warnings = 0;
  const templates = fs.readdirSync(TEMPLATES).filter((f) => f.endsWith(".html")).sort().map((f) => path.join(TEMPLATES, f));
  const files = [INDEX, ...docFiles(), ...templates];

  // Glossary: compiled data must be fresh and entries well-formed.
  const glossary = compileGlossary();
  const globalTerms = new Set(glossary.entries.map((e) => e.id));
  {
    const problems = glossaryProblems(glossary.entries);
    const current = fs.existsSync(GLOSSARY_OUT) ? fs.readFileSync(GLOSSARY_OUT, "utf8") : "";
    if (current !== glossary.js) problems.push("theme/glossary.js is stale: run `npm run index`");
    console.log((problems.length ? c.red("✗ ") : c.green("✓ ")) + `glossary (${glossary.entries.length} terms)`);
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

function cmdServe([port = "8000"]) {
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".woff2": "font/woff2", ...MIME };
  http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
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
