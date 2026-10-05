/* ==========================================================================
   <bh-sequence> — sequence diagrams drawn with the theme's diagram vocabulary.

   <figure class="diagram wide" id="seq-request">
     <bh-sequence aria-label="A request through the limiter">
       <bh-actor data-id="client" class="c3">Client</bh-actor>
       <bh-actor data-id="limiter" class="c5">Limiter</bh-actor>
       <bh-msg data-id="m-req" from="client" to="limiter">GET /orders</bh-msg>
       <bh-note data-id="n-take" over="limiter">take 1 token</bh-note>     (over="a b" spans)
       <bh-msg data-id="m-ok" from="limiter" to="client" reply>200 OK</bh-msg>
       <bh-msg from="limiter" to="limiter">refill</bh-msg>                 (self message)
     </bh-sequence>
     <figcaption>…</figcaption>
   </figure>

   Actors are .node groups with dashed lifelines; messages are .edge paths whose tips
   land on the target lifeline (path ends ARROW_LEN + 1 short, per the arrow rule);
   replies are dashed. Parts keep their data-id, so <bh-stepper for> and data-ref work.
   Without JS the source reads as a list of messages.
   ========================================================================== */
(function () {
  "use strict";
  const bh = window.bh;
  const SVG = "http://www.w3.org/2000/svg";
  const ARROW_LEN = 10;          // must match the marker size in bh.js
  const ACTOR_H = 40, TOP = 0;
  const ROW = 46, SELF_ROW = 58, NOTE_H = 30, NOTE_GAP = 14, FIRST_ROW = ACTOR_H + 34;
  const MIN_GAP = 170, LABEL_PAD = 44;

  // Text widths are estimated (no layout pass needed); generous so labels never collide.
  const textWidth = (text, size) => text.length * size * 0.6;

  function svgEl(tag, attrs, text) {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  }

  class BhSequence extends HTMLElement {
    connectedCallback() { bh.whenReady(() => this.render()); }

    render() {
      if (this._ready) return;
      const actors = [...this.querySelectorAll(":scope > bh-actor")].map((a, i) => ({
        id: a.dataset.id || `actor-${i + 1}`, name: a.textContent.trim(),
        tone: [...a.classList].find((c) => /^c[1-6]$/.test(c)) || "c6",
      }));
      if (!actors.length) return;
      this._ready = true;
      const index = new Map(actors.map((a, i) => [a.id, i]));

      const rows = [];
      let n = 0;
      for (const child of this.children) {
        const tag = child.tagName;
        if (tag === "BH-MSG") {
          const from = index.get(child.getAttribute("from")), to = index.get(child.getAttribute("to"));
          if (from === undefined || to === undefined) { console.warn("[bh-sequence] unknown actor in", child); continue; }
          rows.push({ kind: "msg", id: child.dataset.id || `msg-${++n}`, from, to, label: child.textContent.trim(), reply: child.hasAttribute("reply") });
        } else if (tag === "BH-NOTE") {
          const over = (child.getAttribute("over") || "").split(/[\s,]+/).map((a) => index.get(a)).filter((i) => i !== undefined);
          if (!over.length) { console.warn("[bh-sequence] note needs over=\"actor\"", child); continue; }
          rows.push({ kind: "note", id: child.dataset.id || `note-${++n}`, over, label: child.textContent.trim() });
        }
      }

      // ---- Horizontal layout: actor widths, then gaps wide enough for every label.
      const widths = actors.map((a) => Math.max(110, textWidth(a.name, 14) + 32));
      const gaps = actors.slice(1).map((_, i) => Math.max(MIN_GAP, (widths[i] + widths[i + 1]) / 2 + 40));
      for (const r of rows) {
        if (r.kind !== "msg" || r.from === r.to) continue;
        const lo = Math.min(r.from, r.to), hi = Math.max(r.from, r.to);
        const need = textWidth(r.label, 13) + LABEL_PAD;
        const have = gaps.slice(lo, hi).reduce((a, b) => a + b, 0);
        if (have < need) for (let i = lo; i < hi; i++) gaps[i] += (need - have) / (hi - lo);
      }
      const xs = [widths[0] / 2];
      gaps.forEach((g, i) => xs.push(xs[i] + g));
      // Self messages loop to the right of the last column; leave room for their labels.
      const selfRight = Math.max(0, ...rows.filter((r) => r.kind === "msg" && r.from === r.to)
        .map((r) => xs[r.from] + 46 + textWidth(r.label, 13) - xs[xs.length - 1] - widths[widths.length - 1] / 2));
      const width = xs[xs.length - 1] + widths[widths.length - 1] / 2 + selfRight;

      // ---- Vertical layout.
      let y = FIRST_ROW;
      for (const r of rows) {
        if (r.kind === "note") { r.y = y; y += NOTE_H + NOTE_GAP; }
        else if (r.from === r.to) { r.y = y; y += SELF_ROW; }
        else { r.y = y; y += ROW; }
      }
      const bottom = y;

      // ---- Draw.
      const label = this.getAttribute("aria-label") || `Sequence between ${actors.map((a) => a.name).join(", ")}`;
      const svg = svgEl("svg", { viewBox: `-16 -16 ${width + 32} ${bottom + 32}`, role: "img", "aria-label": label });
      // Never scale up: 1 unit = 1 CSS px, so text matches the page (it may scale down).
      svg.style.maxWidth = `${width + 32}px`;
      const gLines = svgEl("g"), gActors = svgEl("g"), gRows = svgEl("g");
      svg.append(gLines, gRows, gActors);

      actors.forEach((a, i) => {
        const x = xs[i], w = widths[i];
        gLines.append(svgEl("path", { class: "seq-lifeline", "data-id": a.id, d: `M${x} ${TOP + ACTOR_H} V${bottom}` }));
        const g = svgEl("g", { class: `node ${a.tone}`, "data-id": a.id });
        g.append(svgEl("rect", { x: x - w / 2, y: TOP, width: w, height: ACTOR_H, rx: 10 }), svgEl("text", { x, y: TOP + ACTOR_H / 2 }, a.name));
        gActors.append(g);
      });

      for (const r of rows) {
        if (r.kind === "note") {
          const lo = Math.min(...r.over), hi = Math.max(...r.over);
          const w = Math.max(textWidth(r.label, 12) + 28, hi > lo ? xs[hi] - xs[lo] + 60 : 0);
          const cx = (xs[lo] + xs[hi]) / 2;
          const g = svgEl("g", { class: "node seq-note", "data-id": r.id });
          g.append(svgEl("rect", { x: cx - w / 2, y: r.y - NOTE_H / 2, width: w, height: NOTE_H, rx: 6 }),
            svgEl("text", { class: "sub", x: cx, y: r.y }, r.label));
          gRows.append(g);
          continue;
        }
        const x1 = xs[r.from], x2 = xs[r.to];
        const cls = `edge${r.reply ? " dashed" : ""}`;
        if (r.from === r.to) {
          // Loop out to the right and back; the final run points left onto the lifeline.
          const d = `M${x1} ${r.y - 10} H${x1 + 40} V${r.y + 14} H${x1 + ARROW_LEN + 1}`;
          gRows.append(svgEl("path", { class: cls, "data-id": r.id, d }),
            svgEl("text", { class: "label", "data-id": r.id, x: x1 + 48, y: r.y + 2, "text-anchor": "start" }, r.label));
        } else {
          const dir = Math.sign(x2 - x1);
          const end = x2 - dir * (ARROW_LEN + 1);
          gRows.append(svgEl("path", { class: cls, "data-id": r.id, d: `M${x1} ${r.y} H${end}` }),
            svgEl("text", { class: "label", "data-id": r.id, x: (x1 + x2) / 2, y: r.y - 11, "text-anchor": "middle" }, r.label));
        }
      }

      // Screen readers get the sequence as an ordered list.
      const list = bh.el("ol", { class: "visually-hidden" }, rows.map((r) => bh.el("li", {
        text: r.kind === "note"
          ? `Note over ${r.over.map((i) => actors[i].name).join(" and ")}: ${r.label}`
          : `${actors[r.from].name} to ${actors[r.to].name}${r.reply ? " (reply)" : ""}: ${r.label}`,
      })));

      this.replaceChildren(svg, list);
      this.classList.add("is-ready");
      bh.ensureMarkers();
    }
  }

  customElements.define("bh-sequence", BhSequence);
  window.bhModules = Object.assign(window.bhModules || {}, { "sequence.js": true });
})();
