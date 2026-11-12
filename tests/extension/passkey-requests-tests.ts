import type { Page } from "@playwright/test";
import type { PasskeyTestContext, Serialized, Spec } from "./passkeys.spec";

export function registerPasskeyRequestTests({
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
  requestWithChooser,
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
  | "requestWithChooser"
>) {
  test("discoverable, allow-listed, unattended and UV-required requests get UP and UV assertions", async () => {
    const { server, origin } = await startRelyingParty();
    try {
      await withLoginExtension(async (context, _worker, extensionId) => {
        const probe = await probeControls(context, extensionId);
        await probe.configure();
        const page = await openRelyingParty(context, origin);
        const discoverable = challengeHex();
        expectPateatAssertion(
          await clickRequest(page, { challenge: discoverable }),
          origin,
          discoverable,
        );
        // The manual-run status agrees with the independent verifier.
        await expect(page.locator("#result")).toHaveText("Pateat, flags 0x1d, signature verified");
        const allowListed = challengeHex();
        expectPateatAssertion(
          await clickRequest(page, {
            challenge: allowListed,
            rpId: "localhost",
            userVerification: "required",
            allow: [PROBE_PASSKEY.credentialId],
          }),
          origin,
          allowListed,
        );
        // No transient activation: the page starts this request on load, because Playwright's
        // evaluate would itself grant a user gesture.
        const unattended = await openRelyingParty(context, origin, "/?unattended");
        expectPateatAssertion(
          await unattended.evaluate(
            () => (window as unknown as { pending: Promise<Serialized> }).pending,
          ),
          origin,
          "00".repeat(32),
        );
        expect(await probe.signatures()).toBe(3);
      });
    } finally {
      server.close();
    }
  });

  test("unclaimed requests reach the browser's own authenticator unchanged", async () => {
    const { server, origin } = await startRelyingParty();
    try {
      await withLoginExtension(async (context, _worker, extensionId) => {
        const probe = await probeControls(context, extensionId);
        await probe.configure({ counter: 3 });
        const page = await openRelyingParty(context, origin);
        const counted = challengeHex();
        expectNativeAssertion(await clickRequest(page, { challenge: counted }), origin, counted);
        await probe.configure({ enabled: false });
        const unconfigured = challengeHex();
        expectNativeAssertion(
          await clickRequest(page, { challenge: unconfigured }),
          origin,
          unconfigured,
        );
        await probe.configure();
        // Neither authenticator holds this credential, so the browser's own rejection surfaces.
        expect(
          await clickRequest(page, { challenge: challengeHex(), allow: ["00112233"] }),
        ).toEqual({
          error: "NotAllowedError",
        });
        await expect(page.locator("#result")).toHaveText("error NotAllowedError");
        // A page whose permissions policy denies passkey requests keeps the browser's rejection.
        const denied = await openRelyingParty(context, origin, "/denied");
        expect(await clickRequest(denied, { challenge: challengeHex() })).toEqual({
          error: "NotAllowedError",
        });
        expect(await probe.signatures()).toBe(0);
      });
    } finally {
      server.close();
    }
  });

  test("a ceremony policy delegates unattended and UV-required requests and clears UV", async () => {
    const { server, origin } = await startRelyingParty();
    try {
      await withLoginExtension(async (context, _worker, extensionId) => {
        const probe = await probeControls(context, extensionId);
        await probe.configure({ presence: "activation", verification: "never" });
        const unattended = await openRelyingParty(context, origin, "/?unattended");
        expectNativeAssertion(
          await unattended.evaluate(
            () => (window as unknown as { pending: Promise<Serialized> }).pending,
          ),
          origin,
          "00".repeat(32),
        );
        const page = await openRelyingParty(context, origin);
        const required = challengeHex();
        expectNativeAssertion(
          await clickRequest(page, { challenge: required, userVerification: "required" }),
          origin,
          required,
        );
        const activated = challengeHex();
        expectPateatAssertion(
          await clickRequest(page, { challenge: activated }),
          origin,
          activated,
          0x19,
        );
        expect(await probe.signatures()).toBe(1);
      });
    } finally {
      server.close();
    }
  });

  test("abort rejects with the caller's reason and a slow bridge delegates", async () => {
    const { server, origin } = await startRelyingParty();
    try {
      await withLoginExtension(async (context, _worker, extensionId) => {
        const probe = await probeControls(context, extensionId);
        await probe.configure({ signDelayMs: 3000 });
        const page = await openRelyingParty(context, origin);
        await page.evaluate(
          (value) => {
            (window as unknown as { nextSpec: Spec }).nextSpec = value;
          },
          { challenge: challengeHex() },
        );
        await page.getByRole("button", { name: "Sign in with a passkey" }).click();
        // Exercise cancellation during signing, after the asynchronous permission checks.
        await expect.poll(probe.delayed).toBe(1);
        await page.evaluate(() => {
          const scope = window as unknown as { controller: AbortController; abortReason: unknown };
          scope.abortReason = { synthetic: "abort" };
          scope.controller.abort(scope.abortReason);
        });
        expect(
          await page.evaluate(
            () => (window as unknown as { pending: Promise<Serialized> }).pending,
          ),
        ).toEqual({ error: "caller-reason" });

        await probe.configure({ signDelayMs: 3000, timeoutMs: 300 });
        const slow = challengeHex();
        expectNativeAssertion(await clickRequest(page, { challenge: slow }), origin, slow);
        // Cancellation and the deadline stopped both delayed signatures, so neither signs, and
        // no signature started again after its stop.
        await expect.poll(probe.stopped).toBe(2);
        expect(await probe.delayed()).toBe(2);
        expect(await probe.signatures()).toBe(0);
      });
    } finally {
      server.close();
    }
  });

  test("a document navigated away from while Pateat signs gets nothing, and the tab's next document is answered without asking again", async () => {
    const { server, origin } = await startRelyingParty();
    try {
      await withLoginExtension(async (context, _worker, extensionId) => {
        const probe = await probeControls(context, extensionId);
        await probe.configure({ signDelayMs: 3000 });
        const page = await openRelyingParty(context, origin);
        await page.evaluate(
          (value) => {
            (window as unknown as { nextSpec: Spec }).nextSpec = value;
          },
          { challenge: challengeHex() },
        );
        await page.getByRole("button", { name: "Sign in with a passkey" }).click();
        // Leave only once the background is waiting on the delayed signature.
        await expect.poll(probe.delayed).toBe(1);
        await page.goto(`${origin}/?after`);
        // The replaced document's cancel stopped the signature that was running.
        await expect.poll(probe.stopped).toBe(1);
        expect(await probe.signatures()).toBe(0);

        // Nothing was recorded as a sign-in in this tab, so the single match signs silently.
        await probe.configure();
        const opened: Page[] = [];
        const track = (added: Page) => opened.push(added);
        context.on("page", track);
        const next = challengeHex();
        expectPateatAssertion(await clickRequest(page, { challenge: next }), origin, next);
        context.off("page", track);
        // No chooser window, which a recorded sign-in would have opened.
        expect(opened).toEqual([]);
        expect(await probe.signatures()).toBe(1);

        // Navigating away from a request whose chooser window is open closes the window; without
        // the cancel it would stay open. The counts below are sanity checks only.
        await probe.configure({ count: 2 });
        const fresh = await openRelyingParty(context, origin);
        const waiting = await requestWithChooser(context, fresh, { challenge: challengeHex() });
        const closed = waiting.chooser.waitForEvent("close");
        await fresh.goto(`${origin}/?left`);
        await closed;
        expect(await probe.signatures()).toBe(1);
        expect(await probe.remembered()).toEqual([]);
      });
    } finally {
      server.close();
    }
  });
}
