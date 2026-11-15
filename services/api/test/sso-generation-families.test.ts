import { generatedRecipeId } from "@pateat/generation";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { revokeUnusedRecipes } from "../src/recipe-store";
import {
  claude,
  element,
  generate,
  generateSso,
  observation,
  ORIGIN,
  owner,
  plan,
  rows,
  seed,
  ssoAnswer,
  storedHead,
  useSyntheticClaude,
} from "./sso-generation-harness";

// SSO entries beside a recipe's native routes (ADR 0026 amendment of 2026-11-12): what one
// family's write, retry window and daily repair leave of the other's.

useSyntheticClaude();
const { replies, sent } = claude;

const providers = observation("/login", [
  element("a", "button", "Continue with A"),
  element("b", "button", "Continue with B"),
  element("c", "button", "Continue with C"),
  element("d", "button", "Continue with D"),
]);
const formAndProvider = observation("/login", [
  element("email", "email", "Email"),
  element("next", "button", "Next"),
  element("a", "button", "Continue with A"),
]);
const abstain = JSON.stringify({ result: { decision: "abstain", reason: "ambiguous" } });

describe("SSO entries beside native routes", () => {
  it("asks once per label and keeps every label's entry in one layout", async () => {
    const device = await owner();
    replies.push(...["a", "b", "c", "d"].map((candidate) => ({ text: ssoAnswer(candidate) })));
    for (const label of ["A", "B", "C", "D", "A", "B", "C", "D"]) {
      // oxlint-disable-next-line no-await-in-loop -- each label's request follows the last write
      expect(await generateSso(device, providers, [label])).toMatchObject({ status: "recipe" });
    }
    expect(sent).toHaveLength(4);
    expect(
      await storedHead(device.ownerId, await generatedRecipeId(ORIGIN, "/login")),
    ).toMatchObject({
      revision: 4,
      sso: {
        layouts: [
          {
            entries: ["a", "b", "c", "d"].map((value) => ({
              label: value.toUpperCase(),
              target: { by: "id", value },
            })),
          },
        ],
      },
    });
  });

  it("makes no further call for other labels while the SSO entries are unchanged", async () => {
    const device = await owner();
    replies.push({ text: abstain });
    // Labels that are not on the page, varied on each request.
    for (const [index, labels] of Array.from({ length: 6 }, (_, at) => ["A", `x${at}`]).entries())
      // oxlint-disable-next-line no-await-in-loop -- each request follows the last one's answer
      expect(await generateSso(device, providers, labels)).toMatchObject(
        index === 0 ? { status: "abstained" } : { status: "unavailable", reason: "recently-tried" },
      );
    expect(await generateSso(device, providers, ["A"])).toMatchObject({
      status: "unavailable",
      reason: "recently-tried",
    });
    expect(sent).toHaveLength(1);
    // A write of new entries opens the window again for the next label.
    const other = await owner();
    replies.push({ text: ssoAnswer("a") }, { text: ssoAnswer("b") });
    expect(await generateSso(other, providers, ["A"])).toMatchObject({ status: "recipe" });
    expect(await generateSso(other, providers, ["B"])).toMatchObject({ status: "recipe" });
    for (const labels of [["A"], ["b"], ["B", "a"]])
      // oxlint-disable-next-line no-await-in-loop -- answered from the stored entries
      expect(await generateSso(other, providers, labels)).toMatchObject({ status: "recipe" });
    expect(sent).toHaveLength(3);
  });

  it("counts a merged layout's idle time from its newest entries", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    await seed(device, {
      version: 1,
      id: recipeId,
      revision: 1,
      origin: ORIGIN,
      sso: {
        path: "/login",
        layouts: [
          {
            key: "2000",
            createdAt: 2000,
            entries: [{ label: "A", target: { by: "id", value: "a" } }],
          },
        ],
      },
    });
    replies.push({ text: ssoAnswer("b") });
    const before = Date.now();
    expect(await generateSso(device, providers, ["B"])).toMatchObject({
      status: "recipe",
      change: { revision: 2 },
    });
    const head = (await storedHead(device.ownerId, recipeId)) as {
      sso: { layouts: { key: string; createdAt: number; entries: unknown[] }[] };
    };
    expect(head.sso.layouts).toHaveLength(1);
    expect(head.sso.layouts[0]).toMatchObject({ key: "2000", entries: [{}, {}] });
    expect(head.sso.layouts[0]!.createdAt).toBeGreaterThanOrEqual(before);
    // The layout stays for the label added today.
    expect(await revokeUnusedRecipes(env.DB, device.ownerId, Date.now())).toBe(0);
    expect(await storedHead(device.ownerId, recipeId)).toEqual(head);
    // Its record names the call that last changed its entries.
    expect(
      await rows(
        "SELECT layout, unit, origin FROM recipe_unit_sources WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([{ layout: "2000", unit: "sso", origin: "generated" }]);
  });

  it("keeps an abstained SSO request's retry window across a native write", async () => {
    const device = await owner();
    replies.push({ text: abstain });
    expect(await generateSso(device, formAndProvider, ["A"])).toMatchObject({
      status: "abstained",
    });
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, formAndProvider)).toMatchObject({ status: "recipe" });
    expect(await generateSso(device, formAndProvider, ["A"])).toMatchObject({
      status: "unavailable",
      reason: "recently-tried",
    });
    expect(sent).toHaveLength(2);
    // The log rows and the attempt row name the same branch.
    const logged = await rows(
      "SELECT branch, recipe_page FROM inference_log WHERE owner_id = ? AND recipe_page = 'sso'",
      device.ownerId,
    );
    expect(logged).toHaveLength(2);
    const branch = logged[0]!.branch;
    expect(branch).toMatch(/^sso:[0-9a-f]{16}$/);
    expect(logged).toEqual([
      { branch, recipe_page: "sso" },
      { branch, recipe_page: "sso" },
    ]);
    expect(
      await rows(
        "SELECT branch, base_revision FROM generation_attempts WHERE owner_id = ? AND branch != ''",
        device.ownerId,
      ),
    ).toEqual([{ branch, base_revision: 0 }]);
  });

  it("stores a native confirm answer beside SSO-only entries", async () => {
    const device = await owner();
    replies.push({ text: ssoAnswer("a") });
    expect(await generateSso(device, formAndProvider, ["A"])).toMatchObject({ status: "recipe" });
    replies.push({
      text: plan([["email", "email"]], "next", "advance", {
        pageKind: "confirm",
        irreversible: "yes",
      }),
    });
    const native = await generate(device, formAndProvider, { signedIn: true });
    expect(sent).toHaveLength(2);
    const stored = {
      revision: 2,
      layouts: [{ pageKind: "confirm" }],
      sso: { layouts: [{ entries: [{ label: "A", target: { by: "id", value: "a" } }] }] },
    };
    expect(native).toMatchObject({ status: "recipe", change: { recipe: stored } });
    expect(
      await storedHead(device.ownerId, await generatedRecipeId(ORIGIN, "/login")),
    ).toMatchObject(stored);
  });

  it("gives SSO entries and native routes a daily repair each", async () => {
    const device = await owner();
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, formAndProvider);
    if (first.status !== "recipe") throw new Error(first.status);
    replies.push({ text: ssoAnswer("a") });
    const repairedSso = await generateSso(device, formAndProvider, ["A"], {
      repair: { recipeId: first.change.recipeId, revision: first.change.revision },
    });
    if (repairedSso.status !== "recipe") throw new Error(repairedSso.status);
    const revised = observation("/login", [
      element("email-new", "email", "Email"),
      element("next-new", "button", "Next"),
      element("a", "button", "Continue with A"),
    ]);
    replies.push({ text: plan([["email", "email-new"]], "next-new", "advance") });
    const repairedNative = await generate(device, revised, {
      repair: { recipeId: first.change.recipeId, revision: repairedSso.change.revision },
    });
    expect(repairedNative).toMatchObject({ status: "recipe", change: { revision: 3 } });
    if (repairedNative.status !== "recipe") throw new Error(repairedNative.status);
    // Each family's repair is still once a day.
    expect(
      await generateSso(device, formAndProvider, ["A"], {
        repair: { recipeId: first.change.recipeId, revision: repairedNative.change.revision },
      }),
    ).toMatchObject({ status: "unavailable", reason: "repair-limit" });
    expect(
      await generate(device, formAndProvider, {
        repair: { recipeId: first.change.recipeId, revision: repairedNative.change.revision },
      }),
    ).toMatchObject({ status: "unavailable", reason: "repair-limit" });
    expect(sent).toHaveLength(3);
  });

  it("drops an SSO entry on a control a native answer uses, and never offers it again", async () => {
    const device = await owner();
    const shared = observation("/login", [
      element("email", "email", "Email"),
      element("next", "button", "Continue"),
      element("a", "button", "Continue with A"),
    ]);
    replies.push({ text: ssoAnswer("next") });
    expect(await generateSso(device, shared, ["Work SSO"])).toMatchObject({ status: "recipe" });
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const native = await generate(device, shared);
    expect(native).toMatchObject({
      status: "recipe",
      change: { revision: 2, recipe: { layouts: [{}] } },
    });
    if (native.status !== "recipe") throw new Error(native.status);
    expect(native.change.recipe).not.toHaveProperty("sso");
    // With no SSO entries left, the family is as it was before the first request, whose
    // retry window holds for ten minutes (ADR 0016).
    expect(await generateSso(device, shared, ["A"])).toMatchObject({
      status: "unavailable",
      reason: "recently-tried",
    });
    const later = Date.now() + 11 * 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      replies.push({ text: ssoAnswer("a") });
      expect(await generateSso(device, shared, ["A"])).toMatchObject({
        status: "recipe",
        change: { revision: 3, recipe: { sso: { layouts: [{ entries: [{ label: "A" }] }] } } },
      });
    } finally {
      clock.mockRestore();
    }
    expect(sent).toHaveLength(3);
    const body = sent[2]!.body as { messages: { content: { text: string }[] }[] };
    const input = JSON.parse(body.messages[0]!.content[0]!.text) as {
      observation: { candidates: { id: string }[] };
    };
    expect(input.observation.candidates.map((candidate) => candidate.id)).toEqual(["a"]);
  });
});
