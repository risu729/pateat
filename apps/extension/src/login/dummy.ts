import {
  DUMMY_VAULT_CATALOG,
  parseLoginRecipe,
  recipeStartSteps,
  type LoginAccountBinding,
  type LoginRecipe,
  type VaultCatalog,
} from "@pateat/contracts";
import type { LoginRecipeStart } from "./runtime";

export const DEFAULT_PROBE_ORIGIN = "http://127.0.0.1:3847";
/** Bundled synthetic adapter. This is not a Bitwarden connection or a production grant. */
export function createProbeCatalog(): VaultCatalog {
  return structuredClone(DUMMY_VAULT_CATALOG);
}

const target = (value: string) => ({ by: "id" as const, value });
const PROBE_PATHS = [
  "/identity",
  "/single",
  "/delayed-result",
  "/rejection",
  "/unknown",
  "/ambiguous",
  "/delayed",
  "/input-submit",
  "/change-submit",
  "/input-advance",
  "/spa-login",
  "/dialog",
  "/slow-button",
  "/text-submit",
  "/variants",
  "/passkey",
  "/totp",
  "/identifier-first",
];
/** Where every synthetic recipe starts, which a fixture document watches for. */
export function probeStarts(origin: string): LoginRecipeStart[] {
  return PROBE_PATHS.map((path) => {
    const recipe = probeRecipe(origin, path)!;
    return { path: recipe.steps[0]!.path, steps: recipeStartSteps(recipe) };
  });
}
/**
 * Two identifier sets on one page (ADR 0027): a contract number, which the demo account
 * has no mapping for, or a branch and account number. Only the second variant fits it.
 */
function variantsRecipe(origin: string, path: string): LoginRecipe {
  const set = (slots: string[]) => ({
    slots,
    steps: [
      {
        kind: "fill" as const,
        path,
        fields: slots.map((slot) => ({ slot, target: target(slot) })),
      },
      { kind: "click" as const, path, target: target("login"), purpose: "submit" as const },
    ],
  });
  const contract = set(["contract", "password"]);
  return parseLoginRecipe({
    version: 1,
    id: "demo-variants",
    revision: 1,
    origin,
    pageKind: "sign-in",
    ...contract,
    alternatives: [set(["branch", "account", "password"])],
    completion: [{ target: target("authenticated") }],
    rejection: target("rejected"),
    maxSubmissions: 1,
  });
}
/**
 * A password page followed by an authenticator app code page (ADR 0027): the `totp`
 * handler fills the code into `#code` and clicks `#verify`.
 */
function totpRecipe(origin: string, path: string): LoginRecipe {
  return parseLoginRecipe({
    version: 1,
    id: "demo-totp",
    revision: 1,
    origin,
    pageKind: "sign-in",
    slots: ["password"],
    steps: [
      { kind: "fill", path, fields: [{ slot: "password", target: target("password") }] },
      { kind: "click", path, target: target("login"), purpose: "submit" },
    ],
    handlers: [
      { kind: "totp", path: "/totp-code", field: target("code"), target: target("verify") },
    ],
    completion: [{ target: target("authenticated") }],
    rejection: target("rejected"),
    maxSubmissions: 1,
  });
}
/**
 * An identifier-first form (ADR 0013): Next hides the account form and shows the password
 * form in the same document and on the same path, so only the password form's elements
 * confirm the advance.
 */
function identifierFirstRecipe(origin: string, path: string): LoginRecipe {
  return parseLoginRecipe({
    version: 1,
    id: "demo-identifier-first",
    revision: 1,
    origin,
    pageKind: "sign-in",
    slots: ["account", "password"],
    steps: [
      { kind: "fill", path, fields: [{ slot: "account", target: target("account") }] },
      { kind: "click", path, target: target("next"), purpose: "advance" },
      { kind: "fill", path, fields: [{ slot: "password", target: target("password") }] },
      { kind: "click", path, target: target("login"), purpose: "submit" },
    ],
    completion: [{ target: target("authenticated") }],
    rejection: target("rejected"),
    maxSubmissions: 2,
  });
}
export function probeRecipe(origin: string, path: string): LoginRecipe | undefined {
  if (!PROBE_PATHS.includes(path)) return undefined;
  if (path === "/variants") return variantsRecipe(origin, path);
  if (path === "/totp") return totpRecipe(origin, path);
  if (path === "/identifier-first") return identifierFirstRecipe(origin, path);
  const multi = path === "/identity";
  const inputAdvance = path === "/input-advance";
  const inputSubmit = path === "/input-submit" || path === "/change-submit";
  return parseLoginRecipe({
    version: 1,
    id: `demo-${path.slice(1)}`,
    revision: 1,
    origin,
    pageKind: "sign-in",
    slots: multi
      ? ["branch", "account", "password"]
      : inputAdvance
        ? ["account", "password"]
        : ["password"],
    steps: inputAdvance
      ? [
          {
            kind: "fill",
            path,
            fields: [{ slot: "account", target: target("account") }],
            effect: "advance",
            event: "input",
          },
          {
            kind: "wait",
            path: "/password",
            target: target("password"),
            present: true,
            timeoutMs: 3000,
          },
          {
            kind: "fill",
            path: "/password",
            fields: [{ slot: "password", target: target("password") }],
          },
          { kind: "click", path: "/password", target: target("login"), purpose: "submit" },
        ]
      : inputSubmit
        ? [
            {
              kind: "fill",
              path,
              fields: [{ slot: "password", target: target("password") }],
              effect: "submit",
              event: path === "/change-submit" ? "change" : "input",
            },
          ]
        : multi
          ? [
              {
                kind: "fill",
                path,
                fields: [
                  { slot: "branch", target: target("branch") },
                  { slot: "account", target: target("account") },
                ],
              },
              { kind: "assert", path, target: target("next"), present: true },
              { kind: "click", path, target: target("next"), purpose: "advance" },
              {
                kind: "wait",
                path: "/password",
                target: target("password"),
                present: true,
                timeoutMs: 3000,
              },
              {
                kind: "fill",
                path: "/password",
                fields: [{ slot: "password", target: target("password") }],
              },
              { kind: "click", path: "/password", target: target("login"), purpose: "submit" },
            ]
          : [
              ...(path === "/delayed"
                ? [
                    {
                      kind: "wait",
                      path,
                      target: target("password"),
                      present: true,
                      timeoutMs: 5000,
                    },
                  ]
                : []),
              {
                kind: "fill",
                path,
                fields: [
                  {
                    slot: "password",
                    target:
                      path === "/ambiguous"
                        ? { by: "name", value: "password" }
                        : target("password"),
                  },
                ],
              },
              {
                kind: "click",
                path,
                target: path === "/text-submit" ? { by: "text", value: "Log in" } : target("login"),
                purpose: "submit",
              },
            ],
    completion: [{ target: target("authenticated") }],
    rejection: target("rejected"),
    ...(path === "/single" ? { accountSwitch: { by: "text", value: "Use another account" } } : {}),
    // The start page's passkey sign-in button (ADR 0027).
    ...(path === "/passkey" ? { passkey: { path, target: target("passkey") } } : {}),
    maxSubmissions: multi || inputAdvance ? 2 : 1,
  });
}
export type ProbeAccount = {
  connectionId: string;
  itemId: string;
  slots: { slot: string; fieldId: string }[];
};
/** The bundled demo item. A configured probe account replaces it as one explicit binding. */
export const DEMO_PROBE_ACCOUNT: ProbeAccount = {
  connectionId: "demo-personal",
  itemId: "primary",
  slots: [
    { slot: "branch", fieldId: "branch" },
    { slot: "account", fieldId: "username" },
    { slot: "password", fieldId: "password" },
  ],
};
/** The account's mappings for `slots`, the slots of the route a login tries. */
export function probeBinding(
  recipe: LoginRecipe,
  account: ProbeAccount,
  slots: readonly string[],
): LoginAccountBinding {
  return {
    origin: recipe.origin,
    connectionId: account.connectionId,
    itemId: account.itemId,
    // A route slot without an explicit mapping fails plan resolution; nothing is guessed.
    slots: account.slots.filter((entry) => slots.includes(entry.slot)),
  };
}
/**
 * Synthetic origin grant for the loopback fixture only. Live provider URI matching
 * supplies production origins; this never derives an origin from vault data. A bundled
 * demo item also gets a synthetic TOTP field in the copy, which a `totp` handler fills
 * (ADR 0027).
 */
export function grantProbeOrigin(
  catalog: VaultCatalog,
  origin: string,
  account: Pick<ProbeAccount, "connectionId" | "itemId">,
): VaultCatalog {
  const granted = structuredClone(catalog);
  const connection = granted.connections.find((entry) => entry.id === account.connectionId);
  const item = connection?.items.find((entry) => entry.id === account.itemId);
  if (item && !item.allowedOrigins.includes(origin)) item.allowedOrigins.push(origin);
  if (connection?.provider === "dummy" && item && !item.fields.some((field) => field.id === "totp"))
    item.fields.push({ id: "totp", label: "TOTP", name: null, kind: "otp" });
  return granted;
}

/** Resolve one allowed field at a time; no values enter recipes, metadata or status. */
export function resolveDummyField(fieldId: string): string | undefined {
  if (fieldId === "branch") return "007";
  if (fieldId === "username") return "00001234";
  if (fieldId === "password") return "Pateat-synthetic-only!";
  // A fixed synthetic code; the probe vault holds no TOTP secret.
  if (fieldId === "totp") return "012345";
  return undefined;
}
