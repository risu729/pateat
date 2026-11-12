import type { Page } from "@playwright/test";
import type { PasskeyTestContext, Serialized, Spec } from "./passkeys.spec";

export function registerPasskeyProviderTests({
  test,
  expect,
  startRelyingParty,
  withLoginExtension,
  probeControls,
  openRelyingParty,
  challengeHex,
  expectPateatAssertion,
  clickRequest,
  PROBE_PASSKEY,
  expectNativeAssertion,
  addVirtualAuthenticator,
  virtualCredentialId,
}: Pick<
  PasskeyTestContext,
  | "test"
  | "expect"
  | "startRelyingParty"
  | "withLoginExtension"
  | "probeControls"
  | "openRelyingParty"
  | "challengeHex"
  | "expectPateatAssertion"
  | "clickRequest"
  | "PROBE_PASSKEY"
  | "expectNativeAssertion"
  | "addVirtualAuthenticator"
  | "virtualCredentialId"
>) {
  test("Pateat answers first when another provider wraps get later or restores it", async () => {
    const { server, origin } = await startRelyingParty();
    try {
      await withLoginExtension(async (context, _worker, extensionId) => {
        const probe = await probeControls(context, extensionId);
        await probe.configure();
        const page = await openRelyingParty(context, origin, "/provider");
        const providerCalls = (target: Page) =>
          target.evaluate(() => (window as unknown as { providerCalls: number }).providerCalls);
        const plain = challengeHex();
        expectPateatAssertion(await clickRequest(page, { challenge: plain }), origin, plain);
        // Named, so Pateat signs again in this tab without asking (ADR 0021 D).
        const named = [PROBE_PASSKEY.credentialId];
        const required = challengeHex();
        expectPateatAssertion(
          await clickRequest(page, {
            challenge: required,
            userVerification: "required",
            allow: named,
          }),
          origin,
          required,
        );
        expect(await providerCalls(page)).toBe(0);

        // An unclaimed request goes to the provider, which rejects it as Bitwarden does.
        await probe.configure({ enabled: false });
        expect(await clickRequest(page, { challenge: challengeHex() })).toEqual({ error: "Error" });
        expect(await providerCalls(page)).toBe(1);

        // Restoring the provider's saved function leaves Pateat outermost.
        await probe.configure();
        await page.evaluate(() =>
          (window as unknown as { restoreProvider(): void }).restoreProvider(),
        );
        const restored = challengeHex();
        expectPateatAssertion(
          await clickRequest(page, {
            challenge: restored,
            userVerification: "required",
            allow: named,
          }),
          origin,
          restored,
        );

        // A provider fallback reaches the browser's own authenticator exactly once.
        const fallback = await openRelyingParty(context, origin, "/provider?fallback");
        await probe.configure({ enabled: false });
        const delegated = challengeHex();
        expectNativeAssertion(
          await clickRequest(fallback, { challenge: delegated }),
          origin,
          delegated,
        );
        expect(await providerCalls(fallback)).toBe(1);
        expect(await probe.signatures()).toBe(3);
      });
    } finally {
      server.close();
    }
  });

  test("a page wrapper cloning request options preserves native fallback and caller cancellation", async () => {
    const { server, origin } = await startRelyingParty();
    try {
      await withLoginExtension(async (context, _worker, extensionId) => {
        const probe = await probeControls(context, extensionId);
        await probe.configure();
        const page = await context.newPage();
        const { session, authenticatorId } = await addVirtualAuthenticator(context, page);
        await page.goto(`${origin}/page-wrapper`);
        const calls = () =>
          page.evaluate(() => (window as unknown as { pageWrapperCalls: number }).pageWrapperCalls);
        const claimed = challengeHex();
        expectPateatAssertion(await clickRequest(page, { challenge: claimed }), origin, claimed);
        expect(await probe.signatures()).toBe(1);
        expect(await calls()).toBe(0);

        await probe.configure({ enabled: false });
        const fallback = challengeHex();
        expectNativeAssertion(await clickRequest(page, { challenge: fallback }), origin, fallback);
        expect(await calls()).toBe(1);

        // Hold native user presence so the request stays pending after delegation.
        // An unknown allowlist would let Chromium reject before the caller can abort.
        await session.send("WebAuthn.setAutomaticPresenceSimulation", {
          authenticatorId,
          enabled: false,
        });
        await page.evaluate(
          (spec) => {
            (window as unknown as { nextSpec: Spec }).nextSpec = spec;
          },
          {
            challenge: challengeHex(),
            allow: [virtualCredentialId.toString("hex")],
            timeout: 30_000,
          },
        );
        await page.getByRole("button", { name: "Sign in with a passkey" }).click();
        await expect.poll(calls).toBe(2);
        await page.evaluate(() => {
          const state = window as unknown as { controller: AbortController; abortReason: object };
          state.abortReason = { source: "synthetic caller" };
          state.controller.abort(state.abortReason);
        });
        expect(
          await page.evaluate(
            () => (window as unknown as { pending: Promise<Serialized> }).pending,
          ),
        ).toEqual({ error: "caller-reason" });
        expect(await calls()).toBe(2);
        expect(await probe.signatures()).toBe(1);
      });
    } finally {
      server.close();
    }
  });

  test("a locked provider holding an unclaimed request does not divert later requests", async () => {
    const { server, origin } = await startRelyingParty();
    try {
      await withLoginExtension(async (context, _worker, extensionId) => {
        const probe = await probeControls(context, extensionId);
        await probe.configure();
        const page = await openRelyingParty(context, origin, "/provider?locked");
        const claimed = challengeHex();
        expectPateatAssertion(
          await clickRequest(page, { challenge: claimed, userVerification: "required" }),
          origin,
          claimed,
        );

        // The provider holds an unclaimed request, as Bitwarden's locked-vault window does.
        await probe.configure({ enabled: false });
        await page.evaluate(
          (spec) => {
            (window as unknown as { nextSpec: Spec }).nextSpec = spec;
          },
          { challenge: challengeHex() },
        );
        await page.getByRole("button", { name: "Sign in with a passkey" }).click();
        await page.evaluate(() => {
          const scope = window as unknown as { pending: unknown; held: unknown };
          scope.held = scope.pending;
        });
        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as { providerCalls: number }).providerCalls),
          )
          .toBe(1);

        await probe.configure();
        // Named, so Pateat signs again in this tab without asking (ADR 0021 D).
        const meanwhile = challengeHex();
        expectPateatAssertion(
          await clickRequest(page, { challenge: meanwhile, allow: [PROBE_PASSKEY.credentialId] }),
          origin,
          meanwhile,
        );

        // Unlocking ends the held request with the provider's own rejection, never Pateat's.
        await page.evaluate(() =>
          (window as unknown as { unlockProvider(): void }).unlockProvider(),
        );
        expect(
          await page.evaluate(() => (window as unknown as { held: Promise<Serialized> }).held),
        ).toEqual({ error: "Error" });
        expect(await probe.signatures()).toBe(2);
      });
    } finally {
      server.close();
    }
  });

  test("a provider's conditional request reaches the browser once and leaves sign-in to Pateat", async () => {
    const { server, origin } = await startRelyingParty();
    try {
      await withLoginExtension(async (context, _worker, extensionId) => {
        const probe = await probeControls(context, extensionId);
        await probe.configure();
        const page = await openRelyingParty(context, origin, "/provider");
        // Autofill-style requests start without a gesture and stay pending.
        await page.evaluate((challenge) => {
          const scope = window as unknown as {
            request(spec: Spec): Promise<unknown>;
            conditional: Promise<unknown>;
          };
          scope.conditional = scope.request({ challenge, mediation: "conditional" });
        }, challengeHex());
        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as { providerCalls: number }).providerCalls),
          )
          .toBe(1);
        const modal = challengeHex();
        expectPateatAssertion(await clickRequest(page, { challenge: modal }), origin, modal);
        expect(
          await page.evaluate(() => (window as unknown as { providerCalls: number }).providerCalls),
        ).toBe(1);
        expect(await probe.signatures()).toBe(1);
      });
    } finally {
      server.close();
    }
  });
}
