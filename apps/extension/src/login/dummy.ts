import {
  DUMMY_VAULT_CATALOG,
  parseLoginRecipe,
  type LoginAccountBinding,
  type LoginRecipe,
  type VaultCatalog,
} from "@pateat/contracts";

export const DEFAULT_PROBE_ORIGIN = "http://127.0.0.1:3847";
/** Bundled synthetic adapter. This is not a Bitwarden connection or a production grant. */
export function createProbeCatalog(origin = DEFAULT_PROBE_ORIGIN): VaultCatalog {
  const catalog = structuredClone(DUMMY_VAULT_CATALOG);
  catalog.connections[0]!.items[0]!.allowedOrigins.push(origin);
  return catalog;
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
export function probeBinding(recipe: LoginRecipe): LoginAccountBinding {
  return {
    origin: recipe.origin,
    connectionId: "demo-personal",
    itemId: "primary",
    slots: recipe.slots.map((slot) => ({ slot, fieldId: slot === "account" ? "username" : slot })),
  };
}

/** Resolve one allowed field at a time; no values enter recipes, metadata or status. */
export function resolveDummyField(fieldId: string): string | undefined {
  if (fieldId === "branch") return "007";
  if (fieldId === "username") return "00001234";
  if (fieldId === "password") return "Pateat-synthetic-only!";
  return undefined;
}
