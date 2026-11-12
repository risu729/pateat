import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { ssoCompletionRequestSchema } from "./sso-generation";
import { completionRequestSchema, recipeCompletionRequestSchema } from "./generation";

const request = {
  version: 1,
  kind: "sso-completion",
  revision: 1,
  layout: "1000",
  observation: {
    version: 1,
    origin: "https://rp.example.test",
    path: "/home",
    language: "en",
    complete: true,
    candidates: [
      { id: "logout", role: "button", target: { by: "id", value: "logout" }, label: "Sign out" },
    ],
  },
};
describe("dedicated value-free RP-return judgement request", () => {
  it("uses its explicit kind and layout while the generic native request remains native", () => {
    expect(v.safeParse(ssoCompletionRequestSchema, request).success).toBe(true);
    expect(v.safeParse(completionRequestSchema, request).success).toBe(true);
    expect(v.safeParse(recipeCompletionRequestSchema, request).success).toBe(false);
    expect(
      v.safeParse(recipeCompletionRequestSchema, {
        version: 1,
        revision: 1,
        route: "sso",
        branch: "1000",
        observation: request.observation,
        slots: [],
      }).success,
    ).toBe(false);
  });
  it.each([
    "account",
    "username",
    "password",
    "idpOrigin",
    "mapping",
    "sourceEvidence",
    "usernameProof",
    "fieldId",
    "slots",
    "route",
    "branch",
  ])("has no field for %s in remote RP judgement", (field) =>
    expect(
      v.safeParse(ssoCompletionRequestSchema, { ...request, [field]: "synthetic-private" }).success,
    ).toBe(false),
  );
  it.each([
    { kind: "completion" },
    { revision: 0 },
    { layout: "" },
    { layout: "native-layout" },
    { layout: "1000".repeat(5) },
    { version: 2 },
  ])("refuses a malformed or alternate request family %#", (change) => {
    expect(v.safeParse(ssoCompletionRequestSchema, { ...request, ...change }).success).toBe(false);
  });
  it.each(["anthropic", "openai"] as const)(
    "carries the existing bounded %s device relay without values",
    (provider) => {
      const deviceModel = {
        provider,
        responses: [],
        judgement: { id: "a0000000-0000-4000-8000-000000000001" },
      };
      expect(v.safeParse(ssoCompletionRequestSchema, { ...request, deviceModel }).success).toBe(
        true,
      );
      expect(
        v.safeParse(ssoCompletionRequestSchema, {
          ...request,
          deviceModel: { ...deviceModel, apiKey: "synthetic-key" },
        }).success,
      ).toBe(false);
    },
  );
});
