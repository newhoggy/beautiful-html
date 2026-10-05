#!/usr/bin/env node
// Visual regression for beautiful-html — zero dependencies, Node ≥ 22 (global WebSocket).
//
//   node scripts/visual.mjs                compare against baselines (missing ones are created)
//   node scripts/visual.mjs --update       accept the current renders as the new baselines
//   node scripts/visual.mjs --only gallery run cases whose name contains "gallery"
//   node scripts/visual.mjs --system-fonts block Google Fonts (offline / hermetic runs)
//
// Drives a local Chrome/Chromium over the DevTools protocol (set CHROME_PATH to override),
// renders each page in light, dark and phone layouts with reduced motion, waits for
// <html data-bh-ready>, hides [data-vr-mask] regions (live simulations), takes a full-page
// screenshot, and diffs it pixel by pixel.
//
// Determinism: each tab is brought to the front and two animation frames are awaited
// before capture. Without that, a background tab could be captured from a stale frame and
// repeated runs flipped between two renderings. Every web font face the theme uses is
// loaded first. Repeated runs are pixel-identical. Results go to .visual/ (git-ignored, because
// font rendering differs between machines): baseline/, current/, diff/ and report.html.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".visual", process.argv.includes("--system-fonts") ? "system-fonts" : "");
const PAGES = [
  ["index", "index.html"],
  ["gallery", "docs/component-gallery.html"],
  ["token-bucket", "docs/token-bucket-rate-limiting.html"],
  ["design-doc", "docs/edge-rate-limiting-design.html"],
  ["glossary", "docs/glossary.html"],
  ["adr-001", "docs/adr-001-rate-limit-in-each-service.html"],
];
const VARIANTS = [
  { name: "light", width: 1280, height: 900, scheme: "light", mobile: false },
  { name: "dark", width: 1280, height: 900, scheme: "dark", mobile: false },
  { name: "phone", width: 390, height: 844, scheme: "light", mobile: true },
];
const FONT_FACES = [
  '400 16px "IBM Plex Sans"', '500 16px "IBM Plex Sans"', '600 16px "IBM Plex Sans"', '700 16px "IBM Plex Sans"', 'italic 400 16px "IBM Plex Sans"',
  '400 16px "Fraunces"', '600 16px "Fraunces"', '700 16px "Fraunces"', '400 16px "JetBrains Mono"', '600 16px "JetBrains Mono"',
];
// Renders are pixel-identical run to run, so any real difference is a change: a small
// per-channel tolerance absorbs only rounding, and a single changed pixel fails.
const CHANNEL_TOLERANCE = 8;
const MAX_CHANGED_RATIO = 0;

const args = process.argv.slice(2);
const update = args.includes("--update");
const webFonts = !args.includes("--system-fonts");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const c = { red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- PNG (8-bit RGB/RGBA, non-interlaced) -------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let p = 8, width = 0, height = 0, depth = 0, type = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString("ascii", p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG not supported");
    } else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    p += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !channels) throw new Error(`unsupported PNG: depth ${depth}, colour type ${type}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels, out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0, b = prev[i], cc = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - cc, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - cc); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : cc; }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, s = x * channels;
      if (channels >= 3) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; }
      else { out[o] = out[o + 1] = out[o + 2] = cur[s]; }
      out[o + 3] = channels === 4 ? cur[s + 3] : channels === 2 ? cur[s + 1] : 255;
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, data: out };
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const chunk = (kind, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(kind, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Pixel diff: changed pixels in red over a faded copy of the baseline. */
function diffImages(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { sizeChanged: true, changed: Infinity, ratio: 1 };
  const out = Buffer.alloc(a.data.length);
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > CHANNEL_TOLERANCE) { changed++; out[i] = 230; out[i + 1] = 30; out[i + 2] = 40; out[i + 3] = 255; }
    else { const g = 255 - (255 - (a.data[i] + a.data[i + 1] + a.data[i + 2]) / 3) * 0.25; out[i] = out[i + 1] = out[i + 2] = g; out[i + 3] = 255; }
  }
  return { changed, ratio: changed / (a.width * a.height), image: encodePng(a.width, a.height, out) };
}

// ---- Static server & Chrome over the DevTools protocol ----------------------------------------

function serve() {
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (e, data) => {
      if (e) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" }).end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
  for (const p of mac) if (fs.existsSync(p)) return p;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try { return execSync(`command -v ${name}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { /* next */ }
  }
  throw new Error("Chrome not found: set CHROME_PATH");
}

async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-visual-"));
  const proc = spawn(findChrome(), [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
    "--no-default-browser-check", "--hide-scrollbars", "--force-color-profile=srgb", "--disable-lcd-text",
    "--font-render-hinting=none",
    // GPU rasterization varies between Chrome processes (glyph edges antialias differently);
    // software rendering makes repeated runs pixel-identical.
    "--disable-gpu", "--disable-gpu-compositing", "--disable-gpu-rasterization", "--force-device-scale-factor=1",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not start")), 15000);
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on("exit", (code) => reject(new Error(`Chrome exited (${code})`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const close = async () => {
    try { ws.close(); } catch { /* already closed */ }
    // Wait for Chrome to exit before removing its profile (it writes until it's gone).
    const exited = new Promise((resolve) => { if (proc.exitCode !== null) resolve(); else proc.once("exit", resolve); });
    proc.kill();
    await Promise.race([exited, sleep(5000)]);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { send, close };
}

async function capture(send, url, v) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  try {
    await s("Page.enable");
    // A new tab may not be the foreground one; background tabs can be captured from a stale
    // frame (runs flipped between two renderings until this was added).
    await s("Page.bringToFront");
    if (!webFonts) {
      await s("Network.enable");
      await s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
    }
    await s("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: v.mobile });
    await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: v.scheme }, { name: "prefers-reduced-motion", value: "reduce" }] });
    await s("Page.navigate", { url });
    const deadline = Date.now() + 20000;
    for (;;) {
      const r = await s("Runtime.evaluate", { expression: "document.readyState === 'complete' && document.documentElement.hasAttribute('data-bh-ready')", returnByValue: true });
      if (r.result.value) break;
      if (Date.now() > deadline) throw new Error("page never signalled data-bh-ready");
      await sleep(100);
    }
    // Load every face the theme uses up front (fonts load lazily, so a weight first used
    // late could otherwise arrive between two runs' screenshots), then hide live regions.
    // document.fonts.load() only waits for faces that are already registered, and they
    // come from the Google Fonts stylesheet bh.css imports, so first wait (≤ 8s) for every
    // family to be declared. Offline, this times out and the run is consistently fallback.
    if (webFonts) await s("Runtime.evaluate", { expression: `(async () => {
      const families = ${JSON.stringify([...new Set(FONT_FACES.map((f) => f.match(/"([^"]+)"/)[1]))])};
      const t0 = Date.now();
      while (Date.now() - t0 < 8000 && !families.every((fam) => [...document.fonts].some((f) => f.family.replace(/["']/g, "") === fam))) await new Promise((r) => setTimeout(r, 50));
    })()`, awaitPromise: true });
    await s("Runtime.evaluate", { expression: `Promise.all(${JSON.stringify(FONT_FACES)}.map((f) => document.fonts.load(f).catch(() => null)))
      .then(() => document.fonts.ready)
      .then(() => { document.querySelectorAll('[data-vr-mask]').forEach((e) => { e.style.visibility = 'hidden'; }); return true; })`, awaitPromise: true });
    await sleep(400);
    // Two real animation frames: proof the page is rendering, not throttled in the background.
    await s("Runtime.evaluate", { expression: "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))", awaitPromise: true });
    const { cssContentSize } = await s("Page.getLayoutMetrics");
    const height = Math.min(Math.ceil(cssContentSize.height), 30000);
    const { data } = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: v.width, height, scale: 1 } });
    return Buffer.from(data, "base64");
  } finally {
    await send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

// ---- Main ----------------------------------------------------------------------------------------

const cases = PAGES.flatMap(([page, file]) => VARIANTS.map((v) => ({ name: `${page}--${v.name}`, file, v })))
  .filter((k) => !only || k.name.includes(only));
for (const d of ["baseline", "current", "diff"]) fs.mkdirSync(path.join(OUT, d), { recursive: true });

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/`;
const chrome = await launchChrome();
const results = [];
const started = Date.now();
try {
  for (const k of cases) {
    const png = await capture(chrome.send, base + k.file, k.v);
    const cur = path.join(OUT, "current", `${k.name}.png`), basePng = path.join(OUT, "baseline", `${k.name}.png`), diffPng = path.join(OUT, "diff", `${k.name}.png`);
    fs.writeFileSync(cur, png);
    fs.rmSync(diffPng, { force: true });
    if (update || !fs.existsSync(basePng)) {
      fs.writeFileSync(basePng, png);
      results.push({ ...k, status: update ? "updated" : "new" });
      console.log(c.yellow(update ? "↻ " : "+ ") + k.name + c.dim(update ? " baseline updated" : " no baseline yet: saved"));
      continue;
    }
    const d = diffImages(decodePng(fs.readFileSync(basePng)), decodePng(png));
    const fail = d.sizeChanged || d.ratio > MAX_CHANGED_RATIO;
    if (d.image && d.changed) fs.writeFileSync(diffPng, d.image);
    results.push({ ...k, status: fail ? "changed" : "same", changed: d.changed, ratio: d.ratio, sizeChanged: d.sizeChanged });
    const what = d.sizeChanged ? "page size changed" : `${d.changed} px (${(d.ratio * 100).toFixed(3)}%) differ`;
    console.log((fail ? c.red("✗ ") : c.green("✓ ")) + k.name + c.dim(` ${what}`));
  }
} finally {
  await chrome.close();
  server.close();
}

// Report: side-by-side images for every case that changed.
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
const rows = results.map((r) => `<section class="${r.status}"><h2>${esc(r.name)} <small>${esc(r.status)}${r.changed && isFinite(r.changed) ? ` · ${r.changed} px` : ""}</small></h2>${
  r.status === "changed" ? `<div class="row"><figure><img src="baseline/${r.name}.png"><figcaption>baseline</figcaption></figure><figure><img src="current/${r.name}.png"><figcaption>current</figcaption></figure>${fs.existsSync(path.join(OUT, "diff", `${r.name}.png`)) ? `<figure><img src="diff/${r.name}.png"><figcaption>diff</figcaption></figure>` : ""}</div>` : ""}</section>`).join("\n");
fs.writeFileSync(path.join(OUT, "report.html"), `<!doctype html><meta charset="utf-8"><title>Visual regression report</title>
<style>body{font:14px system-ui;margin:24px;background:#f6f7f9;color:#15181e}section{margin:0 0 12px}h2{font-size:15px;margin:0 0 6px}.changed h2{color:#c4262e}.same h2{color:#127a48}small{font-weight:400;color:#596173}.row{display:flex;gap:12px;align-items:flex-start;overflow-x:auto}figure{margin:0;flex:1;min-width:260px}img{width:100%;border:1px solid #dfe3ea}figcaption{color:#596173}</style>
<h1>Visual regression: ${results.filter((r) => r.status === "changed").length} changed of ${results.length}</h1>
${rows}`);

const changed = results.filter((r) => r.status === "changed").length;
console.log(`\n${results.length} cases in ${((Date.now() - started) / 1000).toFixed(1)}s · ${changed ? c.red(changed + " changed") : "0 changed"} · report: ${path.relative(process.cwd(), path.join(OUT, "report.html"))}`);
if (changed) {
  console.log(c.dim("If the changes are intended, accept them with: npm run visual -- --update"));
  process.exit(1);
}
