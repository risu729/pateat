// Rasterizes the extension icon sources into the PNG sizes Chrome reads.
// Chrome does not accept SVG manifest icons, so the PNG files are committed outputs.
import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extension = fileURLToPath(new URL("../apps/extension/", import.meta.url));
const icons = [
  { source: "icons/icon.svg", output: "public/icon" },
  { source: "icons/icon-locked.svg", output: "public/icon-locked" },
];
// The toolbar icon's spin while a tab waits on a model request: the logo turned in 45° steps,
// drawn smaller so its corners stay inside the square at every angle.
const busy = { source: "icons/icon.svg", output: "public/icon-busy", frames: 8, scale: 0.92 };
// Chrome's guidance draws the 128 px store icon at 96 px with transparent padding.
const sizes = [
  { size: 16, art: 16 },
  { size: 32, art: 32 },
  { size: 48, art: 48 },
  { size: 128, art: 96 },
];

async function render(browser, svg, path, { size, art, turn = 0 }) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}body{display:grid;place-items:center;width:${size}px;height:${size}px}</style><img src="${src}" width="${art}" height="${art}" style="transform:rotate(${turn}deg)">`,
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
  const svg = await readFile(resolve(extension, busy.source), "utf8");
  const frames = Array.from({ length: busy.frames }, async (_, frame) => {
    const output = resolve(extension, busy.output, String(frame));
    await mkdir(output, { recursive: true });
    const turn = (360 / busy.frames) * frame;
    await Promise.all(
      [16, 32].map((size) =>
        render(browser, svg, resolve(output, `${size}.png`), {
          size,
          art: size * busy.scale,
          turn,
        }),
      ),
    );
  });
  await Promise.all(frames);
  console.log(`${busy.source} -> ${busy.output}/{0..${busy.frames - 1}}/{16,32}.png`);
  await Promise.all(jobs);
} finally {
  await browser.close();
}
