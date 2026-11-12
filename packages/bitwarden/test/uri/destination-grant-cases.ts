import { expect, it } from "vitest";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  resolveSiteAccount,
} from "../../../contracts/src/settings";
import { matchBitwardenLoginUris } from "../../src/uri";

export function registerDestinationGrant() {
  it.each([
    { uri: "https://bank.example", match: 2, target: "https://bank.example.evil.test/login" },
    { uri: "https://bank.example", match: 0, target: "http://bank.example/login" },
    { uri: "https://bank.example", match: 0, target: "https://bank.example:8443/login" },
  ])(
    "a permissive provider match cannot change the allowed origin case %#",
    ({ uri, match, target: targetUrl }) => {
      expect(matchBitwardenLoginUris([{ uri, match }], targetUrl)).toMatchObject({
        ok: true,
        data: { matched: true },
      });
      const settings = createDefaultSettings();
      // Even an explicit site selection cannot expand this item's allowed origin.
      settings.siteDefaults.push({
        origin: new URL(targetUrl).origin,
        provider: "dummy",
        server: "cloud-us",
        userId: "demo-personal-account",
        itemId: "primary",
      });
      expect(resolveSiteAccount(settings, DUMMY_VAULT_CATALOG, targetUrl)).toEqual({
        ok: false,
        reason: "item-origin-mismatch",
      });
    },
  );
}
