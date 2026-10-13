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
  let ws, closing;
  const pending = new Map();
  // "close" includes drained stdio, unlike "exit". Register before startup can fail.
  const closed = new Promise((resolve) => proc.once("close", resolve));
  const close = () => closing ??= (async () => {
    for (const { reject } of pending.values()) reject(new Error("Chrome closed"));
    pending.clear();
    try { ws?.close(); } catch { /* already closed */ }
    // Cancel the deadline when Chrome closes normally: a losing sleep in Promise.race
    // otherwise keeps Node alive for five seconds after the renderer's final report.
    const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
    try {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
      await closed;
    } finally {
      clearTimeout(timer);
    }
    // Chrome's helpers can briefly keep writing even after the browser closes.
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
    catch (e) { console.warn(dim(`(could not remove Chrome profile ${profile}: ${e.code})`)); }
  })();
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = "";
      const finish = (error, url) => {
        clearTimeout(timer);
        proc.stderr.off("data", onData);
        proc.off("exit", onExit);
        proc.off("error", onError);
        error ? reject(error) : resolve(url);
      };
      const onData = (d) => {
        buf += d;
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) finish(null, m[1]);
      };
      const onExit = (code) => finish(new Error(`Chrome exited (${code})`));
      const onError = (error) => finish(error);
      const timer = setTimeout(() => finish(new Error("Chrome did not start")), 15000);
      proc.stderr.on("data", onData);
      proc.once("exit", onExit);
      proc.once("error", onError);
    });
    // Drain Chrome diagnostics after startup without retaining the startup buffer.
    proc.stderr.resume();
    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        ws.onopen = ws.onerror = ws.onclose = null;
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => finish(new Error("Chrome WebSocket did not open")), 15000);
      ws.onopen = () => finish();
      ws.onerror = () => finish(new Error("Chrome WebSocket failed"));
      ws.onclose = () => finish(new Error("Chrome WebSocket closed during startup"));
    });
  } catch (error) {
    await close();
    throw error;
  }
  let nextId = 0;
  ws.onclose = () => {
    for (const { reject } of pending.values()) reject(new Error("Chrome WebSocket closed"));
    pending.clear();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (closing || ws.readyState !== WebSocket.OPEN) { reject(new Error("Chrome closed")); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    try { ws.send(JSON.stringify({ id, method, params, sessionId })); }
    catch (error) { pending.delete(id); reject(error); }
  });
  return { send, close };
}

/** Static server for `root` on a free port. `routes` maps a URL path to { type, body } and wins over files.
 * Symlinked roots and in-root targets are supported; targets outside the canonical root return 403.
 * Unresolvable paths return 404. Directories do not automatically select index.html.
 */
export function serveStatic(root, routes = new Map()) {
  root = fs.realpathSync(root);
  const contains = (file) => file === root || file.startsWith(root + path.sep);
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400).end(); return; }
    if (routes.has(pathname)) { const r = routes.get(pathname); res.writeHead(200, { "content-type": r.type }).end(r.body); return; }
    const file = path.join(root, pathname);
    if (!contains(file)) { res.writeHead(403).end(); return; }
    let target;
    try { target = fs.realpathSync(file); }
    catch { res.writeHead(404).end(); return; }
    if (!contains(target)) { res.writeHead(403).end(); return; }
    fs.readFile(target, (e, data) => {
      if (e) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" }).end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
