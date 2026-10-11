// Shared by scripts/visual.mjs and scripts/cards.mjs: find a local Chrome and drive it over the
// DevTools protocol (Node >= 22 for the global WebSocket). No dependencies.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execSync } from "node:child_process";

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Path of a local Chrome/Chromium, or null (CHROME_PATH overrides the search). */
export function findChrome() {
  if (process.env.CHROME_PATH) return fs.existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  const mac = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
  for (const p of mac) if (fs.existsSync(p)) return p;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try { return execSync(`command -v ${name}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { /* next */ }
  }
  return null;
}

export async function launchChrome() {
  const exe = findChrome();
  if (!exe) throw new Error("Chrome not found: set CHROME_PATH");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-chrome-"));
  const proc = spawn(exe, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
    "--no-default-browser-check", "--hide-scrollbars", "--force-color-profile=srgb", "--disable-lcd-text",
    "--font-render-hinting=none",
    // GPU rasterization varies between Chrome processes (glyph edges antialias differently);
    // software rendering makes repeated runs pixel-identical.
    "--disable-gpu", "--disable-gpu-compositing", "--disable-gpu-rasterization", "--force-device-scale-factor=1",
    // Ubuntu 24.04 CI runners restrict the user namespaces Chrome's sandbox needs; it only
    // ever loads this repo's own pages, so CI runs it unsandboxed.
    ...(process.env.CI ? ["--no-sandbox"] : []),
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
    // Best effort: Chrome's helper processes (notably on Linux) can still be writing to the
    // profile after the browser exits. A leftover temp dir must never fail the run.
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
    catch (e) { console.warn(dim(`(could not remove Chrome profile ${profile}: ${e.code})`)); }
  };
  return { send, close };
}

/** Static server for `root` on a free port. `routes` maps a URL path to { type, body } and wins over files. */
export function serveStatic(root, routes = new Map()) {
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (routes.has(pathname)) { const r = routes.get(pathname); res.writeHead(200, { "content-type": r.type }).end(r.body); return; }
    const file = path.join(root, pathname);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (e, data) => {
      if (e) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" }).end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
