import { describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import {
  bindingRepairRequestSchema,
  bindingReviewResponseSchema,
  createBindingReviewClient,
} from "./binding-review-wire";
import { bindingProfileScope } from "./runtime/binding-review-state";

describe("binding review wire", () => {
  const valid = {
    version: 1,
    type: "login.binding-review.pick",
    tabId: 1,
    reviewId: "synthetic-review",
    picks: [{ slot: "branch", fieldId: "custom.synthetic" }],
  };
  it.each([
    { ...valid, version: 2 },
    { ...valid, tabId: 1.5 },
    { ...valid, reviewId: "" },
    { ...valid, picks: [] },
    { ...valid, picks: [{ slot: "branch", fieldId: "custom.synthetic", value: "secret" }] },
    { ...valid, remember: true },
  ])("rejects malformed or permission-bearing request %j", (request) => {
    expect(v.safeParse(bindingRepairRequestSchema, request).success).toBe(false);
  });
  it("rejects field values or an expanded permission on the names-only response", () => {
    const response = {
      ok: true,
      blocked: [],
      repair: {
        reviewId: "synthetic-review",
        origin: "https://login.example",
        item: "Synthetic",
        slots: [
          {
            slot: "branch",
            name: "Old",
            reason: "field-missing",
            candidates: [
              { fieldId: "custom.synthetic", name: "Branch", value: "synthetic-secret" },
            ],
          },
        ],
      },
    };
    expect(v.safeParse(bindingReviewResponseSchema, response).success).toBe(false);
    expect(
      v.safeParse(bindingReviewResponseSchema, { ok: true, blocked: [], grant: true }).success,
    ).toBe(false);
  });
  it("uses separate review messages and validates the worker response", async () => {
    const send = vi.fn(async (_message: unknown): Promise<unknown> => ({ ok: true, blocked: [] }));
    const client = createBindingReviewClient(send);
    expect(await client.get(1)).toEqual({ ok: true, blocked: [] });
    expect(send).toHaveBeenLastCalledWith({
      version: 1,
      type: "login.binding-review.get",
      tabId: 1,
    });
    send.mockResolvedValueOnce({ ok: false, reason: "stale-review" });
    expect(
      await client.pick({ tabId: 1, reviewId: "synthetic-review", picks: valid.picks }),
    ).toEqual({ ok: false, reason: "stale-review" });
    expect(send).toHaveBeenLastCalledWith(valid);
    send.mockResolvedValueOnce({ ok: true, waiting: "master-password" });
    expect(
      await client.pick({ tabId: 1, reviewId: "synthetic-review", picks: valid.picks }),
    ).toEqual({ ok: true, waiting: "master-password" });
    send.mockResolvedValueOnce({ ok: true, blocked: [] });
    await client.get(1, true);
    expect(send).toHaveBeenLastCalledWith({
      version: 1,
      type: "login.binding-review.get",
      tabId: 1,
      reconnect: true,
    });
    send.mockResolvedValueOnce({ ok: true, blocked: [], secret: "synthetic-secret" });
    await expect(client.get(1)).rejects.toThrow();
  });
});

describe("profile identity for a binding review", () => {
  const device = { origin: "https://service.example", deviceId: "synthetic-device" };
  const base = { ...device, profileId: "profile-a" };
  it("retains only service, device and profile identity", () => {
    expect(
      bindingProfileScope(
        { ...base, accessToken: "synthetic-secret", settings: { anything: true } },
        { revision: 5 },
        device,
      ),
    ).toBe(JSON.stringify([device.origin, device.deviceId, "profile-a"]));
    expect(bindingProfileScope(undefined, { revision: 5 }, undefined)).toBe("local");
  });
  it("rejects a base that belongs to a different service or device", () => {
    expect(() =>
      bindingProfileScope({ ...base, deviceId: "other-device" }, { revision: 5 }, device),
    ).toThrow();
    expect(() =>
      bindingProfileScope({ ...base, origin: "https://other.example" }, { revision: 5 }, device),
    ).toThrow();
  });
  it("takes a locally replaced profile only with exact service-sync change evidence", () => {
    const switching = { ...base, localWrite: { revision: 5, profileId: "profile-b" } };
    expect(bindingProfileScope(switching, { revision: 4 }, device)).toContain("profile-a");
    expect(() => bindingProfileScope(switching, { revision: 5 }, device)).toThrow();
    expect(() =>
      bindingProfileScope(
        switching,
        { revision: 5, changes: [{ revision: 5, cause: "account-choice" }] },
        device,
      ),
    ).toThrow();
    expect(
      bindingProfileScope(
        switching,
        {
          revision: 6,
          changes: [
            { revision: 5, cause: "service-sync" },
            { revision: 6, cause: "account-choice" },
          ],
        },
        device,
      ),
    ).toContain("profile-b");
  });
});
