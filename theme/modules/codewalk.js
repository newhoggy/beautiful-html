/* ==========================================================================
   <bh-codewalk> — scroll-driven code walkthrough.

   <bh-codewalk class="wide" id="walk-limiter">
     <pre data-title="token_bucket.rs"><code class="language-rust">…</code></pre>
     <bh-cw-step lines="3-8">The state is two numbers…</bh-cw-step>
     <bh-cw-step lines="12-15">Refill lazily…</bh-cw-step>
   </bh-codewalk>

   Wide containers: steps scroll on the left, the code stays pinned on the right.
   Narrow containers: the code pins at the top. The step crossing the middle of the
   viewport is active: its lines get an accent band, other lines are shaded, and the code
   panel scrolls to keep the band in view. Line numbers and shading are overlays, so they
   survive syntax highlighting. Steps are linkable as #<id>-step-N.
   Without JS: the code, then each step labelled with its lines.
   ========================================================================== */
(function () {
  "use strict";
  const bh = window.bh;
  const { el, whenReady, reducedMotion } = bh;

  /** "3-8, 12" → Set {3,4,5,6,7,8,12} */
  function parseLines(spec, max) {
    const out = new Set();
    for (const part of (spec || "").split(",")) {
      const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!m) continue;
      const a = +m[1], b = m[2] ? +m[2] : a;
      for (let i = Math.max(1, a); i <= Math.min(max, b); i++) out.add(i);
    }
    return out;
  }

  /** Runs of consecutive line numbers from 1..max, tagged lit or not. */
  function runs(lit, max) {
    const out = [];
    for (let i = 1; i <= max; i++) {
      const on = lit.has(i);
      const last = out[out.length - 1];
      if (last && last.on === on) last.end = i;
      else out.push({ on, start: i, end: i });
    }
    return out;
  }

  class BhCodewalk extends HTMLElement {
    connectedCallback() { whenReady(() => this.init()); }

    init() {
      if (this._ready) return;
      this.pre = this.querySelector(":scope > pre, :scope > .code-block > pre");
      this.steps = [...this.querySelectorAll(":scope > bh-cw-step")];
      if (!this.pre || !this.steps.length) return;
      this._ready = true;
      this.code = this.pre.querySelector("code") || this.pre;
      this.lineCount = this.code.textContent.replace(/\n$/, "").split("\n").length;

      // Layout: [steps | code]. The code block (with bh.js's header + copy button) moves.
      const codeBlock = this.pre.closest(".code-block") || this.pre;
      // An inner grid: the element itself is the size container, and a container query
      // can't style the container it queries.
      this.codePanel = el("div", { class: "cw-code" });
      this.stepsCol = el("div", { class: "cw-steps" });
      this.prepend(el("div", { class: "cw-grid" }, [this.stepsCol, this.codePanel]));
      this.codePanel.append(codeBlock);
      this.stepsCol.append(...this.steps);

      // Overlays inside <pre>: gutter numbers, then one band/shade per run of lines.
      this.pre.classList.add("cw-pre");
      this.gutter = el("span", { class: "cw-gutter", "aria-hidden": "true",
        text: Array.from({ length: this.lineCount }, (_, i) => i + 1).join("\n") });
      this.layer = el("span", { class: "cw-layer", "aria-hidden": "true" });
      this.pre.prepend(this.gutter, this.layer); // shades paint over the gutter too

      const base = this.id;
      this.steps.forEach((s, i) => {
        s.dataset.n = i + 1;
        if (!s.id && base) s.id = `${base}-step-${i + 1}`;
        s.tabIndex = 0;
        s.setAttribute("aria-label", `Step ${i + 1}: lines ${s.getAttribute("lines") || "—"}`);
        s.addEventListener("focus", () => this.activate(i));
        s.addEventListener("click", () => this.activate(i));
      });

      // Re-measure when fonts or highlighting change line heights; re-aim the step detector
      // when the layout switches between side-by-side and stacked.
      this.ro = new ResizeObserver(() => { this.observeSteps(); this.paint(); });
      this.ro.observe(this.code);
      this.ro.observe(this);

      this.classList.add("is-ready");
      this.observeSteps(); // now, not only from the ResizeObserver: rendering may be throttled
      this.activate(0, true);
    }

    /** The active step crosses a detection band: mid-viewport when side by side, and just
        below the pinned code when stacked (the code covers the top half). */
    observeSteps() {
      if (!("IntersectionObserver" in window)) return;
      const wide = getComputedStyle(this.querySelector(".cw-grid")).gridTemplateColumns.split(" ").length > 1;
      if (this.io && this._wide === wide) return;
      this._wide = wide;
      if (this.io) this.io.disconnect();
      this.io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) this.activate(this.steps.indexOf(e.target));
      }, { rootMargin: wide ? "-45% 0px -45% 0px" : "-62% 0px -28% 0px" });
      this.steps.forEach((s) => this.io.observe(s));
    }

    activate(i, instant) {
      if (i < 0 || i === this.index && !instant) return;
      this.index = i;
      this.steps.forEach((s, j) => s.classList.toggle("is-active", j === i));
      this.lit = parseLines(this.steps[i].getAttribute("lines"), this.lineCount);
      this.paint(instant);
    }

    paint(instant) {
      if (!this.lit) return;
      const cs = getComputedStyle(this.code);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.6;
      const top = this.code.offsetTop;
      const width = Math.max(this.pre.scrollWidth, this.pre.clientWidth);
      const parts = runs(this.lit, this.lineCount);
      // Reuse overlay elements so they glide between steps instead of popping.
      while (this.layer.children.length < parts.length) this.layer.append(el("span"));
      [...this.layer.children].forEach((n, k) => {
        const p = parts[k];
        if (!p) { n.style.display = "none"; return; }
        n.style.display = "";
        n.className = this.lit.size === 0 ? "cw-none" : p.on ? "cw-band" : "cw-shade";
        n.style.top = `${top + (p.start - 1) * lh}px`;
        n.style.height = `${(p.end - p.start + 1) * lh}px`;
        n.style.width = `${width}px`;
      });
      this.gutter.style.top = `${top}px`;
      this.gutter.style.lineHeight = `${lh}px`;
      // Keep the first lit line comfortably in view inside the code panel.
      const first = Math.min(...this.lit);
      if (isFinite(first)) {
        const y = top + (first - 1) * lh - lh * 2;
        const behavior = instant || reducedMotion.matches ? "instant" : "smooth";
        this.pre.scrollTo({ top: Math.max(0, y), behavior });
      }
    }

    disconnectedCallback() {
      if (this.io) this.io.disconnect();
      if (this.ro) this.ro.disconnect();
    }
  }

  customElements.define("bh-codewalk", BhCodewalk);
  window.bhModules = Object.assign(window.bhModules || {}, { "codewalk.js": true });
})();
