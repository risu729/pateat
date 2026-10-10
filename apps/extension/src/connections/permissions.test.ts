import { expect, it } from "vitest";
import { providerPermissionOrigins } from "./permissions";

it.each([
  [
    { kind: "cloud", region: "us" },
    ["https://identity.bitwarden.com/*", "https://api.bitwarden.com/*"],
  ],
  [
    { kind: "cloud", region: "eu" },
    ["https://identity.bitwarden.eu/*", "https://api.bitwarden.eu/*"],
  ],
  [
    { kind: "self-hosted", baseUrl: "https://VAULT.EXAMPLE:8443/" },
    ["https://vault.example:8443/*"],
  ],
  [{ kind: "self-hosted", baseUrl: "https://vault.example./" }, ["https://vault.example./*"]],
] as const)(
  "requests only the configured provider HTTPS origins for %o",
  (environment, origins) => {
    expect(providerPermissionOrigins(environment)).toEqual({ ok: true, data: origins });
  },
);

it.each([
  "http://vault.example",
  "https://vault.example/api",
  "https://user@vault.example",
  "https://vault.example?x=1",
  "https://vault.example#secret",
  "https://*.example",
  "https://*/*",
])("never turns malformed configured URL %s into a broader permission", (baseUrl) => {
  expect(providerPermissionOrigins({ kind: "self-hosted", baseUrl }).ok).toBe(false);
});
