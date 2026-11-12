import { expect, it, vi } from "vitest";
import { createPasskeyRuntime } from "../../src/passkeys/runtime";
import type { RuntimeFixtures } from "./runtime-context";

export function registerReportCases({
  extensionId,
  origin,
  sender,
  candidate,
  request,
  get,
  source,
}: Pick<
  RuntimeFixtures,
  "extensionId" | "origin" | "sender" | "candidate" | "request" | "get" | "source"
>) {
  it("reports the delegate reason and value-free counts without credential data", async () => {
    const report = vi.fn();
    const stored = [
      { ...candidate, credentialId: "BAUG", preferred: true, discoverable: false },
      candidate,
      { ...candidate, credentialId: "BwgJ" },
    ];
    const runtime = createPasskeyRuntime(
      source({
        candidates: vi.fn(async () => ({
          candidates: stored,
          complete: true,
          siteDefault: "searched" as const,
        })),
      }),
      { extensionId, report },
    );
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "ambiguous-credential",
    });
    // The site default's passkey is not discoverable, so a request without an allow list
    // cannot use it and the two other passkeys stay ambiguous.
    expect(report).toHaveBeenCalledWith({
      tabId: 7,
      origin,
      outcome: "delegate",
      reason: "ambiguous-credential",
      rpId: "example.com",
      allowCredentials: 0,
      stored: 3,
      accepted: 2,
      siteDefault: 1,
      siteDefaultAccepted: 0,
      siteDefaultItem: "searched",
      complete: true,
    });
    expect(report).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(report.mock.calls);
    for (const secret of ["AQID", "BAUG", "BwgJ", "dXNlcg"])
      expect(serialized).not.toContain(secret);
  });

  it("reports admission delegations and assertions, and a failing report changes nothing", async () => {
    const report = vi.fn(() => {
      throw new Error("console unavailable");
    });
    const runtime = createPasskeyRuntime(source(), { extensionId, report });
    expect(
      await runtime.handle(
        { ...get(), request: { ...request, mediation: "conditional" } },
        sender(),
      ),
    ).toEqual({ kind: "delegate", reason: "unsupported-mediation" });
    // A delegation is reported after the reply.
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith({
        tabId: 7,
        origin,
        outcome: "delegate",
        reason: "unsupported-mediation",
        mediation: "conditional",
      }),
    );
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(report).toHaveBeenLastCalledWith({
      tabId: 7,
      origin,
      outcome: "assertion",
      rpId: "example.com",
      allowCredentials: 0,
      stored: 1,
      accepted: 1,
      siteDefault: 0,
      siteDefaultAccepted: 0,
      complete: true,
    });
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("reports which member of an invalid request broke its bounds, without its value", async () => {
    const report = vi.fn();
    const runtime = createPasskeyRuntime(source(), { extensionId, report });
    const oversized = btoa("x".repeat(4097)).replace(/=+$/u, "");
    expect(
      await runtime.handle({ ...get(), request: { ...request, challenge: oversized } }, sender()),
    ).toEqual({ kind: "delegate", reason: "invalid-request" });
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith({
        tabId: 7,
        origin,
        outcome: "delegate",
        reason: "invalid-request",
        invalid: "challenge",
        invalidLength: 4097,
      }),
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain(oversized.slice(0, 16));
    // Another delegation names no invalid member.
    await runtime.handle({ ...get(), request: { ...request, mediation: "silent" } }, sender());
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
    expect(report.mock.lastCall![0]).not.toHaveProperty("invalid");
    expect(report.mock.lastCall![0]).not.toHaveProperty("invalidLength");
  });

  it.each([
    ["conditional", "conditional"],
    ["silent", "silent"],
    ["immediate", "immediate"],
    ["made-up", "other"],
  ])("reports a %s request delegated while the tab's login runs", async (mediation, reported) => {
    // Another provider, such as the Bitwarden extension, may show its prompt then.
    const report = vi.fn();
    let login: { connectionId: string; itemId: string } | undefined = {
      connectionId: "synthetic-connection",
      itemId: "synthetic-item",
    };
    const runtime = createPasskeyRuntime(source(), {
      extensionId,
      report,
      loginAccount: async () => login,
    });
    const delegated = {
      ...get(),
      request: { ...request, mediation },
    };
    expect(await runtime.handle(delegated, sender())).toEqual({
      kind: "delegate",
      reason: "unsupported-mediation",
    });
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith({
        tabId: 7,
        origin,
        outcome: "delegate",
        reason: "unsupported-mediation",
        mediation: reported,
        duringLogin: true,
      }),
    );
    login = undefined;
    await runtime.handle(delegated, sender());
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
    expect(report.mock.lastCall![0]).not.toHaveProperty("duringLogin");
  });

  it("tells a login of each request outside conditional mediation, from a top frame only", async () => {
    const requested = vi.fn(() => {
      throw new Error("a failing listener changes nothing");
    });
    const runtime = createPasskeyRuntime(source(), { extensionId, requested });
    await runtime.handle({ ...get(), request: { ...request, mediation: "conditional" } }, sender());
    await runtime.handle(get(), sender({ frameId: 3 }));
    expect(requested).not.toHaveBeenCalled();
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    // A delegated request counts too: the page still asked.
    expect(
      await runtime.handle({ ...get(), request: { ...request, mediation: "silent" } }, sender()),
    ).toEqual({ kind: "delegate", reason: "unsupported-mediation" });
    expect(requested.mock.calls).toEqual([
      [7, origin],
      [7, origin],
    ]);
  });

  it("does not count person-started passkey sign-ins towards the relogin guard (ADR 0062 C)", async () => {
    const answered = vi.fn();
    const runtime = createPasskeyRuntime(source(), { extensionId, answered });
    // The person's click gives the request user activation; it is theirs, not Pateat's.
    expect(await runtime.handle(get(undefined, true), sender())).toMatchObject({
      kind: "assertion",
    });
    expect(answered.mock.lastCall?.[4]).toEqual({ incognito: false, documentId: "document-a" });
    // The page started this one on load, with no activation: Pateat signed by itself.
    expect(await runtime.handle(get(undefined, false), sender())).toMatchObject({
      kind: "assertion",
    });
    expect(answered.mock.lastCall?.[4]).toEqual({
      silent: true,
      incognito: false,
      documentId: "document-a",
    });
  });

  it("tells a login of each assertion it returns, with its RP ID and passkey", async () => {
    const answered = vi.fn(() => {
      throw new Error("a failing listener changes nothing");
    });
    const runtime = createPasskeyRuntime(source(), { extensionId, answered });
    // A delegated request returns nothing from Pateat.
    expect(
      await runtime.handle({ ...get(), request: { ...request, mediation: "silent" } }, sender()),
    ).toEqual({ kind: "delegate", reason: "unsupported-mediation" });
    expect(answered).not.toHaveBeenCalled();
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(answered.mock.calls).toEqual([
      [7, origin, "example.com", candidate, { incognito: false, documentId: "document-a" }],
    ]);
    // A person-started passkey sign-in is not counted towards the relogin guard; one the
    // page started with no user activation, as on load after a logout, is (ADR 0062 C).
    expect(await runtime.handle(get(undefined, false), sender())).toMatchObject({
      kind: "assertion",
    });
    expect(answered.mock.lastCall).toEqual([
      7,
      origin,
      "example.com",
      candidate,
      { silent: true, incognito: false, documentId: "document-a" },
    ]);
    // A private window's request is told apart, for its own relogin count.
    expect(
      await runtime.handle(get(undefined, false), sender({ tab: { id: 7, incognito: true } })),
    ).toMatchObject({ kind: "assertion" });
    expect(answered.mock.lastCall).toEqual([
      7,
      origin,
      "example.com",
      candidate,
      { silent: true, incognito: true, documentId: "document-a" },
    ]);
    // Each answer names the top document it went to: the assertion signed that page in, so
    // the login runtime starts no login of its own there.
    expect(await runtime.handle(get(), sender({ documentId: "document-c" }))).toMatchObject({
      kind: "assertion",
    });
    expect(answered.mock.lastCall).toEqual([
      7,
      origin,
      "example.com",
      candidate,
      { incognito: false, documentId: "document-c" },
    ]);
  });

  it("reports no request from an invalid sender or a cancellation", async () => {
    const report = vi.fn();
    const runtime = createPasskeyRuntime(source(), { extensionId, report });
    await runtime.handle(get(), sender({ frameId: 3 }));
    await runtime.handle(
      { version: 1, type: "passkey.cancel", operationId: crypto.randomUUID() },
      sender(),
    );
    // Delegation reports are sent after the answer, so let them run first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(report).not.toHaveBeenCalled();
  });
}
