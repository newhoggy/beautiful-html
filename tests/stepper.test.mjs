import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, serveStatic, sleep } from "../scripts/chrome.mjs";

// A stepper's diagram must match the narration on screen from the first paint: step 1 is lit
// before anyone presses "Next". It once showed the whole diagram until the reader engaged, so
// "Next" jumped to step 2 and step 1's highlight was only ever seen after "Back".
const skip = !findChrome() || typeof WebSocket === "undefined" ? "needs Chrome and Node >= 22" : false;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Pages whose source has a stepper bound to a diagram that has `data-id` parts. */
const pages = readdirSync(join(root, "docs"))
  .filter((f) => f.endsWith(".html"))
  .filter((f) => /<bh-stepper\b[^>]*\bfor="/.test(readFileSync(join(root, "docs", f), "utf8")));

/** For every enhanced stepper, the bar's offset from the stepper's top edge on each step. */
const barProbe = `(() => [...document.querySelectorAll("bh-stepper.is-ready")].map((s) => {
  const bar = s.querySelector(".bh-stepper-bar");
  const offsets = s.steps.map((_, i) => {
    s.go(i);
    return Math.round((bar.getBoundingClientRect().top - s.getBoundingClientRect().top) * 10) / 10;
  });
  s.go(0);
  return { id: s.id || s.getAttribute("for"), offsets, first: s.firstElementChild === bar };
}))()`;

/** What a page reports for every stepper that has a highlight on its first step. */
const probe = `(() => [...document.querySelectorAll("bh-stepper[for]")].map((s) => {
  const first = s.steps && s.steps[0];
  const ids = first ? (first.getAttribute("highlight") || "").split(/[\\s,]+/).filter(Boolean) : [];
  const lit = s.target ? [...s.target.querySelectorAll("[data-id].is-lit")].map((n) => n.dataset.id) : [];
  return { id: s.getAttribute("for"), index: s.index, ids, lit, ready: s.classList.contains("is-ready") };
}))()`;

test("every stepper starts on step 1 with step 1's parts lit, and its bar stays put", { skip, timeout: 120000 }, async (t) => {
  assert.ok(pages.length > 0, "found pages with a stepper");
  const server = await serveStatic(root);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/docs/`;
  const chrome = await launchChrome();
  t.after(() => chrome.close());

  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  t.after(() => chrome.send("Target.closeTarget", { targetId }).catch(() => {}));
  const s = (method, params) => chrome.send(method, params, sessionId);
  await s("Page.enable");
  await s("Page.bringToFront");
  const evaluate = async (expression) => {
    const r = await s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  for (const page of pages) {
    await t.test(page, async () => {
      await s("Page.navigate", { url: base + page });
      for (let i = 0; i < 100; i++) {
        await sleep(100);
        if (await evaluate("document.readyState === 'complete' && document.documentElement.hasAttribute('data-bh-ready')").catch(() => false)) break;
      }
      // The steps differ in height. The bar must not move with them, or "Next" is awkward to click repeatedly.
      for (const p of await evaluate(barProbe)) {
        assert.ok(p.first, `${p.id}: the bar comes before the steps`);
        assert.ok(p.offsets.every((o) => o === p.offsets[0]), `${p.id}: the bar stays put across steps (offsets: ${p.offsets})`);
      }
      const steppers = await evaluate(probe);
      for (const p of steppers) {
        if (!p.ready) continue; // a stepper in a hidden tab or collapsed section may not have started
        assert.equal(p.index, 0, `${p.id} starts on step 1`);
        if (p.ids.length) {
          // A part is several nodes (a shape and its text), so compare the ids, not the nodes.
          const lit = [...new Set(p.lit)];
          assert.ok(lit.length > 0, `${p.id}: step 1's parts are lit before "Next" is pressed`);
          assert.ok(lit.every((id) => p.ids.includes(id)), `${p.id}: only step 1's parts are lit (lit: ${lit}, step 1: ${p.ids})`);
        }
      }
    });
  }
});
