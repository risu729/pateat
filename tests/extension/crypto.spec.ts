import { expect, test } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withLoginExtension } from "./login-fixture";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const production = resolve(repository, "apps/extension/.output/chrome-mv3");
const probe = resolve(repository, "apps/extension/.output/chrome-mv3-probe");

test("crypto probe packages native WASM under MV3 CSP and stays out of production", async () => {
  const productionFiles = await readdir(production, { recursive: true });
  expect(productionFiles).not.toContain("crypto-probe.html");
  expect(productionFiles.filter((file) => file.endsWith(".wasm"))).toEqual([]);
  const manifest = JSON.parse(await readFile(resolve(probe, "manifest.json"), "utf8"));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.content_security_policy.extension_pages).toContain("'wasm-unsafe-eval'");
  expect(manifest.content_security_policy.extension_pages).not.toContain("'unsafe-eval'");
  expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"]);
  const files = await readdir(probe, { recursive: true });
  expect(files).toContain("crypto-probe.html");
  const wasmFiles = files.filter((file) => file.endsWith(".wasm"));
  expect(wasmFiles).toHaveLength(1);
  const bytes = await readFile(resolve(probe, wasmFiles[0]!));
  expect(Array.from(bytes.subarray(0, 8))).toEqual([0, 97, 115, 109, 1, 0, 0, 0]);
});

test("packaged Dedicated Worker executes real SDK vectors without external requests", async () => {
  await withLoginExtension(async (context, _background, extensionId) => {
    const externalRequests: string[] = [];
    const wasmRequests: string[] = [];
    context.on("request", (request) => {
      const url = request.url();
      if (/^https?:/u.test(url)) externalRequests.push(url);
      if (url.endsWith(".wasm")) wasmRequests.push(url);
    });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/crypto-probe.html`);
    const createdWorker = page.waitForEvent("worker");
    await page.locator("#run-vectors").click();
    const worker = await createdWorker;
    expect(worker.url()).toMatch(new RegExp(`^chrome-extension://${extensionId}/`));
    await expect(page.locator("#status")).toHaveText("Complete", { timeout: 15_000 });
    const results = JSON.parse((await page.locator("#results").textContent()) ?? "null");
    expect(results).toEqual({
      pbkdf2: true,
      argon2id: true,
      loginMatches: true,
      corruptionRejected: true,
      v2Verified: true,
      authPbkdf2: true,
      authArgon2id: true,
      mappedV1Login: true,
      mappedV2Blob: true,
    });
    expect(wasmRequests).toHaveLength(1);
    expect(wasmRequests[0]).toMatch(new RegExp(`^chrome-extension://${extensionId}/`));
    expect(externalRequests).toEqual([]);
  });
});

test("cancellation terminates the computing Worker and a fresh Worker remains usable", async () => {
  await withLoginExtension(async (context, _background, extensionId) => {
    const externalRequests: string[] = [];
    context.on("request", (request) => {
      if (/^https?:/u.test(request.url())) externalRequests.push(request.url());
    });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/crypto-probe.html`);
    const computingWorker = page.waitForEvent("worker");
    await page.locator("#run-kdf").click();
    const oldWorker = await computingWorker;
    let closed = false;
    oldWorker.on("close", () => {
      closed = true;
    });
    await expect(page.locator("#status")).toHaveText("Computing", { timeout: 10_000 });
    await page.locator("#cancel").click();
    await expect(page.locator("#status")).toHaveText("Cancelled", { timeout: 5_000 });
    await expect.poll(() => closed, { timeout: 5_000 }).toBe(true);
    await expect(page.locator("#results")).toHaveText("");
    const nextWorker = page.waitForEvent("worker");
    await page.locator("#run-vectors").click();
    expect(await nextWorker).not.toBe(oldWorker);
    await expect(page.locator("#status")).toHaveText("Complete", { timeout: 15_000 });
    expect(JSON.parse((await page.locator("#results").textContent()) ?? "null")).toEqual({
      pbkdf2: true,
      argon2id: true,
      loginMatches: true,
      corruptionRejected: true,
      v2Verified: true,
      authPbkdf2: true,
      authArgon2id: true,
      mappedV1Login: true,
      mappedV2Blob: true,
    });
    expect(externalRequests).toEqual([]);
  });
});
