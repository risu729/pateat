import { expect, it } from "vitest";
import { accountNow } from "../../../../../packages/bitwarden/src/__fixtures__/account";
import { v1Password } from "../../../../../packages/bitwarden/src/__fixtures__/crypto";
import type { SetupTestContext } from "./context";

export function registerChallengeCases({
  newInput,
  harness,
  noSecrets,
  closers,
}: Pick<SetupTestContext, "newInput" | "harness" | "noSecrets" | "closers">) {
  it("new-device verification sends only the explicitly entered OTP and does not synthesize an MFA token", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "device_error", error_description: "New device verification required" },
    });
    const result = await h.caller.begin(newInput());
    expect(result).toMatchObject({
      ok: true,
      kind: "new-device-verification-required",
      invalidOtp: false,
      expiresAt: accountNow * 1000 + 300_000,
    });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    if (!result.ok || result.kind !== "new-device-verification-required")
      throw new Error("Synthetic new-device challenge failed");
    expect((await h.caller.continue({ flowId: result.flowId, newDeviceOtp: "000987" })).ok).toBe(
      true,
    );
    const token = h.fetch.mock.calls.filter(([url]) => url.endsWith("/token"))[1]!;
    const form = new URLSearchParams(String(token[1].body));
    expect(form.get("newDeviceOtp")).toBe("000987");
    expect(form.has("twoFactorToken")).toBe(false);
    expect(h.host.deriveAuthentication).toHaveBeenCalledTimes(1);
    expect(h.fetch).toHaveBeenCalledTimes(4);
  });
  it("an unsupported offered MFA provider stops without a password replay or native cache mutation", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "5": null } },
    });
    expect(await h.caller.begin(newInput())).toEqual({
      ok: true,
      kind: "interaction-required",
      reason: "unsupported-challenge",
    });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.manager.accept).not.toHaveBeenCalled();
    expect(h.durable()).toBeNull();
  });
  it("holds MFA without replay, then uses the explicit selected provider and code exactly once", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null, "1": {} } },
    });
    const challenge = await h.caller.begin(newInput());
    expect(challenge).toMatchObject({ ok: true, kind: "mfa-required", providers: [0, 1] });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.manager.accept).not.toHaveBeenCalled();
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    noSecrets(challenge);
    const completed = await h.caller.continue({
      flowId: challenge.flowId,
      twoFactor: { provider: 1, code: "000123" },
    });
    expect(completed).toMatchObject({ ok: true, kind: "ready" });
    const tokens = h.fetch.mock.calls.filter(([url]) => url.endsWith("/token"));
    expect(tokens).toHaveLength(2);
    const form = new URLSearchParams(String(tokens[1]![1].body));
    expect(form.get("twoFactorToken")).toBe("000123");
    expect(form.get("twoFactorProvider")).toBe("1");
    expect(h.host.deriveAuthentication).toHaveBeenCalledTimes(1);
    noSecrets(completed);
  });
  it("keeps the sign-in waiting after a refused code, as the official two-step page does", async () => {
    const h = harness();
    h.tokenResponses.push(
      {
        status: 400,
        body: { error: "invalid_grant", TwoFactorProviders2: { "0": null, "1": {} } },
      },
      // Bitwarden's answer to a wrong code; Vaultwarden's forms are parsed the same way.
      {
        status: 400,
        body: {
          error: "invalid_grant",
          error_description: "invalid_username",
          ErrorModel: { Message: "Two-step token is invalid. Try again.", Object: "error" },
        },
      },
    );
    const challenge = await h.caller.begin(newInput());
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    const refused = await h.caller.continue({
      flowId: challenge.flowId,
      twoFactor: { provider: 1, code: "000111" },
    });
    expect(refused).toEqual({
      ok: true,
      kind: "mfa-required",
      flowId: challenge.flowId,
      providers: [0, 1],
      expiresAt: challenge.expiresAt,
      invalidCode: true,
    });
    noSecrets(refused);
    expect(await h.caller.keepAlive(challenge.flowId)).toEqual({
      ok: true,
      kind: "waiting",
      flowId: challenge.flowId,
    });
    const completed = await h.caller.continue({
      flowId: challenge.flowId,
      twoFactor: { provider: 1, code: "000123" },
    });
    expect(completed).toMatchObject({ ok: true, kind: "ready" });
    const tokens = h.fetch.mock.calls.filter(([url]) => url.endsWith("/token"));
    expect(tokens).toHaveLength(3);
    expect(new URLSearchParams(String(tokens[2]![1].body)).get("twoFactorToken")).toBe("000123");
    // The password was derived once; the retry sent the same hash.
    expect(h.host.deriveAuthentication).toHaveBeenCalledTimes(1);
  });
  it("answers a code the flow's end stopped mid-request as expired, not cancelled", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null } },
    });
    const challenge = await h.caller.begin(newInput());
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    const real = h.fetch.getMockImplementation()!;
    // The 5 minutes run out while the code's token request is on its way.
    h.fetch.mockImplementationOnce(async (url, init) => {
      h.advance(300_000);
      return real(url, init);
    });
    expect(
      await h.caller.continue({ flowId: challenge.flowId, twoFactor: { provider: 0, code: "1" } }),
    ).toEqual({ ok: false, error: { code: "setup-expired" } });
  });
  it("emails a code with the hash the password grant sent, and the sign-in still waits", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null, "1": {} } },
    });
    const challenge = await h.caller.begin(newInput());
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    const grant = new URLSearchParams(
      String(h.fetch.mock.calls.find(([url]) => url.endsWith("/token"))![1].body),
    );
    h.emailResponses.push(
      { status: 200, body: null },
      { status: 429, body: null },
      { status: 400, body: { message: "Email 2FA is disabled", object: "error" } },
      { status: 400, body: { message: "Synthetic refusal", object: "error" } },
      { status: 500, body: null },
    );
    const results = [];
    for (let i = 0; i < 5; i++)
      // oxlint-disable-next-line no-await-in-loop
      results.push(await h.caller.sendEmailCode(challenge.flowId));
    expect(
      results.map((result) => result.ok && result.kind === "email-code" && result.result),
    ).toEqual(["sent", "rate-limited", "unavailable", "refused", "failed"]);
    for (const result of results) noSecrets(result);
    const sends = h.fetch.mock.calls.filter(([url]) =>
      url.endsWith("/two-factor/send-email-login"),
    );
    expect(sends).toHaveLength(5);
    // The account's own server: its API host, as the official clients send it.
    expect(sends[0]![0]).toBe("https://api.bitwarden.com/two-factor/send-email-login");
    expect(sends[0]![1].method).toBe("POST");
    expect(JSON.parse(String(sends[0]![1].body))).toEqual({
      email: grant.get("username"),
      masterPasswordHash: grant.get("password"),
      ssoEmail2FaSessionToken: "",
      deviceIdentifier: grant.get("deviceIdentifier"),
      authRequestAccessCode: "",
      authRequestId: "",
    });
    expect(h.host.deriveAuthentication).toHaveBeenCalledTimes(1);
    expect(
      await h.caller.continue({
        flowId: challenge.flowId,
        twoFactor: { provider: 1, code: "000123" },
      }),
    ).toMatchObject({ ok: true, kind: "ready" });
  });
  it("answers the page's heartbeat while its sign-in waits, and expired once it ends", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "1": {} } },
    });
    const challenge = await h.caller.begin(newInput());
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    // The page shows this end on the code screen.
    expect(challenge.expiresAt).toBe(accountNow * 1000 + 300_000);
    const waiting = { ok: true, kind: "waiting", flowId: challenge.flowId };
    expect(await h.caller.keepAlive(challenge.flowId)).toEqual(waiting);
    // It does not take the page's one running request, so it answers during a send.
    h.emailResponses.push({ status: 200, body: null });
    const sent = h.caller.sendEmailCode(challenge.flowId);
    expect(await h.caller.keepAlive(challenge.flowId)).toEqual(waiting);
    expect(await sent).toMatchObject({ ok: true, kind: "email-code", result: "sent" });
    // Another flow ID, another page, or a flow past its 5 minutes is expired; a worker
    // Chrome restarted holds no flow and answers the same.
    const expired = { ok: false, error: { code: "setup-expired" } };
    expect(await h.caller.keepAlive("not-a-flow")).toEqual(expired);
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    expect(await other.keepAlive(challenge.flowId)).toEqual(expired);
    h.advance(299_999);
    expect(await h.caller.keepAlive(challenge.flowId)).toEqual(waiting);
    h.advance(1);
    expect(await h.caller.keepAlive(challenge.flowId)).toEqual(expired);
    other.dispose();
    expect(await other.keepAlive(challenge.flowId)).toEqual({
      ok: false,
      error: { code: "setup-unavailable" },
    });
    expect(
      await h.caller.continue({ flowId: challenge.flowId, twoFactor: { provider: 1, code: "1" } }),
    ).toMatchObject({ ok: false });
  });
  it("sends no email code for a flow without email two-step or after it ends", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null } },
    });
    const challenge = await h.caller.begin(newInput());
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    expect(await h.caller.sendEmailCode(challenge.flowId)).toMatchObject({ ok: false });
    expect(await h.caller.sendEmailCode("not-a-flow")).toMatchObject({ ok: false });
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    expect(await other.sendEmailCode(challenge.flowId)).toMatchObject({ ok: false });
    await h.caller.cancel(challenge.flowId);
    expect(await h.caller.sendEmailCode(challenge.flowId)).toMatchObject({ ok: false });
    expect(
      h.fetch.mock.calls.filter(([url]) => url.endsWith("/two-factor/send-email-login")),
    ).toHaveLength(0);
  });
  it.each([
    ["lost provider access", "provider-permission-required"],
    ["a transport that cannot be built", "invalid-profile"],
  ] as const)(
    "a send refused for %s ends the sign-in so a new one can start",
    async (why, code) => {
      const h = harness();
      h.tokenResponses.push({
        status: 400,
        body: { error: "invalid_grant", TwoFactorProviders2: { "1": {} } },
      });
      const challenge = await h.caller.begin(newInput());
      if (!challenge.ok || challenge.kind !== "mfa-required")
        throw new Error("Synthetic MFA challenge failed");
      if (why === "lost provider access") h.permission(false);
      else h.transportFor.mockReturnValueOnce({ ok: false, error: { code } } as never);
      expect(await h.caller.sendEmailCode(challenge.flowId)).toMatchObject({
        ok: false,
        error: { code },
      });
      expect(
        (
          await h.caller.continue({
            flowId: challenge.flowId,
            twoFactor: { provider: 1, code: "1" },
          })
        ).ok,
      ).toBe(false);
      h.permission(true);
      expect(await h.caller.begin(newInput())).toMatchObject({ ok: true, kind: "ready" });
      expect(
        h.fetch.mock.calls.filter(([url]) => url.endsWith("/two-factor/send-email-login")),
      ).toHaveLength(0);
    },
  );
  it("a sign-in cancelled while its code is being sent answers cancelled and ends", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "1": {} } },
    });
    const challenge = await h.caller.begin(newInput());
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    const fetch = h.fetch.getMockImplementation()!;
    let reached!: () => void;
    const sending = new Promise<void>((resolve) => {
      reached = resolve;
    });
    h.fetch.mockImplementation(async (url, init) => {
      if (!url.endsWith("/two-factor/send-email-login")) return fetch(url, init);
      reached();
      await new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
      throw new Error("unreachable");
    });
    const sent = h.caller.sendEmailCode(challenge.flowId);
    await sending;
    await h.caller.cancel(challenge.flowId);
    expect(await sent).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(
      (await h.caller.continue({ flowId: challenge.flowId, twoFactor: { provider: 1, code: "1" } }))
        .ok,
    ).toBe(false);
    expect(await h.caller.begin(newInput())).toMatchObject({ ok: true, kind: "ready" });
  });
  it("another options caller cannot continue or cancel an owned MFA flow", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null } },
    });
    const challenge = await h.caller.begin(newInput());
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    expect(
      (
        await other.continue({
          flowId: challenge.flowId,
          twoFactor: { provider: 0, code: "123456" },
        })
      ).ok,
    ).toBe(false);
    await other.cancel(challenge.flowId);
    expect(
      (
        await h.caller.continue({
          flowId: challenge.flowId,
          twoFactor: { provider: 0, code: "123456" },
        })
      ).ok,
    ).toBe(true);
  });
  it("cancelled and expired challenges cannot send another password grant", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null } },
    });
    const challenge = await h.caller.begin(newInput());
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    await h.caller.cancel(challenge.flowId);
    expect(
      (
        await h.caller.continue({
          flowId: challenge.flowId,
          twoFactor: { provider: 0, code: "123456" },
        })
      ).ok,
    ).toBe(false);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null } },
    });
    const next = await h.caller.begin(newInput());
    if (!next.ok || next.kind !== "mfa-required") throw new Error("Synthetic MFA challenge failed");
    h.advance(600_000);
    expect(
      (await h.caller.continue({ flowId: next.flowId, twoFactor: { provider: 0, code: "123456" } }))
        .ok,
    ).toBe(false);
    expect(h.fetch).toHaveBeenCalledTimes(4);
  });
  it("records the add form's policy choice before the first sign-in, so a later sign-in keeps it", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null } },
    });
    const challenge = await h.caller.begin({ ...newInput(), enabled: true });
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    const [configuration] = [...h.configurations.values()];
    if (!configuration) throw new Error("Synthetic connection was not registered");
    const connectionId = configuration.profile.connectionId;
    expect(h.policy.register.mock.calls).toEqual([[connectionId, true]]);
    expect(h.policy.register.mock.invocationCallOrder[0]).toBeLessThan(
      h.registry.put.mock.invocationCallOrder[0]!,
    );
    // The first attempt ends unfinished; the settings page then offers "Sign in again".
    await h.caller.cancel(challenge.flowId);
    expect(h.policy.adopt).not.toHaveBeenCalled();
    const ready = await h.caller.begin({
      kind: "existing",
      connectionId,
      password: v1Password,
    });
    expect(ready).toMatchObject({ ok: true, kind: "ready", connectionId });
    expect(h.policy.register).toHaveBeenCalledTimes(1);
    expect(h.policy.adopt).toHaveBeenCalledTimes(1);
  });
  it("revoked permission between challenge and continuation prevents the next HTTP request", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null } },
    });
    const challenge = await h.caller.begin(newInput());
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    h.permission(false);
    expect(
      await h.caller.continue({
        flowId: challenge.flowId,
        twoFactor: { provider: 0, code: "123456" },
      }),
    ).toEqual({ ok: false, error: { code: "provider-permission-required" } });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
}
