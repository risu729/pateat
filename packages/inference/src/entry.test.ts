import type { LoginObservation, ObservedCandidate } from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import { entryRecipe } from "./assemble";
import { evaluationCorpus } from "./corpus/cases";
import {
  createEntryGenerator,
  createRecipeGenerator,
  entryGenerationInstructions,
  entryInstruction,
  generationInstructions,
} from "./generation";
import { validateEntry } from "./plan";
import { textModel, textResult } from "./testing/fake-models";

// ADR 0031: a synthetic top page without a login form, sent without slots.

const limits = { timeoutMs: 1_000, maxInputBytes: 16_384 };
const link = (id: string, text: string): ObservedCandidate => ({
  id,
  role: "link",
  target: { by: "text", value: text },
});
const topPage: LoginObservation = {
  version: 1,
  origin: "https://shop.example.test",
  path: "/en/",
  language: "en",
  complete: true,
  candidates: [
    link("c1", "Create account"),
    link("c2", "Login"),
    { id: "c3", role: "button", target: { by: "text", value: "Search" } },
    { id: "c4", role: "link", target: { by: "id", value: "sign-in" }, label: "Sign in" },
  ],
};
const entry = (candidate: string) =>
  JSON.stringify({ result: { decision: "entry", entry: candidate } });

function entryGenerator(text: string) {
  const model = textModel(async () => textResult(text));
  return { model, generate: createEntryGenerator({ model, limits, maxOutputTokens: 512 }) };
}

describe("entry generation (ADR 0031)", () => {
  it("returns the link the model names, with its locator", async () => {
    const { model, generate } = entryGenerator(entry("c2"));
    expect(await generate({ observation: topPage })).toMatchObject({
      status: "ok",
      calls: 1,
      value: { entry: "c2", target: { by: "text", value: "Login" } },
    });
    // The entry line goes with the generation role's instructions, and no slot is sent.
    const call = model.doGenerateCalls[0]!;
    const system = call.prompt.filter((message) => message.role === "system");
    expect(system.map((message) => message.content)).toEqual([entryGenerationInstructions]);
    expect(entryGenerationInstructions).toBe(`${generationInstructions} ${entryInstruction}`);
    const user = call.prompt.find((message) => message.role === "user")!;
    const text = user.content.find((part) => part.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "")).toEqual({
      task: "entry",
      observation: topPage,
    });
  });

  it("returns a link located by its id with its label checked", async () => {
    const { generate } = entryGenerator(entry("c4"));
    expect(await generate({ observation: topPage })).toMatchObject({
      status: "ok",
      value: { entry: "c4", target: { by: "id", value: "sign-in" } },
    });
  });

  it("passes an abstention through", async () => {
    const { generate } = entryGenerator(
      JSON.stringify({ result: { decision: "abstain", reason: "no-login-form" } }),
    );
    expect(await generate({ observation: topPage })).toMatchObject({
      status: "abstained",
      reason: "no-login-form",
    });
  });

  it("refuses a plan for an entry request, kept by reference only", async () => {
    const { generate } = entryGenerator(
      JSON.stringify({
        result: {
          decision: "plan",
          pageKind: "sign-in",
          irreversible: "no",
          fields: [{ slot: "username", candidate: "c2" }],
          action: { candidate: "Search", purpose: "submit" },
        },
      }),
    );
    expect(await generate({ observation: topPage })).toMatchObject({
      status: "failed",
      error: "invalid-output",
      detail: "unexpected-plan",
      output: {
        result: {
          fields: [{ slot: "?", candidate: "c2" }],
          action: { candidate: "?", purpose: "submit" },
        },
      },
      // The request log's answer reduces it the same way: an entry request has no slots.
      answer: {
        decision: "plan",
        pageKind: "sign-in",
        irreversible: "no",
        fields: [{ slot: "?", candidate: "c2" }],
        action: { candidate: "?", purpose: "submit" },
      },
    });
  });

  it("keeps the named entry as the answer, and ? for an ID the page lacks", async () => {
    expect((await entryGenerator(entry("c2")).generate({ observation: topPage })).answer).toEqual({
      decision: "entry",
      entry: "c2",
    });
    const unknown = await entryGenerator(entry("Log in here")).generate({ observation: topPage });
    expect(unknown).toMatchObject({
      status: "failed",
      error: "invalid-output",
      answer: { decision: "entry", entry: "?" },
    });
  });

  it("refuses an account list for an entry request", async () => {
    const { generate } = entryGenerator(
      JSON.stringify({ result: { decision: "account-list", other: "c2" } }),
    );
    expect(await generate({ observation: topPage })).toMatchObject({
      status: "failed",
      error: "invalid-output",
      detail: "unexpected-account-list",
      output: { result: { decision: "account-list", other: "c2" } },
    });
  });

  it("refuses an entry for a request with slots", async () => {
    const page = evaluationCorpus[0]!;
    const model = textModel(async () => textResult(entry("email")));
    const generate = createRecipeGenerator({ model, limits, maxOutputTokens: 512 });
    expect(await generate({ observation: page.observation, slots: page.slots })).toMatchObject({
      status: "failed",
      error: "invalid-output",
      detail: "unexpected-entry",
      output: { result: { decision: "entry", entry: "email" } },
    });
    // The first-page instructions never carry the entry line.
    const system = model.doGenerateCalls[0]!.prompt.filter((message) => message.role === "system");
    expect(system.map((message) => message.content)).toEqual([generationInstructions]);
    expect(generationInstructions).not.toContain(entryInstruction);
  });

  it.each([
    ["a button", "c3", "incompatible-role"],
    ["an unknown candidate", "Login", "unknown-candidate"],
  ])("refuses an entry that names %s", async (_name, candidate, detail) => {
    const { generate } = entryGenerator(entry(candidate));
    expect(await generate({ observation: topPage })).toMatchObject({
      status: "failed",
      error: "invalid-output",
      detail,
      output: { result: { decision: "entry", entry: candidate === "Login" ? "?" : candidate } },
    });
  });

  it("refuses a page with a field, accounts or no complete description before any call", async () => {
    const field: ObservedCandidate = {
      id: "email",
      role: "email",
      target: { by: "id", value: "email" },
    };
    const cases = [
      [{ ...topPage, candidates: [...topPage.candidates, field] }, "invalid-request"],
      [{ ...topPage, accounts: ["[email]"] }, "invalid-request"],
      [{ ...topPage, path: "relative" }, "invalid-request"],
      [{ ...topPage, complete: false }, "incomplete-observation"],
    ] as const;
    await Promise.all(
      cases.map(async ([observation, error]) => {
        const { model, generate } = entryGenerator(entry("c2"));
        expect(await generate({ observation })).toMatchObject({
          status: "failed",
          error,
          calls: 0,
        });
        expect(model.doGenerateCalls).toHaveLength(0);
      }),
    );
  });
});

describe("entry plan check (ADR 0031)", () => {
  const page = (candidate: ObservedCandidate) => ({ candidates: [link("c2", "Login"), candidate] });

  it("accepts a link located by id, name, test ID or text", () => {
    for (const target of [
      { by: "id", value: "login" },
      { by: "name", value: "login" },
      { by: "test-id", value: "login-link" },
      { by: "text", value: "Sign in" },
    ] as const)
      expect(validateEntry(page({ id: "x", role: "link", target }), "x")).toEqual({
        ok: true,
        entry: { entry: "x", target },
      });
  });

  it.each([
    ["an email address", "Continue as a@example.test"],
    ["[email]", "Continue as [email]"],
    ["[masked]", "Account [masked]"],
    ["[number]", "Member [number]"],
    ["four digits", "Member 1234"],
  ])("refuses a link whose text holds %s", (_name, text) => {
    expect(validateEntry(page(link("x", text)), "x")).toEqual({
      ok: false,
      reason: "account-text",
    });
    expect(
      validateEntry(
        page({ id: "x", role: "link", target: { by: "id", value: "x" }, label: text }),
        "x",
      ),
    ).toEqual({ ok: false, reason: "account-text" });
  });

  it("refuses a link whose locator value may name an account", () => {
    expect(
      validateEntry(
        page({ id: "x", role: "link", target: { by: "id", value: "user-12345" }, label: "Login" }),
        "x",
      ),
    ).toEqual({ ok: false, reason: "account-text" });
  });

  it("keeps short numbers and brackets that are no redaction", () => {
    expect(validateEntry(page(link("x", "Login 24/7 [beta]")), "x")).toMatchObject({ ok: true });
  });

  it("refuses a button, a field and an unknown candidate", () => {
    const button: ObservedCandidate = {
      id: "x",
      role: "button",
      target: { by: "text", value: "Login" },
    };
    expect(validateEntry(page(button), "x")).toEqual({ ok: false, reason: "incompatible-role" });
    const field: ObservedCandidate = {
      id: "x",
      role: "text",
      target: { by: "autocomplete", value: "username" },
    };
    expect(validateEntry(page(field), "x")).toEqual({ ok: false, reason: "incompatible-role" });
    // A visible name names only a field (ADR 0037), even on a link the check is given.
    expect(
      validateEntry(page({ id: "x", role: "link", target: { by: "label", value: "Login" } }), "x"),
    ).toEqual({ ok: false, reason: "incompatible-role" });
    // An accessible name names only a `password` handler's button (ADR 0048 amendment of
    // 2026-10-19).
    expect(
      validateEntry(
        page({ id: "x", role: "link", target: { by: "accessible-name", value: "Login" } }),
        "x",
      ),
    ).toEqual({ ok: false, reason: "incompatible-role" });
    expect(validateEntry(page(button), "y")).toEqual({ ok: false, reason: "unknown-candidate" });
  });
});

describe("entry recipe assembly (ADR 0031)", () => {
  it("builds a recipe with only its entry", () => {
    expect(
      entryRecipe({
        id: "gen-1",
        revision: 3,
        origin: "https://shop.example.test",
        path: "/en/",
        target: { by: "text", value: "Login" },
      }),
    ).toEqual({
      ok: true,
      recipe: {
        version: 1,
        id: "gen-1",
        revision: 3,
        origin: "https://shop.example.test",
        entry: { path: "/en/", target: { by: "text", value: "Login" } },
      },
    });
  });

  it("refuses a recipe the contract does not accept", () => {
    for (const page of [
      { origin: "https://shop.example.test/", path: "/en/" },
      { origin: "https://shop.example.test", path: "/en/?return_to=/x" },
    ])
      expect(
        entryRecipe({ id: "gen-1", revision: 1, target: { by: "text", value: "Login" }, ...page }),
      ).toEqual({ ok: false, reason: "invalid-recipe" });
  });
});
