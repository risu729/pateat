import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("messages to the background", () => {
  it("are all sent through the messaging protocol, never a raw runtime.sendMessage", () => {
    const raw = [...sources(join(root, "src")), ...sources(join(root, "entrypoints"))]
      .filter((path) => /runtime\s*\.\s*sendMessage\b/.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path));
    expect(raw).toEqual([]);
  });
});
