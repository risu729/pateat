import type { LocalVaultMetadata } from "@pateat/bitwarden";
import type { LocalSettings, VaultCatalog } from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import { catalogEntry } from "../connections/catalog";
import { detailCandidates, linkedField } from "./details";

// Synthetic vault data only: no real names or numbers.
const userId = "60000000-0000-4000-8000-000000000001";
const snapshotId = "60000000-0000-4000-8000-000000000002";
const card = (id: string, label: string, inactive?: true): LocalVaultMetadata["items"][number] => ({
  id,
  label,
  type: 3,
  ...(inactive ? { inactive } : {}),
  groupIds: [],
  fields: [
    { id: "card.number", label: "Number", name: null, kind: "hidden" },
    { id: "card.code", label: "Security code", name: null, kind: "hidden" },
  ],
});
const active = "60000000-0000-4000-8000-000000000010";
const trashed = "60000000-0000-4000-8000-000000000011";
const login = "60000000-0000-4000-8000-000000000020";
const projected: LocalVaultMetadata = {
  connectionId: "personal",
  userId,
  snapshotId,
  groups: [],
  // Deleted or archived items come from the vault worker marked `inactive`.
  items: [card(active, "Synthetic card"), card(trashed, "Synthetic old card", true)],
};
const connection = catalogEntry("personal", "Synthetic vault", projected);
const catalog: VaultCatalog = { connections: [connection] };
const settings: LocalSettings = {
  connections: [
    {
      connectionId: "personal",
      enabled: true,
      selection: { mode: "all", groupIds: [], itemIds: [] },
      excludedItemIds: [],
      excludedFields: [],
    },
  ],
  excludedSites: [],
  repromptSites: [],
  passkeyBrowserSites: [],
  siteDefaults: [],
  bindings: [],
};

describe("an inactive vault item in the settings catalog (ADR 0061)", () => {
  it("keeps the inactive mark from the vault metadata", () => {
    expect(connection.items.find((item) => item.id === trashed)?.inactive).toBe(true);
    expect(connection.items.find((item) => item.id === active)).not.toHaveProperty("inactive");
  });

  it("is never offered as a detail candidate", () => {
    for (const detail of ["card-last-4", "card-code"] as const) {
      const candidates = detailCandidates(settings, catalog, connection, detail, {
        // The trashed card's name matches the page, which would rank it first.
        host: "old.example",
        title: "Synthetic old card",
        loginItemId: login,
      });
      expect(candidates.map((candidate) => candidate.itemId)).toEqual([active]);
    }
  });

  it("gives no value to a link that names it", () => {
    const source = (itemId: string) => ({ itemId, field: "card.code" }) as const;
    expect(
      linkedField(settings, catalog, connection, {
        detail: "card-code",
        itemId: login,
        source: source(trashed),
      }),
    ).toBe(undefined);
    expect(
      linkedField(settings, catalog, connection, {
        detail: "card-code",
        itemId: login,
        source: source(active),
      }),
    ).toEqual({ itemId: active, fieldId: "card.code", name: null });
  });
});
