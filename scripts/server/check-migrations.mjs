import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Regenerate migrations from the Drizzle schema into a scratch copy and require
// the committed SQL and snapshots to be unchanged. Nothing contacts a database.
const project = fileURLToPath(new URL("../../services/api/", import.meta.url));
const committed = join(project, "migrations");
const scratch = mkdtempSync(join(tmpdir(), "pateat-migrations-"));

function listFiles(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .toSorted();
}

try {
  cpSync(committed, scratch, { recursive: true });
  // drizzle-kit can report some failures with exit status 0, so require its
  // explicit no-change result as well as identical files.
  const output = execFileSync(
    process.execPath,
    [
      join(project, "node_modules", "drizzle-kit", "bin.cjs"),
      "generate",
      "--dialect",
      "sqlite",
      "--schema",
      "src/db/schema.ts",
      "--out",
      // drizzle-kit resolves --out relative to the working directory.
      relative(project, scratch),
    ],
    { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const expected = listFiles(committed);
  const actual = listFiles(scratch);
  const stale =
    !output.includes("No schema changes") ||
    JSON.stringify(expected) !== JSON.stringify(actual) ||
    expected.some(
      (file) => !readFileSync(join(committed, file)).equals(readFileSync(join(scratch, file))),
    );
  if (stale) {
    console.error(
      "services/api/migrations is out of date; run `mise run generate:server-migrations`.",
    );
    process.exitCode = 1;
  } else {
    console.log(`Migrations match the schema (${expected.length} files).`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
