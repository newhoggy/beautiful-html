/* ==========================================================================
   Private cards — the home-page cards of sealed pages, shown to whoever holds the key.

   `npm run seal` encrypts each private page's card (title, description, kind, status, date,
   tags) into theme/private-cards.js, under the same key as the page. A group of pages shares
   one key (<meta name="bh:group">). Opening index.html#k=<key> (repeat k= for several groups)
   decrypts the blobs that key opens and merges their cards into the catalogue.

   Keys come from the fragment, from sessionStorage["bh-index-keys"] (keys that opened cards
   earlier in this tab) and from the sealed pages opened in this tab (bh-sealed-key:*). With
   none of them nothing happens: no request, no UI. Keys are removed from the address bar,
   never logged, and never written into the page except in the card links the reader follows
   (docs/<slug>.html#k=<key>). Decrypted text is inserted with textContent, never as HTML.

   bh.js loads this module only where keys exist, then calls bh.privateCards.start() inside
   bh.settle(), so data-bh-ready waits for the cards. The module is inert until start().
   `bundle` inlines it into every page; start() does nothing where there is no catalogue.
   ========================================================================== */
(function () {
  "use strict";
  const bh = window.bh;
  const doc = document;
  const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
  const INDEX_KEYS = "bh-index-keys", SEALED_KEY_PREFIX = "bh-sealed-key:";
  const AAD = "bh-card/1:";
  const KIND_LABELS = { explainer: "Explainer", design: "Design doc", decision: "Decision", incident: "Incident", review: "Review", reference: "Reference" };
  const SVG_NS = "http://www.w3.org/2000/svg";

  // ---- the card -----------------------------------------------------------------------------
  //
  // A card is described as a small tree, { tag, attrs: [[name, value]], children }, so the same
  // description can be built into DOM here and serialised in a test, where it must equal what
  // `npm run index` writes for a public card (scripts/private-cards.mjs, docCardHtml).

  /**
   * d: { href, title, description, kind, status, date, supersededBy (href or ""), example }
   * titles: Map from a supersededBy href to the title shown after "Replaced by".
   * `label` adds the "Private" mark (a lock and the word, so the state is not carried by colour).
   */
  function cardSpec(d, tags, titles, label) {
    const search = [d.title, d.description, tags.join(", "), d.kind].join(" ").toLowerCase();
    const kindLabel = KIND_LABELS[d.kind] || d.kind;
    const t = (tag, attrs, children) => ({ tag, attrs: attrs || [], children: children || [] });
    const meta = [];
    if (label) meta.push(t("span", [["class", "card-private"]], [lock(), "Private"]));
    if (d.status) meta.push(t("span", [["class", "badge " + d.status.toLowerCase()]], [d.status]));
    if (d.date) meta.push(t("time", [["datetime", d.date]], [d.date]));
    return t("li", [
      ["class", "card doc-card" + (d.supersededBy ? " is-superseded" : "")],
      ...(d.example ? [["data-example", ""]] : []),
      ["data-kind", d.kind], ["data-tags", tags.join(",")], ["data-search", search],
    ], [
      t("a", [["class", "card-link"], ["href", d.href]], [
        t("span", [["class", "eyebrow"]], [d.example ? "Example · " + kindLabel : kindLabel]),
        t("h3", [], [d.title]),
        t("p", [], [d.description]),
      ]),
      t("span", [["class", "card-meta"]], meta),
      ...(d.supersededBy ? [t("p", [["class", "card-replaced"]], ["Replaced by ", t("a", [["href", d.supersededBy]], [titles.get(d.supersededBy) || d.supersededBy])])] : []),
    ]);
  }

  /** The padlock: a body and a shackle, drawn with currentColor. */
  function lock() {
    return {
      tag: "svg", svg: true,
      attrs: [["viewBox", "0 0 16 16"], ["width", "12"], ["height", "12"], ["aria-hidden", "true"], ["focusable", "false"]],
      children: [
        { tag: "path", svg: true, attrs: [["d", "M5 7V5a3 3 0 0 1 6 0v2"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "1.5"], ["stroke-linecap", "round"]], children: [] },
        { tag: "rect", svg: true, attrs: [["x", "3"], ["y", "7"], ["width", "10"], ["height", "7"], ["rx", "1.5"], ["fill", "currentColor"]], children: [] },
      ],
    };
  }

  function build(spec) {
    if (typeof spec === "string") return doc.createTextNode(spec);
    const node = spec.svg ? doc.createElementNS(SVG_NS, spec.tag) : doc.createElement(spec.tag);
    for (const [name, value] of spec.attrs) node.setAttribute(name, value);
    for (const child of spec.children) node.append(build(child));
    return node;
  }

  // ---- keys ---------------------------------------------------------------------------------

  function fragmentParts() {
    return location.hash.slice(1).split("&").filter(Boolean);
  }

  function storedKeys(name) {
    try { const v = JSON.parse(sessionStorage.getItem(name) || "[]"); return Array.isArray(v) ? v.filter((k) => KEY_RE.test(k)) : []; } catch (_) { return []; }
  }

  function sealedPageKeys() {
    const out = [];
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const name = sessionStorage.key(i);
        if (name && name.startsWith(SEALED_KEY_PREFIX)) out.push(sessionStorage.getItem(name));
      }
    } catch (_) { /* storage blocked */ }
    return out.filter((k) => KEY_RE.test(k));
  }

  /** Remove the k= parameters from the address bar, keeping any other fragment (a section id). */
  function stripKeys() {
    const rest = fragmentParts().filter((p) => !/^k=/.test(p));
    try { history.replaceState(null, "", location.pathname + location.search + (rest.length ? "#" + rest.join("&") : "")); } catch (_) { /* not worth failing for */ }
  }

  // ---- decrypting ---------------------------------------------------------------------------

  const bytes = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const fromBase64Url = (s) => bytes(s.replace(/-/g, "+").replace(/_/g, "/") + "=");

  async function inflate(buffer) {
    return new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  }

  /** The card in `blob` under `cryptoKey`, bound to `slug`; null when the key does not open it. */
  async function open(blob, cryptoKey, slug) {
    try {
      const raw = bytes(blob);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12), additionalData: new TextEncoder().encode(AAD + slug) }, cryptoKey, raw.slice(12));
      return clean(JSON.parse(await inflate(plain)));
    } catch (_) { return null; }
  }

  const text = (v) => (typeof v === "string" ? v : "");

  /** A decrypted card with every field a string (or list of strings): it is still data from a file. */
  function clean(c) {
    if (!c || typeof c !== "object" || !text(c.title)) return null;
    return {
      title: text(c.title), description: text(c.description), kind: text(c.kind) || "explainer", status: text(c.status),
      date: /^\d{4}-\d{2}-\d{2}$/.test(text(c.date)) ? c.date : "",
      tags: (Array.isArray(c.tags) ? c.tags : []).filter((t) => typeof t === "string" && t),
      supersededBy: /^[a-z0-9-]+$/.test(text(c.supersededBy)) ? c.supersededBy : "",
    };
  }

  // ---- the catalogue ------------------------------------------------------------------------

  const itemDate = (li) => (li.querySelector("time") || {}).textContent || "";
  const itemTitle = (li) => (li.querySelector("h3") || {}).textContent || "";
  /** Newest first, then by title: the order `npm run index` writes. */
  const before = (a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title);

  function insert(list, li, entry) {
    const next = [...list.children].find((x) => before(entry, { date: itemDate(x), title: itemTitle(x) }) < 0);
    list.insertBefore(li, next || null);
  }

  function show(list, found) {
    const hrefs = new Map(found.map((f) => [f.slug, "docs/" + f.slug + ".html#k=" + f.key]));
    const titles = new Map(found.map((f) => [hrefs.get(f.slug), f.card.title]));
    for (const f of found.slice().sort((a, b) => before(a.card, b.card))) {
      if (list.querySelector('[data-private-slug="' + f.slug + '"]')) continue;
      const replacedBy = f.card.supersededBy && hrefs.get(f.card.supersededBy);
      const li = build(cardSpec({ ...f.card, href: hrefs.get(f.slug), supersededBy: replacedBy || "", example: false }, f.card.tags, titles, true));
      li.dataset.privateSlug = f.slug;
      insert(list, li, f.card);
    }
    const filter = doc.querySelector('bh-filter[for="' + list.id + '"]');
    if (filter && filter.refresh) filter.refresh();
  }

  // ---- start --------------------------------------------------------------------------------

  async function start() {
    const list = doc.querySelector("ul[data-private-cards]");
    if (!list) return;
    const fromHash = fragmentParts().filter((p) => p.startsWith("k=")).map((p) => p.slice(2)).filter((k) => KEY_RE.test(k));
    const remembered = storedKeys(INDEX_KEYS);
    const keys = [...new Set([...fromHash, ...remembered, ...sealedPageKeys()])];
    if (!keys.length) return;
    const typed = fromHash.length > 0; // the reader asked for these, so tell them when it did not work
    try {
      if (!(window.crypto && crypto.subtle) || typeof DecompressionStream === "undefined") throw new Error("unsupported");
      if (!window.BH_PRIVATE) await bh.loadScript(new URL("theme/private-cards.js", bh.siteRoot).href);
      const file = window.BH_PRIVATE;
      if (!file || file.v !== 1 || !Array.isArray(file.cards)) throw new Error("no cards");
      const opened = [];
      for (const key of keys) {
        const cryptoKey = await crypto.subtle.importKey("raw", fromBase64Url(key), "AES-GCM", false, ["decrypt"]);
        opened.push({ key, cryptoKey });
      }
      const found = [], used = new Set();
      for (const { slug, blob } of file.cards) {
        for (const { key, cryptoKey } of opened) {
          const card = await open(blob, cryptoKey, slug);
          if (card) { found.push({ slug, card, key }); used.add(key); break; }
        }
      }
      if (found.length) show(list, found);
      if (typed && fromHash.some((k) => !used.has(k))) bh.toast("No private pages for that key", 3500);
      const keep = [...new Set([...remembered.filter((k) => used.has(k)), ...fromHash.filter((k) => used.has(k))])];
      try { sessionStorage.setItem(INDEX_KEYS, JSON.stringify(keep)); } catch (_) { /* storage blocked */ }
    } catch (_) {
      if (typed || storedKeys(INDEX_KEYS).length) bh.toast("Private pages can't be shown here. This page is the public list.", 4500);
    } finally {
      stripKeys();
    }
  }

  bh.privateCards = { start, cardSpec };
  window.bhModules = window.bhModules || {};
  window.bhModules["private-cards.js"] = true;
})();
