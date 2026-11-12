import { exports } from "cloudflare:workers";
import { completionPromptVersion } from "@pateat/inference";
import { expect, it, vi } from "vitest";
import type { GenerationContext } from "./context";

export function registerCompletion(context: GenerationContext) {
  const { element, observation, homePage, owner, post, complete, rows, twoPageRecipe, state } =
    context;

  it("passes rejection through, keeping only the verdict", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    state.replies.push({ text: JSON.stringify({ result: { decision: "rejected" } }) });
    expect(await complete(device, change.recipeId, 2)).toEqual({
      status: 200,
      body: { version: 1, status: "rejected" },
    });
    // Each revision and path is judged once, so another page path is sent.
    state.replies.push({ text: JSON.stringify({ result: { decision: "unclear" } }) });
    expect(
      (await complete(device, change.recipeId, 2, { ...homePage, path: "/welcome" })).body,
    ).toEqual({
      version: 1,
      status: "unclear",
    });
    const [head] = await rows(
      "SELECT revision FROM recipe_heads WHERE owner_id = ? AND recipe_id = ?",
      device.ownerId,
      change.recipeId,
    );
    expect(head).toEqual({ revision: 2 });
    // A path judged `rejected` is answered so again; one the model could not decide is
    // only `already-judged` (ADR 0029).
    const calls = state.sent.length;
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "judged-rejected",
    });
    expect(
      (await complete(device, change.recipeId, 2, { ...homePage, path: "/welcome" })).body,
    ).toEqual({ version: 1, status: "unavailable", reason: "already-judged" });
    expect(state.sent).toHaveLength(calls);
  });

  // A description that left out a disabled field may hide a code field waiting for its code
  // (owner, 2026-10-12, ADR 0029).
  it("judges a path again in full after the model could not decide a partial page", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const verdict = async () =>
      (
        await rows(
          "SELECT verdict FROM page_judgements WHERE owner_id = ? AND path = '/home'",
          device.ownerId,
        )
      ).map((row) => row["verdict"]);
    state.replies.push({ text: JSON.stringify({ result: { decision: "unclear" } }) });
    expect((await complete(device, change.recipeId, 2, homePage, true)).body).toEqual({
      version: 1,
      status: "unclear",
    });
    expect(await verdict()).toEqual(["partial"]);
    // Left out again, the page is not judged again, and the answer never completes it.
    const calls = state.sent.length;
    expect((await complete(device, change.recipeId, 2, homePage, true)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "already-judged",
    });
    expect(state.sent).toHaveLength(calls);
    // Described in full, the path is judged again, and its verdict is kept as usual.
    state.replies.push({ text: JSON.stringify({ result: { decision: "unclear" } }) });
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "unclear",
    });
    expect(state.sent).toHaveLength(calls + 1);
    expect(await verdict()).toEqual(["unclear"]);
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "already-judged",
    });
    expect(state.sent).toHaveLength(calls + 1);
  });

  it("keeps a partial page's decided verdict as for any page", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    state.replies.push({
      text: JSON.stringify({ result: { decision: "signed-in", marker: "logout" } }),
    });
    expect((await complete(device, change.recipeId, 2, homePage, true)).body).toMatchObject({
      version: 1,
      status: "signed-in",
    });
    expect(
      await rows(
        "SELECT verdict FROM page_judgements WHERE owner_id = ? AND path = '/home'",
        device.ownerId,
      ),
    ).toEqual([{ verdict: "signed-in" }]);
  });

  it("logs which check refused a judgement's output, as codes only", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    // A code source outside the list: the output format refuses it.
    state.replies.push({
      text: JSON.stringify({
        result: {
          decision: "challenge",
          code: { field: "logout", submit: "help", source: "Text message to your phone" },
        },
      }),
    });
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
    });
    const [logged] = await rows(
      "SELECT outcome, prompt_version, result FROM inference_log WHERE owner_id = ? AND role = 'judge'",
      device.ownerId,
    );
    expect({ ...logged, result: JSON.parse(String(logged!.result)) }).toEqual({
      outcome: "invalid-output",
      prompt_version: await completionPromptVersion(),
      result: {
        rejection: { check: "schema", issue: "picklist", path: "result.code.source" },
      },
    });
    expect(String(logged!.result)).not.toMatch(/phone/u);
    expect(info).toHaveBeenCalledWith("Model output refused", {
      role: "judge",
      promptVersion: await completionPromptVersion(),
      rejection: { check: "schema", issue: "picklist", path: "result.code.source" },
    });
    info.mockRestore();
    // The failed request left the path without a verdict, so a later login of the
    // revision never completes on it (ADR 0029).
    const calls = state.sent.length;
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "judgement-unanswered",
    });
    expect(state.sent).toHaveLength(calls);
  });

  it("does not judge a page that shows the login form again", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const calls = state.sent.length;
    const reposted = observation("/session", [
      element("email", "email", "Email"),
      element("help", "link", "Help"),
    ]);
    expect((await complete(device, change.recipeId, 2, reposted)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "not-judgeable",
    });
    expect(state.sent).toHaveLength(calls);
  });

  it("checks the recipe, revision, origin and owner before any call", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const calls = state.sent.length;

    expect((await complete(device, change.recipeId, 1)).body).toMatchObject({
      reason: "recipe-conflict",
    });
    // Another origin is judged only over HTTPS (ADR 0022).
    expect(
      (
        await complete(device, change.recipeId, 2, {
          ...homePage,
          origin: "http://www.example.test",
        })
      ).status,
    ).toBe(400);
    expect((await complete(device, "gen-missing", 1)).status).toBe(404);
    // Another owner cannot see or judge this owner's recipe.
    expect((await complete(await owner(), change.recipeId, 2)).status).toBe(404);
    expect(state.sent).toHaveLength(calls);
  });

  it("answers other methods with 405", async () => {
    const device = await owner();
    const responses = await Promise.all(
      ["/v1/recipes/generate", "/v1/recipes/gen-1/completion"].map((path) =>
        exports.default.fetch(`https://pateat.invalid${path}`, {
          headers: { Authorization: `Bearer ${device.token}` },
        }),
      ),
    );
    const put = await post(device, "/v1/recipes/generate", {}, "PUT");
    for (const response of [...responses, put]) {
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
    }
  });
}
