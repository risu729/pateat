// A verification page in a tab without Pateat's login (ADR 0035, amended 2026-11-22): it
// is filled automatically only when it shows the username of exactly one of its matching
// accounts, never for an item that asks for the master password, and nothing is pressed.
import { describe, expect, it, vi } from "vitest";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { pickFixture } = await import("./confirmation-pick-fixture");
const {
  otherItemId,
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

type H = ReturnType<typeof start>["h"];
type Live = Parameters<typeof start>[1];

/** Each item's username, and the one the page shows in its header, if any. */
function page(
  usernames: { first: string; other: string; shown?: string },
  live: Live = {},
  settings: Parameters<typeof start>[0] = {},
) {
  const { h, reports } = start(settings, { username: true, otherUsername: true, ...live });
  h.fields.mockImplementation(async (read) =>
    read.fieldId === "login.username"
      ? read.account.itemId === otherItemId
        ? usernames.other
        : usernames.first
      : "synthetic-secret",
  );
  fake.state.signs = (message) => ({
    password: true,
    code: false,
    captcha: false,
    invalid: false,
    alert: false,
    username:
      usernames.shown !== undefined &&
      (message["account"] as { username?: string } | undefined)?.username === usernames.shown,
  });
  configure(h, cached());
  // A new login's lookup takes only recipes that run a login, as the recipe cache's does.
  h.recipes.recipe.mockResolvedValue(undefined);
  // The page shows the site's signed-in marker, so its log signs are read at once.
  fake.state.present = new Set(["password", "login", "authenticated"]);
  return { h, reports };
}

const passwordReads = (h: H) =>
  h.fields.mock.calls
    .filter(([read]) => read.fieldId === "login.password")
    .map(([read]) => read.account.itemId);

/** The page announces its form, then reports its first step shown, as the content script does. */
async function announceShown(h: H) {
  await announce(h);
  await shownHello(h, { documentId: "confirmation-document" });
}

/** Waits until the page's own rows are logged, so a fill that would start has started. */
async function looked(h: H, reports: { type: string; detail?: string }[]) {
  await vi.waitFor(() =>
    expect(reports).toContainEqual(
      expect.objectContaining({ type: "refused", detail: "confirm-unsupported" }),
    ),
  );
  await settled(h);
}

describe("a verification page that shows one matching account's username", () => {
  it("fills that account's password once, pressing nothing", async () => {
    const { h, reports } = page({ first: "first-user", other: "other-user", shown: "other-user" });
    await announceShown(h);
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(h);
    expect(confirmations()[0]).toMatchObject({
      operation: {
        attemptId: "confirm:shown",
        signInFill: true,
        step: { kind: "fill", effect: "prepare" },
      },
    });
    expect(passwordReads(h)).toEqual([otherItemId]);
    expect(clicks()).toEqual([]);
    await vi.waitFor(() =>
      expect(reports).toContainEqual(
        expect.objectContaining({ detail: "confirm-fill", accountSource: "shown" }),
      ),
    );
    expect(JSON.stringify(reports)).not.toContain(otherItemId);
    // Another announcement of the same page fills nothing again.
    await announceShown(h);
    await settled(h);
    expect(confirmations()).toHaveLength(1);
  });

  it.each([
    ["shows no username", { first: "first-user", other: "other-user" }],
    ["shows a username both accounts hold", { first: "same", other: "same", shown: "same" }],
  ] as const)("fills nothing when the page %s", async (_name, usernames) => {
    const { h, reports } = page(usernames);
    await announceShown(h);
    await looked(h, reports);
    expect(confirmations()).toEqual([]);
    expect(passwordReads(h)).toEqual([]);
    // The popup still offers **Fill**.
    expect(await offers(h)).toMatchObject({
      ok: true,
      targets: [expect.objectContaining({ fill: true })],
    });
  });

  it("never fills an item that asks for the master password, nor asks for it", async () => {
    const askMasterPassword = vi.fn();
    const { h, reports } = page(
      { first: "first-user", other: "other-user", shown: "first-user" },
      { reprompt: true, askMasterPassword },
      { repromptSites: [{ hostname: "login.example", includeSubdomains: false }] },
    );
    await announceShown(h);
    await looked(h, reports);
    expect(confirmations()).toEqual([]);
    expect(passwordReads(h)).toEqual([]);
    expect(askMasterPassword).not.toHaveBeenCalled();
  });
});
