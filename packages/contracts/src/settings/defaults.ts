import type { LocalSettings, VaultCatalog } from "./schema";

/** Synthetic display metadata only. No field values, credentials or provider sessions. */
export const DUMMY_VAULT_CATALOG: VaultCatalog = {
  connections: [
    {
      id: "demo-personal",
      label: "Demo personal vault",
      provider: "dummy",
      server: "cloud-us",
      userId: "demo-personal-account",
      groups: [{ id: "everyday", label: "Everyday", kind: "folder" }],
      items: [
        {
          id: "primary",
          label: "Demo primary account",
          allowedOrigins: ["https://bank.example"],
          groupIds: ["everyday"],
          fields: [
            { id: "username", label: "Username", name: null, kind: "text" },
            { id: "password", label: "Password", name: null, kind: "hidden" },
            { id: "branch", label: "Branch number", name: "Branch number", kind: "text" },
          ],
        },
        {
          id: "secondary",
          label: "Demo secondary account",
          allowedOrigins: ["https://bank.example", "https://mail.example"],
          groupIds: [],
          fields: [
            { id: "username", label: "Username", name: null, kind: "text" },
            { id: "password", label: "Password", name: null, kind: "hidden" },
          ],
        },
      ],
    },
    {
      id: "demo-work",
      label: "Demo work vault",
      provider: "dummy",
      server: "cloud-us",
      userId: "demo-work-account",
      groups: [{ id: "team", label: "Team", kind: "collection" }],
      items: [
        {
          id: "primary",
          label: "Demo team account",
          allowedOrigins: ["https://bank.example"],
          groupIds: ["team"],
          fields: [
            { id: "username", label: "Username", name: null, kind: "text" },
            { id: "password", label: "Password", name: null, kind: "hidden" },
          ],
        },
      ],
    },
  ],
};

export function createDefaultSettings(catalog: VaultCatalog = DUMMY_VAULT_CATALOG): LocalSettings {
  return {
    connections: [],
    // Demo metadata is safe to preview. New real connections require an explicit grant.
    accountPolicies: catalog.connections.flatMap((entry) =>
      entry.provider === "dummy" && entry.userId !== undefined
        ? [
            {
              provider: entry.provider,
              server: entry.server,
              userId: entry.userId,
              accountName: entry.label,
              enabled: true,
              selection: { mode: "all" as const },
            },
          ]
        : [],
    ),
    itemPolicies: [],
    customFieldReviews: [],
    excludedSites: [],
    repromptSites: [],
    passkeyBrowserSites: [],
    siteDefaults: [],
    bindings: [],
  };
}
