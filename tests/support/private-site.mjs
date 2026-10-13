// A throwaway copy of the site for tests of private pages, with `op` replaced by a script on PATH
// that keeps its items in a JSON file, so the real cmdSeal and cmdCheck run end to end without
// touching a vault (or holding a real key).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseCardsFile, renderCardsFile } from "../../scripts/private-cards.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const FAKE_OP = `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.FAKE_OP_STATE;
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { items: [], archived: [] };
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const [a, b, ...rest] = process.argv.slice(2);
if (a !== "item") { console.error("[ERROR] fake op: unsupported " + a); process.exit(1); }
if (b === "get") {
  const item = state.items.find((i) => i.title === rest[0]);
  if (!item) { console.error('[ERROR] 2026/01/01 00:00:00 "' + rest[0] + '" isn\\'t an item in the "Private" vault.'); process.exit(1); }
  console.log(JSON.stringify(item));
} else if (b === "create") {
  const item = JSON.parse(fs.readFileSync(0, "utf8"));
  item.id = "id" + (state.items.length + state.archived.length);
  state.items.push(item); save(); console.log(JSON.stringify({ id: item.id }));
} else if (b === "delete" && rest.includes("--archive")) {
  const i = state.items.findIndex((x) => x.title === rest[0]);
  if (i < 0) { console.error("[ERROR] not found"); process.exit(1); }
  state.archived.push(...state.items.splice(i, 1)); save();
} else { console.error("[ERROR] fake op: unsupported " + b); process.exit(1); }
`;

export function site(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bh-private-cards-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "site"), bin = path.join(temp, "bin"), state = path.join(temp, "op-state.json");
  fs.mkdirSync(root); fs.mkdirSync(bin);
  for (const entry of ["scripts", "theme", "docs", "templates", "reviews", "package.json", "index.html"]) {
    fs.cpSync(path.join(ROOT, entry), path.join(root, entry), { recursive: true });
  }
  // The real sealed pages belong to the real vault: this site starts with none.
  for (const f of fs.readdirSync(path.join(root, "docs")).filter((f) => f.endsWith(".html"))) {
    if (/<meta\s+name="bh:sealed"/.test(fs.readFileSync(path.join(root, "docs", f), "utf8"))) fs.rmSync(path.join(root, "docs", f));
  }
  fs.writeFileSync(path.join(root, "theme/private-cards.js"), renderCardsFile([]));
  fs.writeFileSync(path.join(bin, "op"), FAKE_OP, { mode: 0o755 });
  const env = (withOp) => ({ ...process.env, PATH: (withOp ? bin + path.delimiter : "") + path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin", FAKE_OP_STATE: state, BH_OP_VAULT: "Private", CI: "" });
  const run = (args, { withOp = true } = {}) => {
    const r = spawnSync(process.execPath, [path.join(root, "scripts/bh.mjs"), ...args], { cwd: root, env: env(withOp), encoding: "utf8" });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const write = (rel, text) => fs.writeFileSync(path.join(root, rel), text);
  const items = () => JSON.parse(fs.existsSync(state) ? fs.readFileSync(state, "utf8") : '{"items":[]}').items;
  const field = (title, label) => items().find((i) => i.title === title)?.fields.find((f) => f.label === label)?.value;
  const entries = () => parseCardsFile(read("theme/private-cards.js")).entries;
  const newPrivate = (slug, title, group) => {
    const r = run(["new", "--private", "explainer", slug, title, `About ${title}`]);
    assert.equal(r.code, 0, r.out);
    if (group) setGroup(slug, group);
  };
  const setGroup = (slug, group) => {
    const rel = `docs/${slug}.private.html`, html = read(rel).replace(/\s*<meta name="bh:group"[^>]*>/, "");
    const next = group ? html.replace(/(<meta name="bh:tags"[^>]*>)/, `$1\n  <meta name="bh:group" content="${group}">`) : html;
    assert.ok(!group || next !== html, "the group meta was not injected");
    write(rel, next);
  };
  const setMeta = (slug, name, value) => {
    const rel = `docs/${slug}.private.html`, html = read(rel), next = html.replace(new RegExp(`(<meta name="${name}" content=")[^"]*"`), `$1${value}"`);
    assert.notEqual(next, html, `${name} was not changed`);
    write(rel, next);
  };
  return { root, run, read, write, items, field, entries, newPrivate, setGroup, setMeta };
}

