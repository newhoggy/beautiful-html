/* ==========================================================================
   Unlisted cards — the home page's cards for unlisted pages.

   Loaded for <ul data-unlisted-cards>. Only when the page was opened with #unlisted=true does it
   fetch theme/unlisted-pages.js (BH_UNLISTED) and add a card per unlisted page to the list, each
   labelled "Unlisted" in words. The list was written by `npm run index` without them, so with the
   flag off (or without JavaScript) no unlisted title is anywhere in the page.

   build(page) is the one card builder: the markup is the same as cmdIndex writes for a listed page
   (tests/unlisted.test.mjs compares them), so a card looks and filters like any other.
   It is exposed as bh.cards.build so other generated cards can share it. Text goes in through
   textContent, never innerHTML.
   ========================================================================== */
(function () {
  "use strict";
  const bh = window.bh;
  const { el } = bh;

  /** The <li> card for a page record of BH_UNLISTED (see buildSiteData in scripts/bh.mjs). */
  function build(p) {
    const tags = p.tags || [];
    const search = [p.title, p.description, tags.join(", "), p.kind].join(" ").toLowerCase();
    const eyebrow = (p.example ? "Example · " : "") + (p.unlisted ? "Unlisted · " : "") + (p.kindLabel || p.kind);
    return el("li", {
      class: "card doc-card" + (p.replacedBy ? " is-superseded" : ""),
      "data-example": !!p.example, "data-unlisted": !!p.unlisted,
      "data-kind": p.kind, "data-tags": tags.join(","), "data-search": search,
    }, [
      el("a", { class: "card-link", href: p.href }, [
        el("span", { class: "eyebrow", text: eyebrow }),
        el("h3", { text: p.title }),
        el("p", { text: p.description }),
      ]),
      el("span", { class: "card-meta" }, [
        p.status ? el("span", { class: "badge " + p.status.toLowerCase(), text: p.status }) : null,
        p.date ? el("time", { datetime: p.date, text: p.date }) : null,
      ]),
      p.replacedBy ? el("p", { class: "card-replaced" }, ["Replaced by ", el("a", { href: p.replacedBy.href, text: p.replacedBy.title })]) : null,
    ]);
  }

  /** Newest first, then by title: the order cmdIndex sorts the listed cards in. */
  const before = (a, b) => (b.date || "").localeCompare(a.date || "") || a.title.localeCompare(b.title);

  function insert(list, pages) {
    const existing = [...list.children].map((node) => ({
      node,
      date: ((node.querySelector("time") || {}).dateTime) || "",
      title: (node.querySelector("h3") || {}).textContent || "",
    }));
    for (const page of pages.slice().sort(before)) {
      const next = existing.find((e) => before(page, e) < 0);
      const card = build(page);
      list.insertBefore(card, next ? next.node : null);
      existing.splice(next ? existing.indexOf(next) : existing.length, 0, { node: card, date: page.date || "", title: page.title });
    }
  }

  function start() {
    const list = document.querySelector("ul[data-unlisted-cards]");
    if (!list || !bh.unlisted.visible) return;
    bh.settle(bh.unlisted.data().then((data) => {
      if (!data || !data.pages.length) return;
      insert(list, data.pages);
      // The filter read the list before these arrived: have it read it again (chips, search, count).
      const filter = document.querySelector(`bh-filter[for="${list.id}"]`);
      if (filter && filter.refresh) filter.refresh();
    }));
  }

  bh.cards = { build, insert };
  start();
  window.bhModules = Object.assign(window.bhModules || {}, { "unlisted-cards.js": true });
})();
