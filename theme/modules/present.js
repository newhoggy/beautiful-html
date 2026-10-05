/* ==========================================================================
   Presentation mode — any document as slides, from the same HTML.

   Enter with the top bar's Present button or ?present in the URL. Slide 1 is the hero
   (plus anything before the first h2, e.g. the TL;DR); each h2 section is one slide.
   → / Space / PageDown next · ← / PageUp previous · Home / End · f full screen · Esc exit.
   Swipe left/right on touch screens. Keys a component already handled (steppers, tabs,
   charts, sliders) never change the slide. The URL hash follows the slide's h2 id, so
   ?present#section-id links straight to a slide (any id inside a slide works too).
   ========================================================================== */
(function () {
  "use strict";
  const bh = window.bh;
  const doc = document, root = doc.documentElement;
  let slides = [], index = 0, active = false, bar = null, counter = null, progress = null;

  function buildSlides() {
    const article = doc.querySelector(".bh-article");
    const out = [[]];
    for (const child of article.children) {
      if (child.classList.contains("bh-footer")) continue;
      if (child.tagName === "H2" && out[out.length - 1].length) out.push([]);
      out[out.length - 1].push(child);
    }
    return out.filter((s) => s.length);
  }

  function slideOf(id) {
    const target = id && doc.getElementById(id);
    if (!target) return -1;
    return slides.findIndex((s) => s.some((n) => n === target || n.contains(target)));
  }

  /** Figures a slide drives but doesn't contain (a stepper's `for`, a data-ref's figure):
      shown on this slide too, so the walkthrough has its diagram. */
  function borrowed(nodes) {
    const ids = new Set();
    for (const n of nodes) {
      for (const s of [n, ...n.querySelectorAll("bh-stepper[for], [data-ref]")]) {
        if (s.matches && s.matches("bh-stepper[for]")) ids.add(s.getAttribute("for"));
        if (s.dataset && s.dataset.ref) ids.add(s.dataset.ref.split(":")[0].trim());
      }
    }
    return [...ids].map((id) => doc.getElementById(id))
      .filter((f) => f && f.parentElement && f.parentElement.classList.contains("bh-article") && !nodes.includes(f));
  }

  function render() {
    for (const s of slides) for (const n of s) n.style.order = "";
    const extra = borrowed(slides[index]);
    slides.forEach((nodes, i) => nodes.forEach((n, k) => {
      n.classList.toggle("slide-off", i !== index && !extra.includes(n));
      n.classList.toggle("slide-first", i === index && k === 0);
      if (i === index) n.classList.remove("reveal-pending");
    }));
    // Grid order: the slide's heading, then borrowed figures, then the rest of the slide.
    if (extra.length) {
      slides[index].forEach((n, k) => { n.style.order = k === 0 ? "0" : "2"; });
      for (const f of extra) { f.style.order = "1"; f.classList.remove("reveal-pending", "slide-first"); }
    }
    counter.textContent = `${index + 1} / ${slides.length}`;
    progress.style.setProperty("--slide-progress", slides.length > 1 ? index / (slides.length - 1) : 1);
    bar.querySelector("[data-prev]").disabled = index === 0;
    bar.querySelector("[data-next]").disabled = index === slides.length - 1;
    const h2 = slides[index][0].tagName === "H2" ? slides[index][0] : null;
    const hash = h2 && h2.id ? "#" + h2.id : "";
    try { history.replaceState(history.state, "", location.pathname + location.search + hash); } catch (_) { /* sandboxed */ }
    scrollTo({ top: 0, behavior: "instant" });
    // Restart the entry animation on the new slide.
    for (const n of [...slides[index], ...extra]) { n.classList.remove("slide-in"); void n.offsetWidth; n.classList.add("slide-in"); }
  }

  function go(i) {
    const next = Math.max(0, Math.min(slides.length - 1, i));
    if (next === index && active) return;
    index = next;
    render();
  }

  function onKey(e) {
    if (!active || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest("input, textarea, select, [contenteditable], .chart-plot, [role=tab], bh-stepper")) return;
    const pop = doc.getElementById("bh-gloss-pop");
    const k = e.key;
    if (k === "Escape") { if (pop && !pop.hidden) return; e.preventDefault(); exit(); return; }
    if (k === "f" || k === "F") { e.preventDefault(); toggleFullscreen(); return; }
    const delta = { ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 }[k] ?? (k === " " ? (e.shiftKey ? -1 : 1) : 0);
    if (delta) { e.preventDefault(); go(index + delta); }
    else if (k === "Home") { e.preventDefault(); go(0); }
    else if (k === "End") { e.preventDefault(); go(slides.length - 1); }
  }

  let touch = null;
  const onPointerDown = (e) => { if (e.pointerType === "touch") touch = { x: e.clientX, y: e.clientY }; };
  const onPointerUp = (e) => {
    if (!touch || e.pointerType !== "touch") return;
    const dx = e.clientX - touch.x, dy = e.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) go(index + (dx < 0 ? 1 : -1));
  };

  function toggleFullscreen() {
    if (doc.fullscreenElement) doc.exitFullscreen().catch(() => {});
    else root.requestFullscreen && root.requestFullscreen().catch(() => {});
  }

  function enter(startId) {
    if (active) return;
    slides = buildSlides();
    if (!slides.length) return;
    active = true;
    root.classList.add("bh-presenting");
    const { el } = bh;
    counter = el("span", { class: "bh-present-count", "aria-live": "polite" });
    progress = el("div", { class: "bh-present-progress", "aria-hidden": "true" });
    bar = el("div", { class: "bh-present-bar", role: "toolbar", "aria-label": "Presentation" }, [
      el("button", { type: "button", class: "btn ghost", "data-prev": "", "aria-label": "Previous slide", text: "←", onclick: () => go(index - 1) }),
      counter,
      el("button", { type: "button", class: "btn ghost", "data-next": "", "aria-label": "Next slide", text: "→", onclick: () => go(index + 1) }),
      el("button", { type: "button", class: "btn ghost icon", "aria-label": "Full screen", title: "Full screen (f)", onclick: toggleFullscreen,
        html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>' }),
      el("button", { type: "button", class: "btn ghost", text: "Exit", title: "Exit (Esc)", onclick: () => exit() }),
    ]);
    doc.body.append(progress, bar);
    doc.addEventListener("keydown", onKey);
    doc.addEventListener("pointerdown", onPointerDown);
    doc.addEventListener("pointerup", onPointerUp);
    const fromHash = startId || decodeURIComponent(location.hash.slice(1));
    index = Math.max(0, slideOf(fromHash));
    render();
    bar.querySelector("[data-next]").focus({ preventScroll: true });
  }

  function exit() {
    if (!active) return;
    active = false;
    const anchor = slides[index][0];
    root.classList.remove("bh-presenting");
    for (const s of slides) for (const n of s) { n.classList.remove("slide-off", "slide-first", "slide-in"); n.style.order = ""; }
    bar.remove();
    progress.remove();
    doc.removeEventListener("keydown", onKey);
    doc.removeEventListener("pointerdown", onPointerDown);
    doc.removeEventListener("pointerup", onPointerUp);
    if (doc.fullscreenElement) doc.exitFullscreen().catch(() => {});
    const params = new URLSearchParams(location.search);
    params.delete("present");
    const qs = params.toString();
    try { history.replaceState(history.state, "", location.pathname + (qs ? "?" + qs : "") + location.hash); } catch (_) { /* sandboxed */ }
    anchor.scrollIntoView({ block: "start", behavior: "instant" });
  }

  bh.present = { enter, exit, go, get index() { return index; }, get count() { return slides.length; }, get active() { return active; } };
  window.bhModules = Object.assign(window.bhModules || {}, { "present.js": true });
})();
