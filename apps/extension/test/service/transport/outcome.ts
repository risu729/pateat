import { expect, it, vi } from "vitest";
import type { TransportTestContext } from "../../../src/service/transport.test";
import type { ServiceTransport } from "../../../src/service/transport";

export function registerOutcomeCases({
  ORIGIN,
  CREDENTIAL,
  respond,
  report,
  send,
}: Pick<TransportTestContext, "ORIGIN" | "CREDENTIAL" | "respond"> & {
  report: Parameters<ServiceTransport["reportOutcome"]>[3];
  send: (fetch: typeof globalThis.fetch) => ReturnType<ServiceTransport["reportOutcome"]>;
}) {
  it("posts only the codes with the device credential and no cookies", async () => {
    const fetch = respond(204);
    expect(await send(fetch)).toEqual({ kind: "kept" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/v1/recipes/gen-0123/outcome`);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    expect(init!.headers).toEqual({
      Authorization: `Bearer ${CREDENTIAL}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init!.body as string)).toEqual(report);
  });

  it.each([
    [404, { error: "not_found" }, { kind: "refused" }],
    [400, { error: "bad_request" }, { kind: "refused" }],
    [401, { error: "device_revoked" }, { kind: "rejected" }],
    [429, { error: "rate_limited" }, { kind: "failed", error: "rate-limited" }],
    [500, { error: "internal_error" }, { kind: "failed", error: "unexpected-response" }],
    [200, { version: 1 }, { kind: "failed", error: "unexpected-response" }],
  ])("answers %i as its kind", async (status, body, expected) => {
    expect(await send(respond(status, body))).toEqual(expected);
  });

  it("reports an unreachable service", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await send(fetch)).toEqual({ kind: "failed", error: "unreachable" });
  });
}
