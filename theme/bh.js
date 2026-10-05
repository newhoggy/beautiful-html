/* ==========================================================================
   beautiful-html runtime — progressive enhancement for every page.
   Classic script (not a module) so pages work from file:// with no server.

   Page chrome:   top bar, theme toggle, reading progress, skip link, TOC +
                  scroll-spy, heading anchors & eyebrows, auto meta, sidenotes,
                  code-block copy buttons, scroll reveal, SVG arrow markers.
   Lazy libs:     Prism (if code has language-*), Mermaid (if pre.mermaid).
   Components:    <bh-tabs>, <bh-stepper>/<bh-step>, <bh-playground>, <bh-filter>.

   Everything degrades to readable static HTML when JavaScript is off.
   ========================================================================== */
(function () {
  "use strict";

  const doc = document;
  const root = doc.documentElement;
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
    const heads = [...article.querySelectorAll(":scope > h2, :scope > h3")].filter((h) => !h.classList.contains("no-toc"));
    let n = 0;
    for (const h of heads) {
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
      h.append(el("a", { class: "heading-anchor", href: "#" + h.id, "aria-label": "Link to this section", text: "#" }));
    }
    return heads;
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
        const text = code.innerText.replace(/\n$/, "");
        try { await navigator.clipboard.writeText(text); }
        catch (_) {
          const ta = el("textarea", { style: "position:fixed;opacity:0" });
          ta.value = text; doc.body.append(ta); ta.select(); doc.execCommand("copy"); ta.remove();
        }
        btn.textContent = "Copied"; btn.classList.add("copied");
        setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1600);
      });
      const wrap = el("div", { class: "code-block" + (pre.classList.contains("wide") ? " wide" : "") });
      pre.replaceWith(wrap);
      pre.classList.remove("wide");
      wrap.append(el("div", { class: "code-head" }, [el("span", { text: label }), btn]), pre);
    }

    if (doc.querySelector('code[class*="language-"]')) {
      const base = "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/";
      window.Prism = window.Prism || { manual: true };
      loadScript(base + "components/prism-core.min.js")
        .then(() => loadScript(base + "plugins/autoloader/prism-autoloader.min.js"))
        .then(() => {
          window.Prism.plugins.autoloader.languages_path = base + "components/";
          window.Prism.highlightAll();
        })
        .catch(() => { /* offline: plain monospace is fine */ });
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
      m.run({ nodes });
    };
    loadScript("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js")
      .then(() => { render(); doc.addEventListener("bh-themechange", () => requestAnimationFrame(render)); })
      .catch(() => {});
  }

  // ---- SVG arrow markers (shared defs referenced by .edge in diagrams.css) -------------------

  function injectMarkers() {
    if (!doc.querySelector(".diagram svg, svg .edge") || doc.getElementById("bh-arrow")) return;
    const ns = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(ns, "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.style.position = "absolute";
    svg.innerHTML = `<defs>
      <marker id="bh-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="bh-arrow-head" d="M0 0 10 5 0 10z"/></marker>
      <marker id="bh-arrow-start" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="bh-arrow-head" d="M0 0 10 5 0 10z"/></marker>
      <marker id="bh-arrow-lit" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="bh-arrow-head lit" d="M0 0 10 5 0 10z"/></marker>
    </defs>`;
    doc.body.prepend(svg);
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
   */
  class BhStepper extends HTMLElement {
    connectedCallback() { whenReady(() => this.init()); }
    init() {
      if (this._ready) return;
      this._ready = true;
      this.steps = [...this.querySelectorAll(":scope > bh-step")];
      if (!this.steps.length) return;
      this.target = this.getAttribute("for") ? doc.getElementById(this.getAttribute("for")) : null;
      this.steps.forEach((s, i) => { s.dataset.n = i + 1; s.dataset.total = this.steps.length; });

      const live = el("div", { "aria-live": "polite" });
      this.steps[0].before(live);
      live.append(...this.steps);

      this.prevBtn = el("button", { class: "btn", type: "button", text: "← Back", onclick: () => this.go(this.index - 1) });
      this.nextBtn = el("button", { class: "btn primary", type: "button", text: "Next →", onclick: () => this.go(this.index + 1) });
      this.playBtn = el("button", { class: "btn ghost", type: "button", text: "▶ Play", onclick: () => this.togglePlay() });
      this.dots = this.steps.map((_, i) => el("button", { type: "button", "aria-label": `Go to step ${i + 1}`, onclick: () => this.go(i) }));
      this.append(el("div", { class: "bh-stepper-bar" }, [this.prevBtn, el("div", { class: "bh-stepper-dots" }, this.dots), this.playBtn, this.nextBtn]));

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
  });

  window.bh = { applyTheme, whenReady, el, format };
})();
