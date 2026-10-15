/* ==========================================================================
   Unlisted pages — whether they are shown, and the page fragment.

   A page marked <meta name="bh:unlisted" content="true"> is published and opens from its direct
   link, but the site does not surface it: it stays off the home page, search, backlinks and
   in-site links unless the page you are on was opened with #unlisted=true. This is discoverability
   control, not access control: the page, its address and the generated data are all public.

   Load it synchronously in <head>, right after theme/examples.js, so the decision is made before
   first paint. It sets
     <html data-unlisted="on|off">   whether unlisted pages are surfaced
     <html data-unlisted-page>       this page is unlisted
   and exposes window.bhUnlisted for bh.js and the modules.

   The flag lives in the fragment, remembered for the tab session so it survives following links:
     #unlisted=true  (or on / 1 / yes)   surface them
     #unlisted=false (or off / 0 / no)   hide them again
     #unlisted=auto                      forget the choice
   Unlike a private page's key it is not secret, so it stays in the address bar.
   Default is off everywhere, including local hosts, so an author sees what readers see.
   A bundled single file (<html data-bundled>) always shows its own content.

   The fragment is a list of &-separated tokens. Reserved: k=<43-char key> (repeatable, read by the
   sealed-page shell) and unlisted=<value>. The first other token without "=" is a section id.
   parseFragment is the one parser; bh.js uses it through bh.fragment().
   ========================================================================== */
(function (g) {
  "use strict";

  var STORE_KEY = "bh-unlisted";
  var KEY_RE = /^k=[A-Za-z0-9_-]{43}$/;

  /** "on", "off", "auto" or null for the value of an unlisted= token. */
  function parseValue(value) {
    value = String(value).toLowerCase();
    if (value === "true" || value === "on" || value === "1" || value === "yes") return "on";
    if (value === "false" || value === "off" || value === "0" || value === "no") return "off";
    return value === "auto" ? "auto" : null;
  }

  /** { id, unlisted, keys } for a location.hash: the section to scroll to ("" if none), the last
      unlisted= choice (null if none) and the k= tokens. A token that is neither reserved nor an
      id (it has "=") is ignored. */
  function parseFragment(hash) {
    var out = { id: "", unlisted: null, keys: [] };
    var tokens = String(hash || "").replace(/^#/, "").split("&");
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      if (!token) continue;
      if (KEY_RE.test(token)) { out.keys.push(token.slice(2)); continue; }
      var eq = token.indexOf("=");
      if (eq < 0) {
        if (!out.id) {
          try { out.id = decodeURIComponent(token); } catch (e) { out.id = token; }
        }
        continue;
      }
      if (token.slice(0, eq) === "unlisted") {
        var value = parseValue(token.slice(eq + 1));
        if (value) out.unlisted = value;
      }
    }
    return out;
  }

  /** { visible, source } for an environment: { hash, bundled, storage }. */
  function resolve(env) {
    if (env.bundled) return { visible: true, source: "bundle" };
    var storage = env.storage, asked = parseFragment(env.hash).unlisted;
    function store(fn) { try { return fn(); } catch (e) { return null; } }
    if (asked === "on" || asked === "off") {
      store(function () { storage.setItem(STORE_KEY, asked); });
      return { visible: asked === "on", source: "fragment" };
    }
    if (asked === "auto") store(function () { storage.removeItem(STORE_KEY); });
    else {
      var kept = store(function () { return storage.getItem(STORE_KEY); });
      if (kept === "on" || kept === "off") return { visible: kept === "on", source: "session" };
    }
    return { visible: false, source: "default" };
  }

  var api = { parseFragment: parseFragment, resolve: resolve, visible: false, source: "default", page: false };

  var doc = g.document;
  if (doc && g.location) {
    var storage = null;
    try { storage = g.sessionStorage; } catch (e) { /* blocked: the choice just isn't remembered */ }
    var root = doc.documentElement;
    var found = resolve({ hash: g.location.hash, bundled: root.hasAttribute("data-bundled"), storage: storage });
    api.visible = found.visible; api.source = found.source;
    // The marker is earlier in <head> than this script, so it has been parsed.
    api.page = !!doc.querySelector('meta[name="bh:unlisted"]');
    root.setAttribute("data-unlisted", api.visible ? "on" : "off");
    if (api.page) root.setAttribute("data-unlisted-page", "");
    // A new #unlisted=… in an open tab changes what the page should show: start over with it.
    if (g.addEventListener && !root.hasAttribute("data-bundled")) {
      g.addEventListener("hashchange", function () {
        // Only an explicit unlisted= in the new fragment changes the choice: a section link must not
        // reload the page (and, with sessionStorage blocked, lose the flag).
        if (!parseFragment(g.location.hash).unlisted) return;
        var next = resolve({ hash: g.location.hash, bundled: false, storage: storage });
        if (next.visible !== api.visible && g.location.reload) g.location.reload();
      });
    }
  }
  g.bhUnlisted = api;
})(typeof window !== "undefined" ? window : globalThis);
