import {
  MAX_ACTIVE_RECIPE_BYTES,
  type EntryGenerationResult,
  type LoginObservation,
} from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import {
  entryGenerationInstructions,
  entryGenerationPromptVersion,
  entryInstruction,
  generationPromptVersion,
} from "@pateat/inference";
import { expect, it } from "vitest";
import { writeRecipe } from "../../src/recipe-store";
import {
  ATTEMPT_WINDOW_MS,
  generatedRecipeId,
  MIN_GENERATION_RECIPE_ROOM_BYTES,
} from "@pateat/generation";
import { seedRecipeBytes } from "../recipe-byte-helpers";
import type { GenerationContext, Device } from "./context";

export function registerEntryPages(context: GenerationContext) {
  const {
    ORIGIN,
    observation,
    emailPage,
    plan,
    owner,
    post,
    generate,
    rows,
    logRows,
    hashOf,
    state,
  } = context;

  // A synthetic top page the site sent the visitor to before signing in: no field, a
  // sign-up link, the sign-in link and a button.
  const link = (id: string, text: string) => ({
    id,
    role: "link" as const,
    target: { by: "text" as const, value: text },
  });
  const topPage = observation("/en/", [
    link("c1", "Create account"),
    link("c2", "Login"),
    { id: "c3", role: "button", target: { by: "text", value: "Search" } },
  ]);
  const entryAnswer = (candidate: string) =>
    JSON.stringify({ result: { decision: "entry", entry: candidate } });
  const abstain = JSON.stringify({ result: { decision: "abstain", reason: "no-login-form" } });

  async function generateEntry(device: Device, page: LoginObservation) {
    const response = await post(device, "/v1/recipes/generate", { version: 1, observation: page });
    expect(response.status).toBe(200);
    return (await response.json()) as EntryGenerationResult;
  }

  it("refuses entry generation before the model call when less than 32 KiB remains", async () => {
    const device = await owner();
    await seedRecipeBytes(
      device.ownerId,
      MAX_ACTIVE_RECIPE_BYTES - MIN_GENERATION_RECIPE_ROOM_BYTES + 1,
    );
    expect(await generateEntry(device, topPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recipe-limit",
    });
    expect(state.sent).toHaveLength(0);
    expect(
      await rows("SELECT * FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([]);
  });

  it("maps entry generation's byte refusal after the model call", async () => {
    const device = await owner();
    state.during = () => seedRecipeBytes(device.ownerId, MAX_ACTIVE_RECIPE_BYTES);
    state.replies.push({ text: entryAnswer("c2") });
    expect(await generateEntry(device, topPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recipe-limit",
    });
    expect(state.sent).toHaveLength(1);
    expect(
      await rows(
        "SELECT revision FROM recipe_heads WHERE owner_id = ? AND recipe_id = ?",
        device.ownerId,
        await generatedRecipeId(ORIGIN, topPage.path),
      ),
    ).toEqual([]);
  });

  it("stores the named link as the entry recipe of the page's origin and path", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/en/");
    state.replies.push({ text: entryAnswer("c2") });
    const recipe = {
      version: 1,
      id: recipeId,
      revision: 1,
      origin: ORIGIN,
      entry: { path: "/en/", target: { by: "text", value: "Login" } },
    };
    const answer = await generateEntry(device, topPage);
    expect(answer).toEqual({
      version: 1,
      status: "recipe",
      change: { recipeId, revision: 1, state: "active", recipe },
    });
    // The entry line goes into this request only, and no slot is sent.
    const body = state.sent[0]!.body as {
      system: { text: string }[];
      messages: { content: { text: string }[] }[];
    };
    expect(body.system.map((part) => part.text)).toEqual([entryGenerationInstructions]);
    expect(entryGenerationInstructions).toContain(entryInstruction);
    expect(JSON.parse(body.messages[0]!.content[0]!.text)).toEqual({
      task: "entry",
      observation: topPage,
    });

    // Asking again answers with the stored recipe without a call.
    expect(await generateEntry(device, topPage)).toEqual(answer);
    expect(state.sent).toHaveLength(1);
    const feed = await exports.default.fetch("https://pateat.invalid/v1/recipes", {
      headers: { Authorization: `Bearer ${device.token}` },
    });
    expect(await feed.json()).toMatchObject({ changes: [{ recipeId, revision: 1, recipe }] });

    const log = await rows(
      "SELECT role, path, outcome, prompt_version, request, result FROM inference_log WHERE owner_id = ?",
      device.ownerId,
    );
    expect(
      log.map((row) => ({
        ...row,
        request: JSON.parse(String(row.request)),
        result: JSON.parse(String(row.result)),
      })),
    ).toEqual([
      {
        role: "generate",
        path: "/en/",
        outcome: "ok",
        prompt_version: await entryGenerationPromptVersion(),
        request: { instructions: entryGenerationInstructions, observation: topPage },
        result: { entry: "c2" },
      },
      // Asking again is logged as answered with the stored recipe.
      {
        role: "generate",
        path: "/en/",
        outcome: "recipe",
        prompt_version: await entryGenerationPromptVersion(),
        request: { instructions: entryGenerationInstructions, observation: topPage },
        result: null,
      },
    ]);
    expect(await logRows(device.ownerId)).toMatchObject([
      {
        recipe_id: recipeId,
        branch: "",
        base_revision: 0,
        revision: 1,
        recipe_page: "first",
        build: "test-revision",
        observation_hash: await hashOf(topPage),
        answer: { decision: "entry", entry: "c2" },
      },
      {
        recipe_id: recipeId,
        branch: "",
        base_revision: 1,
        revision: null,
        recipe_page: "first",
        observation_hash: await hashOf(topPage),
        answer: null,
      },
    ]);
    expect(await entryGenerationPromptVersion()).not.toBe(await generationPromptVersion());
    expect(
      await rows(
        "SELECT recipe_id, path, base_revision FROM generation_attempts WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([{ recipe_id: recipeId, path: "/en/", base_revision: 0 }]);

    // A page request never gets the entry line.
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
    expect(JSON.stringify(state.sent[1]!.body)).not.toContain(entryInstruction);
  });

  it("refuses an entry for a page request and a plan for an entry request", async () => {
    const device = await owner();
    state.replies.push({ text: entryAnswer("next") });
    expect(await generate(device, emailPage)).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
      rejection: { check: "plan", reason: "unexpected-entry" },
    });
    const other = await owner();
    state.replies.push({ text: plan([["email", "c2"]], "c3", "submit") });
    expect(await generateEntry(other, topPage)).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
      rejection: { check: "plan", reason: "unexpected-plan" },
    });
    const logged = async (each: Device) =>
      (
        await rows(
          "SELECT outcome, prompt_version, result FROM inference_log WHERE owner_id = ?",
          each.ownerId,
        )
      ).map((row) => ({ ...row, result: JSON.parse(String(row.result)) }));
    expect(await logged(device)).toEqual([
      {
        outcome: "invalid-output",
        prompt_version: await generationPromptVersion(),
        result: {
          rejection: { check: "plan", reason: "unexpected-entry" },
          output: { result: { decision: "entry", entry: "next" } },
        },
      },
    ]);
    // The plan is kept by reference; its slot is not one the request offered.
    expect(await logged(other)).toEqual([
      {
        outcome: "invalid-output",
        prompt_version: await entryGenerationPromptVersion(),
        result: {
          rejection: { check: "plan", reason: "unexpected-plan" },
          output: {
            result: {
              pageKind: "sign-in",
              irreversible: "no",
              fields: [{ slot: "?", candidate: "c2" }],
              action: { candidate: "c3", purpose: "submit" },
            },
          },
        },
      },
    ]);
    // Neither stored anything, and both count toward the retry window.
    expect(await rows("SELECT * FROM recipe_heads WHERE owner_id = ?", other.ownerId)).toEqual([]);
    expect(await generateEntry(other, topPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recently-tried",
    });
  });

  it.each([
    ["a button", "c3", topPage, "incompatible-role"],
    ["an unknown candidate", "Login", topPage, "unknown-candidate"],
    [
      "a link whose text may name an account",
      "c4",
      observation("/en/", [link("c2", "Login"), link("c4", "Continue as [email]")]),
      "account-text",
    ],
    [
      "a link whose label holds a number",
      "c4",
      observation("/en/", [
        link("c2", "Login"),
        {
          id: "c4",
          role: "link",
          target: { by: "id", value: "account" },
          label: "Member [number]",
        },
      ]),
      "account-text",
    ],
    [
      "a link whose label holds a masked value",
      "c4",
      observation("/en/", [
        link("c2", "Login"),
        { ...link("c4", "Account"), label: "Account [masked]" },
      ]),
      "account-text",
    ],
  ] as const)("refuses an entry that names %s", async (_name, candidate, page, reason) => {
    const device = await owner();
    state.replies.push({ text: entryAnswer(candidate) });
    expect(await generateEntry(device, page)).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
      rejection: { check: "plan", reason },
    });
    const [row] = await rows("SELECT result FROM inference_log WHERE owner_id = ?", device.ownerId);
    // A name that is no candidate of the page is not kept.
    expect(JSON.parse(String(row!.result))).toMatchObject({
      output: { result: { decision: "entry", entry: candidate === "Login" ? "?" : candidate } },
    });
    expect(await rows("SELECT * FROM recipe_heads WHERE owner_id = ?", device.ownerId)).toEqual([]);
  });

  it("refuses an entry request with a field, accounts or a base before any call", async () => {
    const device = await owner();
    const send = (body: unknown) => post(device, "/v1/recipes/generate", body);
    const bodies = [
      { version: 1, observation: emailPage },
      {
        version: 1,
        observation: { ...topPage, accounts: ["[email]"] },
      },
      {
        version: 1,
        observation: topPage,
        base: { recipeId: await generatedRecipeId(ORIGIN, "/en/"), revision: 1 },
      },
      { version: 1, observation: topPage, slots: [] },
    ];
    expect((await Promise.all(bodies.map(send))).map((response) => response.status)).toEqual(
      bodies.map(() => 400),
    );
    expect(await generateEntry(device, { ...topPage, complete: false })).toEqual({
      version: 1,
      status: "failed",
      error: "incomplete-observation",
    });
    expect(state.sent).toEqual([]);
    expect(
      await rows("SELECT * FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([]);
  });

  it("logs an abstention and tries the page again only after ten minutes", async () => {
    const device = await owner();
    state.replies.push({ text: abstain });
    expect(await generateEntry(device, topPage)).toEqual({
      version: 1,
      status: "abstained",
      reason: "no-login-form",
    });
    const log = await rows(
      "SELECT outcome, result FROM inference_log WHERE owner_id = ?",
      device.ownerId,
    );
    expect(log.map((row) => ({ ...row, result: JSON.parse(String(row.result)) }))).toEqual([
      { outcome: "abstained", result: { reason: "no-login-form" } },
    ]);
    expect(await rows("SELECT * FROM recipe_heads WHERE owner_id = ?", device.ownerId)).toEqual([]);
    // The window is per origin and path, whatever kind of request tried it.
    expect(await generateEntry(device, topPage)).toMatchObject({ reason: "recently-tried" });
    expect(await generate(device, { ...emailPage, path: "/en/" })).toMatchObject({
      reason: "recently-tried",
    });
    expect(state.sent).toHaveLength(1);

    await env.DB.prepare("UPDATE generation_attempts SET attempted_at = ? WHERE owner_id = ?")
      .bind(Date.now() - ATTEMPT_WINDOW_MS - 1, device.ownerId)
      .run();
    state.replies.push({ text: entryAnswer("c2") });
    expect(await generateEntry(device, topPage)).toMatchObject({
      status: "recipe",
      change: { revision: 1, recipe: { entry: { path: "/en/" } } },
    });
  });

  it("answers recipe-conflict when a login recipe starts on the entry page's path", async () => {
    const device = await owner();
    // A page with a form on `/en/` generated a login recipe there first.
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, { ...emailPage, path: "/en/" })).toMatchObject({
      status: "recipe",
    });
    expect(await generateEntry(device, topPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recipe-conflict",
    });
    // So does a chooser recipe (ADR 0028) stored there.
    const other = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/en/");
    const chooser = {
      version: 1,
      expectedRevision: 0,
      state: "active",
      recipe: {
        version: 1,
        id: recipeId,
        revision: 1,
        origin: ORIGIN,
        chooser: {
          path: "/en/",
          layouts: [
            { key: "1000", createdAt: 1000, other: { by: "text", value: "Use another account" } },
          ],
        },
      },
    };
    expect((await post(other, `/v1/recipes/${recipeId}`, chooser, "PUT")).status).toBe(200);
    expect(await generateEntry(other, topPage)).toMatchObject({ reason: "recipe-conflict" });
    expect(state.sent).toHaveLength(1);
  });

  it("generates a revoked entry recipe again as the revision after its tombstone", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/en/");
    state.replies.push({ text: entryAnswer("c2") });
    expect(await generateEntry(device, topPage)).toMatchObject({ status: "recipe" });
    const revoked = await post(
      device,
      `/v1/recipes/${recipeId}`,
      { version: 1, expectedRevision: 1, state: "revoked" },
      "PUT",
    );
    expect(revoked.status).toBe(200);
    await env.DB.prepare("UPDATE generation_attempts SET attempted_at = ? WHERE owner_id = ?")
      .bind(Date.now() - ATTEMPT_WINDOW_MS - 1, device.ownerId)
      .run();
    state.replies.push({ text: entryAnswer("c2") });
    expect(await generateEntry(device, topPage)).toMatchObject({
      status: "recipe",
      change: { recipeId, revision: 3, recipe: { revision: 3 } },
    });
  });

  it("answers with the entry recipe another device stored while the call ran", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/en/");
    const theirs = {
      version: 1,
      id: recipeId,
      revision: 1,
      origin: ORIGIN,
      entry: { path: "/en/", target: { by: "text", value: "Sign in" } },
    } as const;
    state.during = async () => {
      const written = await writeRecipe(
        env.DB,
        device.ownerId,
        recipeId,
        { version: 1, state: "active", expectedRevision: 0, recipe: theirs },
        device.deviceId,
      );
      expect(written.ok).toBe(true);
    };
    state.replies.push({ text: entryAnswer("c2") });
    expect(await generateEntry(device, topPage)).toEqual({
      version: 1,
      status: "recipe",
      change: { recipeId, revision: 1, state: "active", recipe: theirs },
    });
  });
}
