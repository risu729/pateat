import { describe, expect, it } from "vitest";
import { getFoundationStatus, isStatusRequest, parseRuntimeStatus } from "./index";

describe("read-only foundation status boundary", () => {
  it("accepts only the versioned status request", () => {
    expect(isStatusRequest({ version: 1, type: "runtime.status.get" })).toBe(true);
    for (const message of [
      null,
      { version: 2, type: "runtime.status.get" },
      { version: 1, type: "vault.read" },
      { version: 1, type: "runtime.status.get", grant: "vault.read" },
    ]) {
      expect(isStatusRequest(message)).toBe(false);
    }
  });

  it("rejects readiness claims and extra data unsupported by this build", () => {
    expect(parseRuntimeStatus(getFoundationStatus())).toEqual(getFoundationStatus());
    expect(() =>
      parseRuntimeStatus({
        ...getFoundationStatus(),
        vault: "connected",
      }),
    ).toThrow();
    expect(() =>
      parseRuntimeStatus({
        ...getFoundationStatus(),
        secret: "synthetic-forbidden-field",
      }),
    ).toThrow();
  });
});
