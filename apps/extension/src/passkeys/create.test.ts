import { describe, expect, it, vi } from "vitest";
import {
  CREATE_AFTER_SIGN_IN_MS,
  createPasskeyCreateHandler,
  type PasskeyCreateReport,
} from "./create";
import type { PasskeySource } from "./runtime";
import type { PasskeyCandidate } from "./select";
import { createSignIns, type SignInRecord, type SignIns } from "./sign-ins";
import type { SignedTabsStorage } from "./signed-tabs";

const extensionId = "synthetic-extension";
const origin = "https://login.example.com";
const NOW = Date.UTC(2026, 9, 12, 9, 0);
const sender = (overrides: Record<string, unknown> = {}) => ({
  id: extensionId,
  tab: { id: 7 },
  frameId: 0,
  documentId: "document-a",
  documentLifecycle: "active",
  origin,
  url: `${origin}/account/security`,
  ...overrides,
});
/** A vault passkey Pateat signs with: AQID is base64url for the bytes 1, 2, 3. */
const candidate: PasskeyCandidate = {
  credentialId: "AQID",
  rpId: "example.com",
  userHandle: "dXNlcg",
  discoverable: true,
  counter: 0,
};
const listedPasskey = { type: "public-key", id: "AQID", transports: ["internal"] };
const create = (request: unknown, operationId: string = crypto.randomUUID()) => ({
  version: 1,
  type: "passkey.create",
  operationId,
  request,
});
const request = (overrides: Record<string, unknown> = {}) => ({
  rpId: "example.com",
  excludeCredentials: [listedPasskey],
  ...overrides,
});

function source(candidates: readonly PasskeyCandidate[] = [candidate]): PasskeySource {
  return {
    candidates: vi.fn(async () => ({ candidates, complete: true })),
    sign: vi.fn(async () => {
      throw new Error("a create check never signs");
    }),
  };
}
/** Sign-ins of tab 7 only, as `list` reads them. */
function signedIn(...records: Array<Partial<SignInRecord>>): Pick<SignIns, "list"> {
  return {
    list: vi.fn(async (tabId: number) =>
      tabId === 7 ? records.map((record) => ({ origin, at: NOW - 60_000, ...record })) : [],
    ),
  };
}
function handler(
  backing: PasskeySource = source(),
  signIns: Pick<SignIns, "list"> = signedIn({}),
  extra: Partial<Parameters<typeof createPasskeyCreateHandler>[1]> = {},
) {
  const report = vi.fn<(report: PasskeyCreateReport) => void>();
  const leave = vi.fn();
  const hold = vi.fn(async () => leave);
  const created = createPasskeyCreateHandler(backing, {
    extensionId,
    signIns,
    report,
    hold,
    now: () => NOW,
    ...extra,
  });
  return { ...created, report, hold, leave, backing };
}
const delegate = (reason: string) => ({ kind: "delegate", reason });

describe("passkey create check (ADR 0007)", () => {
  it("declines a registration listing a vault passkey right after Pateat signed the tab in", async () => {
    const check = handler();
    expect(await check.handle(create(request()), sender())).toEqual({ kind: "decline" });
    expect(check.backing.candidates).toHaveBeenCalledOnce();
    expect(check.backing.candidates).toHaveBeenCalledWith(
      origin,
      "example.com",
      expect.any(AbortSignal),
    );
    expect(check.backing.sign).not.toHaveBeenCalled();
    // The vault is held only while it is read.
    expect(check.hold).toHaveBeenCalledOnce();
    expect(check.leave).toHaveBeenCalledOnce();
    expect(check.report).toHaveBeenCalledOnce();
    expect(check.report.mock.calls[0]![0]).toEqual({
      tabId: 7,
      origin,
      outcome: "declined",
      rpId: "example.com",
      excludeCredentials: 1,
      listed: true,
      sinceSignIn: 60,
    });
  });

  it("uses the origin's host as the RP ID when the request names none", async () => {
    const check = handler(source([{ ...candidate, rpId: "login.example.com" }]));
    expect(await check.handle(create(request({ rpId: undefined })), sender())).toEqual({
      kind: "decline",
    });
    expect(check.backing.candidates).toHaveBeenCalledWith(
      origin,
      "login.example.com",
      expect.any(AbortSignal),
    );
  });

  it("declines when any one of several listed passkeys is the vault's", async () => {
    const check = handler(source([{ ...candidate, credentialId: "BAUG", counter: 3 }, candidate]));
    const excludeCredentials = [
      { type: "public-key", id: "CQoL" },
      { type: "public-key", id: "BAUG" },
      listedPasskey,
    ];
    expect(await check.handle(create(request({ excludeCredentials })), sender())).toEqual({
      kind: "decline",
    });
    expect(check.report.mock.calls[0]![0]).toMatchObject({ excludeCredentials: 3, listed: true });
  });

  describe("which sign-ins count", () => {
    it("counts a login of an origin the RP ID covers", async () => {
      const check = handler(source(), signedIn({ origin: "https://www.example.com" }));
      expect(await check.handle(create(request()), sender())).toEqual({ kind: "decline" });
    });

    it("counts a passkey sign-in recorded with the same RP ID", async () => {
      const check = handler(
        source(),
        signedIn({ origin: "https://accounts.example.net", rpId: "example.com" }),
      );
      expect(await check.handle(create(request()), sender())).toEqual({ kind: "decline" });
    });

    it.each<[string, Partial<SignInRecord>, string | undefined]>([
      ["another site", { origin: "https://example.net" }, "example.com"],
      // A parent domain's login does not cover a registration for a subdomain's RP ID.
      ["the parent domain", { origin: "https://example.com" }, "login.example.com"],
      ["a sibling host", { origin: "https://www.example.com" }, "login.example.com"],
      [
        "a passkey for another RP ID",
        { origin: "https://www.example.com", rpId: "example.com" },
        "login.example.com",
      ],
    ])("ignores a sign-in to %s", async (_name, record, rpId) => {
      const check = handler(
        source([{ ...candidate, rpId: rpId ?? "example.com" }]),
        signedIn(record),
      );
      expect(await check.handle(create(request({ rpId })), sender())).toEqual(
        delegate("not-signed-in"),
      );
      expect(check.backing.candidates).not.toHaveBeenCalled();
      expect(check.hold).not.toHaveBeenCalled();
      expect(check.report.mock.calls[0]![0]).toEqual({
        tabId: 7,
        origin,
        outcome: "delegate",
        reason: "not-signed-in",
        rpId,
        excludeCredentials: 1,
      });
    });

    it("never lets a sign-in in one tab decline a registration in another", async () => {
      const storage = memoryStorage();
      const signIns = createSignIns(
        storage,
        () => {},
        () => NOW - 1_000,
      );
      await signIns.add(7, { origin });
      const check = handler(source(), signIns);
      expect(await check.handle(create(request()), sender({ tab: { id: 8 } }))).toEqual(
        delegate("not-signed-in"),
      );
      expect(await check.handle(create(request()), sender())).toEqual({ kind: "decline" });
      expect(check.report.mock.calls.map(([entry]) => [entry.tabId, entry.outcome])).toEqual([
        [8, "delegate"],
        [7, "declined"],
      ]);
    });
  });

  describe("the five minutes after a sign-in", () => {
    it.each<[string, number, unknown, number]>([
      ["just after the sign-in", 0, { kind: "decline" }, 0],
      ["at exactly five minutes", CREATE_AFTER_SIGN_IN_MS, { kind: "decline" }, 300],
      ["a millisecond later", CREATE_AFTER_SIGN_IN_MS + 1, delegate("expired"), 300],
      ["an hour later", 3_600_000, delegate("expired"), 3600],
    ])("%s", async (_name, elapsed, expected, seconds) => {
      const check = handler(source(), signedIn({ at: NOW - elapsed }));
      expect(await check.handle(create(request()), sender())).toEqual(expected);
      expect(check.report.mock.calls[0]![0]).toMatchObject({ sinceSignIn: seconds });
      if ((expected as { kind: string }).kind === "delegate") {
        // An expired sign-in reads nothing from the vault.
        expect(check.backing.candidates).not.toHaveBeenCalled();
        expect(check.hold).not.toHaveBeenCalled();
        expect(check.report.mock.calls[0]![0]).not.toHaveProperty("listed");
      }
    });

    it("measures from the latest matching sign-in", async () => {
      const check = handler(
        source(),
        signedIn(
          { at: NOW - CREATE_AFTER_SIGN_IN_MS - 60_000 },
          { origin: "https://www.example.com", at: NOW - 10_000 },
          // A later sign-in elsewhere does not count.
          { origin: "https://example.net", at: NOW },
        ),
      );
      expect(await check.handle(create(request()), sender())).toEqual({ kind: "decline" });
      expect(check.report.mock.calls[0]![0]).toMatchObject({ sinceSignIn: 10 });
    });

    it("reports no negative time for a sign-in the clock puts later", async () => {
      const check = handler(source(), signedIn({ at: NOW + 5_000 }));
      expect(await check.handle(create(request()), sender())).toEqual({ kind: "decline" });
      expect(check.report.mock.calls[0]![0]).toMatchObject({ sinceSignIn: 0 });
    });
  });

  describe("which listed passkeys count", () => {
    it("hands on a registration listing only other passkeys", async () => {
      const check = handler();
      const excludeCredentials = [{ type: "public-key", id: "BAUG" }];
      expect(await check.handle(create(request({ excludeCredentials })), sender())).toEqual(
        delegate("not-listed"),
      );
      expect(check.report.mock.calls[0]![0]).toMatchObject({ listed: false });
      expect(check.leave).toHaveBeenCalledOnce();
    });

    it("skips descriptors of another credential type without a lookup", async () => {
      const check = handler();
      const excludeCredentials = [{ type: "future-type", id: "AQID" }];
      expect(await check.handle(create(request({ excludeCredentials })), sender())).toEqual(
        delegate("not-listed"),
      );
      expect(check.backing.candidates).not.toHaveBeenCalled();
      expect(check.report.mock.calls[0]![0]).toMatchObject({
        excludeCredentials: 1,
        listed: false,
      });
    });

    it("reads only the public-key descriptors of a mixed list", async () => {
      const check = handler();
      const excludeCredentials = [
        { type: "future-type", id: "AQID" },
        { type: "public-key", id: "BAUG" },
      ];
      expect(await check.handle(create(request({ excludeCredentials })), sender())).toEqual(
        delegate("not-listed"),
      );
      expect(check.backing.candidates).toHaveBeenCalledOnce();
      expect(check.report.mock.calls[0]![0]).toMatchObject({
        excludeCredentials: 2,
        listed: false,
      });
    });

    it.each<[string, PasskeyCandidate]>([
      ["a passkey with a nonzero counter", { ...candidate, counter: 1 }],
      ["a passkey of another RP ID", { ...candidate, rpId: "login.example.com" }],
    ])("does not count %s", async (_name, stored) => {
      const check = handler(source([stored]));
      expect(await check.handle(create(request()), sender())).toEqual(delegate("not-listed"));
      expect(check.report.mock.calls[0]![0]).toMatchObject({ listed: false });
    });

    it("names a vault it could not search fully, but still declines for a passkey it found", async () => {
      const incomplete = (candidates: readonly PasskeyCandidate[]) => {
        const backing = source(candidates);
        vi.mocked(backing.candidates).mockResolvedValue({ candidates, complete: false });
        return backing;
      };
      const missing = handler(incomplete([{ ...candidate, credentialId: "BAUG" }]));
      expect(await missing.handle(create(request()), sender())).toEqual(
        delegate("vault-incomplete"),
      );
      expect(missing.report.mock.calls[0]![0]).toMatchObject({
        reason: "vault-incomplete",
        listed: false,
      });
      const found = handler(incomplete([candidate]));
      expect(await found.handle(create(request()), sender())).toEqual({ kind: "decline" });
    });
  });

  describe("failures hand the registration on", () => {
    it("delegates without configuration", async () => {
      const backing = source();
      vi.mocked(backing.candidates).mockResolvedValue(undefined);
      const check = handler(backing);
      expect(await check.handle(create(request()), sender())).toEqual(delegate("not-configured"));
      expect(check.leave).toHaveBeenCalledOnce();
      expect(check.report.mock.calls[0]![0]).not.toHaveProperty("listed");
    });

    it("delegates once the lookup outlasts its budget, aborting it", async () => {
      let signal!: AbortSignal;
      const backing = source();
      vi.mocked(backing.candidates).mockImplementation((_origin, _rpId, given) => {
        signal = given;
        return new Promise(() => {});
      });
      const check = handler(backing, signedIn({}), { timeoutMs: () => 20 });
      expect(await check.handle(create(request()), sender())).toEqual(delegate("timeout"));
      expect(signal.aborted).toBe(true);
      expect(check.leave).toHaveBeenCalledOnce();
      expect(check.report.mock.calls[0]![0]).toMatchObject({
        outcome: "delegate",
        reason: "timeout",
      });
    });

    it("delegates when the vault hold outlasts the budget, and leaves a late hold", async () => {
      let enter!: (leave: () => void) => void;
      const leave = vi.fn();
      const backing = source();
      const check = handler(backing, signedIn({}), {
        timeoutMs: () => 20,
        hold: () => new Promise((resolve) => (enter = resolve)),
      });
      expect(await check.handle(create(request()), sender())).toEqual(delegate("timeout"));
      expect(backing.candidates).not.toHaveBeenCalled();
      enter(leave);
      await vi.waitFor(() => expect(leave).toHaveBeenCalledOnce());
    });

    it("delegates as vault-unavailable when the lookup fails", async () => {
      const backing = source();
      vi.mocked(backing.candidates).mockRejectedValue(new Error("vault"));
      const check = handler(backing);
      expect(await check.handle(create(request()), sender())).toEqual(
        delegate("vault-unavailable"),
      );
      expect(check.leave).toHaveBeenCalledOnce();
    });

    it("delegates as vault-unavailable when the vault hold fails, leaving no rejection", async () => {
      const backing = source();
      const failed = Promise.reject(new Error("locked"));
      // Settled before the check reads it, so Vitest sees any rejection left unhandled after.
      failed.catch(() => {});
      const check = handler(backing, signedIn({}), { hold: () => failed });
      expect(await check.handle(create(request()), sender())).toEqual(
        delegate("vault-unavailable"),
      );
      expect(backing.candidates).not.toHaveBeenCalled();
    });

    it("delegates when the sign-in records cannot be read", async () => {
      const check = handler(source(), {
        list: async () => {
          throw new Error("storage");
        },
      });
      expect(await check.handle(create(request()), sender())).toEqual({
        kind: "delegate",
        reason: "vault-unavailable",
      });
      expect(check.backing.candidates).not.toHaveBeenCalled();
    });

    it("hands on any request beyond sixteen checks at once, unchecked", async () => {
      const lookups: Array<() => void> = [];
      const backing = source();
      vi.mocked(backing.candidates).mockImplementation(
        () =>
          new Promise((resolve) =>
            lookups.push(() => resolve({ candidates: [candidate], complete: true })),
          ),
      );
      const check = handler(backing);
      const pending = Array.from({ length: 16 }, () => check.handle(create(request()), sender()));
      await vi.waitFor(() => expect(lookups).toHaveLength(16));
      expect(await check.handle(create(request()), sender())).toEqual(delegate("busy"));
      expect(check.report).toHaveBeenLastCalledWith({
        tabId: 7,
        origin,
        outcome: "delegate",
        reason: "busy",
      });
      for (const release of lookups) release();
      expect(await Promise.all(pending)).toEqual(
        Array.from({ length: 16 }, () => ({ kind: "decline" })),
      );
      // The budget is free again.
      vi.mocked(backing.candidates).mockResolvedValue({ candidates: [candidate], complete: true });
      expect(await check.handle(create(request()), sender())).toEqual({ kind: "decline" });
    });
  });

  describe("requests it does not check", () => {
    it.each([
      ["another extension", { id: "other" }],
      ["a subframe", { frameId: 3 }],
      ["no tab", { tab: undefined }],
      ["no document", { documentId: undefined }],
      ["mismatched URL", { url: "https://evil.example.net/" }],
      ["missing origin", { origin: undefined }],
    ])("delegates from %s without reading anything or reporting", async (_name, overrides) => {
      const signIns = signedIn({});
      const check = handler(source(), signIns);
      expect(await check.handle(create(request()), sender(overrides))).toEqual(
        delegate("invalid-sender"),
      );
      expect(signIns.list).not.toHaveBeenCalled();
      expect(check.backing.candidates).not.toHaveBeenCalled();
      expect(check.report).not.toHaveBeenCalled();
    });

    it.each([
      ["another version", { ...create(request()), version: 2 }],
      ["a malformed operation ID", create(request(), "operation-1")],
      ["an extra member", { ...create(request()), userActivation: true }],
      ["another type", { ...create(request()), type: "passkey.get" }],
    ])("delegates a message with %s as invalid-sender", async (_name, message) => {
      const check = handler();
      expect(await check.handle(message, sender())).toEqual(delegate("invalid-sender"));
      expect(check.report).not.toHaveBeenCalled();
    });

    it.each<[string, unknown]>([
      ["no excludeCredentials", { rpId: "example.com" }],
      ["an empty excludeCredentials", request({ excludeCredentials: [] })],
      [
        "more than 64 excluded credentials",
        request({ excludeCredentials: Array.from({ length: 65 }, () => listedPasskey) }),
      ],
      [
        "an ID that is not base64url",
        request({ excludeCredentials: [{ type: "public-key", id: "AQ==" }] }),
      ],
      ["an empty ID", request({ excludeCredentials: [{ type: "public-key", id: "" }] })],
      ["an unknown member", request({ user: { name: "owner@example.com" } })],
      ["an overlong RP ID", request({ rpId: `${"a".repeat(250)}.com` })],
      ["a non-object", "AQID"],
    ])("delegates a request with %s as invalid-request", async (_name, invalid) => {
      const signIns = signedIn({});
      const check = handler(source(), signIns);
      expect(await check.handle(create(invalid), sender())).toEqual(delegate("invalid-request"));
      expect(signIns.list).not.toHaveBeenCalled();
      expect(check.report.mock.calls[0]![0]).toEqual({
        tabId: 7,
        origin,
        outcome: "delegate",
        reason: "invalid-request",
      });
    });

    it.each<[string, Record<string, unknown>, Record<string, unknown>, string]>([
      [
        "an insecure origin",
        {},
        { origin: "http://login.example.com", url: "http://login.example.com/account" },
        "invalid-origin",
      ],
      ["a non-canonical RP ID", { rpId: "Example.COM" }, {}, "invalid-rp-id"],
      ["an IP address RP ID", { rpId: "192.0.2.1" }, {}, "invalid-rp-id"],
      ["another site's RP ID", { rpId: "example.net" }, {}, "rp-id-mismatch"],
      ["a public suffix RP ID", { rpId: "com" }, {}, "rp-id-mismatch"],
    ])("delegates %s with the browser's reason", async (_name, members, from, reason) => {
      const signIns = signedIn({});
      const check = handler(source(), signIns);
      expect(await check.handle(create(request(members)), sender(from))).toEqual(delegate(reason));
      expect(signIns.list).not.toHaveBeenCalled();
      const report = check.report.mock.calls[0]![0];
      expect(report).toMatchObject({ outcome: "delegate", reason, excludeCredentials: 1 });
      expect(report).not.toHaveProperty("rpId");
    });
  });

  describe("reports", () => {
    it.each<[string | undefined, PasskeyCreateReport["mediation"]]>([
      ["conditional", "conditional"],
      ["optional", "other"],
      ["Owner's own text", "other"],
      [undefined, undefined],
    ])("names mediation %s only as conditional or other", async (mediation, expected) => {
      const check = handler();
      await check.handle(create(request(mediation === undefined ? {} : { mediation })), sender());
      const report = check.report.mock.calls[0]![0];
      if (expected === undefined) expect(report).not.toHaveProperty("mediation");
      else expect(report.mediation).toBe(expected);
    });

    it("never carries a credential ID, user handle or the page's own text", async () => {
      const check = handler(
        source([{ ...candidate, display: { item: "Synthetic item", userName: "owner" } }]),
      );
      const outcomes = [
        request({ mediation: "Owner's own text" }),
        request({ excludeCredentials: [{ type: "public-key", id: "BAUG" }] }),
        request({ excludeCredentials: [{ type: "Owner's type", id: "CQoL" }] }),
      ];
      for (const entry of outcomes)
        // oxlint-disable-next-line no-await-in-loop -- reports are compared in order
        await check.handle(create(entry), sender());
      const reports = check.report.mock.calls.map(([entry]) => entry);
      expect(reports.map((entry) => entry.outcome)).toEqual(["declined", "delegate", "delegate"]);
      const allowed = new Set([
        "tabId",
        "origin",
        "outcome",
        "reason",
        "rpId",
        "mediation",
        "excludeCredentials",
        "listed",
        "sinceSignIn",
      ]);
      for (const entry of reports)
        for (const key of Object.keys(entry)) expect(allowed.has(key)).toBe(true);
      const serialized = JSON.stringify(reports);
      for (const value of ["AQID", "BAUG", "CQoL", "dXNlcg", "Owner", "Synthetic item", "internal"])
        expect(serialized).not.toContain(value);
    });

    it("answers the same when the report throws", async () => {
      const check = handler(source(), signedIn({}), {
        report: () => {
          throw new Error("log unavailable");
        },
      });
      expect(await check.handle(create(request()), sender())).toEqual({ kind: "decline" });
      expect(await check.handle(create(request({ rpId: "example.net" })), sender())).toEqual(
        delegate("rp-id-mismatch"),
      );
    });

    it("works without a report, hold or clock", async () => {
      const created = createPasskeyCreateHandler(source(), {
        extensionId,
        signIns: { list: async () => [{ origin, at: Date.now() - 1_000 }] },
      });
      expect(await created.handle(create(request()), sender())).toEqual({ kind: "decline" });
    });
  });
});

function memoryStorage(): SignedTabsStorage {
  const items: Record<string, unknown> = {};
  return {
    get: async (key) => (key in items ? { [key]: structuredClone(items[key]) } : {}),
    async set(values) {
      Object.assign(items, structuredClone(values));
    },
  };
}
