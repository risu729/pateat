import { expect, it } from "vitest";
import type { CryptoHostTestContext } from "./context";

export function registerCustomFieldDigestsCases({
  harness,
  itemId,
  otherItem,
  digests,
}: Pick<CryptoHostTestContext, "harness" | "itemId" | "otherItem" | "digests">) {
  it("requests custom-field digests by item ID without a key and returns only digests", async () => {
    const h = harness();
    const session = await h.open();
    const pending = h.host.customFieldDigests(session, [itemId, otherItem]);
    const request = await h.command(1);
    expect(request.operation).toEqual({
      kind: "custom-digest",
      session,
      itemIds: [itemId, otherItem],
    });
    h.reply(request, { ok: true, data: digests });
    expect(await pending).toEqual({ ok: true, data: digests });
  });

  it.each([
    [itemId, itemId.toUpperCase()],
    Array.from({ length: 2001 }, () => crypto.randomUUID()),
    ["not-a-uuid"],
  ])("rejects a malformed digest request before dispatch case %#", async (...ids) => {
    const h = harness();
    const session = await h.open();
    expect(await h.host.customFieldDigests(session, ids)).toEqual({
      ok: false,
      error: { code: "invalid-request" },
    });
    expect(h.commands).toHaveLength(1);
  });

  it.each([
    { digests: { [itemId]: "A".repeat(43) } },
    { digests: { ...digests.digests, [crypto.randomUUID()]: null } },
    { digests: { [itemId]: "A".repeat(42), [otherItem]: null } },
    { digests: { [itemId]: "synthetic-value", [otherItem]: null } },
    { ...digests, values: ["007"] },
  ])("locks the session on a digest reply of another shape case %#", async (data) => {
    const h = harness();
    const session = await h.open();
    const pending = h.host.customFieldDigests(session, [itemId, otherItem]);
    h.reply(await h.command(1), { ok: true, data });
    expect(await pending).toEqual({ ok: false, error: { code: "crypto-locked" } });
    expect(await h.host.catalog(session)).toEqual({ ok: false, error: { code: "crypto-locked" } });
  });
}
