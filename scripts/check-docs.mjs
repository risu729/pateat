import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter((file) => file.endsWith(".md"));
const failures = [];
let count = 0;

for (const file of new Set(files)) {
  const source = readFileSync(path.join(root, file), "utf8");
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^[a-z]+:/i.test(target)) continue;
    const [relative, fragment] = target.split("#");
    const resolved = relative
      ? path.resolve(path.dirname(path.join(root, file)), decodeURIComponent(relative))
      : path.join(root, file);
    if (!resolved.startsWith(root + path.sep) || !existsSync(resolved)) {
      failures.push(`${file}: missing or out-of-repository link: ${target}`);
      continue;
    }
    if (fragment) {
      const headings = readFileSync(resolved, "utf8")
        .split("\n")
        .filter((line) => /^#{1,6} /.test(line))
        .map((line) =>
          line
            .replace(/^#+ /, "")
            .trim()
            .toLowerCase()
            .replace(/[^\w\s-]/g, "")
            .replace(/\s/g, "-"),
        );
      if (!headings.includes(fragment)) failures.push(`${file}: missing heading: ${target}`);
    }
    count++;
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${files.length} Markdown files and ${count} local links.`);
}
