import { PAGE_SAMPLE_INTERVAL_MS } from "@pateat/contracts";
import { expect, it, vi } from "vitest";
import { MAX_PAGE_SAMPLES } from "../../../src/service/generation";
import { DEVICE_GENERATION_ORIGIN } from "../../../src/service/device-generation";
import type { Samples1Context } from "./context";

export function registerSamples1(context: Samples1Context) {
  const { connection, KEY, recipeId, signedIn, sample, accountSlots, sampleSetup } = context;

  it("records a sample before sending it, and sends the next only after 30 days", async () => {
    const h = sampleSetup();
    const sent = vi.fn(async () => undefined);
    expect(await h.generation.samplePage!(sample, h.describePage, sent)).toEqual({
      outcome: "kept",
    });
    expect(h.order).toEqual(["record", "send"]);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(h.samplePage).toHaveBeenCalledWith(connection.origin, connection.credential, recipeId, {
      version: 1,
      revision: 2,
      route: "password",
      branch: KEY,
      observation: signedIn,
      // The judge request's slots: `totp` only beside a code field (owner 2026-10-23).
      slots: [accountSlots[0]],
    });
    expect(h.stored()).toEqual({
      version: 1,
      samples: [
        {
          service: connection.origin,
          deviceId: connection.deviceId,
          recipeId,
          branch: KEY,
          at: 5_000_000_000,
        },
      ],
    });
    // Within 30 days the page is not even described.
    h.advance(PAGE_SAMPLE_INTERVAL_MS - 1);
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({ outcome: "not-due" });
    expect(h.describePage).toHaveBeenCalledTimes(1);
    expect(h.samplePage).toHaveBeenCalledTimes(1);
    // Another branch of a chooser is sampled on its own.
    expect(
      await h.generation.samplePage!({ ...sample, branch: `${KEY}:account` }, h.describePage),
    ).toEqual({
      outcome: "kept",
    });
    expect(h.samplePage.mock.calls[1]![3]).toMatchObject({ branch: `${KEY}:account` });
    h.advance(1);
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({ outcome: "kept" });
    expect(h.samplePage).toHaveBeenCalledTimes(3);
    // Expired samples are dropped when the next is recorded.
    expect(
      (h.stored() as { samples: { branch?: string }[] }).samples.map((entry) => entry.branch),
    ).toEqual([`${KEY}:account`, KEY]);
  });

  it("samples no page of a login without a layout (ADR 0060)", async () => {
    const h = sampleSetup();
    const { branch: _branch, ...unnamed } = sample;
    expect(await h.generation.samplePage!(unnamed, h.describePage)).toEqual({
      outcome: "not-due",
      reason: "no-layout",
    });
    expect(h.describePage).not.toHaveBeenCalled();
    expect(h.samplePage).not.toHaveBeenCalled();
  });

  it("sends nothing and describes nothing without a paired service", async () => {
    const h = sampleSetup(false);
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({
      outcome: "not-due",
      reason: "not-connected",
    });
    expect(h.describePage).not.toHaveBeenCalled();
    expect(h.sampleStorage.read).not.toHaveBeenCalled();
    expect(h.samplePage).not.toHaveBeenCalled();
  });

  it("keeps no sample on a device without a pairing, which generates on its own (ADR 0040)", async () => {
    const h = sampleSetup({
      origin: DEVICE_GENERATION_ORIGIN,
      deviceId: DEVICE_GENERATION_ORIGIN,
      credential: "",
      rejected: false,
    });
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({
      outcome: "not-due",
      reason: "not-connected",
    });
    expect(h.describePage).not.toHaveBeenCalled();
    expect(h.samplePage).not.toHaveBeenCalled();
  });

  it("records nothing for a page that could not be described, so a later login may send it", async () => {
    const h = sampleSetup();
    h.describePage.mockResolvedValueOnce({ unsent: "incomplete" });
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({
      outcome: "not-sent",
      reason: "incomplete",
    });
    expect(h.sampleStorage.write).not.toHaveBeenCalled();
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({ outcome: "kept" });
  });

  it("never sends a sample it could not record", async () => {
    const h = sampleSetup();
    h.sampleStorage.write.mockRejectedValueOnce(new Error("storage"));
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({
      outcome: "not-sent",
      reason: "storage-unavailable",
    });
    expect(h.samplePage).not.toHaveBeenCalled();
  });

  it("keeps a sample recorded when its request fails, and reports the service's answers", async () => {
    const h = sampleSetup();
    h.samplePage.mockResolvedValueOnce({ kind: "failed", error: "unreachable" });
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({
      outcome: "failed",
      reason: "unreachable",
    });
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({ outcome: "not-due" });
    h.samplePage.mockResolvedValueOnce({ kind: "recent" });
    expect(
      await h.generation.samplePage!({ ...sample, branch: `${KEY}:other` }, h.describePage),
    ).toEqual({
      outcome: "recent",
    });
    h.samplePage.mockResolvedValueOnce({ kind: "rejected" });
    expect(
      await h.generation.samplePage!({ ...sample, branch: `${KEY}:account` }, h.describePage),
    ).toEqual({
      outcome: "failed",
      reason: "device-rejected",
    });
    h.samplePage.mockResolvedValueOnce({ kind: "gone" });
    expect(
      await h.generation.samplePage!({ ...sample, recipeId: `${recipeId}0` }, h.describePage),
    ).toEqual({ outcome: "gone" });
    h.samplePage.mockResolvedValueOnce({ kind: "refused" });
    expect(
      await h.generation.samplePage!({ ...sample, recipeId: `${recipeId}1` }, h.describePage),
    ).toEqual({ outcome: "refused" });
  });

  it("stops a recorded sample that the last check before sending refuses", async () => {
    const h = sampleSetup();
    // The site was paused while the page was described and the sample recorded.
    const sending = vi.fn(async () => "paused");
    expect(await h.generation.samplePage!(sample, h.describePage, sending)).toEqual({
      outcome: "not-sent",
      reason: "paused",
    });
    expect(h.order).toEqual(["record"]);
    expect(h.samplePage).not.toHaveBeenCalled();
    // The record stays, so the recipe is not sampled again within 30 days.
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({ outcome: "not-due" });
    // A check that fails stops it as well.
    const failing = vi.fn(async (): Promise<string | undefined> => {
      throw new Error("synthetic settings failure");
    });
    expect(
      await h.generation.samplePage!(
        { ...sample, branch: `${KEY}:account` },
        h.describePage,
        failing,
      ),
    ).toEqual({ outcome: "not-sent", reason: "settings-unavailable" });
    expect(h.samplePage).not.toHaveBeenCalled();
  });

  it("sends one of two samples of a recipe asked for at once", async () => {
    const h = sampleSetup();
    const answers = await Promise.all([
      h.generation.samplePage!(sample, h.describePage),
      h.generation.samplePage!(sample, h.describePage),
    ]);
    // Both were due and described; the second found the first's record when it claimed.
    expect(h.describePage).toHaveBeenCalledTimes(2);
    expect(answers).toEqual([{ outcome: "kept" }, { outcome: "not-due" }]);
    expect(h.samplePage).toHaveBeenCalledTimes(1);
    expect((h.stored() as { samples: unknown[] }).samples).toHaveLength(1);
  });

  it("keeps samples apart per service and device, and at most 200 of them", async () => {
    const h = sampleSetup();
    const ids = Array.from(
      { length: MAX_PAGE_SAMPLES },
      (_, index) => `gen-${index.toString(16).padStart(32, "0")}`,
    );
    for (const id of ids)
      // eslint-disable-next-line no-await-in-loop
      await h.generation.samplePage!({ ...sample, recipeId: id }, h.describePage);
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({ outcome: "kept" });
    const samples = (h.stored() as { samples: { recipeId: string }[] }).samples;
    expect(samples).toHaveLength(MAX_PAGE_SAMPLES);
    expect(samples[0]!.recipeId).toBe(ids[1]);
    expect(samples.at(-1)!.recipeId).toBe(recipeId);
    // A sample another device of the service recorded does not count for this one.
    const stored = h.stored() as { version: 1; samples: Record<string, unknown>[] };
    h.sampleStorage.read.mockResolvedValue({
      version: 1,
      samples: stored.samples.map((entry) => ({ ...entry, deviceId: "another-device" })),
    });
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({ outcome: "kept" });
  });
}
