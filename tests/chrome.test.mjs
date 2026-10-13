import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromeModule = new URL("../scripts/chrome.mjs", import.meta.url).href;

// The child must exit naturally. Killing a timed-out child is test cleanup, never success.
function run(args, env, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", timedOut = false, reportAt;
    const started = Date.now();
    let timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    let completed = false;
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => {
      output += data;
      // Allow slow process startup under CI load, but bound exit after work completes.
      if (!completed && /CAUGHT|CLOSED| · report:|Chrome exited \(7\)|Chrome WebSocket failed/.test(output)) {
        completed = true;
        clearTimeout(timer);
        timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 2000);
      }
      if (reportAt === undefined && output.includes(" · report:")) reportAt = Date.now();
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Child did not exit within ${timeout}ms:\n${output}`));
      else resolve({ code, signal, output, elapsed: Date.now() - started, reportDelay: reportAt === undefined ? undefined : Date.now() - reportAt });
    });
  });
}

function fixture(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bh-chrome-test-"));
  t.after(() => {
    // Also stop fixture children if the code under test regresses and times out.
    for (const name of ["browser.pid", "helper.pid"]) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) {
        try { process.kill(Number(fs.readFileSync(file, "utf8")), "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const exe = path.join(dir, "chrome");
  // Use the exact Node binary, including when running the suite on Node 22.
  fs.writeFileSync(exe, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return { CHROME_PATH: exe, PROFILE_RECORD: path.join(dir, "profile.txt") };
}

function rendererFixture(env, renderer = "visual.mjs") {
  const scripts = path.join(path.dirname(env.CHROME_PATH), "repo", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of [renderer, "chrome.mjs"]) fs.copyFileSync(path.join(root, "scripts", file), path.join(scripts, file));
  return path.join(scripts, renderer);
}

const profileRecorder = `const fs = require('node:fs');
const profile = process.argv.find(a => a.startsWith('--user-data-dir=')).split('=')[1];
fs.writeFileSync(process.env.PROFILE_RECORD, profile);
fs.writeFileSync(require('node:path').join(require('node:path').dirname(process.env.PROFILE_RECORD), 'browser.pid'), String(process.pid));`;

function assertProfileRemoved(env) {
  const profile = fs.readFileSync(env.PROFILE_RECORD, "utf8");
  assert.equal(fs.existsSync(profile), false, `profile left behind: ${profile}`);
}

test("Chrome cleanup cancels its deadline and repeated close is safe", async (t) => {
  const env = fixture(t, `${profileRecorder}
console.error('DevTools listening on ws://fake');
setInterval(() => {}, 1000);`);
  const result = await run(["--input-type=module", "-e", `
    globalThis.WebSocket = class {
      static OPEN = 1;
      readyState = 1;
      constructor() { setTimeout(() => this.onopen(), 0); }
      close() {}
    };
    const { launchChrome } = await import(${JSON.stringify(chromeModule)});
    const chrome = await launchChrome();
    await Promise.all([chrome.close(), chrome.close()]);
    await chrome.close();
    await chrome.send('Page.enable').then(() => { throw new Error('send should reject'); }, () => {});
    console.log('CLOSED');
  `], env);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /CLOSED/);
  assertProfileRemoved(env);
});

for (const mode of ["exit", "websocket"]) {
  test(`Chrome ${mode} startup failure releases its process, timer and profile`, async (t) => {
    const env = fixture(t, `${profileRecorder}\n${mode === "exit" ? "process.exit(7);" : "console.error('DevTools listening on ws://fake'); setInterval(() => {}, 1000);"}`);
    const result = await run(["--input-type=module", "-e", `
      globalThis.WebSocket = class {
        constructor() { setTimeout(() => this.onerror(), 0); }
        close() {}
      };
      const { launchChrome } = await import(${JSON.stringify(chromeModule)});
      await launchChrome().then(() => { throw new Error('expected failure'); }, e => console.log(e.message));
    `], env);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, mode === "exit" ? /Chrome exited \(7\)/ : /Chrome WebSocket failed/);
    assertProfileRemoved(env);
  });
}

test("renderer startup failure closes the static server and exits nonzero", async (t) => {
  const env = fixture(t, `${profileRecorder}\nprocess.exit(7);`);
  const result = await run([rendererFixture(env), "--system-fonts", "--only", "no-cases"], env);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Chrome exited \(7\)/);
  assertProfileRemoved(env);
});

test("rendering errors report failures and exit nonzero without lingering resources", async (t) => {
  const env = fixture(t, `${profileRecorder}
console.error('DevTools listening on ws://fake');
setInterval(() => {}, 1000);`);
  const preload = path.join(path.dirname(env.CHROME_PATH), "websocket.mjs");
  fs.writeFileSync(preload, `globalThis.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    constructor() { setTimeout(() => this.onopen(), 0); }
    close() {}
    send(data) {
      const { id } = JSON.parse(data);
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id, error: { message: 'injected rendering failure' } }) }));
    }
  };`);
  const result = await run(["--import", preload, rendererFixture(env), "--system-fonts", "--only", "index--light"], env);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /injected rendering failure/);
  assert.match(result.output, /1 cases .*1 changed/);
  assert.ok(result.reportDelay < 2000, `report-to-exit took ${result.reportDelay}ms`);
  assertProfileRemoved(env);
});


test("shutdown deadline handles a helper retaining stderr after the browser exits", async (t) => {
  const env = fixture(t, `${profileRecorder}
const { spawn } = require('node:child_process');
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 2] });
fs.writeFileSync(require('node:path').join(require('node:path').dirname(process.env.PROFILE_RECORD), 'helper.pid'), String(helper.pid));
helper.unref();
console.error('DevTools listening on ws://fake');
setInterval(() => {}, 1000);`);
  const result = await run(["--input-type=module", "-e", `
    globalThis.WebSocket = class {
      static OPEN = 1;
      readyState = 1;
      constructor() { setTimeout(() => this.onopen(), 0); }
      close() {}
    };
    const { launchChrome } = await import(${JSON.stringify(chromeModule)});
    const chrome = await launchChrome();
    await chrome.close();
    console.log('CLOSED');
  `], env, 15000);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /CLOSED/);
  assertProfileRemoved(env);
});


test("cards startup failure closes the static server and caller exits naturally nonzero", async (t) => {
  const env = fixture(t, `${profileRecorder}\nprocess.exit(7);`);
  const cards = rendererFixture(env, "cards.mjs");
  const result = await run(["--input-type=module", "-e", `
    const { renderCards } = await import(${JSON.stringify(pathToFileURL(cards).href)});
    try { await renderCards([{}], { sharedCard: '' }); }
    catch (error) { console.log(error.message); process.exitCode = 1; }
  `], env);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Chrome exited \(7\)/);
  assertProfileRemoved(env);
});

// Real process/profile cleanup runs first; only its final return is made to reject.
function injectCardsCleanupFailure(cards) {
  const file = path.join(path.dirname(cards), "chrome.mjs");
  let source = fs.readFileSync(file, "utf8");
  for (const name of ["launchChrome", "serveStatic"]) {
    const original = name === "launchChrome" ? `export async function ${name}(` : `export function ${name}(`;
    assert.ok(source.includes(original), `missing injection target: ${name}`);
    source = source.replace(original, original.replace(name, `${name}Original`));
  }
  source += `
export async function launchChrome() {
  const chrome = await launchChromeOriginal();
  return { ...chrome, async close() { await chrome.close(); throw new Error('injected Chrome cleanup failure'); } };
}
export async function serveStatic(...args) {
  const server = await serveStaticOriginal(...args);
  const close = server.close.bind(server);
  server.close = (callback) => close((error) => setTimeout(() => {
    console.log('SERVER_CLOSED', server.listening);
    callback(error);
  }, 100));
  return server;
}
`;
  fs.writeFileSync(file, source);
}

const failingWebSocket = `globalThis.WebSocket = class {
  static OPEN = 1;
  readyState = 1;
  constructor() { setTimeout(() => this.onopen(), 0); }
  close() {}
  send(data) {
    const { id } = JSON.parse(data);
    queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id, error: { message: 'injected card rendering failure' } }) }));
  }
};`;

test("cards awaits server closure when Chrome cleanup throws and preserves the failure", async (t) => {
  const env = fixture(t, `${profileRecorder}\nconsole.error('DevTools listening on ws://fake'); setInterval(() => {}, 1000);`);
  const cards = rendererFixture(env, "cards.mjs");
  injectCardsCleanupFailure(cards);
  const result = await run(["--input-type=module", "-e", `
    ${failingWebSocket}
    const { renderCards } = await import(${JSON.stringify(pathToFileURL(cards).href)});
    try { await renderCards([], { sharedCard: '' }); }
    catch (error) { console.log('CAUGHT', error.message); process.exitCode = 1; }
  `], env);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /SERVER_CLOSED false[\s\S]*CAUGHT injected Chrome cleanup failure/);
  assertProfileRemoved(env);
});

test("cards reports every page failure and releases resources across repeated runs", async (t) => {
  const env = fixture(t, `${profileRecorder}\nconsole.error('DevTools listening on ws://fake'); setInterval(() => {}, 1000);`);
  const cards = rendererFixture(env, "cards.mjs");
  const result = await run(["--input-type=module", "-e", `
    ${failingWebSocket}
    const assert = (await import('node:assert/strict')).default;
    const { renderCards } = await import(${JSON.stringify(pathToFileURL(cards).href)});
    const jobs = ['one', 'two'].map(slug => ({ slug, href: slug + '.html', out: ${JSON.stringify(path.dirname(env.CHROME_PATH))} + '/' + slug + '.png', selection: { css: 'figure', index: 0 } }));
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await renderCards(jobs, { sharedCard: '' }), { rendered: 0, fallback: 0, failed: ['one.html', 'two.html'] });
    }
    console.log('CLOSED');
  `], env);
  assert.equal(result.code, 0, result.output);
  assert.equal((result.output.match(/injected card rendering failure/g) || []).length, 4, result.output);
  for (const slug of ["one", "two"]) assert.equal(fs.existsSync(path.join(path.dirname(env.CHROME_PATH), `${slug}.png`)), false);
  assertProfileRemoved(env);
});

test("cards without Chrome retains shared-card fallback across repeated runs", async (t) => {
  const env = fixture(t, "process.exit(7);");
  const cards = rendererFixture(env, "cards.mjs");
  env.CHROME_PATH += "-missing";
  const out = path.join(path.dirname(cards), "fallback.png");
  const sharedCard = path.join(root, "theme", "logo", "og.png");
  const result = await run(["--input-type=module", "-e", `
    const assert = (await import('node:assert/strict')).default;
    const fs = (await import('node:fs')).default;
    const { renderCards, tagPng } = await import(${JSON.stringify(pathToFileURL(cards).href)});
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await renderCards([{ out: ${JSON.stringify(out)} }], { sharedCard: ${JSON.stringify(sharedCard)} }), { rendered: 0, fallback: 1, failed: [] });
      assert.deepEqual(fs.readFileSync(${JSON.stringify(out)}), tagPng(fs.readFileSync(${JSON.stringify(sharedCard)}), 'fallback'));
    }
    console.log('CLOSED');
  `], env);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /shared card \(fallback\)/);
});
