import { describe, expect, it } from "vitest";
import type { LocalSettings, VaultItemMetadata } from "@pateat/contracts";
import { waitsForMasterPassword, type DetailSite } from "./details";

// Items with Bitwarden's re-prompt as a personal detail's source (ADR 0061; owner,
// 2026-10-23 21:50 UTC): on a site in `repromptSites`, an item other than the login item is
// read only once the login holds the master password. Synthetic vault data only.
const item = (id: string, reprompt: boolean): Pick<VaultItemMetadata, "id" | "reprompt"> => ({
  id,
  ...(reprompt ? { reprompt: true as const } : {}),
});
const policy = (asks: boolean): LocalSettings => ({
  connections: [],
  accountPolicies: [],
  itemPolicies: [],
  customFieldReviews: [],
  excludedSites: [],
  repromptSites: asks ? [{ hostname: "bank.example", includeSubdomains: true }] : [],
  passkeyBrowserSites: [],
  siteDefaults: [],
  bindings: [],
});
const site = (verified: boolean, url = "https://www.bank.example/confirm"): DetailSite => ({
  url,
  verified,
});

describe("an item with Bitwarden's re-prompt as a detail's source", () => {
  it("waits on a site that asks for an identity or a card until the login holds the master password", () => {
    expect(waitsForMasterPassword(policy(true), item("card", true), "login", site(false))).toBe(
      true,
    );
    expect(waitsForMasterPassword(policy(true), item("card", true), "login", site(true))).toBe(
      false,
    );
  });

  it("never waits on a site that does not ask, whether or not the login holds it", () => {
    for (const verified of [false, true])
      expect(
        waitsForMasterPassword(policy(false), item("card", true), "login", site(verified)),
      ).toBe(false);
    // Another site than the listed one does not ask either.
    expect(
      waitsForMasterPassword(
        policy(true),
        item("card", true),
        "login",
        site(false, "https://other.example/confirm"),
      ),
    ).toBe(false);
  });

  it("never waits for an item without the re-prompt, or for the login item itself", () => {
    expect(waitsForMasterPassword(policy(true), item("card", false), "login", site(false))).toBe(
      false,
    );
    // The login item's own answers and member IDs: its login started after the password.
    expect(waitsForMasterPassword(policy(true), item("login", true), "login", site(false))).toBe(
      false,
    );
  });

  it("waits on a page whose URL does not read as a site, so a doubt never skips the question", () => {
    expect(
      waitsForMasterPassword(policy(false), item("card", true), "login", site(false, "not a url")),
    ).toBe(true);
  });
});
