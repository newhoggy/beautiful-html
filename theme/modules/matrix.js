/* ==========================================================================
   <bh-matrix> — weighted decision matrix, authored as a plain table.

   <bh-matrix class="wide" id="db-choice">
     <table>
       <caption>Scores 1–5 (higher is better); weights 0–5.</caption>
       <thead><tr><th>Criterion</th><th>Weight</th><th>PostgreSQL</th><th>DynamoDB</th></tr></thead>
       <tbody>
         <tr><th>Transactions</th><td>4</td><td>5</td><td>2</td></tr>
       </tbody>
     </table>
   </bh-matrix>

   Weights become sliders; scores show as five-dot meters (numbers stay for screen
   readers); a weighted-score row ranks the options and marks the leader (ties included);
   a live region announces a change of leader; Reset restores the authored weights.
   Without JS it is the authored table.
   ========================================================================== */
(function () {
  "use strict";
  const bh = window.bh;
  const { el, whenReady } = bh;
  const MAX = 5;

  class BhMatrix extends HTMLElement {
    connectedCallback() { whenReady(() => this.init()); }

    init() {
      if (this._ready) return;
      const table = this.querySelector("table");
      const head = table && table.tHead && table.tHead.rows[0];
      if (!head || head.cells.length < 4) return;
      this._ready = true;
      this.options = [...head.cells].slice(2).map((c) => c.textContent.trim());
      this.headCells = [...head.cells].slice(2);
      this.rows = [...table.tBodies[0].rows].map((tr) => {
        const cells = [...tr.cells];
        return {
          name: cells[0].textContent.trim(),
          weightCell: cells[1],
          initial: +cells[1].textContent.trim() || 0,
          scoreCells: cells.slice(2),
          scores: cells.slice(2).map((c) => +c.textContent.trim() || 0),
        };
      });

      if (!table.parentElement.classList.contains("table-wrap")) {
        const wrap = el("div", { class: "table-wrap" });
        table.before(wrap);
        wrap.append(table);
      }

      // Weight sliders.
      for (const r of this.rows) {
        r.input = el("input", { type: "range", min: "0", max: String(MAX), step: "1", value: String(r.initial), "aria-label": `Weight for ${r.name}` });
        r.out = el("output", { class: "mx-weight-value", text: String(r.initial) });
        r.input.addEventListener("input", () => this.update());
        r.weightCell.replaceChildren(el("div", { class: "mx-weight" }, [r.input, r.out]));
      }
      // Score meters.
      for (const r of this.rows) {
        r.scoreCells.forEach((c, i) => {
          const s = r.scores[i];
          const dots = el("span", { class: "mx-dots", "aria-hidden": "true" },
            Array.from({ length: MAX }, (_, k) => el("span", { class: k < s ? "on" : "" })));
          c.replaceChildren(dots, el("span", { class: "visually-hidden", text: `${s} of ${MAX}` }));
          c.classList.add("mx-score");
        });
      }
      // Totals row.
      this.totalCells = this.options.map(() => el("td", { class: "mx-total" }));
      const tfoot = table.tFoot || table.createTFoot();
      tfoot.replaceChildren(el("tr", {}, [el("th", { scope: "row", text: "Weighted score" }), el("td"), ...this.totalCells]));

      this.status = el("p", { class: "mx-status" });
      // Screen readers hear only a change of leader, not every slider step.
      this.live = el("p", { class: "visually-hidden", "aria-live": "polite" });
      this.reset = el("button", { type: "button", class: "btn ghost", text: "Reset weights", onclick: () => {
        for (const r of this.rows) r.input.value = String(r.initial);
        this.update();
      } });
      this.append(el("div", { class: "mx-bar" }, [this.status, this.reset]), this.live);
      this.classList.add("is-ready");
      this.update(true);
    }

    update(first) {
      const weights = this.rows.map((r) => +r.input.value);
      this.rows.forEach((r, i) => { r.out.textContent = String(weights[i]); });
      const wsum = weights.reduce((a, b) => a + b, 0);
      const totals = this.options.map((_, j) =>
        wsum ? this.rows.reduce((acc, r, i) => acc + weights[i] * r.scores[j], 0) / (wsum * MAX) : 0);
      const best = Math.max(...totals);
      const leaders = this.options.filter((_, j) => wsum && Math.abs(totals[j] - best) < 1e-9);

      totals.forEach((t, j) => {
        const pct = Math.round(t * 100);
        const lead = leaders.includes(this.options[j]);
        this.totalCells[j].replaceChildren(
          el("span", { class: "mx-total-bar", style: `--pct:${pct}%`, "aria-hidden": "true" }),
          el("span", { class: "mx-total-value", text: `${pct}%` }));
        for (const c of [this.headCells[j], this.totalCells[j], ...this.rows.map((r) => r.scoreCells[j])]) c.classList.toggle("is-leader", lead);
      });

      const changed = this.rows.some((r, i) => weights[i] !== r.initial);
      this.reset.disabled = !changed;
      const summary = !wsum ? "All weights are zero."
        : leaders.length > 1 ? `Tie: ${leaders.join(" and ")} (${Math.round(best * 100)}%).`
        : `${leaders[0]} leads with ${Math.round(best * 100)}%${changed ? " under your weights" : ""}.`;
      this.status.textContent = summary;
      const key = leaders.join("|");
      if (!first && key !== this._leaders) this.live.textContent = summary;
      this._leaders = key;
    }
  }

  customElements.define("bh-matrix", BhMatrix);
  window.bhModules = Object.assign(window.bhModules || {}, { "matrix.js": true });
})();
