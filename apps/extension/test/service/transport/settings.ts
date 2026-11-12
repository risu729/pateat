import { expect, it } from "vitest";
import type { TransportTestContext } from "../../../src/service/transport.test";
import { createServiceTransport, type ServiceTransport } from "../../../src/service/transport";

type SettingsDocument = Parameters<ServiceTransport["saveSettings"]>[2]["settings"];

export function registerSettingsCases({
  ORIGIN,
  CREDENTIAL,
  respond,
  untimed,
  document,
  state,
}: TransportTestContext & {
  document: SettingsDocument;
  state: { version: number; profileId: string; revision: number; settings: SettingsDocument };
}) {
  it("reads and conditionally writes the settings document", async () => {
    const read = respond(200, state);
    expect(
      await untimed(createServiceTransport({ fetch: read }).settings(ORIGIN, CREDENTIAL)),
    ).toEqual({
      kind: "state",
      state,
    });
    expect(read.mock.calls[0]).toMatchObject([
      `${ORIGIN}/v1/settings`,
      { method: "GET", headers: { Authorization: `Bearer ${CREDENTIAL}` } },
    ]);

    const write = respond(200, { ...state, revision: 5 });
    const written = { version: 1, expectedRevision: 4, settings: document } as const;
    expect(
      await untimed(
        createServiceTransport({ fetch: write }).saveSettings(ORIGIN, CREDENTIAL, written),
      ),
    ).toEqual({ kind: "state", state: { ...state, revision: 5 } });
    const [url, init] = write.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/v1/settings`);
    expect(init).toMatchObject({
      method: "PUT",
      headers: { Authorization: `Bearer ${CREDENTIAL}`, "Content-Type": "application/json" },
      redirect: "error",
      credentials: "omit",
    });
    expect(JSON.parse(String(init?.body))).toEqual(written);
  });

  it("returns the service's state on a stale write", async () => {
    const fetch = respond(409, { error: "settings_conflict", current: state });
    expect(
      await untimed(
        createServiceTransport({ fetch }).saveSettings(ORIGIN, CREDENTIAL, {
          version: 1,
          expectedRevision: 3,
          settings: document,
        }),
      ),
    ).toEqual({ kind: "conflict", current: state });
  });

  it.each([
    ["a malformed document", 200, { ...state, revision: 0 }, "unexpected-response"],
    ["a conflict without its state", 409, { error: "settings_conflict" }, "unexpected-response"],
    ["a rate limit", 429, { error: "rate_limited" }, "rate-limited"],
  ])("rejects %s", async (_, status, body, error) => {
    expect(
      await untimed(
        createServiceTransport({ fetch: respond(status, body) }).settings(ORIGIN, CREDENTIAL),
      ),
    ).toEqual({ kind: "failed", error });
  });

  it("rejects an oversized write", async () => {
    expect(
      await untimed(
        createServiceTransport({
          fetch: respond(413, { error: "payload_too_large" }),
        }).saveSettings(ORIGIN, CREDENTIAL, {
          version: 1,
          expectedRevision: 3,
          settings: document,
        }),
      ),
    ).toEqual({ kind: "failed", error: "unexpected-response" });
  });

  it("distinguishes another profile's composed settings limit from a request body limit", async () => {
    const fetch = respond(413, { error: "settings_limit" });
    expect(
      await untimed(
        createServiceTransport({ fetch }).saveSettings(ORIGIN, CREDENTIAL, {
          version: 1,
          expectedRevision: 4,
          settings: document,
        }),
      ),
    ).toEqual({ kind: "limited" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reports a rejected device", async () => {
    expect(
      await untimed(
        createServiceTransport({ fetch: respond(401, { error: "device_revoked" }) }).settings(
          ORIGIN,
          CREDENTIAL,
        ),
      ),
    ).toEqual({ kind: "rejected" });
  });
}
