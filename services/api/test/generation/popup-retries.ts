import { type RecipeGenerationResult } from "@pateat/contracts";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { GenerationContext, Device } from "./context";

export function registerPopupRetries(context: GenerationContext) {
  const { slots, emailPage, plan, holdSlots, owner, post, generate, rows, month, day, state } =
    context;

  const manual = async (device: Device) => {
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: emailPage,
      slots,
      signedIn: false,
      manual: true,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as RecipeGenerationResult;
  };

  it("retries a recent abstention while recording and charging the new call", async () => {
    const device = await owner();
    state.replies.push({
      text: JSON.stringify({ result: { decision: "abstain", reason: "ambiguous" } }),
    });
    expect(await generate(device, emailPage)).toMatchObject({ status: "abstained" });
    expect(await generate(device, emailPage)).toMatchObject({ reason: "recently-tried" });
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await manual(device)).toMatchObject({ status: "recipe" });
    expect(state.sent).toHaveLength(2);
    expect(
      await rows("SELECT path FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([{ path: "/login" }]);
    const spend = await rows(
      "SELECT calls FROM inference_spend WHERE owner_id = ?",
      device.ownerId,
    );
    expect(spend).toHaveLength(2);
    expect(spend.every((row) => row["calls"] === 2)).toBe(true);
  });

  it.each(["monthly", "daily"] as const)("keeps the %s spend limit", async (period) => {
    const device = await owner();
    await env.DB.prepare(
      "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, ?, 1, ?)",
    )
      .bind(
        device.ownerId,
        period === "monthly" ? month() : day(),
        period === "monthly" ? 100_000_000 : 5_000_000,
      )
      .run();
    expect(await manual(device)).toMatchObject({
      status: "unavailable",
      reason: `${period}-limit`,
    });
    expect(state.sent).toEqual([]);
    expect(
      await rows("SELECT path FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([]);
  });

  it("keeps the per-owner model concurrency limit", async () => {
    const device = await owner();
    await holdSlots(device.ownerId);
    expect(await manual(device)).toMatchObject({ status: "unavailable", reason: "busy" });
    expect(state.sent).toEqual([]);
    expect(
      await rows("SELECT path FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([]);
  });
}
