import { expect, it } from "vitest";
import type { CryptoHostTestContext } from "./context";

export function registerLoginUsernamesCases({
  harness,
  itemId,
  otherItem,
  usernames,
}: Pick<CryptoHostTestContext, "harness" | "itemId" | "otherItem" | "usernames">) {
  it("requests login usernames by item ID and returns one per requested item", async () => {
    const h = harness();
    const session = await h.open();
    const pending = h.host.loginUsernames(session, [itemId, otherItem]);
    const request = await h.command(1);
    expect(request.operation).toEqual({
      kind: "login-usernames",
      session,
      itemIds: [itemId, otherItem],
    });
    h.reply(request, { ok: true, data: usernames });
    expect(await pending).toEqual({ ok: true, data: usernames });
  });

  it.each([
    [itemId, itemId.toUpperCase()],
    Array.from({ length: 2001 }, () => crypto.randomUUID()),
    ["not-a-uuid"],
  ])("rejects a malformed username request before dispatch case %#", async (...ids) => {
    const h = harness();
    const session = await h.open();
    expect(await h.host.loginUsernames(session, ids)).toEqual({
      ok: false,
      error: { code: "invalid-request" },
    });
    expect(h.commands).toHaveLength(1);
  });

  it.each([
    { usernames: { [itemId]: "alice@example.test" } },
    { usernames: { ...usernames.usernames, [crypto.randomUUID()]: null } },
    { usernames: { [itemId]: "a".repeat(1025), [otherItem]: null } },
    { ...usernames, passwords: ["synthetic-value"] },
  ])("locks the session on a username reply of another shape case %#", async (data) => {
    const h = harness();
    const session = await h.open();
    const pending = h.host.loginUsernames(session, [itemId, otherItem]);
    h.reply(await h.command(1), { ok: true, data });
    expect(await pending).toEqual({ ok: false, error: { code: "crypto-locked" } });
    expect(await h.host.catalog(session)).toEqual({ ok: false, error: { code: "crypto-locked" } });
  });
}
