/* ==========================================================================
   beautiful-html runtime — progressive enhancement for every page.
   Classic script (not a module) so pages work from file:// with no server.

   Page chrome:   top bar, theme toggle, reading progress, skip link, TOC +
                  scroll-spy, heading anchors & eyebrows, auto meta, sidenotes,
                  code-block copy buttons, scroll reveal, SVG arrow markers.
   Diagram refs:  <span data-ref="figure-id:node-id …"> in prose lights those diagram parts.
   Deep links:    every section heading, figure, glossary entry and [data-linkable]
                  block offers "copy link"; arriving at #id reveals and highlights it.
   Lazy libs:     Prism (if code has language-*), Mermaid (if pre.mermaid).
   Components:    <bh-tabs>, <bh-stepper>/<bh-step>, <bh-playground>, <bh-filter>.
   Modules:       larger components load on demand from theme/modules/ (bundle inlines them).
   Ready signal:  <html data-bh-ready> once glossary, modules, Prism, Mermaid and fonts settle.
   Glossary:      auto-marks glossary terms in prose; hover/focus/tap shows a
                  stationary popup the pointer can move into (select, copy, links).

   Everything degrades to readable static HTML when JavaScript is off.
   ========================================================================== */
(function () {
  "use strict";

  const doc = document;
  const root = doc.documentElement;
  // Site root, derived from this script's URL (theme/bh.js → ../). Null when inlined by `bundle`.
  const SCRIPT_SRC = doc.currentScript && doc.currentScript.src;
  const SITE_ROOT = SCRIPT_SRC ? new URL("../", SCRIPT_SRC) : null;
  const THEME_KEY = "bh-theme";
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  root.classList.add("js");

  // ---- Helpers -----------------------------------------------------------

  function whenReady(fn) {
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", fn, { once: true });
    else fn();
  }

  function el(tag, attrs, children) {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of [].concat(children || [])) if (c) node.append(c);
    return node;
  }

  function slugify(text) {
    return text.toLowerCase().trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "section";
  }

  function meta(name) {
    const m = doc.querySelector(`meta[name="${name}"]`);
    return m ? m.content.trim() : "";
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = el("script", { src, async: true });
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load " + src));
      doc.head.append(s);
    });
  }

  function storage(fn) { try { return fn(); } catch (_) { return null; } }

  /** Copy text to the clipboard; resolves true on success. Falls back to execCommand. */
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (_) {
      const ta = el("textarea", { style: "position:fixed;opacity:0", "aria-hidden": "true" });
      ta.value = text;
      doc.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = doc.execCommand("copy"); } catch (_) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  let toastEl = null, toastTimer = 0;
  /** Brief status message at the bottom of the viewport (announced to screen readers). */
  function toast(message, ms = 1800) {
    if (!toastEl) {
      toastEl = el("div", { class: "bh-toast", role: "status", "aria-live": "polite" });
      doc.body.append(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add("is-shown");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("is-shown"), ms);
  }

  // ---- Theme -----------------------------------------------------------------

  const THEMES = ["auto", "light", "dark"];
  const ICONS = {
    auto: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>',
    light: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  };

  function currentTheme() { return root.dataset.theme || "auto"; }

  function applyTheme(theme) {
    if (theme === "auto") delete root.dataset.theme;
    else root.dataset.theme = theme;
    storage(() => theme === "auto" ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, theme));
    doc.dispatchEvent(new CustomEvent("bh-themechange", { detail: { theme } }));
  }

  // Apply stored theme immediately (templates also inline this in <head> to avoid a flash).
  const stored = storage(() => localStorage.getItem(THEME_KEY));
  if (stored && stored !== "auto") root.dataset.theme = stored;
  // ?theme=dark|light|auto previews a theme for this view only (not saved): handy for
  // sharing a link in a given theme and for screenshot tests.
  const themeParam = new URLSearchParams(location.search).get("theme");
  if (themeParam === "light" || themeParam === "dark") root.dataset.theme = themeParam;
  else if (themeParam === "auto") delete root.dataset.theme;

  /** Async work the page waits on before it is "ready" (see data-bh-ready). */
  const pending = [];
  const settle = (p) => { pending.push(Promise.resolve(p).catch(() => {})); return p; };

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (currentTheme() === "auto") doc.dispatchEvent(new CustomEvent("bh-themechange", { detail: { theme: "auto" } }));
  });

  // ---- Chrome: skip link, top bar, progress ---------------------------------------

  function buildChrome() {
    if (doc.body.dataset.chrome === "none") return;
    const main = doc.querySelector("main");
    if (main && !main.id) main.id = "main";
    doc.body.prepend(el("a", { class: "skip-link", href: "#" + (main ? main.id : "main"), text: "Skip to content" }));

    const home = doc.body.dataset.home;
    const site = doc.body.dataset.site || "beautiful-html";
    const brandChildren = [el("span", { class: "bh-brand-mark", "aria-hidden": "true" }), el("span", { text: site })];
    const brand = home && !root.hasAttribute("data-bundled")
      ? el("a", { class: "bh-brand", href: home, title: "Back to index" }, brandChildren)
      : el("span", { class: "bh-brand" }, brandChildren);

    const title = el("span", { class: "bh-topbar-title", "aria-hidden": "true" });
    const h1 = doc.querySelector("h1");
    title.textContent = h1 ? h1.textContent.trim() : doc.title;

    const themeBtn = el("button", { class: "btn ghost icon", type: "button" });
    const syncThemeBtn = () => {
      const t = currentTheme();
      themeBtn.innerHTML = ICONS[t];
      themeBtn.setAttribute("aria-label", `Theme: ${t}. Click to change.`);
      themeBtn.title = `Theme: ${t}`;
    };
    themeBtn.addEventListener("click", () => {
      applyTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length]);
      syncThemeBtn();
    });
    syncThemeBtn();

    const progress = el("div", { class: "bh-progress", "aria-hidden": "true" });
    const bar = el("header", { class: "bh-topbar" }, [brand, title, el("div", { class: "bh-topbar-actions" }, [themeBtn]), progress]);
    doc.querySelector(".skip-link").after(bar);

    // Show the page title in the bar once the h1 scrolls away.
    if (h1 && "IntersectionObserver" in window) {
      new IntersectionObserver(([e]) => bar.classList.toggle("show-title", !e.isIntersecting && e.boundingClientRect.top < 0))
        .observe(h1);
    }

    // JS fallback for reading progress where scroll-driven animations are unsupported.
    if (!CSS.supports("animation-timeline: scroll()")) {
      let ticking = false;
      const update = () => {
        const max = root.scrollHeight - innerHeight;
        progress.style.setProperty("--progress", max > 0 ? Math.min(1, scrollY / max) : 0);
        ticking = false;
      };
      addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
      update();
    }
  }

  // ---- Auto meta (from <meta name="bh:*">) into <dl class="bh-meta" data-auto> ------

  function buildMeta() {
    const dl = doc.querySelector("dl.bh-meta[data-auto]");
    if (!dl) return;
    const article = doc.querySelector(".bh-article");
    const words = article ? article.textContent.trim().split(/\s+/).length : 0;
    const rows = [
      ["Status", meta("bh:status") && el("span", { class: `badge ${meta("bh:status").toLowerCase()}`, text: meta("bh:status") })],
      ["Updated", meta("bh:date") && el("time", { datetime: meta("bh:date"), text: meta("bh:date") })],
      ["Authors", meta("bh:authors")],
      ["Reading time", words > 150 && `${Math.max(1, Math.round(words / 230))} min`],
      ["Tags", meta("bh:tags")],
    ];
    for (const [k, v] of rows) {
      if (!v) continue;
      dl.append(el("div", {}, [el("dt", { text: k }), el("dd", {}, [v])]));
    }
  }

  // ---- Headings: ids, anchors, eyebrows; TOC + scroll-spy ---------------------------

  function buildHeadings() {
    const article = doc.querySelector(".bh-article");
    if (!article) return [];
    const used = new Set([...doc.querySelectorAll("[id]")].map((n) => n.id));
    const all = [...article.querySelectorAll(":scope > h2, :scope > h3, :scope > h4")];
    const heads = all.filter((h) => h.tagName !== "H4" && !h.classList.contains("no-toc"));
    let n = 0;
    for (const h of all) {
      if (!h.id) {
        let id = slugify(h.textContent), i = 2;
        while (used.has(id)) id = `${slugify(h.textContent)}-${i++}`;
        h.id = id;
        used.add(id);
      }
      if (h.tagName === "H2") {
        n += 1;
        if (!h.dataset.eyebrow && doc.body.dataset.eyebrows !== "off") h.dataset.eyebrow = `§${n}`;
      }
      h.append(linkAnchor(h.id, "section"));
    }
    return heads;
  }

  // ---- Deep links: copy a link to any section, figure or glossary entry ---------------------

  const LINK_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

  function linkLabel(target) {
    if (target.tagName === "BH-STEP" && target.dataset.n) {
      const stepper = target.closest("bh-stepper");
      const fig = stepper && stepper.target;
      return `Step ${target.dataset.n} of ${target.dataset.total}${fig ? ` (${linkLabel(fig)})` : ""}`;
    }
    if (target.tagName === "FIGURE" && target.querySelector(":scope > figcaption")) {
      const figs = [...doc.querySelectorAll(".bh-article figure")].filter((f) => f.querySelector(":scope > figcaption"));
      return `Figure ${figs.indexOf(target) + 1}`;
    }
    const clone = target.cloneNode(true);
    clone.querySelectorAll(".heading-anchor, .bh-link-btn, figcaption").forEach((x) => x.remove());
    const text = clone.textContent.replace(/\s+/g, " ").trim();
    return text.length > 60 ? text.slice(0, 57) + "…" : text || "this block";
  }

  /** Copy the page URL with #id, put it in the address bar without jumping, and confirm. */
  async function copyLink(id) {
    const hash = "#" + encodeURIComponent(id);
    const url = location.href.split("#")[0] + hash;
    try { history.replaceState(history.state, "", hash); } catch (_) { /* sandboxed */ }
    const target = doc.getElementById(id);
    const ok = await copyText(url);
    toast(ok ? `Link copied: ${target ? linkLabel(target) : id}` : url, ok ? 1800 : 6000);
  }

  /** "#" anchor for headings and glossary entries: a real link, but click copies it. */
  function linkAnchor(id, what) {
    const a = el("a", { class: "heading-anchor", href: "#" + id, title: `Copy link to this ${what}`, "aria-label": `Copy link to this ${what}`, text: "#" });
    a.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // let modified clicks open/new-tab
      e.preventDefault();
      copyLink(id);
    });
    return a;
  }

  /** Link buttons on figures and [data-linkable] blocks; anchors on glossary entries. */
  function buildLinkTargets() {
    doc.querySelectorAll(".bh-article figure[id], .bh-article [data-linkable][id]").forEach((t) => {
      if (t.querySelector(":scope > .bh-link-btn")) return;
      const what = t.tagName === "FIGURE" ? "figure" : "block";
      const btn = el("button", { class: "bh-link-btn", type: "button", title: `Copy link to this ${what}`, "aria-label": `Copy link to this ${what}`, html: LINK_ICON });
      btn.addEventListener("click", () => copyLink(t.id));
      t.append(btn);
    });
    doc.querySelectorAll("dl.glossary > dt[id]").forEach((dt) => {
      if (!dt.querySelector(".heading-anchor")) dt.append(linkAnchor(dt.id, "entry"));
    });
  }

  /** Bring the #target into view: open collapsed details, select its tab or step, highlight it. */
  function revealTarget(instant) {
    let id;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch (_) { return; }
    const target = id && doc.getElementById(id);
    if (!target) return;
    for (let p = target; p && p !== doc.body; p = p.parentElement) {
      if (p.tagName === "DETAILS" && !p.open) p.open = true;
      const host = p.parentElement;
      if (p.tagName === "SECTION" && host && host.tagName === "BH-TABS" && p.hidden && host.select) {
        host.select([...host.querySelectorAll(":scope > section")].indexOf(p));
      }
      if (p.tagName === "FIGURE" && host && host.classList.contains("bh-versions-stage")) {
        const versions = host.closest("bh-versions");
        if (versions && versions.show) versions.show(versions.figures.indexOf(p));
      }
      if (p.tagName === "BH-STEP") {
        const stepper = p.closest("bh-stepper");
        if (stepper && stepper.go && stepper.steps) stepper.go(stepper.steps.indexOf(p));
      }
    }
    // A step is read together with its diagram: bring the diagram into view, flash the step.
    const stepper = target.tagName === "BH-STEP" && target.closest("bh-stepper");
    // A version is read with its switcher: land on the whole <bh-versions>.
    const scrollTo = (stepper && stepper.target) || target.closest("bh-versions") || target;
    // What we land on is shown at once: no scroll-reveal fade on (or around) it.
    for (const t of new Set([target, scrollTo])) {
      for (const n of [t, ...t.querySelectorAll(".reveal-pending")]) n.classList.remove("reveal-pending");
      for (let p = t.parentElement; p; p = p.parentElement) p.classList.remove("reveal-pending");
    }
    scrollTo.scrollIntoView({ block: "start", behavior: instant || reducedMotion.matches ? "instant" : "smooth" });
    target.classList.remove("is-target-flash");
    void target.offsetWidth;
    target.classList.add("is-target-flash");
    setTimeout(() => target.classList.remove("is-target-flash"), 2000);
  }

  function setupDeepLinks() {
    buildLinkTargets();
    addEventListener("hashchange", () => revealTarget(false));
    if (!location.hash) return;
    // On arrival the browser scrolled before the chrome and fonts settled: scroll again,
    // and once more after web fonts load, unless the reader has started scrolling.
    let interacted = false;
    const mark = () => { interacted = true; };
    ["wheel", "touchstart", "keydown", "pointerdown"].forEach((t) => addEventListener(t, mark, { once: true, passive: true }));
    revealTarget(true);
    if (doc.fonts && doc.fonts.ready) {
      doc.fonts.ready.then(() => {
        if (interacted) return;
        const t = doc.getElementById(decodeURIComponent(location.hash.slice(1)));
        const stepper = t && t.tagName === "BH-STEP" && t.closest("bh-stepper");
        const scrollTo = (stepper && stepper.target) || (t && t.closest("bh-versions")) || t;
        if (scrollTo) scrollTo.scrollIntoView({ block: "start", behavior: "instant" });
      });
    }
  }

  function buildToc(heads) {
    const page = doc.querySelector(".bh-page");
    if (!page || heads.length < 3 || page.classList.contains("no-toc")) {
      if (page) page.classList.add("no-toc");
      return;
    }
    const list = el("ol");
    const links = heads.map((h) => {
      const clone = h.cloneNode(true);
      clone.querySelectorAll(".heading-anchor").forEach((x) => x.remove());
      const a = el("a", { href: "#" + h.id, text: clone.textContent.trim() });
      list.append(el("li", { class: h.tagName === "H3" ? "depth-3" : "depth-2" }, [a]));
      return a;
    });
    const wide = matchMedia("(min-width: 1100px)");
    const toc = el("details", { class: "bh-toc", "aria-label": "Table of contents" }, [el("summary", { text: "Contents" }), el("nav", {}, [list])]);
    toc.open = wide.matches;
    wide.addEventListener("change", () => { toc.open = wide.matches; });
    page.prepend(toc);

    // Close the mobile TOC after navigating.
    list.addEventListener("click", (e) => { if (e.target.closest("a") && !wide.matches) toc.open = false; });

    // Scroll-spy: the active heading is the last one above 30% of the viewport.
    let ticking = false;
    const spy = () => {
      ticking = false;
      const line = innerHeight * 0.3;
      let active = 0;
      heads.forEach((h, i) => { if (h.getBoundingClientRect().top <= line) active = i; });
      links.forEach((a, i) => a.classList.toggle("is-active", i === active));
    };
    addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(spy); } }, { passive: true });
    spy();
  }

  // ---- Sidenotes ----------------------------------------------------------------------

  function buildSidenotes() {
    doc.querySelectorAll(".sidenote").forEach((note, i) => {
      const n = i + 1;
      note.id = note.id || `sn-${n}`;
      note.dataset.n = n;
      note.setAttribute("role", "note");
      const ref = el("button", { class: "sidenote-ref", type: "button", "aria-controls": note.id, "aria-expanded": "false", "aria-label": `Sidenote ${n}` });
      ref.addEventListener("click", () => {
        const open = note.classList.toggle("is-open");
        ref.setAttribute("aria-expanded", String(open));
      });
      note.before(ref);
    });
  }

  // ---- Code blocks: header, copy button; lazy Prism -------------------------------------

  function buildCodeBlocks() {
    const blocks = [...doc.querySelectorAll("pre > code")].filter((c) => !c.closest(".code-block, .mermaid, .no-chrome"));
    for (const code of blocks) {
      const pre = code.parentElement;
      const lang = (code.className.match(/language-(\w+)/) || [])[1];
      const label = pre.dataset.title || lang || "";
      const btn = el("button", { class: "btn copy-btn", type: "button", text: "Copy" });
      btn.addEventListener("click", async () => {
        await copyText(code.innerText.replace(/\n$/, ""));
        btn.textContent = "Copied"; btn.classList.add("copied");
        setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1600);
      });
      const wrap = el("div", { class: "code-block" + (pre.classList.contains("wide") ? " wide" : "") });
      pre.replaceWith(wrap);
      pre.classList.remove("wide");
      wrap.append(el("div", { class: "code-head" }, [el("span", { text: label }), btn]), pre);
    }

    const codes = doc.querySelectorAll('code[class*="language-"]');
    if (codes.length) {
      const base = "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/";
      window.Prism = window.Prism || { manual: true };
      settle(loadScript(base + "components/prism-core.min.js")
        .then(() => loadScript(base + "plugins/autoloader/prism-autoloader.min.js"))
        .then(() => new Promise((resolve) => {
          // Languages load asynchronously: settle once every block has highlighted (or 4s).
          let done = 0;
          window.Prism.hooks.add("complete", () => { if (++done >= codes.length) resolve(); });
          setTimeout(resolve, 4000);
          window.Prism.plugins.autoloader.languages_path = base + "components/";
          window.Prism.highlightAll();
        }))
        .catch(() => { /* offline: plain monospace is fine */ }));
    }
  }

  // ---- Mermaid (lazy, theme-aware, re-renders on theme change) --------------------------

  function buildMermaid() {
    const nodes = [...doc.querySelectorAll("pre.mermaid")];
    if (!nodes.length) return;
    nodes.forEach((n) => { n.dataset.src = n.textContent; });
    const css = (v) => getComputedStyle(doc.body).getPropertyValue(v).trim();
    const render = () => {
      const m = window.mermaid;
      m.initialize({
        startOnLoad: false,
        theme: "base",
        fontFamily: css("--font-body"),
        themeVariables: {
          background: css("--surface"),
          primaryColor: css("--accent-soft"),
          primaryBorderColor: css("--accent"),
          primaryTextColor: css("--text"),
          lineColor: css("--text-muted"),
          secondaryColor: css("--surface-2"),
          tertiaryColor: css("--surface"),
          noteBkgColor: css("--warn-soft"),
          noteBorderColor: css("--warn"),
        },
      });
      nodes.forEach((n) => { n.removeAttribute("data-processed"); n.textContent = n.dataset.src; });
      return m.run({ nodes });
    };
    settle(loadScript("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js")
      .then(() => { doc.addEventListener("bh-themechange", () => requestAnimationFrame(render)); return render(); })
      .catch(() => {}));
  }

  // ---- SVG arrow markers (shared defs referenced by .edge in diagrams.css) -------------------

  function injectMarkers(force) {
    if (doc.getElementById("bh-arrow") || (!force && !doc.querySelector(".diagram svg, svg .edge"))) return;
    const ns = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(ns, "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.style.position = "absolute";
    // Fixed-size heads (10 user units, independent of stroke width) whose BASE centre sits on
    // the path end and which point along the path's final direction. The line therefore stops
    // at the base — square-on and centred — and never runs under the head to blunt the tip.
    // Paths end 10 units short of where the tip should land; `npm run check` verifies landing.
    const head = (id, cls) =>
      `<marker id="${id}" viewBox="0 0 10 10" refX="0" refY="5" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" orient="auto-start-reverse" overflow="visible"><path class="${cls}" d="M0 0 10 5 0 10z"/></marker>`;
    svg.innerHTML = `<defs>${head("bh-arrow", "bh-arrow-head")}${head("bh-arrow-start", "bh-arrow-head")}${head("bh-arrow-lit", "bh-arrow-head lit")}</defs>`;
    doc.body.prepend(svg);
  }

  // ---- Prose ↔ diagram references -------------------------------------------------------
  //
  // <span data-ref="figure-id:node-id [more-ids]">the gateway</span>
  // Hover or focus lights those [data-id] parts (dimming the rest); click also brings the
  // diagram into view and holds the highlight briefly. The diagram's previous state (e.g.
  // a stepper's) is restored afterwards.

  function parseRef(value) {
    const i = (value || "").indexOf(":");
    if (i < 1) return null;
    const fig = doc.getElementById(value.slice(0, i).trim());
    const ids = value.slice(i + 1).split(/[\s,]+/).filter(Boolean);
    return fig && ids.length ? { fig, ids } : null;
  }

  function buildDiagramRefs() {
    const refs = [...doc.querySelectorAll("[data-ref]")];
    if (!refs.length) return;
    let active = null; // { ref, fig, saved, held, timer }

    const restore = () => {
      if (!active) return;
      clearTimeout(active.timer);
      for (const [n, lit, dim] of active.saved) { n.classList.toggle("is-lit", lit); n.classList.toggle("is-dim", dim); }
      active.ref.classList.remove("is-active");
      active = null;
    };
    const apply = (ref) => {
      const r = parseRef(ref.dataset.ref);
      if (!r) return null;
      restore();
      const nodes = [...r.fig.querySelectorAll("[data-id]")];
      const saved = nodes.map((n) => [n, n.classList.contains("is-lit"), n.classList.contains("is-dim")]);
      for (const n of nodes) {
        const lit = r.ids.includes(n.dataset.id);
        n.classList.toggle("is-lit", lit);
        n.classList.toggle("is-dim", !lit);
      }
      ref.classList.add("is-active");
      active = { ref, fig: r.fig, saved, held: false, timer: 0 };
      return r.fig;
    };
    const show = (ref) => {
      const fig = apply(ref);
      if (!fig) return;
      const box = fig.getBoundingClientRect();
      const topbar = (doc.querySelector(".bh-topbar") || { offsetHeight: 0 }).offsetHeight;
      if (box.top < topbar || box.bottom > innerHeight) {
        fig.classList.remove("reveal-pending");
        fig.scrollIntoView({ block: "center", behavior: reducedMotion.matches ? "instant" : "smooth" });
      }
      active.held = true;
      active.timer = setTimeout(restore, 2600);
    };

    for (const ref of refs) {
      const r = parseRef(ref.dataset.ref);
      if (!r) { console.warn(`[bh] data-ref "${ref.dataset.ref}" does not match a figure and its parts`, ref); continue; }
      ref.classList.add("diagram-ref");
      ref.tabIndex = 0;
      ref.setAttribute("role", "button");
      ref.title = `Show in ${linkLabel(r.fig)}`;
      // Take the colour of the first part referred to, so the text matches the diagram.
      const first = r.fig.querySelector(`[data-id="${CSS.escape(r.ids[0])}"]`);
      const tone = first && getComputedStyle(first).getPropertyValue("--tone").trim();
      if (tone) ref.style.setProperty("--ref-tone", tone);
      ref.addEventListener("pointerenter", () => { if (!(active && active.held)) apply(ref); });
      ref.addEventListener("pointerleave", () => { if (active && active.ref === ref && !active.held) restore(); });
      ref.addEventListener("focus", () => apply(ref));
      ref.addEventListener("blur", () => { if (active && active.ref === ref && !active.held) restore(); });
      ref.addEventListener("click", (e) => { e.preventDefault(); show(ref); });
      ref.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); show(ref); }
        if (e.key === "Escape") restore();
      });
    }
  }

  // ---- Scroll reveal (only below-the-fold elements; never hides content without IO) ------------

  function buildReveal() {
    if (reducedMotion.matches || !("IntersectionObserver" in window)) return;
    const targets = doc.querySelectorAll(
      ".bh-article > figure, .bh-article > .cards > *, .bh-article > .compare > *, .bh-article > .metrics > *, .bh-article > .timeline > li, [data-reveal]"
    );
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("reveal-in");
        e.target.classList.remove("reveal-pending");
        io.unobserve(e.target);
      }
    }, { rootMargin: "0px 0px -8% 0px" });
    targets.forEach((t) => {
      if (t.getBoundingClientRect().top < innerHeight) return;
      const siblings = t.parentElement ? [...t.parentElement.children] : [];
      t.style.setProperty("--reveal-i", Math.min(siblings.indexOf(t), 6));
      t.classList.add("reveal-pending");
      io.observe(t);
    });
  }

  // =====================================================================================
  //  Components
  // =====================================================================================

  /** <bh-tabs><section data-label="A">…</section><section data-label="B">…</section></bh-tabs> */
  class BhTabs extends HTMLElement {
    connectedCallback() { whenReady(() => this.init()); }
    init() {
      if (this._ready) return;
      this._ready = true;
      const panels = [...this.querySelectorAll(":scope > section")];
      if (!panels.length) return;
      const uid = "tabs-" + Math.random().toString(36).slice(2, 8);
      const list = el("div", { class: "bh-tablist", role: "tablist" });
      const tabs = panels.map((p, i) => {
        p.id = p.id || `${uid}-p${i}`;
        p.setAttribute("role", "tabpanel");
        const t = el("button", { role: "tab", type: "button", id: `${uid}-t${i}`, "aria-controls": p.id, text: p.dataset.label || `Tab ${i + 1}` });
        p.setAttribute("aria-labelledby", t.id);
        t.addEventListener("click", () => this.select(i));
        list.append(t);
        return t;
      });
      list.addEventListener("keydown", (e) => {
        const i = tabs.indexOf(doc.activeElement);
        if (i < 0) return;
        const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (next === undefined) return;
        e.preventDefault();
        this.select((next + tabs.length) % tabs.length, true);
      });
      this._tabs = tabs;
      this._panels = panels;
      this.prepend(list);
      this.classList.add("is-ready");
      const initial = Math.max(0, panels.findIndex((p) => p.hasAttribute("data-selected")));
      this.select(initial);
    }
    select(i, focus) {
      this._tabs.forEach((t, j) => {
        t.setAttribute("aria-selected", String(i === j));
        t.tabIndex = i === j ? 0 : -1;
        this._panels[j].hidden = i !== j;
      });
      if (focus) this._tabs[i].focus();
    }
  }

  /**
   * <bh-stepper for="diagram-id" [interval="3500"]>
   *   <bh-step highlight="client req">Narration…</bh-step>
   * </bh-stepper>
   * Highlights [data-id] elements inside #diagram-id: listed ids get .is-lit, the rest .is-dim.
   * Each step is linkable as #<stepper id or for>-step-<n> (unless it has its own id); the
   * bar's link button copies a link to the current step.
   */
  class BhStepper extends HTMLElement {
    connectedCallback() { whenReady(() => this.init()); }
    init() {
      if (this._ready) return;
      this._ready = true;
      this.steps = [...this.querySelectorAll(":scope > bh-step")];
      if (!this.steps.length) return;
      this.target = this.getAttribute("for") ? doc.getElementById(this.getAttribute("for")) : null;
      const base = this.id || this.getAttribute("for");
      this.steps.forEach((s, i) => {
        s.dataset.n = i + 1;
        s.dataset.total = this.steps.length;
        if (!s.id && base) s.id = `${base}-step-${i + 1}`;
      });

      const live = el("div", { "aria-live": "polite" });
      this.steps[0].before(live);
      live.append(...this.steps);

      this.prevBtn = el("button", { class: "btn", type: "button", text: "← Back", onclick: () => this.go(this.index - 1) });
      this.nextBtn = el("button", { class: "btn primary", type: "button", text: "Next →", onclick: () => this.go(this.index + 1) });
      this.playBtn = el("button", { class: "btn ghost", type: "button", text: "▶ Play", onclick: () => this.togglePlay() });
      this.dots = this.steps.map((_, i) => el("button", { type: "button", "aria-label": `Go to step ${i + 1}`, onclick: () => this.go(i) }));
      const linkBtn = base ? el("button", { class: "btn ghost icon bh-step-link", type: "button", title: "Copy link to this step", "aria-label": "Copy link to this step", html: LINK_ICON, onclick: () => copyLink(this.steps[this.index].id) }) : null;
      this.append(el("div", { class: "bh-stepper-bar" }, [this.prevBtn, el("div", { class: "bh-stepper-dots" }, this.dots), linkBtn, this.playBtn, this.nextBtn]));

      this.tabIndex = 0;
      this.setAttribute("role", "group");
      this.setAttribute("aria-roledescription", "stepper");
      this.addEventListener("keydown", (e) => {
        if (e.target.closest("input, textarea, select")) return;
        if (e.key === "ArrowRight") { e.preventDefault(); this.go(this.index + 1); }
        if (e.key === "ArrowLeft") { e.preventDefault(); this.go(this.index - 1); }
      });
      this.classList.add("is-ready");
      this.go(0);
      // Show the whole diagram until the reader engages with the stepper.
      this._engaged = false;
      this.highlight([]);
    }
    go(i) {
      if (this.steps && this._engaged === false) this._engaged = true;
      const n = this.steps.length;
      this.index = Math.max(0, Math.min(n - 1, i));
      this.steps.forEach((s, j) => s.classList.toggle("is-active", j === this.index));
      this.dots.forEach((d, j) => { if (j === this.index) d.setAttribute("aria-current", "step"); else d.removeAttribute("aria-current"); });
      this.prevBtn.disabled = this.index === 0;
      this.nextBtn.disabled = this.index === n - 1;
      if (this.index === n - 1) this.stop();
      this.highlight((this.steps[this.index].getAttribute("highlight") || "").split(/[\s,]+/).filter(Boolean));
      this.dispatchEvent(new CustomEvent("bh-step", { bubbles: true, detail: { index: this.index, step: this.steps[this.index] } }));
    }
    highlight(ids) {
      if (!this.target) return;
      this.target.querySelectorAll("[data-id]").forEach((node) => {
        const lit = ids.includes(node.dataset.id);
        node.classList.toggle("is-lit", ids.length > 0 && lit);
        node.classList.toggle("is-dim", ids.length > 0 && !lit);
      });
    }
    togglePlay() { this._timer ? this.stop() : this.play(); }
    play() {
      if (this.index === this.steps.length - 1) this.go(0);
      const ms = +this.getAttribute("interval") || 3500;
      this._timer = setInterval(() => this.go(this.index + 1), ms);
      this.playBtn.textContent = "❚❚ Pause";
    }
    stop() {
      clearInterval(this._timer);
      this._timer = null;
      if (this.playBtn) this.playBtn.textContent = "▶ Play";
    }
    disconnectedCallback() { this.stop(); }
  }

  /**
   * <bh-playground>
   *   <input type="range" name="rate" min="1" max="100" value="10">
   *   <output data-expr="rate * 60" data-digits="0"></output>
   *   <rect data-bind="width: rate * 3; style.opacity: rate / 100"/>
   * </bh-playground>
   * Expressions see every named input (numbers coerced) plus Math.* (e.g. min, max, log2).
   * Emits a bubbling "bh-change" event with the values for custom page scripts.
   */
  const exprCache = new Map();
  function compile(expr) {
    if (!exprCache.has(expr)) {
      // eslint-disable-next-line no-new-func -- authored page content, not user input
      exprCache.set(expr, new Function("v", "with (Math) { with (v) { return (" + expr + "); } }"));
    }
    return exprCache.get(expr);
  }
  function format(value, digits) {
    if (typeof value !== "number" || !isFinite(value)) return String(value);
    const d = digits == null || digits === "" ? (Number.isInteger(value) ? 0 : 2) : +digits;
    return value.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  class BhPlayground extends HTMLElement {
    connectedCallback() { whenReady(() => this.init()); }
    init() {
      if (this._ready) return;
      this._ready = true;
      this.addEventListener("input", () => this.update());
      this.addEventListener("change", () => this.update());
      this.update();
    }
    values() {
      const v = {};
      this.querySelectorAll("input[name], select[name]").forEach((inp) => {
        if (inp.type === "radio") { if (inp.checked) v[inp.name] = coerce(inp.value); }
        else if (inp.type === "checkbox") v[inp.name] = inp.checked;
        else v[inp.name] = coerce(inp.value);
      });
      return v;
    }
    update() {
      const v = this.values();
      this.querySelectorAll("[data-expr]").forEach((node) => {
        try { node.textContent = format(compile(node.dataset.expr)(v), node.dataset.digits); }
        catch (err) { node.textContent = "⚠"; console.warn("[bh-playground]", node.dataset.expr, err); }
      });
      this.querySelectorAll("[data-bind]").forEach((node) => {
        for (const pair of node.dataset.bind.split(";")) {
          const idx = pair.indexOf(":");
          if (idx < 0) continue;
          const attr = pair.slice(0, idx).trim();
          let val;
          try { val = compile(pair.slice(idx + 1).trim())(v); }
          catch (err) { console.warn("[bh-playground]", pair, err); continue; }
          if (attr.startsWith("style.")) node.style.setProperty(attr.slice(6), val);
          else if (attr === "text") node.textContent = typeof val === "number" ? format(val, node.dataset.digits) : val;
          else if (attr.startsWith("class.")) node.classList.toggle(attr.slice(6), !!val);
          else node.setAttribute(attr, val);
        }
      });
      this.dispatchEvent(new CustomEvent("bh-change", { bubbles: true, detail: v }));
    }
  }
  function coerce(s) { return s !== "" && !isNaN(s) ? +s : s; }

  /**
   * <bh-filter for="list-id"></bh-filter>
   * Builds a search box + chips from data-kind on the list's children; matches data-search text.
   */
  class BhFilter extends HTMLElement {
    connectedCallback() { whenReady(() => this.init()); }
    init() {
      if (this._ready) return;
      this._ready = true;
      const list = doc.getElementById(this.getAttribute("for"));
      if (!list) return;
      const items = [...list.children];
      const kinds = [...new Set(items.map((i) => i.dataset.kind).filter(Boolean))].sort();
      let kind = "";
      const search = el("input", { type: "search", placeholder: "Filter documents…", "aria-label": "Filter documents" });
      const chips = ["", ...kinds].map((k) => el("button", {
        class: "chip", type: "button", "aria-pressed": String(k === ""), text: k ? k[0].toUpperCase() + k.slice(1) : "All",
        onclick: (e) => { kind = k; chips.forEach((c) => c.setAttribute("aria-pressed", String(c === e.currentTarget))); apply(); },
      }));
      const apply = () => {
        const q = search.value.trim().toLowerCase();
        for (const item of items) {
          const okKind = !kind || item.dataset.kind === kind;
          const okText = !q || (item.dataset.search || item.textContent).toLowerCase().includes(q);
          item.hidden = !(okKind && okText);
        }
      };
      search.addEventListener("input", apply);
      this.append(el("div", { class: "bh-filter" }, [search, ...chips]));
      // "/" focuses the filter.
      doc.addEventListener("keydown", (e) => {
        if (e.key === "/" && !e.target.closest("input, textarea, select, [contenteditable]")) { e.preventDefault(); search.focus(); }
      });
    }
  }

  customElements.define("bh-tabs", BhTabs);
  customElements.define("bh-stepper", BhStepper);
  customElements.define("bh-step", class extends HTMLElement {});
  customElements.define("bh-playground", BhPlayground);
  customElements.define("bh-filter", BhFilter);

  // =====================================================================================
  //  Glossary
  //
  //  Data: window.BH_GLOSSARY (theme/glossary.js, compiled from docs/glossary.html by
  //  `npm run index`) merged with any <dl class="glossary"> on the page (local wins).
  //  Marking: first occurrence per page in article prose (body[data-glossary] =
  //  page | section | every | off); inside a glossary list, first per definition. Force with data-term="id"; opt out with .no-glossary.
  //  Popup: placed once on open, anchored to the term (never follows the pointer); an
  //  invisible bridge spans the gap so the pointer can move into it; pressing inside it,
  //  clicking the term, or Enter/Space pins it until Esc or a click elsewhere.
  // =====================================================================================

  const GLOSSARY_SKIP = [
    "h1", "h2", "h3", "h4", "h5", "h6", "a", "code", "pre", "kbd", "samp", "svg", "button",
    "input", "select", "textarea", "label", "summary", "script", "style", "[data-term]",
    ".term", ".no-glossary", ".bh-hero", ".bh-footer", ".bh-toc", ".bh-tablist",
    ".code-block", ".mermaid", ".badge", ".eyebrow", "dl.glossary > dt", "[data-ref]",
  ].join(",");

  const splitList = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function loadGlossaryData() {
    if (Array.isArray(window.BH_GLOSSARY)) return Promise.resolve(window.BH_GLOSSARY);
    if (!SITE_ROOT) return Promise.resolve([]);
    return loadScript(new URL("theme/glossary.js", SITE_ROOT).href)
      .then(() => window.BH_GLOSSARY || [], () => []);
  }

  function localGlossary() {
    const out = [];
    doc.querySelectorAll("dl.glossary > dt[id]").forEach((dt) => {
      const dd = dt.nextElementSibling;
      if (!dd || dd.tagName !== "DD") return;
      const name = dt.cloneNode(true);
      name.querySelectorAll(".heading-anchor").forEach((x) => x.remove());
      out.push({ id: dt.id, term: name.textContent.trim(), aliases: splitList(dt.dataset.aliases), html: dd.innerHTML, href: "#" + dt.id, local: true });
    });
    return out;
  }

  function decorateTerm(node, id) {
    node.classList.add("term");
    node.dataset.term = id;
    if (!node.hasAttribute("tabindex")) node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.setAttribute("aria-expanded", "false");
    node.setAttribute("aria-controls", "bh-gloss-pop");
  }

  /** Wrap glossary words found in article prose. Returns nothing; mutates the DOM. */
  function markTerms(byId) {
    const scope = doc.querySelector(".bh-article");
    const mode = doc.body.dataset.glossary || "page";
    if (!scope || mode === "off" || !byId.size) return;

    const lookup = new Map();
    for (const e of byId.values()) for (const name of [e.term, ...e.aliases]) lookup.set(name.toLowerCase(), e.id);
    const names = [...lookup.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
    const re = new RegExp(`(?<![\\p{L}\\p{N}_-])(${names.join("|")})(?![\\p{L}\\p{N}_-])`, "giu");

    const seen = new Set();
    const jobs = [];
    const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 3) return n.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        if (mode === "section" && n.tagName === "H2" && n.parentElement === scope) seen.clear();
        // Each glossary definition is its own section, so cross-references appear in every entry.
        if (n.tagName === "DD" && n.parentElement.matches("dl.glossary")) seen.clear();
        return n.matches(GLOSSARY_SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let node; (node = walker.nextNode());) {
      // A definition never links to itself.
      const dd = node.parentElement.closest("dl.glossary > dd");
      let self = null;
      for (let p = dd && dd.previousElementSibling; p; p = p.previousElementSibling) if (p.tagName === "DT") { self = p.id; break; }
      const hits = [];
      re.lastIndex = 0;
      for (let m; (m = re.exec(node.data));) {
        const id = lookup.get(m[1].toLowerCase());
        if (!id || id === self) continue;
        if (mode !== "every") { if (seen.has(id)) continue; seen.add(id); }
        hits.push({ start: m.index, end: m.index + m[1].length, id });
      }
      if (hits.length) jobs.push({ node, hits });
    }
    for (const { node, hits } of jobs) {
      const frag = doc.createDocumentFragment();
      let at = 0;
      for (const h of hits) {
        frag.append(node.data.slice(at, h.start));
        const span = el("span", { text: node.data.slice(h.start, h.end) });
        decorateTerm(span, h.id);
        frag.append(span);
        at = h.end;
      }
      frag.append(node.data.slice(at));
      node.replaceWith(frag);
    }
  }

  /** A–Z jump bar above long glossary lists. */
  function buildGlossaryIndex() {
    doc.querySelectorAll("dl.glossary").forEach((dl) => {
      const dts = [...dl.querySelectorAll(":scope > dt[id]")];
      if (dts.length < 8) return;
      const firsts = new Map();
      for (const dt of dts) {
        const letter = dt.textContent.trim().charAt(0).toUpperCase();
        if (!firsts.has(letter)) firsts.set(letter, dt.id);
      }
      const width = ["wide", "full"].filter((c) => dl.classList.contains(c)).join(" ");
      dl.before(el("nav", { class: `glossary-az ${width}`.trim(), "aria-label": "Glossary index" },
        [...firsts].map(([letter, id]) => el("a", { href: "#" + id, text: letter }))));
    });
  }

  function setupGlossaryPopup(byId) {
    if (!doc.querySelector(".term[data-term]")) return;
    const pop = el("div", { class: "bh-gloss-pop", id: "bh-gloss-pop", role: "dialog", "aria-modal": "false", tabindex: "-1", hidden: true });
    doc.body.append(pop);

    const OPEN_DELAY = 220, HIDE_DELAY = 300, MARGIN = 8, GAP = 10;
    let current = null, pinned = false, openTimer = 0, hideTimer = 0, lastPoint = null;
    let restoringFocus = false; // returning focus to a term after Esc must not reopen it
    let lastWidth = innerWidth;

    const termOf = (n) => (n && n.closest ? n.closest(".term[data-term]") : null);
    const inPop = (n) => !!n && pop.contains(n);

    function absolutise(container) {
      container.querySelectorAll("[href], [src]").forEach((n) => {
        const attr = n.hasAttribute("href") ? "href" : "src";
        const v = n.getAttribute(attr);
        if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(v)) return;
        if (SITE_ROOT) n.setAttribute(attr, new URL(v, SITE_ROOT).href);
        else if (attr === "href") n.replaceWith(...n.childNodes); // bundled: site pages don't exist
      });
    }

    function render(entry) {
      pop.setAttribute("aria-label", `Glossary: ${entry.term}`);
      const body = el("div", { class: "bh-gloss-body", html: entry.html });
      if (!entry.local) absolutise(body);
      let more = null;
      if (entry.local) more = el("a", { class: "bh-gloss-more", href: entry.href, text: "Jump to definition ↓" });
      else if (SITE_ROOT) more = el("a", { class: "bh-gloss-more", href: new URL(entry.href, SITE_ROOT).href, text: "Open in glossary →" });
      pop.replaceChildren(
        el("div", { class: "bh-gloss-head" }, [el("span", { class: "bh-gloss-term", text: entry.term }), el("span", { class: "bh-gloss-kicker", text: "Glossary" })]),
        body, more);
    }

    // Placed once per open, in document coordinates: it scrolls with its term and never
    // follows the pointer.
    function place(term) {
      const rects = [...term.getClientRects()];
      let r = rects[0];
      if (!r) return false;
      if (lastPoint) {
        r = rects.find((x) => lastPoint.x >= x.left - 2 && lastPoint.x <= x.right + 2 && lastPoint.y >= x.top - 2 && lastPoint.y <= x.bottom + 2) || r;
      }
      pop.style.left = "0px";
      pop.style.top = "0px";
      pop.hidden = false;
      const w = pop.offsetWidth, h = pop.offsetHeight, vw = root.clientWidth;
      const left = Math.max(MARGIN, Math.min(r.left + r.width / 2 - w / 2, vw - w - MARGIN));
      const below = r.bottom + GAP + h <= innerHeight - MARGIN || r.top - GAP - h < MARGIN + 52;
      pop.dataset.side = below ? "below" : "above";
      pop.style.left = `${left + scrollX}px`;
      pop.style.top = `${(below ? r.bottom + GAP : r.top - GAP - h) + scrollY}px`;
      pop.style.setProperty("--caret-x", `${Math.max(14, Math.min(w - 14, r.left + r.width / 2 - left))}px`);
      return true;
    }

    function open(term, pin) {
      clearTimeout(openTimer);
      clearTimeout(hideTimer);
      const entry = byId.get(term.dataset.term);
      if (!entry) return;
      if (current !== term || pop.hidden) {
        if (current) current.setAttribute("aria-expanded", "false");
        render(entry);
        if (!place(term)) { pop.hidden = true; return; }
        pop.classList.remove("is-in");
        void pop.offsetWidth; // restart the entry animation
        pop.classList.add("is-in");
        pinned = false;
      }
      current = term;
      pinned = pinned || !!pin;
      pop.classList.toggle("is-pinned", pinned);
      term.setAttribute("aria-expanded", "true");
    }

    function close() {
      clearTimeout(openTimer);
      clearTimeout(hideTimer);
      if (pop.hidden) return;
      pop.hidden = true;
      pop.classList.remove("is-in", "is-pinned");
      pinned = false;
      if (current) current.setAttribute("aria-expanded", "false");
      current = null;
    }

    function scheduleOpen(term) {
      clearTimeout(hideTimer);
      if (pinned || (term === current && !pop.hidden)) return;
      clearTimeout(openTimer);
      openTimer = setTimeout(() => open(term, false), OPEN_DELAY);
    }

    function scheduleHide() {
      if (pinned || pop.hidden) return;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(close, HIDE_DELAY);
    }

    // ---- Pointer (mouse & pen). Touch uses click/tap only.
    doc.addEventListener("pointerover", (e) => {
      if (e.pointerType === "touch") return;
      lastPoint = { x: e.clientX, y: e.clientY };
      const t = termOf(e.target);
      if (t && !inPop(t)) scheduleOpen(t);
      else if (inPop(e.target)) clearTimeout(hideTimer);
    });
    doc.addEventListener("pointerout", (e) => {
      if (e.pointerType === "touch") return;
      const fromTerm = termOf(e.target), fromPop = inPop(e.target), to = e.relatedTarget;
      if (!fromTerm && !fromPop) return;
      if ((fromTerm && to && fromTerm.contains(to)) || (fromPop && inPop(to))) return; // moving within
      if (fromTerm) clearTimeout(openTimer);
      if (inPop(to) || (current && to && current.contains(to))) return; // term ↔ its popup
      scheduleHide();
    });
    // Pressing inside the popup (to select, copy, or right-click) pins it.
    pop.addEventListener("pointerdown", () => { pinned = true; pop.classList.add("is-pinned"); });

    doc.addEventListener("click", (e) => {
      const t = termOf(e.target);
      if (t && !inPop(t)) {
        e.preventDefault();
        if (current === t && pinned) close();
        else { lastPoint = { x: e.clientX, y: e.clientY }; open(t, true); }
        return;
      }
      if (!pop.hidden && !inPop(e.target)) close();
    });

    // ---- Keyboard & focus
    doc.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !pop.hidden) {
        const back = current, refocus = inPop(doc.activeElement) || doc.activeElement === back;
        close();
        if (back && refocus) {
          restoringFocus = true;
          back.focus();
          restoringFocus = false;
        }
        return;
      }
      const t = termOf(e.target);
      if (t && !inPop(t) && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        lastPoint = null;
        open(t, true);
        pop.focus({ preventScroll: true }); // Tab now reaches the popup's links
      }
    });
    doc.addEventListener("focusin", (e) => {
      const t = termOf(e.target);
      if (t && !inPop(t) && t !== current && !restoringFocus) { lastPoint = null; open(t, false); }
      else if (inPop(e.target)) clearTimeout(hideTimer);
    });
    doc.addEventListener("focusout", (e) => {
      const to = e.relatedTarget;
      if (!(termOf(e.target) || inPop(e.target))) return;
      if (inPop(to) || (current && to === current)) return;
      scheduleHide();
    });

    addEventListener("resize", () => { if (innerWidth !== lastWidth) { lastWidth = innerWidth; close(); } });
  }

  function buildGlossary() {
    return loadGlossaryData().then((global) => {
      const byId = new Map();
      for (const e of global) byId.set(e.id, { ...e, aliases: e.aliases || [], local: false });
      for (const e of localGlossary()) byId.set(e.id, e);
      doc.querySelectorAll("[data-term]").forEach((n) => {
        if (byId.has(n.dataset.term)) decorateTerm(n, n.dataset.term);
        else console.warn(`[bh] unknown glossary term "${n.dataset.term}"`, n);
      });
      buildGlossaryIndex();
      markTerms(byId);
      setupGlossaryPopup(byId);
    });
  }

  // ---- On-demand modules ------------------------------------------------------------------------
  //
  // Larger components live in theme/modules/<file> and load only when the page contains
  // their selector. Each module is a classic script that uses window.bh and marks itself in
  // window.bhModules. `bundle` inlines every module, so standalone files never fetch one.

  const MODULES = [
    ["versions.js", "bh-versions"],
    ["sequence.js", "bh-sequence"],
  ];

  function loadModule(file) {
    window.bhModules = window.bhModules || {};
    if (window.bhModules[file]) return Promise.resolve();
    if (!SITE_ROOT) return Promise.resolve(); // bundled: already inlined (or unavailable)
    window.bhModules[file] = "loading";
    return loadScript(new URL("theme/modules/" + file, SITE_ROOT).href)
      .catch((e) => console.warn("[bh] module failed to load:", file, e));
  }

  function loadModules() {
    return Promise.all(MODULES.filter(([, selector]) => doc.querySelector(selector)).map(([file]) => loadModule(file)));
  }

  // ---- Boot ------------------------------------------------------------------------------------

  whenReady(() => {
    buildChrome();
    buildMeta();
    buildToc(buildHeadings());
    buildSidenotes();
    buildCodeBlocks();
    injectMarkers();
    buildMermaid();
    buildReveal();
    buildDiagramRefs();
    settle(buildGlossary());
    // Deep-link arrival waits for modules, so a link into a module-managed view works.
    const modules = settle(loadModules());
    modules.then(setupDeepLinks);
    if (doc.fonts && doc.fonts.ready) settle(doc.fonts.ready);
    // Wait for everything queued so far (and anything queued while waiting), then signal.
    (async () => {
      for (let seen = 0; seen < pending.length;) { const batch = pending.slice(seen); seen = pending.length; await Promise.all(batch); }
      root.dataset.bhReady = "";
      doc.dispatchEvent(new CustomEvent("bh-ready"));
    })();
  });

  window.bh = {
    applyTheme, whenReady, el, format, copyText, copyLink, toast, linkLabel, settle,
    reducedMotion, LINK_ICON, ensureMarkers: () => injectMarkers(true),
  };
})();
