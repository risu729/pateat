import { type RecipeGenerationResult } from "@pateat/contracts";
import {
  generationInstructions,
  generationPromptVersion,
  passkeyOnlyGenerationInstructions,
  passkeyOnlyGenerationPromptVersion,
} from "@pateat/inference";
import { expect, it } from "vitest";
import type { GenerationContext } from "./context";

export function registerPasskeyOnly(context: GenerationContext) {
  const { element, observation, owner, post, rows, state } = context;

  it("persists and reuses a click-only passkey recipe from a locally mocked model", async () => {
    const device = await owner();
    const page = observation("/passkey-login", [
      element("login-key", "button", "Sign in with a passkey"),
    ]);
    state.replies.push({
      text: JSON.stringify({
        result: {
          decision: "plan",
          pageKind: "sign-in",
          irreversible: "no",
          fields: [],
          action: { candidate: "login-key", purpose: "submit" },
          passkeyButton: "login-key",
        },
      }),
    });
    const body = { version: 1, observation: page, slots: [], passkeyOnly: true, signedIn: false };
    const response = await post(device, "/v1/recipes/generate", body);
    expect(response.status).toBe(200);
    const first = (await response.json()) as RecipeGenerationResult;
    // The recipe's one layout (ADR 0060) is the passkey-only route.
    expect(first).toMatchObject({
      status: "recipe",
      change: {
        recipe: {
          layouts: [
            {
              passkeyOnly: true,
              slots: [],
              steps: [{ kind: "click", purpose: "submit", path: "/passkey-login" }],
            },
          ],
        },
      },
    });
    expect(state.sent).toHaveLength(1);
    // The page goes out with the passkey-only instructions alone, logged under their own
    // prompt version; a request with slots keeps the generation role's (ADR 0053).
    const system = (state.sent[0]!.body as { system: { text: string }[] }).system;
    expect(system.map((part) => part.text)).toEqual([passkeyOnlyGenerationInstructions]);
    const [logged] = await rows(
      "SELECT prompt_version, request FROM inference_log WHERE owner_id = ?",
      device.ownerId,
    );
    expect(logged!["prompt_version"]).toBe(await passkeyOnlyGenerationPromptVersion());
    expect(JSON.parse(String(logged!["request"]))).toMatchObject({
      instructions: passkeyOnlyGenerationInstructions,
      slots: [],
      passkeyOnly: true,
    });
    expect(await passkeyOnlyGenerationPromptVersion()).not.toBe(await generationPromptVersion());
    expect(passkeyOnlyGenerationInstructions).not.toBe(generationInstructions);
    const again = await post(device, "/v1/recipes/generate", body);
    expect(await again.json()).toEqual(first);
    expect(state.sent).toHaveLength(1);
    const unmarked = await post(device, "/v1/recipes/generate", {
      ...body,
      passkeyOnly: undefined,
    });
    expect(unmarked.status).toBe(400);
    expect(state.sent).toHaveLength(1);
  });
}
