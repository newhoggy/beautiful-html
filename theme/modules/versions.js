/* ==========================================================================
   <bh-versions> — the same diagram in two or more versions, e.g. current vs proposed.

   <bh-versions class="wide">
     <figure class="diagram" id="arch-current" data-label="Current"> … <figcaption/></figure>
     <figure class="diagram" id="arch-proposed" data-label="Proposed"> … <figcaption/></figure>
   </bh-versions>

   - Segmented control switches versions (crossfade, no layout jump: versions share a cell).
   - With exactly two versions, "Compare" overlays them with a draggable divider
     (also a range input, so it works by keyboard).
   - Parts marked data-change="added|changed|removed" are highlighted, with a legend.
   - A link to a version's figure id selects that version (see revealTarget in bh.js).
   Without JS the figures simply stack, each labelled.
   ========================================================================== */
(function () {
  "use strict";
  const bh = window.bh;
  const { el, whenReady, linkLabel } = bh;

  class BhVersions extends HTMLElement {
    connectedCallback() { whenReady(() => this.init()); }

    init() {
      if (this._ready) return;
      this.figures = [...this.querySelectorAll(":scope > figure")];
      if (this.figures.length < 2) return;
      this._ready = true;
      const uid = this.id || "versions-" + Math.random().toString(36).slice(2, 8);

      // Stage: every version occupies the same grid cell.
      this.stage = el("div", { class: "bh-versions-stage" });
      this.figures[0].before(this.stage);
      this.stage.append(...this.figures);

      // Segmented control (ARIA tabs) + compare toggle.
      this.tabs = this.figures.map((f, i) => {
        f.setAttribute("role", "tabpanel");
        const t = el("button", {
          type: "button", role: "tab", id: `${uid}-tab-${i}`, "aria-controls": f.id || null,
          text: f.dataset.label || `Version ${i + 1}`, onclick: () => this.show(i),
        });
        f.setAttribute("aria-labelledby", t.id);
        return t;
      });
      const list = el("div", { class: "bh-versions-tabs", role: "tablist", "aria-label": "Versions" }, this.tabs);
      list.addEventListener("keydown", (e) => {
        const i = this.tabs.indexOf(document.activeElement);
        const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: this.tabs.length - 1 }[e.key];
        if (i < 0 || next === undefined) return;
        e.preventDefault();
        this.show((next + this.tabs.length) % this.tabs.length);
        this.tabs[this.index].focus();
      });
      const bar = el("div", { class: "bh-versions-bar" }, [list]);
      if (this.figures.length === 2) {
        this.compareBtn = el("button", { type: "button", class: "btn ghost bh-versions-compare", "aria-pressed": "false", text: "⇆ Compare", onclick: () => this.setCompare(!this.comparing) });
        bar.append(this.compareBtn);
      }
      this.prepend(bar);

      // Shared caption (each figure's own caption is hidden while enhanced).
      this.caption = el("p", { class: "bh-versions-caption", "aria-live": "polite" });
      this.stage.after(this.caption);

      // Change legend, only if any part is marked.
      const kinds = ["added", "changed", "removed"].filter((k) => this.querySelector(`[data-change="${k}"]`));
      if (kinds.length) {
        this.caption.after(el("ul", { class: "legend bh-versions-legend" }, kinds.map((k) =>
          el("li", {}, [el("span", { class: `swatch change-${k}` }), k[0].toUpperCase() + k.slice(1)]))));
      }

      // Slider for compare mode.
      if (this.figures.length === 2) {
        this.divider = el("div", { class: "bh-versions-divider", "aria-hidden": "true" }, [el("span", { class: "bh-versions-handle" })]);
        this.stage.append(this.divider,
          el("span", { class: "bh-versions-tag left", "aria-hidden": "true", text: this.tabs[0].textContent }),
          el("span", { class: "bh-versions-tag right", "aria-hidden": "true", text: this.tabs[1].textContent }));
        this.range = el("input", {
          type: "range", min: "0", max: "100", value: "50", class: "bh-versions-range",
          "aria-label": `Reveal ${this.tabs[1].textContent} over ${this.tabs[0].textContent}`,
        });
        this.range.addEventListener("input", () => this.setPos(+this.range.value));
        this.caption.before(this.range);
        this.stage.addEventListener("pointerdown", (e) => {
          if (!this.comparing || e.target.closest("a, button")) return;
          this.stage.setPointerCapture(e.pointerId);
          this.dragFrom(e);
          const move = (ev) => this.dragFrom(ev);
          const up = () => { this.stage.removeEventListener("pointermove", move); this.stage.removeEventListener("pointerup", up); };
          this.stage.addEventListener("pointermove", move);
          this.stage.addEventListener("pointerup", up);
        });
      }

      this.classList.add("is-ready");
      const initial = Math.max(0, this.figures.findIndex((f) => f.hasAttribute("data-selected")));
      this.show(initial);
      if (this.getAttribute("mode") === "compare") this.setCompare(true);
    }

    show(i) {
      this.index = Math.max(0, Math.min(this.figures.length - 1, i));
      this.figures.forEach((f, j) => {
        const on = j === this.index;
        f.classList.toggle("is-current", on);
        f.toggleAttribute("inert", !on && !this.comparing);
        this.tabs[j].setAttribute("aria-selected", String(on));
        this.tabs[j].tabIndex = on ? 0 : -1;
      });
      if (this.comparing) this.setCompare(false);
      this.renderCaption();
    }

    setCompare(on) {
      this.comparing = on;
      this.classList.toggle("is-comparing", on);
      if (this.compareBtn) this.compareBtn.setAttribute("aria-pressed", String(on));
      this.figures.forEach((f, j) => f.toggleAttribute("inert", !on && j !== this.index));
      if (on) this.setPos(this.range ? +this.range.value : 50);
      this.renderCaption();
    }

    setPos(pct) {
      const p = Math.max(0, Math.min(100, pct));
      this.style.setProperty("--pos", p + "%");
      if (this.range && +this.range.value !== Math.round(p)) this.range.value = Math.round(p);
    }

    dragFrom(e) {
      const r = this.stage.getBoundingClientRect();
      this.setPos(((e.clientX - r.left) / r.width) * 100);
    }

    renderCaption() {
      const describe = (f) => {
        const cap = f.querySelector(":scope > figcaption");
        return [el("strong", { text: `${linkLabel(f)} · ${f.dataset.label || ""}` }), cap ? " — " + cap.textContent.trim() : ""];
      };
      if (this.comparing) {
        this.caption.replaceChildren(el("span", {}, describe(this.figures[0])), el("br"), el("span", {}, describe(this.figures[1])));
      } else {
        this.caption.replaceChildren(...describe(this.figures[this.index]));
      }
    }
  }

  customElements.define("bh-versions", BhVersions);
  window.bhModules = Object.assign(window.bhModules || {}, { "versions.js": true });
})();
