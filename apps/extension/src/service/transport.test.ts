import { describe, expect, it, vi } from "vitest";
import { createServiceTransport } from "./transport";

// Synthetic responses only; no request leaves the test.

const ORIGIN = "https://pateat.example.com";
const VERIFIER = "V".repeat(43);
const CREDENTIAL = `pateat_device_${"C".repeat(43)}`;

function respond(status: number, body?: unknown, init: ResponseInit = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const response = new Response(
      body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body),
      { status, ...init },
    );
    Object.defineProperty(response, "url", { value: String(input) });
    return response;
  });
}

describe("redeem", () => {
  it("posts only the verifier with hardened fetch options", async () => {
    const fetch = respond(404, { error: "enrollment_not_found" });
    expect(await createServiceTransport({ fetch }).redeem(ORIGIN, VERIFIER)).toEqual({
      kind: "pending",
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/redeem`);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(init!.body as string)).toEqual({ version: 1, verifier: VERIFIER });
  });

  it("accepts a valid credential", async () => {
    const result = {
      version: 1,
      deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
      credential: CREDENTIAL,
    };
    expect(
      await createServiceTransport({ fetch: respond(200, result) }).redeem(ORIGIN, VERIFIER),
    ).toEqual({ kind: "issued", result });
  });

  it.each([
    [
      "a malformed credential",
      200,
      { version: 1, deviceId: "x", credential: "y" },
      "unexpected-response",
    ],
    [
      "an extra field",
      200,
      {
        version: 1,
        deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
        credential: CREDENTIAL,
        owner: "x",
      },
      "unexpected-response",
    ],
    ["a non-JSON body", 200, "<html>", "unexpected-response"],
    ["an unknown 404", 404, { error: "not_found" }, "unexpected-response"],
    ["a rate limit", 429, { error: "rate_limited" }, "rate-limited"],
    ["a server error", 500, { error: "internal_error" }, "unexpected-response"],
  ])("rejects %s", async (_, status, body, error) => {
    expect(
      await createServiceTransport({ fetch: respond(status, body) }).redeem(ORIGIN, VERIFIER),
    ).toEqual({ kind: "failed", error });
  });

  it("recognizes a code mismatch", async () => {
    const fetch = respond(409, { error: "enrollment_code_mismatch" });
    expect(await createServiceTransport({ fetch }).redeem(ORIGIN, VERIFIER)).toEqual({
      kind: "code-mismatch",
    });
  });

  it("refuses redirected and oversized responses", async () => {
    const redirected = vi.fn<typeof fetch>(async () => {
      const response = new Response("{}", { status: 200 });
      Object.defineProperty(response, "url", { value: "https://elsewhere.example.com/redeem" });
      return response;
    });
    expect(await createServiceTransport({ fetch: redirected }).redeem(ORIGIN, VERIFIER)).toEqual({
      kind: "failed",
      error: "unexpected-response",
    });
    const huge = respond(200, `"${"x".repeat(20_000)}"`);
    expect(await createServiceTransport({ fetch: huge }).redeem(ORIGIN, VERIFIER)).toEqual({
      kind: "failed",
      error: "unexpected-response",
    });
  });

  it("reports network failures and timeouts as unreachable", async () => {
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await createServiceTransport({ fetch: offline }).redeem(ORIGIN, VERIFIER)).toEqual({
      kind: "failed",
      error: "unreachable",
    });
    const hanging = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
        }),
    );
    expect(
      await createServiceTransport({ fetch: hanging, timeoutMs: 10 }).redeem(ORIGIN, VERIFIER),
    ).toEqual({ kind: "failed", error: "unreachable" });
  });
});

describe("revoke", () => {
  it("sends the credential only to the device route", async () => {
    const fetch = respond(204);
    expect(await createServiceTransport({ fetch }).revoke(ORIGIN, CREDENTIAL)).toEqual({
      kind: "revoked",
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/v1/device`);
    expect(init).toMatchObject({
      method: "DELETE",
      headers: { Authorization: `Bearer ${CREDENTIAL}` },
      redirect: "error",
      credentials: "omit",
    });
  });

  it.each(["device_revoked", "unauthorized"])(
    "treats an already rejected credential as revoked: %s",
    async (error) => {
      const fetch = respond(401, { error });
      expect(await createServiceTransport({ fetch }).revoke(ORIGIN, CREDENTIAL)).toEqual({
        kind: "revoked",
      });
    },
  );

  it.each([{ error: "access_denied" }, "<html>"])(
    "does not count an unknown 401 as revoked: %j",
    async (body) => {
      expect(
        await createServiceTransport({ fetch: respond(401, body) }).revoke(ORIGIN, CREDENTIAL),
      ).toEqual({ kind: "failed", error: "unexpected-response" });
    },
  );

  it("reports other answers as unconfirmed", async () => {
    expect(
      await createServiceTransport({ fetch: respond(500, { error: "internal_error" }) }).revoke(
        ORIGIN,
        CREDENTIAL,
      ),
    ).toEqual({ kind: "failed", error: "unexpected-response" });
  });
});
