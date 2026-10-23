import { toJsonSchema } from "@valibot/to-json-schema";
import { describe, expect, it } from "vitest";
import {
  completionBesideInstructions,
  completionBesidePromptVersion,
  completionInstructions,
  completionPromptVersion,
  completionStopInstructions,
  completionStopPromptVersion,
  judgedPageSchema,
} from "./completion";
import {
  accountListGenerationInstructions,
  accountListGenerationPromptVersion,
  entryGenerationInstructions,
  entryGenerationPromptVersion,
  generatedPlanSchema,
  generationInstructions,
  generationPromptVersion,
} from "./generation";
import { promptVersion, promptVersionOf } from "./outcome";

describe("prompt versions", () => {
  const schema = JSON.stringify(toJsonSchema(generatedPlanSchema));

  it("hashes the instructions and the response format into 12 hex digits", async () => {
    const version = await promptVersion(generationInstructions, schema);
    expect(version).toMatch(/^[0-9a-f]{12}$/u);
    expect(await generationPromptVersion()).toBe(version);
    expect(await completionPromptVersion()).toBe(
      await promptVersion(completionInstructions, JSON.stringify(toJsonSchema(judgedPageSchema))),
    );
    expect(await completionPromptVersion()).not.toBe(version);
    // A page at a login's stop before a password (ADR 0036) is judged under its own version.
    expect(await completionStopPromptVersion()).toBe(
      await promptVersion(
        completionStopInstructions,
        JSON.stringify(toJsonSchema(judgedPageSchema)),
      ),
    );
    expect(await completionStopPromptVersion()).not.toBe(await completionPromptVersion());
    // So is a page beside the sign-in form (ADR 0061).
    expect(await completionBesidePromptVersion()).toBe(
      await promptVersion(
        completionBesideInstructions,
        JSON.stringify(toJsonSchema(judgedPageSchema)),
      ),
    );
    expect(await completionBesidePromptVersion()).not.toBe(await completionPromptVersion());
    expect(await completionBesidePromptVersion()).not.toBe(await completionStopPromptVersion());
    // An entry request (ADR 0031) sends other instructions with the same response format.
    expect(await entryGenerationPromptVersion()).toBe(
      await promptVersion(entryGenerationInstructions, schema),
    );
    expect(await entryGenerationPromptVersion()).not.toBe(version);
    // So does a request for a list of accounts (ADR 0028).
    expect(await accountListGenerationPromptVersion()).toBe(
      await promptVersion(accountListGenerationInstructions, schema),
    );
    expect(await accountListGenerationPromptVersion()).not.toBe(version);
  });

  it("changes when the instruction text or the response format changes", async () => {
    const version = await promptVersion(generationInstructions, schema);
    expect(await promptVersion(`${generationInstructions} `, schema)).not.toBe(version);
    expect(
      await promptVersion(generationInstructions.replace("Pateat", "pateat"), schema),
    ).not.toBe(version);
    expect(await promptVersion(generationInstructions, schema.replace("64", "65"))).not.toBe(
      version,
    );
    // The newline keeps the two parts apart.
    expect(await promptVersion("ab", "c")).not.toBe(await promptVersion("a", "bc"));
  });

  it("computes a role's version once", async () => {
    const version = promptVersionOf("instructions", "{}");
    const first = version();
    expect(version()).toBe(first);
    expect(await first).toBe(await promptVersion("instructions", "{}"));
  });
});
