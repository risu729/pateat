import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/** One build's third-party packages, by `name@version`, from every chunk's module IDs. */
const bundled = new Map<string, { name: string; version: string }>();

const cssBanner = /\/\*! ((?:@[\w.-]+\/)?[\w.-]+) v(\d+\.\d+\.\d+[\w.+-]*) \|/gu;

/** The installed package that holds a module: the nearest package.json with a name and version. */
export function owningPackage(file: string): { name: string; version: string } | undefined {
  if (!file.split(/[\\/]/u).includes("node_modules")) return undefined;
  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest)) {
      const { name, version } = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (typeof name === "string" && typeof version === "string") return { name, version };
    }
    if (path.basename(directory) === "node_modules" || path.dirname(directory) === directory)
      return undefined;
  }
}

/** Record the packages each WXT build step bundles; the release packs their source. */
export function bundledPackagesPlugin(): Plugin {
  return {
    name: "pateat:bundled-packages",
    apply: "build",
    generateBundle(_options, bundle) {
      const record = (id: string) => {
        if (id.startsWith("\0")) return;
        const found = owningPackage(id.replace(/[?#].*$/u, ""));
        if (found) bundled.set(`${found.name}@${found.version}`, found);
      };
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") for (const id of output.moduleIds) record(id);
        // Tailwind inlines its own stylesheet into the CSS without making it a module; like
        // other CSS packages it keeps its license banner, `/*! tailwindcss v4.3.3 | MIT ...`.
        else if (output.fileName.endsWith(".css") && typeof output.source === "string")
          for (const [, name, version] of output.source.matchAll(cssBanner))
            if (name && version) bundled.set(`${name}@${version}`, { name, version });
      }
    },
  };
}

export function resetBundledPackages() {
  bundled.clear();
}

/** Written beside the output directory, so it is not part of the extension ZIP. */
export function writeBundledPackages(outDir: string) {
  const packages = [...bundled.values()].sort(
    (a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"),
  );
  writeFileSync(`${outDir}.packages.json`, `${JSON.stringify(packages, null, 2)}\n`);
}
