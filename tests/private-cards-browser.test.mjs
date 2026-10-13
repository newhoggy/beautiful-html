import assert from "node:assert/strict";
import { test } from "node:test";
import { findChrome, launchChrome, serveStatic, sleep } from "../scripts/chrome.mjs";
import { site } from "./support/private-site.mjs";

// The home page, with real sealed fixture pages, in a real Chrome. Keys are throwaway: the fake
// `op` in tests/support makes them, and nothing here touches a vault. Skipped without Chrome
// (and without the global WebSocket, Node >= 22, that scripts/chrome.mjs drives it with).
const skip = !findChrome() || typeof WebSocket === "undefined" ? "needs Chrome and Node >= 22" : false;

/** A tab: navigate, evaluate, and see what the page did. Every tab has its own sessionStorage. */
async function openTab(chrome, { width = 1100, height = 900, mobile = false, noDecompression = false } = {}) {
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method, params) => chrome.send(method, params, sessionId);
  await s("Page.enable");
  await s("Page.bringToFront");
  await s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
  await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await s("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__errors = [];
    addEventListener("error", (e) => window.__errors.push(String(e.message)));
    addEventListener("unhandledrejection", (e) => window.__errors.push(String(e.reason)));
    ${noDecompression ? "delete window.DecompressionStream;" : ""}` });
  const evaluate = async (expression) => {
    const r = await s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const ready = async () => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate("document.readyState === 'complete' && document.documentElement.hasAttribute('data-bh-ready')").catch(() => false)) return;
      await sleep(100);
    }
    throw new Error("the page never became ready");
  };
  const goto = async (url) => { await s("Page.navigate", { url }); await sleep(150); await ready(); };
  return { evaluate, goto, ready, close: () => chrome.send("Target.closeTarget", { targetId }).catch(() => {}) };
}

const privateCards = "[...document.querySelectorAll('#doc-list [data-private-slug]')].map((li) => li.dataset.privateSlug)";
const titles = "[...document.querySelectorAll('#doc-list > li')].filter((li) => !li.hidden && getComputedStyle(li).display !== 'none').map((li) => li.querySelector('h3').textContent)";

test("the home page shows the private cards a key opens", { skip, timeout: 240000 }, async (t) => {
  const s = site(t);
  s.newPrivate("alpha-plan", "Alpha plan", "kin-circle");
  s.newPrivate("beta-plan", "Beta plan", "kin-circle");
  s.newPrivate("solo-note", "Solo note");
  s.setMeta("alpha-plan", "bh:date", "2026-10-12");
  s.setMeta("beta-plan", "bh:date", "2026-09-01");
  s.setMeta("solo-note", "bh:date", "2026-10-01");
  assert.equal(s.run(["seal"]).code, 0);
  assert.equal(s.run(["index"]).code, 0);
  const group = s.field("beautiful-html private group: kin-circle", "password");
  const solo = s.field("beautiful-html private page: solo-note", "password");
  const wrong = "A".repeat(43);

  const server = await serveStatic(s.root);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const chrome = await launchChrome();
  t.after(() => chrome.close());
  const tab = async (opts) => { const x = await openTab(chrome, opts); t.after(() => x.close()); return x; };

  await t.test("no fragment: the public home page, and no request for the cards", async () => {
    const p = await tab();
    await p.goto(base + "index.html");
    assert.deepEqual(await p.evaluate(privateCards), []);
    assert.equal(await p.evaluate("performance.getEntriesByType('resource').some((r) => /private-cards/.test(r.name))"), false);
    assert.equal(await p.evaluate("sessionStorage.getItem('bh-index-keys')"), null);
    assert.equal(await p.evaluate("!!document.querySelector('.card-private')"), false);
  });

  await t.test("a group key: the group's cards, in date order, filterable, key stripped, kept for the tab", async () => {
    const p = await tab();
    await p.goto(`${base}index.html#k=${group}`);
    assert.deepEqual(await p.evaluate(privateCards), ["alpha-plan", "beta-plan"]);
    assert.equal(await p.evaluate("location.hash"), "");
    assert.equal(await p.evaluate("document.documentElement.hasAttribute('data-bh-ready')"), true);
    const order = await p.evaluate("[...document.querySelectorAll('#doc-list > li:not([data-example])')].map((li) => li.querySelector('time')?.textContent || '')");
    assert.deepEqual(order, [...order].sort().reverse(), "cards are newest first");
    assert.equal(await p.evaluate("document.querySelector('[data-private-slug=alpha-plan] .card-private').textContent.trim()"), "Private");
    assert.equal(await p.evaluate("document.querySelector('[data-private-slug=alpha-plan] a').getAttribute('href')"), `docs/alpha-plan.html#k=${group}`);
    assert.equal(await p.evaluate("getComputedStyle(document.querySelector('.card-private')).display !== 'none'"), true);
    // The filter covers them: the search box, and the Type chips (an "Explainer" chip exists either way).
    await p.evaluate("(() => { const i = document.querySelector('.bh-filter input'); i.value = 'alpha'; i.dispatchEvent(new Event('input')); })()");
    assert.deepEqual(await p.evaluate(titles), ["Alpha plan"]);
    // The tab remembers the key: a reload still shows the cards.
    await p.goto(`${base}index.html`);
    assert.deepEqual(await p.evaluate(privateCards), ["alpha-plan", "beta-plan"]);
    assert.deepEqual(JSON.parse(await p.evaluate("sessionStorage.getItem('bh-index-keys')")), [group]);
    // A new tab does not have it.
    const other = await tab();
    await other.goto(`${base}index.html`);
    assert.deepEqual(await other.evaluate(privateCards), []);
    assert.deepEqual(await p.evaluate("window.__errors"), []);
  });

  await t.test("two keys show two groups, and a wrong key says so", async () => {
    const p = await tab();
    await p.goto(`${base}index.html#k=${group}&k=${solo}`);
    assert.deepEqual(await p.evaluate(privateCards), ["alpha-plan", "solo-note", "beta-plan"]);
    const q = await tab();
    await q.goto(`${base}index.html#k=${wrong}`);
    assert.deepEqual(await q.evaluate(privateCards), []);
    assert.equal(await q.evaluate("document.querySelector('.bh-toast')?.textContent"), "No private pages for that key");
    assert.equal(await q.evaluate("sessionStorage.getItem('bh-index-keys')"), "[]");
    // Another fragment part survives the key being removed.
    const r = await tab();
    await r.goto(`${base}index.html#k=${group}&posts`);
    assert.equal(await r.evaluate("location.hash"), "#posts");
  });

  await t.test("a key pasted into the open home page is picked up without a reload", async () => {
    const p = await tab();
    await p.goto(`${base}index.html`);
    assert.deepEqual(await p.evaluate(privateCards), []);
    await p.evaluate(`location.hash = "#k=${group}"`);
    for (let i = 0; i < 50 && !(await p.evaluate(privateCards)).length; i++) await sleep(100);
    assert.deepEqual(await p.evaluate(privateCards), ["alpha-plan", "beta-plan"]);
    assert.equal(await p.evaluate("location.hash"), "");
  });

  await t.test("a card opens its sealed page, and a page opened by its own link brings its card home", async () => {
    const p = await tab();
    await p.goto(`${base}index.html#k=${group}`);
    await p.goto(await p.evaluate("new URL(document.querySelector('[data-private-slug=alpha-plan] a').getAttribute('href'), location.href).href"));
    assert.equal(await p.evaluate("document.querySelector('h1')?.textContent"), "Alpha plan");

    const q = await tab();
    await q.goto(`${base}docs/solo-note.html#k=${solo}`);
    assert.equal(await q.evaluate("document.querySelector('h1')?.textContent"), "Solo note");
    await q.goto(`${base}index.html`);
    assert.deepEqual(await q.evaluate(privateCards), ["solo-note"]);
  });

  await t.test("without DecompressionStream the public list stays, with a toast and no exception", async () => {
    const p = await tab({ noDecompression: true });
    await p.goto(`${base}index.html#k=${group}`);
    assert.deepEqual(await p.evaluate(privateCards), []);
    assert.match(await p.evaluate("document.querySelector('.bh-toast')?.textContent"), /can't be shown/);
    assert.deepEqual(await p.evaluate("window.__errors"), []);
  });

  await t.test("a phone width: no horizontal scroll, and the lock label is readable", async () => {
    const p = await tab({ width: 375, height: 800, mobile: true });
    await p.goto(`${base}index.html#k=${group}&k=${solo}`);
    assert.equal(await p.evaluate("innerWidth"), 375);
    assert.equal(await p.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    const box = await p.evaluate("(() => { const r = document.querySelector('.card-private').getBoundingClientRect(); return { w: r.width, h: r.height, right: r.right }; })()");
    assert.ok(box.w > 30 && box.h > 8 && box.right <= 375, JSON.stringify(box));
  });
});
