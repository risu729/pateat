import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const checker = resolve("apps/docs/check-links.mjs");

test("the docs link check resolves the deployed prefix, relative pages and fragments", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "pateat-docs-links-"));
  try {
    mkdirSync(resolve(directory, ".vitepress/dist/docs/ja"), { recursive: true });
    writeFileSync(
      resolve(directory, ".vitepress/dist/docs/index.html"),
      '<a href="/docs/setup#step">Setup</a><a href="/docs/ja/">日本語</a><img src="/docs/icon.svg">',
    );
    writeFileSync(
      resolve(directory, ".vitepress/dist/docs/setup.html"),
      '<h1 id="step">Setup</h1><a href="./">Home</a>',
    );
    writeFileSync(
      resolve(directory, ".vitepress/dist/docs/ja/index.html"),
      '<a href="../setup#step">English setup</a>',
    );
    writeFileSync(resolve(directory, ".vitepress/dist/docs/icon.svg"), "<svg/>");
    const checked = spawnSync(process.execPath, [checker], { cwd: directory, encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /Checked 5 local references in 3 built pages/);
    writeFileSync(
      resolve(directory, ".vitepress/dist/docs/setup.html"),
      '<a href="/setup">Unprefixed</a><a href="/docs/missing">Missing</a>',
    );
    const broken = spawnSync(process.execPath, [checker], { cwd: directory, encoding: "utf8" });
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /missing target: \/setup/);
    assert.match(broken.stderr, /missing target: \/docs\/missing/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
