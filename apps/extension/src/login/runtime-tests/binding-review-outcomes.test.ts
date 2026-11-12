import { describe, expect, it, vi } from "vitest";
import { parseLoginRecipe } from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { bindingReviewFixture } = await import("./binding-review-fixture");
const { start, offer, pick, stale, records, repairedRecipe, origin, target } =
  bindingReviewFixture(fake);

describe("a repaired binding whose sign-in does not authenticate", () => {
  it.each(["challenge", "rejected", "unclear"] as const)(
    "keeps synced settings intact after a judged %s outcome",
    async (verdict) => {
      const judge = vi.fn<LoginGeneration["judge"]>(async (...args) => {
        args[4]?.();
        return { verdict };
      });
      const generation: LoginGeneration = {
        available: async () => true,
        generate: async () => ({ outcome: "abstained", reason: "ambiguous" }),
        generateEntry: async () => ({ outcome: "abstained", reason: "ambiguous" }),
        judge,
        slotFields: async () => undefined,
      };
      const h = start({ generation }, { bindings: [{ ...stale, recipeId: "gen-synthetic" }] });
      h.recipes.recipe.mockResolvedValue(
        parseLoginRecipe({ ...repairedRecipe, id: "gen-synthetic", completion: undefined }),
      );
      fake.state.present = new Set(["branch", "password", "login"]);
      fake.state.signs = {
        password: false,
        code: false,
        captcha: false,
        invalid: false,
        alert: false,
      };
      fake.state.extracted = {
        "signed-in": {
          ok: true,
          observation: {
            version: 1,
            origin,
            path: "/home",
            language: "en",
            complete: true,
            candidates: [
              { id: "home", role: "button", target: target("logout"), label: "Sign out" },
            ],
          },
        },
      };
      const review = await offer(h);
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: { kind: string } }).step.kind === "click") {
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        }
      };
      fake.state.onReconnect = () => h.hello();
      expect(await pick(h, review)).toEqual({ ok: true });
      await vi.waitFor(() => expect(judge).toHaveBeenCalled(), { timeout: 8_000 });
      await vi.waitFor(() =>
        expect(records()?.[0]?.state).not.toMatch(/^(ready|executing|reconciling)$/u),
      );
      if (verdict === "unclear")
        expect(records()).toMatchObject([{ state: "authenticated", unconfirmed: true }]);
      if (verdict === "challenge")
        expect(records()).toMatchObject([{ state: "watching", outcome: "challenge" }]);
      if (verdict === "rejected")
        expect(records()).toMatchObject([{ state: "blocked", outcome: "credential-rejected" }]);
      expect(h.store.update).not.toHaveBeenCalled();
      expect(h.settings.settings.bindings[0]).toEqual({ ...stale, recipeId: "gen-synthetic" });
      expect(fake.state.storage["binding-review.synthetic-settings"]).toBeUndefined();
    },
    12_000,
  );
});
