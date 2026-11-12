import { expect, it } from "vitest";
import type { HostSessionRef } from "../../../src/crypto/wire";
import { accountUserId } from "../../../../../packages/bitwarden/src/__fixtures__/account";
import type { CryptoHostTestContext } from "./context";

export function registerUriAndSessionLanesCases({
  harness,
  auth,
  openInput,
  within,
  snapshotId,
  itemId,
  connectionId,
  uriCandidates,
}: Pick<
  CryptoHostTestContext,
  | "harness"
  | "auth"
  | "openInput"
  | "within"
  | "snapshotId"
  | "itemId"
  | "connectionId"
  | "uriCandidates"
>) {
  it("returns snapshot-bound URI candidates without URI strings", async () => {
    const h = harness();
    const session = await h.open();
    const matched = h.host.matchUris(session, "https://example.com/login");
    const request = await h.command(1);
    expect(request.operation).toEqual({
      kind: "match-uris",
      session,
      targetUrl: "https://example.com/login",
    });
    h.reply(request, { ok: true, data: uriCandidates });
    expect(await matched).toEqual({ ok: true, data: uriCandidates });
  });

  it.each([
    { ...uriCandidates, snapshotId: crypto.randomUUID() },
    { ...uriCandidates, targetOrigin: "https://example.net" },
    { ...uriCandidates, candidates: [{ itemId, matches: [], uri: "https://example.com" }] },
  ])("locks the session on a URI reply for another snapshot or shape case %#", async (data) => {
    const h = harness();
    const session = await h.open();
    const pending = h.host.matchUris(session, "https://example.com/login");
    h.reply(await h.command(1), { ok: true, data });
    expect(await pending).toEqual({ ok: false, error: { code: "crypto-locked" } });
    expect(await h.host.catalog(session)).toEqual({ ok: false, error: { code: "crypto-locked" } });
  });

  it("delivers one job per session at a time instead of refusing a concurrent one", async () => {
    // A passkey signed while a login matches the page's URI uses the same session's Worker.
    const h = harness();
    const a = await h.open();
    const b = await h.open("synthetic-other-connection");
    const url = "https://example.com/login";
    const first = h.host.matchUris(a, url);
    const second = h.host.matchUris(a, url);
    const other = h.host.matchUris(b, url);
    const firstCommand = await h.command(2);
    // Another session's job is not held back by this one.
    const otherCommand = await h.command(3);
    expect(firstCommand.operation).toMatchObject({ kind: "match-uris", session: a });
    expect(otherCommand.operation).toMatchObject({ kind: "match-uris", session: b });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.commands).toHaveLength(4);
    const otherCandidates = { ...uriCandidates, connectionId: "synthetic-other-connection" };
    h.reply(otherCommand, { ok: true, data: otherCandidates });
    expect(await other).toEqual({ ok: true, data: otherCandidates });
    h.reply(firstCommand, { ok: true, data: uriCandidates });
    expect(await first).toEqual({ ok: true, data: uriCandidates });
    const secondCommand = await h.command(4);
    expect(secondCommand.operation).toMatchObject({ kind: "match-uris", session: a });
    h.reply(secondCommand, { ok: true, data: uriCandidates });
    expect(await second).toEqual({ ok: true, data: uriCandidates });
    expect(h.host.status()).toMatchObject({ pending: 0 });
  });

  it("lets a session's next job go once a waiting earlier job is cancelled", async () => {
    const h = harness();
    const a = await h.open();
    const url = "https://example.com/login";
    const first = h.host.matchUris(a, url);
    const controller = new AbortController();
    const waiting = h.host.matchUris(a, url, controller.signal);
    const third = h.host.matchUris(a, url);
    const firstCommand = await h.command(1);
    controller.abort();
    expect(await waiting).toEqual({ ok: false, error: { code: "cancelled" } });
    // The cancelled job never reaches the Worker, and the third still waits for the first.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.commands).toHaveLength(2);
    h.reply(firstCommand, { ok: true, data: uriCandidates });
    expect(await first).toEqual({ ok: true, data: uriCandidates });
    const thirdCommand = await h.command(2);
    h.reply(thirdCommand, { ok: true, data: uriCandidates });
    expect(await third).toEqual({ ok: true, data: uriCandidates });
    expect(h.commands).toHaveLength(3);
    expect(
      h.posted.filter((message) => (message as { type: string }).type === "crypto.cancel"),
    ).toHaveLength(0);
  });

  it("gives a job that waited for its turn a full budget once it is delivered", async () => {
    const h = harness({ timeoutMs: 300 });
    const a = await h.open();
    const url = "https://example.com/login";
    const first = h.host.matchUris(a, url);
    const second = h.host.matchUris(a, url);
    const firstCommand = await h.command(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    h.reply(firstCommand, { ok: true, data: uriCandidates });
    expect(await first).toEqual({ ok: true, data: uriCandidates });
    const secondCommand = await h.command(2);
    // Past the budget counted from admission, but within the one counted from delivery.
    await new Promise((resolve) => setTimeout(resolve, 150));
    h.reply(secondCommand, { ok: true, data: uriCandidates });
    expect(await second).toEqual({ ok: true, data: uriCandidates });
  });

  it("refuses a job whose wait for its turn times out and keeps the session open", async () => {
    const h = harness({ timeoutMs: 300 });
    const a = await h.open();
    const url = "https://example.com/login";
    const first = h.host.matchUris(a, url);
    const second = h.host.matchUris(a, url);
    const third = h.host.matchUris(a, url);
    const firstCommand = await h.command(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    h.reply(firstCommand, { ok: true, data: uriCandidates });
    expect(await first).toEqual({ ok: true, data: uriCandidates });
    const secondCommand = await h.command(2);
    // The third has waited its whole budget behind the second, without reaching the Worker.
    expect(await third).toEqual({ ok: false, error: { code: "resource-limit" } });
    h.reply(secondCommand, { ok: true, data: uriCandidates });
    expect(await second).toEqual({ ok: true, data: uriCandidates });
    const next = h.host.matchUris(a, url);
    h.reply(await h.command(3), { ok: true, data: uriCandidates });
    expect(await next).toEqual({ ok: true, data: uriCandidates });
    expect(h.commands).toHaveLength(4);
  });

  it("delivers an open for another connection once the open ahead of it settles", async () => {
    const h = harness();
    const first = h.host.open(openInput());
    const firstCommand = await h.command(0);
    // A page restores connection B while a sync of connection A opens its candidate.
    const second = h.host.open(openInput("connection-2"));
    expect(await within(second, 20)).toBe("waiting");
    expect(h.commands).toHaveLength(1);
    const a = h.answerOpen(firstCommand);
    expect(await first).toMatchObject({ ok: true, data: { session: a } });
    const secondCommand = await h.command(1);
    expect(secondCommand).toMatchObject({
      connectionId: "connection-2",
      operation: { kind: "open" },
    });
    const b = h.answerOpen(secondCommand);
    expect(await second).toMatchObject({ ok: true, data: { session: b } });
  });

  it("delivers a derive-auth once the open ahead of it settles", async () => {
    const h = harness();
    const opening = h.host.open(openInput());
    const openCommand = await h.command(0);
    // A manual sign-in starts while a restore opens another connection's vault.
    const deriving = h.host.deriveAuthentication({ ...auth(), connectionId: "connection-2" });
    expect(await within(deriving, 20)).toBe("waiting");
    expect(h.commands).toHaveLength(1);
    h.answerOpen(openCommand);
    expect(await opening).toMatchObject({ ok: true });
    const deriveCommand = await h.command(1);
    expect(deriveCommand.operation).toMatchObject({ kind: "derive-auth" });
    const derived = { connectionId: "connection-2", masterPasswordHash: "synthetic-hash" };
    h.reply(deriveCommand, { ok: true, data: derived });
    expect(await deriving).toEqual({ ok: true, data: derived });
  });

  it("retires the Worker session of an open whose result the host refuses", async () => {
    const h = harness();
    const pending = h.host.open(openInput());
    const request = await h.command(0);
    const session: HostSessionRef = {
      brokerGeneration: h.host.generation,
      connectionId,
      userId: accountUserId,
      sessionId: crypto.randomUUID(),
      snapshotId,
    };
    // The metadata names another connection, so the host refuses the session.
    h.reply(request, {
      ok: true,
      data: {
        session,
        metadata: {
          connectionId: "connection-2",
          userId: accountUserId,
          accountVersion: "v1",
          securityVersion: 1,
        },
      },
    });
    expect(await pending).toEqual({ ok: false, error: { code: "crypto-failed" } });
    expect(h.posted).toContainEqual(
      expect.objectContaining({ type: "crypto.cancel", requestId: request.requestId }),
    );
    expect(h.host.status()).toMatchObject({ pending: 0, sessions: 0 });
  });

  it("rechecks a waiting open against the session caps when its turn comes", async () => {
    const h = harness();
    await h.open();
    // A sync's candidate open and a second one for the same connection race.
    const candidate = h.host.open(openInput());
    const extra = h.host.open(openInput());
    const candidateCommand = await h.command(1);
    expect(await within(extra, 20)).toBe("waiting");
    h.answerOpen(candidateCommand);
    expect(await candidate).toMatchObject({ ok: true });
    expect(await extra).toEqual({ ok: false, error: { code: "resource-limit" } });
    expect(h.commands).toHaveLength(2);
    expect(h.host.status()).toMatchObject({ pending: 0, sessions: 2 });
  });

  it("refuses a waiting open whose wait outlasts its budget without delivering it", async () => {
    const h = harness({ timeoutMs: 300 });
    const first = h.host.open(openInput());
    const second = h.host.open(openInput("connection-2"));
    const third = h.host.open(openInput("connection-3"));
    const firstCommand = await h.command(0);
    expect(await within(second, 20)).toBe("waiting");
    await new Promise((resolve) => setTimeout(resolve, 130));
    h.answerOpen(firstCommand);
    expect(await first).toMatchObject({ ok: true });
    const secondCommand = await h.command(1);
    // The third has waited its whole budget behind the second, without reaching the Worker.
    expect(await third).toEqual({ ok: false, error: { code: "resource-limit" } });
    h.answerOpen(secondCommand);
    expect(await second).toMatchObject({ ok: true });
    expect(h.commands).toHaveLength(2);
    expect(
      h.posted.filter((message) => (message as { type: string }).type === "crypto.cancel"),
    ).toHaveLength(0);
  });

  it("fails a session's waiting jobs without delivering them when it is locked", async () => {
    const h = harness();
    const a = await h.open();
    const url = "https://example.com/login";
    const first = h.host.matchUris(a, url);
    const second = h.host.matchUris(a, url);
    await h.command(1);
    const locking = h.host.lock(a);
    expect(await first).toEqual({ ok: false, error: { code: "crypto-locked" } });
    expect(await second).toEqual({ ok: false, error: { code: "crypto-locked" } });
    const lockCommand = await h.command(2);
    expect(lockCommand.operation).toEqual({ kind: "lock", session: a });
    h.reply(lockCommand, { ok: true, data: null });
    expect(await locking).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.commands.map((command) => command.operation.kind)).toEqual([
      "open",
      "match-uris",
      "lock",
    ]);
  });

  it("releases a session's waiting job when the job ahead of it fails", async () => {
    const h = harness();
    const a = await h.open();
    const url = "https://example.com/login";
    const first = h.host.matchUris(a, url);
    const second = h.host.matchUris(a, url);
    h.reply(await h.command(1), { ok: false, error: { code: "crypto-failed" } });
    expect(await first).toEqual({ ok: false, error: { code: "crypto-failed" } });
    expect(await second).toEqual({ ok: false, error: { code: "crypto-locked" } });
    expect(h.host.status()).toMatchObject({ pending: 0 });
  });

  it("keeps a decryption failure's check, item ID and revision date, and nothing else", async () => {
    const h = harness();
    const a = await h.open();
    const item = "00000000-0000-4000-8000-000000000002";
    const verified = h.host.verifyReceivedCiphers(a);
    h.reply(await h.command(1), {
      ok: false,
      error: {
        code: "crypto-failed",
        check: "attachment",
        item,
        revised: 1_762_720_517_000,
        name: "Synthetic item name",
      },
    });
    expect(await verified).toEqual({
      ok: false,
      error: { code: "crypto-failed", check: "attachment", item, revised: 1_762_720_517_000 },
    });
    const b = await h.open();
    const refused = h.host.verifyReceivedCiphers(b);
    h.reply(await h.command(3), {
      ok: false,
      error: { code: "crypto-failed", check: "Synthetic item name", item: "not-a-uuid" },
    });
    expect(await refused).toEqual({ ok: false, error: { code: "crypto-failed" } });
    // Each value is checked on its own: a valid check stays beside an invalid item ID.
    const c = await h.open();
    const partly = h.host.verifyReceivedCiphers(c);
    h.reply(await h.command(5), {
      ok: false,
      error: { code: "crypto-failed", check: "worker-exception", item: "not-a-uuid", revised: -1 },
    });
    expect(await partly).toEqual({
      ok: false,
      error: { code: "crypto-failed", check: "worker-exception" },
    });
  });

  it("forwards an unavailable URI context as its own result", async () => {
    const h = harness();
    const session = await h.open();
    const matched = h.host.matchUris(session, "https://example.com/login");
    h.reply(await h.command(1), { ok: false, error: { code: "uri-context-unavailable" } });
    expect(await matched).toEqual({ ok: false, error: { code: "uri-context-unavailable" } });
  });
}
