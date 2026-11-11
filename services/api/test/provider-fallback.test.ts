import type { ModelConfig } from "@pateat/contracts";
import type { GenerationCall } from "@pateat/generation";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { runCall } from "../src/claude/call-execution";
import { saveModelConfig } from "../src/claude/models";
import * as credentials from "../src/claude/provider-credentials";

afterEach(() => vi.restoreAllMocks());

it("keeps credential time from both providers when a refusal falls back to another provider", async () => {
  const ownerId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, 1)").bind(ownerId).run();
  const choices: ModelConfig["generate"] = [
    { provider: "openai", model: "gpt-6.1-sol", effort: "low", speed: "standard" },
    { provider: "anthropic", model: "claude-sonnet-5-5", effort: "low", speed: "standard" },
  ];
  await saveModelConfig(env.DB, ownerId, { generate: choices, judge: choices });
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const resolve = vi
    .spyOn(credentials, "resolveModelCredential")
    .mockImplementation(async (_env, _owner, provider) => {
      now += provider === "openai" ? 17 : 53;
      return { status: "ready", credential: { apiKey: `synthetic-${provider}-key` } };
    });
  const invoke = vi
    .fn<GenerationCall<string>["invoke"]>()
    .mockImplementationOnce(async () => {
      now += 11;
      return {
        status: "failed",
        error: "refused",
        calls: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    })
    .mockImplementationOnce(async () => {
      now += 23;
      return {
        status: "ok",
        value: "synthetic-result",
        calls: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
  const call: GenerationCall<string> = {
    role: "generate",
    promptVersion: "synthetic",
    origin: "https://timing.example.test",
    path: "/login",
    request: { instructions: "Synthetic test", observation: {} },
    recipe: { recipeId: crypto.randomUUID(), branch: "password", baseRevision: 0 },
    invoke,
    logValue: (value) => value,
  };
  const result = await runCall(env, ownerId, call, now);
  expect(result).toMatchObject({
    status: "called",
    outcome: { status: "ok", value: "synthetic-result" },
    served: { provider: "anthropic", model: "claude-sonnet-5-5" },
    timings: { tokenMs: 70, modelMs: 34 },
  });
  expect(resolve.mock.calls.map((args) => args[2])).toEqual(["openai", "anthropic"]);
  expect(invoke).toHaveBeenCalledTimes(2);
  const rows = (
    await env.DB.prepare(
      "SELECT provider, token_ms, model_ms FROM inference_log WHERE owner_id = ? ORDER BY created_at",
    )
      .bind(ownerId)
      .all()
  ).results;
  expect(rows).toEqual([
    { provider: "openai", token_ms: 17, model_ms: 11 },
    { provider: "anthropic", token_ms: 53, model_ms: 23 },
  ]);
});
