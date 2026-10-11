/* ==========================================================================
   Example pages — where they are shown.

   Pages marked <meta name="bh:example" content="true"> exist to demonstrate the theme and the
   templates. They are shown on a local host (a laptop or desktop) and hidden on a proper domain.
   This is the one place that decides, and the one list of local hosts.

   Load it synchronously in <head>, right after the theme script, so the decision is made before
   first paint and examples never flash on the published site. It sets
     <html data-examples="on|off">   whether examples are shown
     <html data-example-page>        this page is an example
   and exposes window.bhExamples for bh.js and the search module.

   Overrides, remembered for the tab session so they survive following links:
     ?examples  or  ?examples=on    show them (on a domain)
     ?examples=off                  hide them (locally: preview the published site)
     ?examples=auto                 forget the override
   A bundled single file (<html data-bundled>) always shows its own content.
   ========================================================================== */
(function (g) {
  "use strict";

  var STORE_KEY = "bh-examples";

  /** True for a laptop or desktop: file://, localhost, 127.0.0.1, [::1], *.localhost and *.local.
      A LAN address such as 192.168.1.5, or a name that merely contains "localhost", is not local. */
  function isLocalHost(protocol, hostname) {
    if (protocol === "file:") return true;
    var h = String(hostname || "").toLowerCase().replace(/\.$/, "");
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" || /.\.(?:localhost|local)$/.test(h);
  }

  /** "on", "off", "auto" or null for the ?examples query parameter. */
  function parseOverride(search) {
    var value;
    try { value = new URLSearchParams(search || "").get("examples"); } catch (e) { return null; }
    if (value === null) return null;
    value = value.toLowerCase();
    if (value === "" || value === "on" || value === "1" || value === "true" || value === "yes") return "on";
    if (value === "off" || value === "0" || value === "false" || value === "no") return "off";
    return value === "auto" ? "auto" : null;
  }

  /** { visible, local, source } for an environment: { protocol, hostname, search, bundled, storage }. */
  function resolve(env) {
    var local = isLocalHost(env.protocol, env.hostname);
    if (env.bundled) return { visible: true, local: local, source: "bundle" };
    var storage = env.storage, asked = parseOverride(env.search);
    function store(fn) { try { return fn(); } catch (e) { return null; } }
    if (asked === "on" || asked === "off") {
      store(function () { storage.setItem(STORE_KEY, asked); });
      return { visible: asked === "on", local: local, source: "query" };
    }
    if (asked === "auto") store(function () { storage.removeItem(STORE_KEY); });
    else {
      var kept = store(function () { return storage.getItem(STORE_KEY); });
      if (kept === "on" || kept === "off") return { visible: kept === "on", local: local, source: "session" };
    }
    return { visible: local, local: local, source: "host" };
  }

  var api = { isLocalHost: isLocalHost, parseOverride: parseOverride, resolve: resolve, visible: true, local: true, source: "host", page: false };

  var doc = g.document;
  if (doc && g.location) {
    var storage = null;
    try { storage = g.sessionStorage; } catch (e) { /* blocked: the override just isn't remembered */ }
    var root = doc.documentElement;
    var found = resolve({
      protocol: g.location.protocol, hostname: g.location.hostname, search: g.location.search,
      bundled: root.hasAttribute("data-bundled"), storage: storage,
    });
    api.visible = found.visible; api.local = found.local; api.source = found.source;
    // The marker is earlier in <head> than this script, so it has been parsed.
    api.page = !!doc.querySelector('meta[name="bh:example"]');
    root.setAttribute("data-examples", api.visible ? "on" : "off");
    if (api.page) root.setAttribute("data-example-page", "");
  }
  g.bhExamples = api;
})(typeof window !== "undefined" ? window : globalThis);
