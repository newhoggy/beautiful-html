// Social card renderer for beautiful-html — zero dependencies, Node ≥ 22, local Chrome.
//
// Called by `bh cards` (scripts/bh.mjs), which decides what to render: the job list carries the
// page, the visual chosen from it (bh.mjs `chooseVisual`) and the staleness key. This file only
// draws. It is also part of that key, so editing the layout below makes every card stale.
//
// Two phases per page, both in Chrome:
//   1. load the real page (light theme, reduced motion), screenshot the chosen element at 2×, so
//      inline SVG keeps the colours its theme classes give it;
//   2. lay that screenshot out on a branded 1200×630 frame with the page title, kind and logo,
//      so the card still says something when the visual is a bare diagram.
// Without Chrome, every card becomes a copy of the shared site card, tagged `fallback`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, findChrome, serveStatic, sleep } from "./chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const c = { red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m` };

export const CARD_W = 1200, CARD_H = 630;
const FAMILIES = ["Fraunces", "IBM Plex Sans"];
const FONT_CSS = "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,700&family=IBM+Plex+Sans:wght@400;600&display=swap";
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".avif": "image/avif" };
// The picture itself, not what wraps it (a chart element also holds its "Show data" table).
const VISUAL = "svg, img";
// The brand's fixed card colours (tokens.css dark values): a PNG has no theme.
const BG = "#0c0e12", TEXT = "#e7e9ee", MUTED = "#9ba3b4", ACCENT = "#a5a8ff";

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const dataUrl = (file) => `data:${MIME[path.extname(file).toLowerCase()] || "application/octet-stream"};base64,${fs.readFileSync(file).toString("base64")}`;

// ---- PNG text chunk: where a card records the key it was rendered for --------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let v = n;
  for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
  return v >>> 0;
});
function crc32(buf) {
  let v = 0xffffffff;
  for (const b of buf) v = CRC_TABLE[(v ^ b) & 0xff] ^ (v >>> 8);
  return (v ^ 0xffffffff) >>> 0;
}

/** The PNG with a `bh-card` tEXt chunk right after IHDR (Chrome's own output has none). */
export function tagPng(png, value) {
  const body = Buffer.concat([Buffer.from("tEXt"), Buffer.from(`bh-card\0${value}`, "latin1")]);
  const len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(body.length - 4);
  crc.writeUInt32BE(crc32(body));
  const ihdrEnd = 8 + 12 + 13;
  return Buffer.concat([png.subarray(0, ihdrEnd), len, body, crc, png.subarray(ihdrEnd)]);
}

// ---- Phase 1: the chosen visual ---------------------------------------------------------------

async function waitFor(s, expression, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    if ((await s("Runtime.evaluate", { expression, returnByValue: true })).result.value) return;
    if (Date.now() > deadline) throw new Error(what);
    await sleep(100);
  }
}

/** Resolves once every family is declared by the page's stylesheet and loaded; throws offline. */
async function loadFonts(s, faces) {
  const families = JSON.stringify(FAMILIES), list = JSON.stringify(faces);
  const r = await s("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const families = ${families};
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !families.every((fam) => [...document.fonts].some((f) => f.family.replace(/["']/g, "") === fam))) await new Promise((r) => setTimeout(r, 50));
    await Promise.all(${list}.map((f) => document.fonts.load(f).catch(() => null)));
    await document.fonts.ready;
    return families.every((fam) => [...document.fonts].some((f) => f.family.replace(/["']/g, "") === fam && f.status === "loaded"));
  })()` });
  if (!r.result.value) throw new Error("the web fonts (IBM Plex Sans, Fraunces) did not load: are you offline? Pass --system-fonts to render with fallback fonts anyway");
}

async function withTab(send, fn) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  try {
    const s = (m, p) => send(m, p, sessionId);
    await s("Page.enable");
    await s("Page.bringToFront"); // a background tab can be captured from a stale frame
    return await fn(s);
  } finally {
    await send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

/** The chosen element of a real page as { src, bg }: a PNG data URL and the page background it sat on. */
async function captureVisual(send, base, job, systemFonts) {
  return withTab(send, async (s) => {
    await s("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
    await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "reduce" }] });
    if (systemFonts) {
      await s("Network.enable");
      await s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
    }
    await s("Page.navigate", { url: base + job.href });
    await waitFor(s, "document.readyState === 'complete' && document.documentElement.hasAttribute('data-bh-ready')", 20000, `${job.href} never signalled data-bh-ready`);
    if (!systemFonts) await loadFonts(s, ['400 16px "IBM Plex Sans"', '600 16px "IBM Plex Sans"', '700 16px "IBM Plex Sans"']);
    const sel = job.selection;
    const found = (await s("Runtime.evaluate", { returnByValue: true, awaitPromise: true, expression: `(async () => {
      const st = document.createElement("style");
      st.textContent = ".bh-topbar, .bh-toc, .bh-progress { visibility: hidden !important; } .reveal-pending { opacity: 1 !important; transform: none !important; } * { animation: none !important; transition: none !important; }";
      document.head.append(st);
      const root = document.querySelectorAll(${JSON.stringify(sel.css)})[${sel.index}];
      if (!root) return { error: "no element matches " + ${JSON.stringify(sel.css)} + " [" + ${sel.index} + "]" };
      const inner = root.matches(${JSON.stringify(VISUAL)}) ? root : [...root.querySelectorAll(${JSON.stringify(VISUAL)})].find((e) => !e.closest("button, a")) || root;
      inner.scrollIntoView({ block: "center", behavior: "instant" });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const r = inner.getBoundingClientRect();
      return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, bg: getComputedStyle(document.body).backgroundColor };
    })()` })).result.value;
    if (found.error) throw new Error(`${job.href}: ${found.error}`);
    if (found.width < 8 || found.height < 8) throw new Error(`${job.href}: the chosen visual is ${found.width}×${found.height}px (is it hidden?)`);
    await sleep(300);
    const { data } = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: found.x, y: found.y, width: found.width, height: found.height, scale: 1 } });
    return { src: `data:image/png;base64,${data}`, bg: found.bg };
  });
}

// ---- Phase 2: the frame ---------------------------------------------------------------------

function markPaths() {
  const svg = fs.readFileSync(path.join(ROOT, "theme", "logo", "mark.svg"), "utf8");
  return [...svg.matchAll(/<path\b[^>]*>/g)].map((m) => m[0].replace(/\sclass="[^"]*"/, ` fill="${ACCENT}"`)).join("");
}

function titleSize(title) {
  const n = title.length;
  return n <= 28 ? 68 : n <= 48 ? 58 : n <= 72 ? 50 : 42;
}

export function frameHtml({ title, kind, date, siteName, visual, bg, tile }) {
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${FONT_CSS}"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: ${CARD_W}px; height: ${CARD_H}px; background: ${BG}; color: ${TEXT}; font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif; display: flex; flex-direction: column; padding: 40px 56px 40px; position: relative; overflow: hidden; }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 12px; background: ${ACCENT}; }
  .top { display: flex; align-items: center; justify-content: space-between; height: 44px; flex: none; }
  .brand { display: flex; align-items: center; gap: 14px; font-size: 26px; font-weight: 600; }
  .brand svg { width: 44px; height: 44px; }
  .meta { font-size: 22px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: ${ACCENT}; }
  h1 { flex: none; margin-top: 22px; font-family: "Fraunces", ui-serif, Georgia, serif; font-weight: 700; font-size: ${titleSize(title)}px; line-height: 1.1; padding-bottom: .14em; letter-spacing: -.01em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .panel { flex: 1; min-height: 0; margin: 24px 0 0; border-radius: 18px; background: ${bg}; display: flex; align-items: center; justify-content: center; padding: 22px; }
  .panel img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .panel img.tile { height: 100%; max-height: 240px; }
</style></head><body>
  <div class="top"><div class="brand"><svg viewBox="0 0 32 32" aria-hidden="true">${markPaths()}</svg><span>${esc(siteName)}</span></div><div class="meta">${esc(kind)}${date ? " · " + esc(date) : ""}</div></div>
  <h1>${esc(title)}</h1>
  <div class="panel"><img class="${tile ? "tile" : ""}" alt="" src="${visual}"></div>
  <div class="bar"></div>
</body></html>`;
}

async function composeCard(send, base, routes, job, visual, systemFonts) {
  const route = `/__card/${job.slug}.html`;
  routes.set(route, { type: "text/html; charset=utf-8", body: frameHtml({ ...job.frame, visual: visual.src, bg: visual.bg, tile: visual.tile }) });
  return withTab(send, async (s) => {
    await s("Emulation.setDeviceMetricsOverride", { width: CARD_W, height: CARD_H, deviceScaleFactor: 1, mobile: false });
    await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "reduce" }] });
    if (systemFonts) {
      await s("Network.enable");
      await s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
    }
    await s("Page.navigate", { url: base + route.slice(1) });
    await waitFor(s, "document.readyState === 'complete'", 20000, "the card frame never finished loading");
    if (!systemFonts) await loadFonts(s, ['700 40px "Fraunces"', '600 26px "IBM Plex Sans"']);
    await waitFor(s, "[...document.images].every((i) => i.complete && i.naturalWidth > 0)", 10000, "the card's visual never decoded");
    await sleep(200);
    await s("Runtime.evaluate", { expression: "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))", awaitPromise: true });
    const { data } = await s("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: CARD_W, height: CARD_H, scale: 1 } });
    return Buffer.from(data, "base64");
  });
}

// ---- Entry point --------------------------------------------------------------------------------

/**
 * Render `jobs` ({ slug, href, out, key, selection, frame:{title,kind,date,siteName} }).
 * `sharedCard` is the file used when Chrome is missing.
 */
export async function renderCards(jobs, { sharedCard, systemFonts = false }) {
  if (!findChrome()) {
    console.log(c.yellow("Chrome not found (set CHROME_PATH): using the shared site card for these pages."));
    for (const j of jobs) {
      fs.mkdirSync(path.dirname(j.out), { recursive: true });
      fs.writeFileSync(j.out, tagPng(fs.readFileSync(sharedCard), "fallback"));
      console.log(c.yellow("~ ") + path.relative(ROOT, j.out) + c.dim(" shared card (fallback)"));
    }
    return { rendered: 0, fallback: jobs.length };
  }
  const routes = new Map();
  const server = await serveStatic(ROOT, routes);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const chrome = await launchChrome();
  let rendered = 0;
  try {
    for (const j of jobs) {
      const sel = j.selection;
      let visual;
      if (sel.css) visual = await captureVisual(chrome.send, base, j, systemFonts);
      else visual = { src: dataUrl(sel.image), bg: "#f6f7f9", tile: sel.tier === "logo" || sel.tier === "glyph" };
      const png = await composeCard(chrome.send, base, routes, j, visual, systemFonts);
      fs.mkdirSync(path.dirname(j.out), { recursive: true });
      fs.writeFileSync(j.out, tagPng(png, j.key));
      rendered++;
      console.log(c.green("✓ ") + path.relative(ROOT, j.out) + c.dim(` ${sel.tier}${sel.css ? ` · ${sel.css}` : ""}`));
    }
  } finally {
    await chrome.close();
    server.close();
  }
  return { rendered, fallback: 0 };
}
