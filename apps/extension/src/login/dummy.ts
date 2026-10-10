import {
  DUMMY_VAULT_CATALOG,
  parseLoginRecipe,
  type LoginAccountBinding,
  type LoginRecipe,
  type VaultCatalog,
} from "@pateat/contracts";

export const DEFAULT_PROBE_ORIGIN = "http://127.0.0.1:3847";
/** Bundled synthetic adapter. This is not a Bitwarden connection or a production grant. */
export function createProbeCatalog(): VaultCatalog {
  return structuredClone(DUMMY_VAULT_CATALOG);
}

const target = (value: string) => ({ by: "id" as const, value });
export function probeRecipe(origin: string, path: string): LoginRecipe | undefined {
  if (
    ![
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
    ].includes(path)
  )
    return undefined;
  const multi = path === "/identity";
  const inputAdvance = path === "/input-advance";
  const inputSubmit = path === "/input-submit" || path === "/change-submit";
  return parseLoginRecipe({
    version: 1,
    id: `demo-${path.slice(1)}`,
    revision: 1,
    origin,
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
              { kind: "click", path, target: target("login"), purpose: "submit" },
            ],
    completion: {
      path: multi || inputAdvance ? "/authenticated" : path,
      target: target("authenticated"),
    },
    rejection: target("rejected"),
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
export function probeBinding(
  recipe: LoginRecipe,
  account: ProbeAccount = DEMO_PROBE_ACCOUNT,
): LoginAccountBinding {
  return {
    origin: recipe.origin,
    connectionId: account.connectionId,
    itemId: account.itemId,
    // A recipe slot without an explicit mapping fails plan resolution; nothing is guessed.
    slots: account.slots.filter((entry) => recipe.slots.includes(entry.slot)),
  };
}
/**
 * Synthetic origin grant for the loopback fixture only. Live provider URI matching
 * supplies production origins; this never derives an origin from vault data.
 */
export function grantProbeOrigin(
  catalog: VaultCatalog,
  origin: string,
  account: Pick<ProbeAccount, "connectionId" | "itemId">,
): VaultCatalog {
  const granted = structuredClone(catalog);
  const item = granted.connections
    .find((entry) => entry.id === account.connectionId)
    ?.items.find((entry) => entry.id === account.itemId);
  if (item && !item.allowedOrigins.includes(origin)) item.allowedOrigins.push(origin);
  return granted;
}

/** Resolve one allowed field at a time; no values enter recipes, metadata or status. */
export function resolveDummyField(fieldId: string): string | undefined {
  if (fieldId === "branch") return "007";
  if (fieldId === "username") return "00001234";
  if (fieldId === "password") return "Pateat-synthetic-only!";
  return undefined;
}
