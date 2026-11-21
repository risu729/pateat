// A confirmation page's fill (ADR 0035 delivery 3) of an identifier split over several
// inputs (ADR 0089): a value its boxes cannot take never reaches the page. Synthetic recipe
// and values.
import { describe, expect, it, vi } from "vitest";
import { parseLoginRecipe } from "@pateat/contracts";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { confirmationFixture } = await import("./confirmation-fixture");
const { recipe, target, confirmations, authenticated, configure, announce, settled } =
  confirmationFixture(fake);

const split = parseLoginRecipe({
  ...recipe,
  id: "synthetic-confirm-split",
  pageKind: "confirm",
  slots: ["username"],
  steps: [
    {
      kind: "fill",
      path: "/confirm",
      fields: [{ slot: "username", target: target("password"), split: [4, 4, 5] }],
    },
    { kind: "click", path: "/confirm", target: target("login"), purpose: "submit" },
  ],
});

describe("a confirmation fill of a split identifier", () => {
  it.each([
    ["sends a number the boxes take", "1234-5678-12345", 1],
    ["never sends one they cannot take", "1234-5678-123456", 0],
  ] as const)("%s", async (_name, username, sent) => {
    const { h } = await authenticated({ username: true });
    configure(h, split);
    h.fields.mockImplementation(async (read) =>
      read.fieldId === "login.username" ? username : "synthetic-secret",
    );
    expect(await announce(h)).toMatchObject({ reason: "confirm-fill" });
    await settled(h);
    expect(confirmations()).toHaveLength(sent);
    if (sent)
      expect(confirmations()[0]).toMatchObject({
        operation: { step: { fields: [{ slot: "username", split: [4, 4, 5] }] } },
      });
    // The value is never logged.
    expect(JSON.stringify(fake.state.storage)).not.toContain("5678");
  });
});
