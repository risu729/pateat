// Checks every local link and asset reference in the built site: the target file must
// exist, and a fragment must name an element ID on the target page.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const dist = path.resolve(".vitepress/dist");
if (!existsSync(dist)) throw new Error(`Build the site first: ${dist} is missing.`);

/** @param {string} directory */
function htmlFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return htmlFiles(full);
    return entry.name.endsWith(".html") ? [full] : [];
  });
}

/** Maps a site path to its built file, as cleanUrls serves it. @param {string} pathname */
function resolve(pathname) {
  const file = path.join(dist, decodeURIComponent(pathname));
  if (!file.startsWith(dist)) return undefined;
  for (const candidate of [file, `${file}.html`, path.join(file, "index.html")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

const ids = new Map();
/** @param {string} file */
function idsOf(file) {
  if (!ids.has(file)) {
    const source = readFileSync(file, "utf8");
    ids.set(file, new Set([...source.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])));
  }
  return ids.get(file);
}

const pages = htmlFiles(dist);
const failures = [];
let count = 0;
for (const page of pages) {
  const source = readFileSync(page, "utf8");
  const pageUrl = new URL(
    `/${path.relative(dist, page).replaceAll(path.sep, "/")}`,
    "https://site.invalid",
  );
  for (const match of source.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
    const reference = match[1].replaceAll("&amp;", "&");
    if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith("//")) continue;
    const url = new URL(reference, pageUrl);
    const target = resolve(url.pathname);
    const name = path.relative(dist, page);
    count++;
    if (!target) {
      failures.push(`${name}: missing target: ${reference}`);
      continue;
    }
    const fragment = decodeURIComponent(url.hash.slice(1));
    if (fragment && target.endsWith(".html") && !idsOf(target).has(fragment)) {
      failures.push(`${name}: missing fragment: ${reference}`);
    }
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${count} local references in ${pages.length} built pages.`);
}
