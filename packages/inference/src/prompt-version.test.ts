import { toJsonSchema } from "@valibot/to-json-schema";
import { describe, expect, it } from "vitest";
import { completionInstructions, completionPromptVersion, judgedPageSchema } from "./completion";
import { generatedPlanSchema, generationInstructions, generationPromptVersion } from "./generation";
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
