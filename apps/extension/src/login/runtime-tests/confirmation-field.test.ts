// The field the popup's **Fill** puts into a verification page (ADR 0035, amended
// 2026-11-22): the person may choose the account's password or one of its named custom
// fields, and the choice is saved as that account's binding of the page's recipe.
import { describe, expect, it, vi } from "vitest";
import type { LocalSettings, VaultFieldReference } from "@pateat/contracts";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { pickFixture } = await import("./confirmation-pick-fixture");
const {
  excludingLive,
  savedBinding,
  otherItemId,
  connectionId,
  popup,
  confirmations,
  cached,
  configure,
  announce,
  settled,
  shownHello,
  start,
  offers,
  clicks,
} = pickFixture(fake);

/** The other item's PIN, and a field holding a TOTP key that is never offered. */
const otherCustom = [
  { name: "PIN", kind: "text" as const },
  { name: "Seed", kind: "hidden" as const, totpSeed: true as const },
];

async function page(settings: Partial<LocalSettings> = {}) {
  // The other item holds a username too, which is never offered for a password slot.
  const { h } = start(settings, { otherCustom, otherUsername: true });
  configure(h, cached());
  await announce(h);
  fake.state.onReconnect = () => shownHello(h, { documentId: "confirmation-document" });
  return h;
}
type H = Awaited<ReturnType<typeof page>>;

async function pressWith(h: H, field?: VaultFieldReference | null, requestId = "fill-press") {
  const offered = await offers(h);
  if (!offered.ok) throw new Error("No page");
  const [selected] = offered.targets;
  if (!selected) throw new Error("No target");
  return h.login.handle(
    {
      version: 1,
      type: "login.confirm.fill",
      requestId,
      document: selected.document,
      scope: selected.scope,
      connectionId,
      itemId: otherItemId,
      ...(field === undefined ? {} : { field }),
    },
    popup,
  );
}

/** The vault fields the fills read for the other item. */
const reads = (h: H) =>
  h.fields.mock.calls
    .filter(([read]) => read.account.itemId === otherItemId)
    .map(([read]) => read.fieldId)
    .filter((id) => id !== "login.username");

const savedFor = (h: H) =>
  h.settings.settings.bindings.find(
    (entry) => entry.recipeId === "synthetic-confirm" && entry.itemId === otherItemId,
  );

describe("the field the popup's Fill puts into a verification page", () => {
  it("offers the account's password and its named custom fields, never a TOTP key", async () => {
    const h = await page();
    const offered = await offers(h);
    expect(offered.ok && offered.targets[0]?.candidates).toContainEqual({
      connectionId,
      itemId: otherItemId,
      fields: [{ field: "password" }, { field: { custom: "PIN" }, name: "PIN" }],
    });
  });

  it("saves the chosen field as the account's binding and fills it", async () => {
    const h = await page();
    expect(await pressWith(h, { custom: "PIN" })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(h);
    expect(h.store.update).toHaveBeenCalledWith(
      undefined,
      "account-choice",
      expect.any(Function),
      expect.any(Function),
    );
    expect(savedFor(h)).toMatchObject({
      origin: "https://login.example",
      itemId: otherItemId,
      slots: [{ slot: "password", field: { custom: "PIN" } }],
    });
    expect(reads(h)).toEqual([expect.stringMatching(/^custom\..*\.0$/)]);
    expect(clicks()).toEqual([]);
    // The next offer shows the saved choice, and a press without one fills it again.
    const offered = await offers(h);
    expect(offered.ok && offered.targets[0]?.candidates).toContainEqual(
      expect.objectContaining({ itemId: otherItemId, chosen: { custom: "PIN" } }),
    );
  });

  it("replaces a saved choice with the password the person chooses later", async () => {
    const h = await page();
    expect(await pressWith(h, { custom: "PIN" })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(h);
    h.fields.mockClear();
    expect(await pressWith(h, "password", "second-press")).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(2));
    await settled(h);
    expect(savedFor(h)?.slots).toEqual([{ slot: "password", field: "password" }]);
    expect(
      h.settings.settings.bindings.filter((entry) => entry.itemId === otherItemId),
    ).toHaveLength(1);
    expect(reads(h)).toEqual(["login.password"]);
  });

  it("writes nothing when the chosen field is the one already saved", async () => {
    const h = await page();
    expect(await pressWith(h, { custom: "PIN" })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(h);
    h.store.update.mockClear();
    expect(await pressWith(h, { custom: "PIN" }, "second-press")).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(2));
    expect(h.store.update).not.toHaveBeenCalled();
  });

  it.each([
    ["a field holding a TOTP key", { custom: "Seed" }],
    ["a field the item does not hold", { custom: "Missing" }],
    ["the username", "username"],
  ] as const)("refuses %s and fills nothing", async (_name, field) => {
    const h = await page();
    expect(await pressWith(h, field)).toMatchObject({ ok: false, reason: "field-unavailable" });
    expect(h.store.update).not.toHaveBeenCalled();
    expect(savedFor(h)).toBeUndefined();
    expect(confirmations()).toEqual([]);
  });

  it("never offers or saves a field the account's policy excludes", async () => {
    const h = await page(excludingLive([{ custom: "PIN" }], otherItemId));
    const offered = await offers(h);
    expect(offered.ok && offered.targets[0]?.candidates).toContainEqual({
      connectionId,
      itemId: otherItemId,
    });
    expect(await pressWith(h, { custom: "PIN" })).toMatchObject({
      ok: false,
      reason: "field-unavailable",
    });
    expect(savedFor(h)).toBeUndefined();
  });

  it("checks the choice again in the settings queue and writes nothing it refuses", async () => {
    const h = await page();
    const update = h.store.update.getMockImplementation()!;
    // The PIN is excluded between the press's settings read and its write.
    h.store.update.mockImplementationOnce(async (...args) => {
      Object.assign(h.settings.settings, excludingLive([{ custom: "PIN" }], otherItemId));
      return update(...args);
    });
    expect(await pressWith(h, { custom: "PIN" })).toMatchObject({
      ok: false,
      reason: "field-unavailable",
    });
    expect(savedFor(h)).toBeUndefined();
    expect(confirmations()).toEqual([]);
  });

  it("replaces the slot's entry in place, so the same choice writes nothing", async () => {
    const binding = {
      ...savedBinding,
      recipeId: "synthetic-confirm",
      itemId: otherItemId,
      itemName: "Other synthetic item",
      slots: [
        { slot: "password", field: { custom: "PIN" } },
        { slot: "answer", field: "password" },
      ],
    } satisfies LocalSettings["bindings"][number];
    const h = await page({ bindings: [savedBinding, binding] });
    expect(await pressWith(h, { custom: "PIN" })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    expect(h.store.update).not.toHaveBeenCalled();
    await settled(h);
    expect(await pressWith(h, "password", "second-press")).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(2));
    expect(savedFor(h)?.slots).toEqual([
      { slot: "password", field: "password" },
      { slot: "answer", field: "password" },
    ]);
  });

  it("clears a saved field no longer offered, so the recipe's own choice fills", async () => {
    const binding = {
      ...savedBinding,
      recipeId: "synthetic-confirm",
      itemId: otherItemId,
      itemName: "Other synthetic item",
      slots: [{ slot: "password", field: { custom: "Renamed" } }],
    } satisfies LocalSettings["bindings"][number];
    const h = await page({ bindings: [savedBinding, binding] });
    const offered = await offers(h);
    expect(offered.ok && offered.targets[0]?.candidates).toContainEqual(
      expect.objectContaining({ itemId: otherItemId, saved: true }),
    );
    expect(offered.ok && offered.targets[0]?.candidates).not.toContainEqual(
      expect.objectContaining({ itemId: otherItemId, chosen: expect.anything() }),
    );
    expect(await pressWith(h, null)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(h);
    expect(savedFor(h)).toBeUndefined();
    expect(h.settings.settings.bindings).toEqual([savedBinding]);
    expect(reads(h)).toEqual(["login.password"]);
  });

  it("offers no choice for an account with only its password", async () => {
    const { h } = start({}, { otherCustom: [] });
    configure(h, cached());
    await announce(h);
    const offered = await offers(h);
    expect(offered.ok && offered.targets[0]?.candidates).toContainEqual({
      connectionId,
      itemId: otherItemId,
    });
  });
});
