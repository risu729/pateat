// Rasterizes the extension icon sources into the PNG sizes Chrome reads.
// Chrome does not accept SVG manifest icons, so the PNG files are committed outputs.
import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extension = fileURLToPath(new URL("../apps/extension/", import.meta.url));
const icons = [{ source: "icons/icon.svg", output: "public/icon" }];
// Chrome's guidance draws the 128 px store icon at 96 px with transparent padding.
const sizes = [
  { size: 16, art: 16 },
  { size: 32, art: 32 },
  { size: 48, art: 48 },
  { size: 128, art: 96 },
];

async function render(browser, svg, path, { size, art }) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}body{display:grid;place-items:center;width:${size}px;height:${size}px}</style><img src="${src}" width="${art}" height="${art}">`,
  );
  await page.locator("img").evaluate((image) => image.decode());
  await page.screenshot({ path, omitBackground: true });
  await page.close();
}

const browser = await chromium.launch();
try {
  const jobs = icons.map(async ({ source, output }) => {
    const svg = await readFile(resolve(extension, source), "utf8");
    await mkdir(resolve(extension, output), { recursive: true });
    await Promise.all(
      sizes.map((entry) =>
        render(browser, svg, resolve(extension, output, `${entry.size}.png`), entry),
      ),
    );
    console.log(`${source} -> ${output}/{${sizes.map(({ size }) => size).join(",")}}.png`);
  });
  await Promise.all(jobs);
} finally {
  await browser.close();
}
