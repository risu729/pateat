import { describe, expect, it, vi } from "vitest";
import { createPasskeyRuntime, type ConditionalDecision, type PasskeySource } from "./runtime";

// A conditional request that names its credentials, decided `named` by the login runtime:
// no login of its page answers it and no recipe starts on its path (ADR 0034 amendment of
// 2026-11-17, #1673).
const extensionId = "synthetic-extension";
const origin = "https://login.example.com";
const sender = () => ({
  id: extensionId,
  tab: { id: 7 },
  frameId: 0,
  documentId: "document-a",
  documentLifecycle: "active",
  origin,
  url: `${origin}/sign-in/password`,
});
const base = { rpId: "example.com", userHandle: "dXNlcg", discoverable: true, counter: 0 };
const accountA = { ...base, credentialId: "AAAA" };
// The site default, which never breaks a tie among named passkeys.
const accountB = { ...base, credentialId: "BBBB", preferred: true };
const accountC = { ...base, credentialId: "CCCC" };
const get = (allowCredentials: string[]) => ({
  version: 1,
  type: "passkey.get",
  operationId: crypto.randomUUID(),
  request: {
    challenge: "AAECAwQFBgcICQoLDA0ODw",
    rpId: "example.com",
    mediation: "conditional",
    allowCredentials: allowCredentials.map((id) => ({ type: "public-key", id })),
  },
  userActivation: false,
  focused: true,
  path: "/sign-in/password",
});
const vault = (stored = [accountA, accountB, accountC], complete = true): PasskeySource => ({
  candidates: vi.fn(async () => ({ candidates: stored, complete })),
  sign: vi.fn(async () => Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01)),
});
function runtime(
  options: {
    decision?: ConditionalDecision;
    defaultUnset?: boolean | "paused";
    reverification?: boolean;
    source?: PasskeySource;
  } = {},
) {
  const report = vi.fn();
  const answered = vi.fn();
  const chooser = { choose: vi.fn() };
  const conditional = vi.fn(async () => options.decision ?? { kind: "named" as const });
  const source = options.source ?? vault();
  const passkeys = createPasskeyRuntime(source, {
    extensionId,
    report,
    answered,
    chooser,
    conditional,
    defaultUnset: async () => options.defaultUnset ?? false,
    reverification: async () => options.reverification ?? false,
  });
  return { passkeys, report, answered, chooser, conditional, source };
}

describe("a conditional request answered by the passkey it names (ADR 0034, 2026-11-17)", () => {
  it("is answered with the one vault passkey it names, as a sign-in Pateat made itself", async () => {
    const { passkeys, report, answered, chooser, conditional } = runtime();
    expect(await passkeys.handle(get(["AAAA", "DDDD"]), sender())).toMatchObject({
      kind: "assertion",
      assertion: expect.objectContaining({ credentialId: "AAAA" }),
    });
    expect(conditional).toHaveBeenCalledWith(expect.objectContaining({ namesCredentials: true }));
    expect(chooser.choose).not.toHaveBeenCalled();
    // Counted by the relogin guard as Pateat's own sign-in (ADR 0062).
    expect(answered).toHaveBeenCalledWith(
      7,
      origin,
      "example.com",
      expect.objectContaining({ credentialId: "AAAA" }),
      expect.objectContaining({ silent: true }),
    );
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "assertion",
        namedCredential: true,
        mediation: "conditional",
      }),
    );
  });

  it("is handed on when several vault passkeys or none are named, or the vault is incomplete", async () => {
    // The site default among them does not decide.
    const several = runtime();
    expect(await several.passkeys.handle(get(["AAAA", "BBBB"]), sender())).toEqual({
      kind: "delegate",
      reason: "ambiguous-credential",
    });
    expect(several.chooser.choose).not.toHaveBeenCalled();
    expect(several.report).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "ambiguous-credential", namedCredential: true }),
    );
    const none = runtime();
    expect(await none.passkeys.handle(get(["DDDD"]), sender())).toEqual({
      kind: "delegate",
      reason: "no-credential",
    });
    expect(none.report).toHaveBeenCalledWith(expect.objectContaining({ namedCredential: true }));
    const partial = runtime({ source: vault([accountA], false) });
    expect(await partial.passkeys.handle(get(["AAAA"]), sender())).toEqual({
      kind: "delegate",
      reason: "vault-incomplete",
    });
    expect(partial.report).toHaveBeenCalledWith(expect.objectContaining({ namedCredential: true }));
  });

  it("is handed on on a paused site, or one that asks or the relogin guard holds", async () => {
    const paused = runtime({ defaultUnset: "paused" });
    expect(await paused.passkeys.handle(get(["AAAA"]), sender())).toEqual({
      kind: "delegate",
      reason: "paused",
    });
    expect(paused.report).toHaveBeenCalledWith(
      expect.objectContaining({ namedCredential: true, paused: true }),
    );
    expect(paused.source.sign).not.toHaveBeenCalled();
    const asking = runtime({ defaultUnset: true });
    expect(await asking.passkeys.handle(get(["AAAA"]), sender())).toEqual({
      kind: "delegate",
      reason: "default-unset",
    });
    expect(asking.chooser.choose).not.toHaveBeenCalled();
    expect(asking.report).toHaveBeenCalledWith(expect.objectContaining({ namedCredential: true }));
  });

  it("hands a re-verification after Pateat's login in the tab on, as ADR 0035 says", async () => {
    const confirm = runtime({ reverification: true });
    expect(await confirm.passkeys.handle(get(["AAAA"]), sender())).toEqual({
      kind: "delegate",
      reason: "confirm-fill",
    });
    expect(confirm.source.candidates).not.toHaveBeenCalled();
    expect(confirm.report).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "confirm-fill", namedCredential: true }),
    );
  });

  it("hands the request on when its page moved before the answer left", async () => {
    const moved = runtime({ decision: { kind: "named", stillOnPath: async () => false } });
    expect(await moved.passkeys.handle(get(["AAAA"]), sender())).toEqual({
      kind: "delegate",
      reason: "page-moved",
    });
    expect(moved.answered).not.toHaveBeenCalled();
    expect(moved.report).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "page-moved", namedCredential: true }),
    );
  });
});
