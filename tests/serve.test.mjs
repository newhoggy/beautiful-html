import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bh-serve-"));
  const root = path.join(dir, "repo");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(source, "scripts/bh.mjs"), path.join(root, "scripts/bh.mjs"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ repository: "github:example/blog" }));
  fs.writeFileSync(path.join(root, "index.html"), "<h1>Home</h1>");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/index.html"), "<h1>Docs</h1>");
  fs.writeFileSync(path.join(root, "docs/a page.html"), "<h1>Encoded path</h1>");
  fs.mkdirSync(path.join(root, "theme"));
  fs.writeFileSync(path.join(root, "theme/test.css"), "body { color: red; }");
  // Both a sibling sharing ROOT's prefix and an unrelated sibling really exist.
  for (const name of ["repo-secrets", "outside"]) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, "secret.txt"), "Must not be served");
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Allocate an available port before launching the actual CLI, which accepts a port argument.
  const reservation = http.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const proc = spawn(process.execPath, [path.join(root, "scripts/bh.mjs"), "serve", String(port)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stderr.on("data", (data) => { output += data; });
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = once(proc, "exit");
      proc.kill();
      await exited;
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Server startup timed out: ${output}`)), 5000);
    const onExit = () => finish(new Error(`Server exited during startup: ${output}`));
    const onData = (data) => { output += data; if (output.includes("Serving ")) finish(); };
    const finish = (error) => {
      clearTimeout(timer);
      proc.off("exit", onExit);
      proc.off("error", finish);
      proc.stdout.off("data", onData);
      error ? reject(error) : resolve();
    };
    proc.once("exit", onExit);
    proc.once("error", finish);
    proc.stdout.on("data", onData);
  });
  return (requestPath) => new Promise((resolve, reject) => {
    // Pass the path directly: URL-based clients normalize literal traversal segments.
    const req = http.get({ hostname: "127.0.0.1", port, path: requestPath }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (data) => { body += data; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on("error", reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
  });
}

test("serve rejects malformed URLs and traversal while preserving pages and build metadata", async (t) => {
  const request = await fixture(t);
  for (const url of ["/%E0%A4%A", "/%", "//["]) {
    assert.equal((await request(url)).status, 400, url);
    assert.equal((await request("/")).body, "<h1>Home</h1>", "server remains alive");
  }
  for (const url of ["/..%2frepo-secrets/secret.txt", "/..%2foutside/secret.txt"]) {
    assert.equal((await request(url)).status, 403, url);
  }
  for (const [url, body] of [["/", "<h1>Home</h1>"], ["/docs/", "<h1>Docs</h1>"], ["/docs/a%20page.html", "<h1>Encoded path</h1>"]]) {
    const res = await request(url);
    assert.equal(res.status, 200);
    assert.equal(res.body, body);
    assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(res.headers["cache-control"], "no-cache");
  }
  const css = await request("/theme/test.css");
  assert.equal(css.status, 200);
  assert.equal(css.body, "body { color: red; }");
  assert.equal(css.headers["content-type"], "text/css");
  assert.equal((await request("/missing.html")).status, 404);
  const build = await request("/theme/build.js");
  assert.equal(build.status, 200);
  assert.equal(build.headers["content-type"], "text/javascript");
  assert.equal(build.headers["cache-control"], "no-cache");
  const window = {};
  vm.runInNewContext(build.body, { window });
  assert.equal(window.BH_BUILD.repo, "example/blog");
  assert.ok(Number.isFinite(Date.parse(window.BH_BUILD.builtAt)));
});
