import { generatedRecipeId } from "@pateat/generation";
import { describe, expect, it } from "vitest";
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
    replies.push({ text: ssoAnswer("a") });
    expect(await generateSso(device, shared, ["A"])).toMatchObject({
      status: "recipe",
      change: { revision: 3, recipe: { sso: { layouts: [{ entries: [{ label: "A" }] }] } } },
    });
    expect(sent).toHaveLength(3);
    const body = sent[2]!.body as { messages: { content: { text: string }[] }[] };
    const input = JSON.parse(body.messages[0]!.content[0]!.text) as {
      observation: { candidates: { id: string }[] };
    };
    expect(input.observation.candidates.map((candidate) => candidate.id)).toEqual(["a"]);
  });
});
