import { expect, it } from "vitest";
import type { CryptoHostTestContext } from "./context";

export function registerSsoFencingCases({
  harness,
  offscreenUrl,
  itemId,
  sourceInput,
  candidateInput,
  sourceResult,
  candidateResult,
}: Pick<
  CryptoHostTestContext,
  | "harness"
  | "offscreenUrl"
  | "itemId"
  | "sourceInput"
  | "candidateInput"
  | "sourceResult"
  | "candidateResult"
>) {
  it.each(["ssoMethods", "ssoCandidates"] as const)(
    "binds %s to the exact live session and immutable input",
    async (kind) => {
      const h = harness();
      const session = await h.open();
      const input = structuredClone(kind === "ssoMethods" ? sourceInput : candidateInput);
      const pending =
        kind === "ssoMethods"
          ? h.host.ssoMethods(session, input as typeof sourceInput)
          : h.host.ssoCandidates(session, input as typeof candidateInput);
      if ("allowedFieldIds" in input) input.allowedFieldIds.push("login.password");
      if ("candidates" in input) {
        input.usernameProof = "X".repeat(43);
        input.candidates[0]!.allowedFieldIds.push("login.password");
      }
      const request = await h.command(1);
      expect(request.operation).toEqual({
        kind: kind === "ssoMethods" ? "sso-methods" : "sso-candidates",
        session,
        ...(kind === "ssoMethods" ? sourceInput : candidateInput),
      });
      const data = kind === "ssoMethods" ? sourceResult : candidateResult;
      h.reply(request, { ok: true, data });
      expect(await pending).toEqual({ ok: true, data });
      expect(h.host.isOpen(session)).toBe(true);
    },
  );
  it("refuses duplicate candidate IDs regardless of case before dispatch", async () => {
    const h = harness();
    const session = await h.open();
    expect(
      await h.host.ssoCandidates(session, {
        ...candidateInput,
        candidates: [
          ...candidateInput.candidates,
          { itemId: itemId.toUpperCase(), allowedFieldIds: ["login.username"] },
        ],
      }),
    ).toEqual({ ok: false, error: { code: "invalid-request" } });
    expect(h.commands).toHaveLength(1);
  });
  it.each(["snapshotId", "itemId", "fieldId", "extra-value"])(
    "locks a source session on changed %s response",
    async (change) => {
      const h = harness();
      const session = await h.open();
      const pending = h.host.ssoMethods(session, sourceInput);
      const data = structuredClone(sourceResult);
      if (change === "snapshotId") data.snapshotId = crypto.randomUUID();
      if (change === "itemId") data.itemId = crypto.randomUUID();
      if (change === "fieldId") data.result.methods[0]!.fieldId = "login.password";
      if (change === "extra-value")
        Object.assign(data.result.methods[0]!, { username: "synthetic-private-username" });
      h.reply(await h.command(1), { ok: true, data });
      expect(await pending).toEqual({ ok: false, error: { code: "crypto-locked" } });
      expect(h.host.isOpen(session)).toBe(false);
      expect(await h.host.ssoMethods(session, sourceInput)).toEqual({
        ok: false,
        error: { code: "crypto-locked" },
      });
    },
  );
  it.each(["snapshotId", "itemId", "duplicate-origin", "value"])(
    "locks a candidate session on changed %s response",
    async (change) => {
      const h = harness();
      const session = await h.open();
      const pending = h.host.ssoCandidates(session, candidateInput);
      const data = structuredClone(candidateResult);
      if (change === "snapshotId") data.snapshotId = crypto.randomUUID();
      if (change === "itemId") data.candidates[0]!.itemId = crypto.randomUUID();
      if (change === "duplicate-origin")
        data.candidates[0]!.origins.push("https://idp.example.test");
      if (change === "value")
        Object.assign(data.candidates[0]!, { username: "synthetic-private-username" });
      h.reply(await h.command(1), { ok: true, data });
      expect(await pending).toEqual({ ok: false, error: { code: "crypto-locked" } });
      expect(h.host.isOpen(session)).toBe(false);
    },
  );
  it.each(["ssoMethods", "ssoCandidates"] as const)(
    "drops %s reply after native document replacement",
    async (kind) => {
      const h = harness();
      const session = await h.open();
      const pending =
        kind === "ssoMethods"
          ? h.host.ssoMethods(session, sourceInput)
          : h.host.ssoCandidates(session, candidateInput);
      const request = await h.command(1);
      h.setContexts([{ documentId: "replacement", documentUrl: offscreenUrl }]);
      h.onDisconnect.emit();
      h.reply(request, { ok: true, data: kind === "ssoMethods" ? sourceResult : candidateResult });
      expect(await pending).toEqual({ ok: false, error: { code: "crypto-failed" } });
      expect(h.host.isOpen(session)).toBe(false);
    },
  );
}
