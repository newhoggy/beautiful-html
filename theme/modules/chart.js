/* ==========================================================================
   <bh-chart> — line and column charts from a plain table (dataviz method).

   <figure class="frame wide" id="p99-latency">
     <bh-chart type="line" unit="ms" y-label="p99 latency" [emphasis="After"] [y-min="auto"]>
       <table>
         <thead><tr><th>Day</th><th>Before</th><th>After</th></tr></thead>
         <tbody><tr><td>Mon</td><td>412</td><td>180</td></tr> …</tbody>
       </table>
     </bh-chart>
     <figcaption>…</figcaption>
   </figure>

   - First column = x categories (in order); every other column = one series, coloured by
     its position (--series-1…6), never by rank. emphasis="Name" greys the others.
   - Marks: 2px lines with ringed end dots, a 10% wash under a single line; columns
     ≤ 24px with a rounded data end and a 2px surface gap; hairline solid grid; one axis.
   - Legend for ≥ 2 series; direct end labels for ≤ 4 lines unless they would collide.
   - Hover/focus: crosshair (line) or category band (column) with a tooltip listing every
     series, value first. Arrow keys move it when the chart has focus.
   - The table stays available under "Show data"; without JS it is the content.
   ========================================================================== */
(function () {
  "use strict";
  const bh = window.bh;
  const { el, whenReady } = bh;
  const SVG = "http://www.w3.org/2000/svg";
  const H = 272, PAD = { top: 30, right: 16, bottom: 30, left: 48 }, BAR_MAX = 24, GAP = 2;

  const svgEl = (tag, attrs, text) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };

  function niceStep(span, target) {
    const raw = span / target, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  }
  function ticks(lo, hi) {
    if (hi === lo) hi = lo + 1;
    const step = niceStep(hi - lo, 4);
    const start = Math.floor(lo / step) * step, end = Math.ceil(hi / step) * step;
    const out = [];
    for (let v = start; v <= end + step / 2; v += step) out.push(+v.toFixed(10));
    return out;
  }

  class BhChart extends HTMLElement {
    connectedCallback() { whenReady(() => this.init()); }

    init() {
      if (this._ready) return;
      const table = this.querySelector("table");
      if (!table || !table.tHead || !table.tBodies[0]) return;
      this._ready = true;
      const head = [...table.tHead.rows[0].cells].map((c) => c.textContent.trim());
      this.xName = head[0];
      this.series = head.slice(1).map((name, i) => ({ name, slot: i + 1 }));
      this.rows = [...table.tBodies[0].rows].map((tr) => {
        const cells = [...tr.cells].map((c) => c.textContent.trim());
        return { x: cells[0], v: cells.slice(1).map((t) => (t === "" ? null : +t.replace(/,/g, ""))) };
      });
      this.type = this.getAttribute("type") === "bar" ? "bar" : "line";
      this.unit = this.getAttribute("unit") || "";
      const emph = this.getAttribute("emphasis");
      for (const s of this.series) s.color = emph && s.name !== emph ? "var(--series-muted)" : `var(--series-${Math.min(s.slot, 6)})`;
      if (emph) this.series.forEach((s) => { if (s.name === emph) s.color = "var(--series-1)"; });

      // Layout: legend, plot, data table.
      this.legend = this.series.length > 1 ? el("ul", { class: "chart-legend" }, this.series.map((s) =>
        el("li", {}, [el("span", { class: `chart-key ${this.type}`, style: `--key:${s.color}` }), s.name]))) : null;
      this.plot = el("div", { class: "chart-plot", tabindex: "0" });
      this.tip = el("div", { class: "chart-tip", role: "status", "aria-live": "polite", hidden: true });
      this.plot.append(this.tip);
      const data = el("details", { class: "disclosure chart-data" }, [el("summary", { text: "Show data" })]);
      table.before(data);
      data.append(el("div", { class: "table-wrap" }, [table]));
      this.prepend(...[this.legend, this.plot].filter(Boolean));
      this.plot.setAttribute("aria-label", this.summary());

      this.plot.addEventListener("pointermove", (e) => this.hoverAt(e.clientX));
      this.plot.addEventListener("pointerleave", () => this.hide());
      this.plot.addEventListener("focus", () => this.show(this.index ?? this.rows.length - 1));
      this.plot.addEventListener("blur", () => this.hide());
      this.plot.addEventListener("keydown", (e) => {
        const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (d === undefined) return;
        e.preventDefault();
        // From nothing selected, ← starts at the latest point and → at the first.
        const from = this.index ?? (d < 0 ? this.rows.length : -1);
        this.show(Math.max(0, Math.min(this.rows.length - 1, from + d)));
      });

      this.classList.add("is-ready");
      this.draw();
      this.ro = new ResizeObserver(() => { if (this.plot.clientWidth !== this._w) this.draw(); });
      this.ro.observe(this.plot);
    }

    fmt(v) {
      if (v == null) return "—";
      const tight = /^[%‰°]$/.test(this.unit); // 6.8%, but 180 ms
      return `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}${this.unit ? (tight ? "" : " ") + this.unit : ""}`;
    }

    summary() {
      const kind = this.type === "bar" ? "Column chart" : "Line chart";
      const what = this.getAttribute("y-label") || this.series.map((s) => s.name).join(", ");
      const parts = this.series.map((s, i) => {
        const vals = this.rows.map((r) => r.v[i]).filter((v) => v != null);
        return `${s.name} from ${this.fmt(vals[0])} to ${this.fmt(vals[vals.length - 1])}`;
      });
      return `${kind} of ${what} by ${this.xName}: ${parts.join("; ")}. Use arrow keys to read values.`;
    }

    draw() {
      const W = Math.max(280, this.plot.clientWidth);
      this._w = this.plot.clientWidth;
      const vals = this.rows.flatMap((r) => r.v).filter((v) => v != null);
      const autoMin = this.getAttribute("y-min") === "auto" && this.type === "line";
      const lo = autoMin ? Math.min(...vals) : Math.min(0, ...vals);
      const yt = ticks(lo, Math.max(...vals));
      const y0 = yt[0], y1 = yt[yt.length - 1];
      // Reserve room on the right for direct end labels (lines), estimated from their text.
      let right = PAD.right;
      if (this.type === "line" && this.series.length <= 4) {
        const last = this.rows[this.rows.length - 1];
        const texts = this.series.map((s, i) => (this.series.length > 1 ? `${s.name} ` : "") + this.fmt(last.v[i]));
        right += 8 + Math.max(...texts.map((t) => t.length)) * 6.6;
      }
      const L = PAD.left, R = W - right, T = PAD.top, B = H - PAD.bottom;
      const y = (v) => B - ((v - y0) / (y1 - y0)) * (B - T);
      const n = this.rows.length;
      const band = (R - L) / n;
      const x = this.type === "bar" ? (i) => L + band * (i + 0.5) : (i) => (n === 1 ? (L + R) / 2 : L + ((R - L) * i) / (n - 1));
      this.geom = { x, y, L, R, T, B, band };

      const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" });
      // Grid + y ticks (hairline, solid) and x labels (thinned to fit).
      const grid = svgEl("g", { class: "chart-grid" });
      for (const t of yt) {
        grid.append(svgEl("line", { x1: L, x2: R, y1: y(t), y2: y(t) }));
        grid.append(svgEl("text", { class: "chart-tick", x: L - 8, y: y(t), "text-anchor": "end" }, t.toLocaleString()));
      }
      const every = Math.max(1, Math.ceil((n * 56) / (R - L)));
      this.rows.forEach((r, i) => {
        if (i % every && i !== n - 1) return;
        grid.append(svgEl("text", { class: "chart-tick", x: x(i), y: B + 18, "text-anchor": "middle" }, r.x));
      });
      if (this.getAttribute("y-label")) {
        // The axis title gets its own band above the top gridline.
        grid.append(svgEl("text", { class: "chart-axis-label", x: L - 40, y: 8 }, `${this.getAttribute("y-label")}${this.unit ? ` (${this.unit})` : ""}`));
      }
      svg.append(grid);

      this.hover = svgEl("g", { class: "chart-hover" });
      if (this.type === "line") this.drawLines(svg); else this.drawBars(svg);
      svg.append(this.hover);
      const old = this.plot.querySelector("svg");
      if (old) old.replaceWith(svg); else this.plot.prepend(svg);
      if (this.index != null && !this.tip.hidden) this.show(this.index);
    }

    drawLines(svg) {
      const { x, y } = this.geom;
      const ends = [];
      // De-emphasised series first, so the emphasised one draws on top.
      const order = this.series.map((s, i) => i).sort((a, b) => (this.series[a].color.includes("muted") ? -1 : 0) - (this.series[b].color.includes("muted") ? -1 : 0));
      for (const i of order) {
        const s = this.series[i];
        const pts = this.rows.map((r, k) => (r.v[i] == null ? null : [x(k), y(r.v[i])]));
        const d = pts.reduce((acc, p, k) => (p ? acc + (acc && pts[k - 1] ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1) : acc), "");
        if (this.series.length === 1) {
          const first = pts.find(Boolean), last = [...pts].reverse().find(Boolean);
          svg.append(svgEl("path", { class: "chart-area", style: `fill:${s.color}`, d: `${d}L${last[0]} ${this.geom.B}L${first[0]} ${this.geom.B}Z` }));
        }
        svg.append(svgEl("path", { class: "chart-line", style: `stroke:${s.color}`, d }));
        const lastK = pts.map(Boolean).lastIndexOf(true);
        if (lastK >= 0) {
          svg.append(svgEl("circle", { class: "chart-dot", style: `fill:${s.color}`, cx: pts[lastK][0], cy: pts[lastK][1], r: 4 }));
          ends.push({ s, i, yv: pts[lastK][1], v: this.rows[lastK].v[i] });
        }
      }
      // Direct end labels for ≤ 4 series, only if they don't collide (else legend + tooltip).
      ends.sort((a, b) => a.yv - b.yv);
      const fits = ends.length <= 4 && ends.every((e, k) => k === 0 || e.yv - ends[k - 1].yv >= 15);
      if (fits && this.series.length > 1) {
        this.plot.classList.add("has-end-labels");
        for (const e of ends) svg.append(svgEl("text", { class: "chart-end-label", x: this.geom.R + 8, y: e.yv }, `${e.s.name} ${this.fmt(e.v)}`));
      } else {
        this.plot.classList.remove("has-end-labels");
        if (ends.length === 1) svg.append(svgEl("text", { class: "chart-end-label", x: this.geom.R + 8, y: ends[0].yv }, this.fmt(ends[0].v)));
      }
    }

    drawBars(svg) {
      const { x, y, band } = this.geom;
      const k = this.series.length;
      const w = Math.min(BAR_MAX, (band * 0.7 - GAP * (k - 1)) / k);
      const groupW = w * k + GAP * (k - 1);
      const base = y(0); // bars always grow from zero (the y range includes it)
      let max = { v: -Infinity };
      this.rows.forEach((r, ri) => this.series.forEach((s, si) => {
        const v = r.v[si];
        if (v == null) return;
        const left = x(ri) - groupW / 2 + si * (w + GAP), top = y(v), r4 = Math.min(4, w / 2, Math.abs(base - top));
        // Rounded data end, square at the baseline.
        const d = v >= 0
          ? `M${left} ${base}V${top + r4}Q${left} ${top} ${left + r4} ${top}H${left + w - r4}Q${left + w} ${top} ${left + w} ${top + r4}V${base}Z`
          : `M${left} ${base}V${top - r4}Q${left} ${top} ${left + r4} ${top}H${left + w - r4}Q${left + w} ${top} ${left + w} ${top - r4}V${base}Z`;
        svg.append(svgEl("path", { class: "chart-bar", style: `fill:${s.color}`, d, "data-row": ri }));
        if (v > max.v) max = { v, cx: left + w / 2, top };
      }));
      // Label only the extreme value; the axis, tooltip and table carry the rest.
      if (isFinite(max.v)) svg.append(svgEl("text", { class: "chart-end-label", x: max.cx, y: max.top - 10, "text-anchor": "middle" }, this.fmt(max.v)));
      svg.append(svgEl("line", { class: "chart-baseline", x1: this.geom.L, x2: this.geom.R, y1: base, y2: base }));
    }

    hoverAt(clientX) {
      const r = this.plot.getBoundingClientRect();
      const px = clientX - r.left;
      const { x } = this.geom;
      let best = 0, dist = Infinity;
      this.rows.forEach((_, i) => { const d = Math.abs(x(i) - px); if (d < dist) { dist = d; best = i; } });
      this.show(best);
    }

    show(i) {
      this.index = i;
      const { x, y, T, B, band } = this.geom;
      const row = this.rows[i];
      this.hover.replaceChildren();
      if (this.type === "line") {
        this.hover.append(svgEl("line", { class: "chart-crosshair", x1: x(i), x2: x(i), y1: T, y2: B }));
        this.series.forEach((s, si) => {
          if (row.v[si] == null) return;
          this.hover.append(svgEl("circle", { class: "chart-dot", style: `fill:${s.color}`, cx: x(i), cy: y(row.v[si]), r: 4 }));
        });
      } else {
        this.hover.append(svgEl("rect", { class: "chart-band", x: x(i) - band / 2, y: T, width: band, height: B - T }));
      }
      this.tip.replaceChildren(el("div", { class: "chart-tip-x", text: row.x }), ...this.series.map((s, si) =>
        el("div", { class: "chart-tip-row" }, [
          el("span", { class: "chart-key line", style: `--key:${s.color}` }), // tooltips key with lines, not boxes
          el("strong", { text: this.fmt(row.v[si]) }),
          el("span", { class: "chart-tip-name", text: s.name }),
        ])));
      this.tip.hidden = false;
      // Beside the crosshair, flipped to stay inside the plot.
      const pw = this.plot.clientWidth, tw = this.tip.offsetWidth;
      const left = x(i) + 14 + tw > pw ? x(i) - 14 - tw : x(i) + 14;
      this.tip.style.left = `${Math.max(0, left)}px`;
      this.tip.style.top = `${T}px`;
    }

    hide() { this.tip.hidden = true; this.hover.replaceChildren(); }

    disconnectedCallback() { if (this.ro) this.ro.disconnect(); }
  }

  customElements.define("bh-chart", BhChart);
  window.bhModules = Object.assign(window.bhModules || {}, { "chart.js": true });
})();
