import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";
import {
  createManualClient,
  manualOfferRequestSchema,
  manualOfferResponseSchema,
  manualStartRequestSchema,
  manualStartResponseSchema,
} from "./manual-wire";

const document = { origin: "https://login.example", tabId: 7, frameId: 3, documentId: "frame" };
const request = {
  requestId: "manual-request",
  document,
  scope: "a".repeat(64),
  connectionId: "connection",
  itemId: "item",
};
const start = { version: 1, type: "login.manual.start", ...request };

describe("the popup's one-time login contract", () => {
  it("requires an exact document and account without persistent choice controls", () => {
    expect(v.parse(manualStartRequestSchema, start)).toEqual(start);
    for (const extra of [{ makeDefault: true }, { paused: false }, { attemptId: "attempt" }])
      expect(v.safeParse(manualStartRequestSchema, { ...start, ...extra }).success).toBe(false);
    for (const property of ["requestId", "document", "scope", "connectionId", "itemId"])
      expect(
        v.safeParse(
          manualStartRequestSchema,
          Object.fromEntries(Object.entries(start).filter(([key]) => key !== property)),
        ).success,
      ).toBe(false);
    expect(
      v.safeParse(manualOfferRequestSchema, { version: 1, type: "login.manual.get", tabId: -1 })
        .success,
    ).toBe(false);
  });

  it("bounds offered accounts, references and status data", () => {
    const target = {
      document,
      scope: request.scope,
      candidates: [{ connectionId: "connection", itemId: "item" }],
    };
    expect(v.safeParse(manualOfferResponseSchema, { ok: true, targets: [target] }).success).toBe(
      true,
    );
    expect(
      v.safeParse(manualOfferResponseSchema, { ok: true, targets: Array(101).fill(target) })
        .success,
    ).toBe(false);
    expect(
      v.safeParse(manualOfferResponseSchema, {
        ok: true,
        targets: [{ ...target, candidates: Array(101).fill(target.candidates[0]) }],
      }).success,
    ).toBe(false);
    expect(v.safeParse(manualStartRequestSchema, { ...start, itemId: "" }).success).toBe(false);
    expect(
      v.safeParse(manualStartResponseSchema, { ok: false, reason: "x".repeat(101) }).success,
    ).toBe(false);
    expect(v.safeParse(manualStartResponseSchema, { ok: true, state: "blocked" }).success).toBe(
      false,
    );
  });

  it("sends only the popup request and validates both replies", async () => {
    const send = vi
      .fn<(message: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({ ok: true, targets: [] })
      .mockResolvedValueOnce({ ok: true, state: "evaluating" });
    const client = createManualClient(send);
    expect(await client.get(7)).toEqual({ ok: true, targets: [] });
    expect(await client.start(request)).toEqual({ ok: true, state: "evaluating" });
    expect(send.mock.calls).toEqual([
      [{ version: 1, type: "login.manual.get", tabId: 7 }],
      [start],
    ]);
    send.mockResolvedValue({ ok: true, state: "authenticated" });
    await expect(client.start(request)).rejects.toThrow();
    send.mockResolvedValue({ ok: true, targets: [], password: "unexpected" });
    await expect(client.get(7)).rejects.toThrow();
  });
});
