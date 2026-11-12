import { expect, it, vi } from "vitest";
import { accountUserId } from "../../../../../packages/bitwarden/src/__fixtures__/account";
import type { CryptoHostTestContext } from "./context";

export function registerRequestFencingCases({
  harness,
  auth,
  snapshotId,
  itemId,
  connectionId,
}: Pick<CryptoHostTestContext, "harness" | "auth" | "snapshotId" | "itemId" | "connectionId">) {
  it("rejects malformed requests and pre-cancelled work without creating a host", async () => {
    const h = harness();
    expect(await h.host.deriveAuthentication({ ...auth(), connectionId: "" })).toEqual({
      ok: false,
      error: { code: "invalid-request" },
    });
    const aborted = new AbortController();
    aborted.abort();
    expect(await h.host.deriveAuthentication(auth(), aborted.signal)).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(h.createDocument).not.toHaveBeenCalled();
  });

  it.each(["generation", "requestId", "connectionId"])(
    "ignores replies with stale %s without settling current work",
    async (field) => {
      const h = harness();
      const pending = h.host.deriveAuthentication(auth());
      const command = await h.command();
      const settled = vi.fn();
      void pending.then(settled);
      h.reply(command, { ok: true, data: "stale-secret" }, { [field]: crypto.randomUUID() });
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      expect(h.host.status().pending).toBe(1);
      h.reply(command, { ok: false, error: { code: "unsupported-crypto" } });
      expect(await pending).toEqual({ ok: false, error: { code: "unsupported-crypto" } });
    },
  );

  it.each([
    null,
    { ok: false, error: { code: "synthetic-secret-error", cause: "password" } },
    { ok: true },
  ])("sanitizes malformed response case %# without passing arbitrary errors", async (result) => {
    const h = harness();
    const pending = h.host.deriveAuthentication(auth());
    h.reply(await h.command(), result);
    expect(await pending).toEqual({ ok: false, error: { code: "crypto-failed" } });
  });

  it.each(["brokerGeneration", "connectionId", "userId", "sessionId", "snapshotId"])(
    "rejects a changed session %s before any command is sent",
    async (field) => {
      const h = harness();
      const session = await h.open();
      const before = h.commands.length;
      expect(
        await h.host.decryptCipher({ ...session, [field]: crypto.randomUUID() }, itemId),
      ).toEqual({ ok: false, error: { code: "crypto-locked" } });
      expect(h.commands).toHaveLength(before);
    },
  );

  it("selects encrypted items by fixed item ID and preserves typed field grants", async () => {
    const h = harness();
    const session = await h.open();
    const ref = {
      connectionId,
      userId: accountUserId,
      itemId,
      snapshotId,
      fieldId: "login.password",
    };
    const pending = h.host.resolveField(session, ref, {
      allowedFieldIds: ["login.password"],
      nowMs: 59_000,
    });
    const command = await h.command(1);
    expect(command.operation).toEqual({
      kind: "resolve",
      session,
      ref,
      allowedFieldIds: ["login.password"],
      nowMs: 59_000,
    });
    h.reply(command, { ok: true, data: { kind: "text", value: "synthetic-field-value" } });
    expect(await pending).toEqual({
      ok: true,
      data: { kind: "text", value: "synthetic-field-value" },
    });
  });

  it("carries a code grant to the Worker and returns only its generated code", async () => {
    const h = harness();
    const session = await h.open();
    const ref = {
      connectionId,
      userId: accountUserId,
      itemId,
      snapshotId,
      fieldId: `custom.${snapshotId}.0`,
    };
    const pending = h.host.resolveField(session, ref, {
      allowedFieldIds: [ref.fieldId],
      code: true,
    });
    const command = await h.command(1);
    expect(command.operation).toEqual({
      kind: "resolve",
      session,
      ref,
      allowedFieldIds: [ref.fieldId],
      code: true,
    });
    const otp = { kind: "otp", value: "654321", period: 30, validUntilMs: 60_000 };
    h.reply(command, { ok: true, data: otp });
    expect(await pending).toEqual({ ok: true, data: otp });
  });

  it.each([false, 1, "true", null])("rejects a code grant of %j before dispatch", async (code) => {
    const h = harness();
    const session = await h.open();
    const ref = {
      connectionId,
      userId: accountUserId,
      itemId,
      snapshotId,
      fieldId: "login.totp-code",
    };
    expect(
      await h.host.resolveField(session, ref, {
        allowedFieldIds: ["login.totp-code"],
        code,
      } as never),
    ).toEqual({ ok: false, error: { code: "invalid-request" } });
    expect(h.commands).toHaveLength(1);
  });
}
