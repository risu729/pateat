import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Offline serialization evidence, not an API/load benchmark. Read the owning constants
// without importing browser/Worker modules or executing their code.
const root = new URL("../", import.meta.url);
const sources = new Map();
function constant(file, name) {
  const source = sources.get(file) ?? readFileSync(new URL(file, root), "utf8");
  sources.set(file, source);
  const declaration = source.match(new RegExp(`^(?:export )?const ${name} = ([^;]+);$`, "m"));
  assert.ok(declaration, `Missing constant ${name} in ${file}`);
  const factors = declaration[1].trim().split(/\s*\*\s*/u);
  // Integer or decimal literals, such as `1.5 * 1024 * 1024`; the product must be whole.
  assert.ok(
    factors.every((factor) => /^\d[\d_]*(?:\.\d+)?$/u.test(factor)),
    "Review changed constant syntax",
  );
  const value = factors.reduce(
    (product, factor) => product * Number(factor.replaceAll("_", "")),
    1,
  );
  assert.ok(Number.isSafeInteger(value) && value > 0, "Expected a positive byte/count limit");
  return value;
}
const limits = {
  recipeCacheBytes: constant("packages/contracts/src/sync.ts", "MAX_RECIPE_CACHE_BYTES"),
  activeRecipeBytes: constant("packages/contracts/src/sync.ts", "MAX_ACTIVE_RECIPE_BYTES"),
  activeRecipes: constant("services/api/src/limits.ts", "MAX_ACTIVE_RECIPES"),
  keptRecipeRevisions: constant("services/api/src/limits.ts", "KEPT_RECIPE_REVISIONS"),
  settingsDocumentBytes: constant("packages/contracts/src/sync.ts", "MAX_SETTINGS_DOCUMENT_BYTES"),
  apiBodyBytes: constant("services/api/src/app.ts", "MAX_BODY_BYTES"),
  pairingBodyBytes: constant("services/api/src/app.ts", "MAX_PAIR_BYTES"),
};
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const target = (value) => ({ by: "id", value });
function recipe(index, kind) {
  const japanese = kind === "two-page-japanese" || kind === "wide-japanese-markers";
  const label = (english, translated) => ({ by: "text", value: japanese ? translated : english });
  return {
    version: 1,
    id: `synthetic-${String(index).padStart(6, "0")}`,
    revision: 1,
    origin: "https://login.example.test",
    pageKind: "sign-in",
    slots: kind === "password" ? ["password"] : ["username", "password"],
    steps: [
      ...(kind === "password"
        ? []
        : [
            {
              kind: "fill",
              effect: "prepare",
              path: "/login",
              fields: [{ slot: "username", target: target("username") }],
            },
            {
              kind: "click",
              path: "/login",
              target: label("Continue", "次へ進む"),
              purpose: "advance",
            },
          ]),
      {
        kind: "fill",
        effect: "prepare",
        path: kind === "password" ? "/login" : "/password",
        fields: [{ slot: "password", target: target("password") }],
      },
      {
        kind: "click",
        path: kind === "password" ? "/login" : "/password",
        target: label("Sign in", "ログインする"),
        purpose: "submit",
      },
    ],
    completion:
      kind === "wide-japanese-markers"
        ? Array.from({ length: 4 }, (_, marker) => ({
            target: { by: "text", value: `${marker}${"ア".repeat(119)}` },
          }))
        : [{ target: label("Account overview", "アカウントの概要") }],
    maxSubmissions: kind === "password" ? 1 : 2,
  };
}
function cache(count, kind) {
  return {
    version: 1,
    origin: "https://pateat.example.test",
    deviceId: "00000000-0000-4000-8000-000000000001",
    cursor: count,
    recipes: Array.from({ length: count }, (_, index) => recipe(index, kind)),
  };
}
function measure(kind) {
  // Fixed-width identifiers make each recipe equal-sized through this search range.
  let lower = 0;
  let upper = 10_000;
  assert.ok(bytes(cache(upper, kind)) > limits.recipeCacheBytes);
  while (lower + 1 < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (bytes(cache(middle, kind)) <= limits.recipeCacheBytes) lower = middle;
    else upper = middle;
  }
  const fittingBytes = bytes(cache(lower, kind));
  const nextBytes = bytes(cache(upper, kind));
  assert.ok(fittingBytes <= limits.recipeCacheBytes && nextBytes > limits.recipeCacheBytes);
  // The service's owner cap counts the UTF-8 bytes of each active recipe document only.
  const recipeBytes = bytes(recipe(0, kind));
  const ownerCapCount = Math.floor(limits.activeRecipeBytes / recipeBytes);
  const ownerCapRecipes = Math.min(ownerCapCount, limits.activeRecipes);
  const cacheAtOwnerCap = bytes(cache(ownerCapRecipes, kind));
  // Within the owner's caps, a device's whole cache must fit its own cap.
  assert.ok(cacheAtOwnerCap <= limits.recipeCacheBytes);
  return {
    kind,
    recipeDocumentBytes: recipeBytes,
    cacheAtActiveRecipeLimitBytes: bytes(cache(limits.activeRecipes, kind)),
    fitsAtActiveRecipeLimit: bytes(cache(limits.activeRecipes, kind)) <= limits.recipeCacheBytes,
    largestCountWithinOwnerBytes: ownerCapCount,
    cacheAtOwnerCapsBytes: cacheAtOwnerCap,
    largestFittingCount: lower,
    fittingCacheBytes: fittingBytes,
    nextCount: upper,
    nextCacheBytes: nextBytes,
  };
}
const samples = ["password", "two-page-english", "two-page-japanese", "wide-japanese-markers"].map(
  measure,
);
const expectedRevision = Number.MAX_SAFE_INTEGER - 1;
const settingsEnvelopeBytes = bytes({ version: 1, expectedRevision, settings: null }) - bytes(null);
assert.ok(limits.settingsDocumentBytes + settingsEnvelopeBytes < limits.apiBodyBytes);
const report = {
  scope:
    "Offline synthetic JSON UTF-8 serialization; no accounts, network, model or browser storage writes",
  node: process.version,
  sources: [...sources].map(([file, source]) => ({
    file,
    sha256: createHash("sha256").update(source).digest("hex"),
  })),
  limits,
  settingsEnvelope: {
    expectedRevision,
    wrapperBytes: settingsEnvelopeBytes,
    maximumDocumentWithWrapperBytes: limits.settingsDocumentBytes + settingsEnvelopeBytes,
    bodyHeadroomBytes: limits.apiBodyBytes - limits.settingsDocumentBytes - settingsEnvelopeBytes,
  },
  samples,
};
// An optional output path is deliberately not supported: shell redirection keeps this
// command read-only unless the caller chooses to save its JSON.
assert.equal(process.argv.length, 2, `Usage: node ${fileURLToPath(import.meta.url)}`);
console.log(JSON.stringify(report, null, 2));
