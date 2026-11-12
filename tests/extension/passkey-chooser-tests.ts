import type { PasskeyTestContext } from "./passkeys.spec";

export function registerPasskeyChooserTests({
  test,
  expect,
  startRelyingParty,
  withLoginExtension,
  probeControls,
  openRelyingParty,
  challengeHex,
  expectPateatAssertion,
  expectNativeAssertion,
  clickRequest,
  PROBE_PASSKEY,
  requestWithChooser,
  choose,
  secondCredentialId,
  settingsRequest,
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
  | "expectNativeAssertion"
  | "clickRequest"
  | "PROBE_PASSKEY"
  | "requestWithChooser"
  | "choose"
  | "secondCredentialId"
  | "settingsRequest"
>) {
  test("several matching passkeys open Pateat's chooser window", async () => {
    const { server, origin } = await startRelyingParty();
    try {
      await withLoginExtension(async (context, _worker, extensionId) => {
        const probe = await probeControls(context, extensionId);
        await probe.configure({ count: 2 });
        const page = await openRelyingParty(context, origin);

        // Choosing the second passkey signs with it and saves it as the default afterwards.
        const chosen = challengeHex();
        const first = await requestWithChooser(context, page, { challenge: chosen });
        const list = first.chooser.getByRole("list", { name: "Matching passkeys" });
        await expect(list.getByRole("button")).toHaveText([
          "synthetic-user-1Synthetic passkey 1 in Probe",
          "synthetic-user-2Synthetic passkey 2 in Probe",
        ]);
        await expect(
          first.chooser.getByRole("checkbox", { name: "Use this account for localhost" }),
        ).toBeChecked();
        await choose(list.getByRole("button", { name: /Synthetic passkey 2/u }));
        const result = await first.settle();
        if ("error" in result) throw new Error(`Expected an assertion, got ${result.error}`);
        expect(result.id).toBe(secondCredentialId);
        await expect.poll(() => probe.remembered()).toEqual([secondCredentialId]);

        // A one-time choice is not saved.
        const onceChallenge = challengeHex();
        const once = await requestWithChooser(context, page, { challenge: onceChallenge });
        await once.chooser.getByRole("checkbox").uncheck();
        await choose(once.chooser.getByRole("button", { name: /Synthetic passkey 1/u }));
        expectPateatAssertion(await once.settle(), origin, onceChallenge);
        expect(await probe.remembered()).toEqual([secondCredentialId]);

        // "Use the browser" just once and closing the window both hand the request to the
        // browser.
        const browserChallenge = challengeHex();
        const toBrowser = await requestWithChooser(context, page, { challenge: browserChallenge });
        await toBrowser.chooser
          .getByRole("button", { name: "Use the browser or another extension" })
          .click();
        await choose(toBrowser.chooser.getByRole("menuitem", { name: "Just once" }));
        expectNativeAssertion(await toBrowser.settle(), origin, browserChallenge);
        const closedChallenge = challengeHex();
        const closed = await requestWithChooser(context, page, { challenge: closedChallenge });
        await closed.chooser.close();
        expectNativeAssertion(await closed.settle(), origin, closedChallenge);

        // The page aborting its request closes the window.
        const aborted = await requestWithChooser(context, page, { challenge: challengeHex() });
        const abortedClosed = aborted.chooser.waitForEvent("close");
        await page.evaluate(() => {
          const scope = window as unknown as { controller: AbortController; abortReason: unknown };
          scope.abortReason = { synthetic: "abort" };
          scope.controller.abort(scope.abortReason);
        });
        expect(await aborted.settle()).toEqual({ error: "caller-reason" });
        await abortedClosed;
      });
    } finally {
      server.close();
    }
  });

  test('"Always for this site" hands the host\'s later requests to the browser until removed (ADR 0007)', async () => {
    const { server, origin } = await startRelyingParty();
    try {
      await withLoginExtension(async (context, _worker, extensionId) => {
        const probe = await probeControls(context, extensionId);
        await probe.configure({ count: 2 });
        const page = await openRelyingParty(context, origin);
        const options = await context.newPage();
        await options.goto(`chrome-extension://${extensionId}/options.html`);
        const listed = async () =>
          (await settingsRequest(options)).snapshot.settings.passkeyBrowserSites;

        const first = challengeHex();
        const always = await requestWithChooser(context, page, { challenge: first });
        await always.chooser
          .getByRole("button", { name: "Use the browser or another extension" })
          .click();
        await choose(always.chooser.getByRole("menuitem", { name: /^Always for this site/u }));
        expectNativeAssertion(await always.settle(), origin, first);
        await expect.poll(listed).toEqual([{ hostname: "localhost" }]);

        // The next request goes to the browser at once, without a window or a signature.
        const later = challengeHex();
        expectNativeAssertion(await clickRequest(page, { challenge: later }), origin, later);
        expect(await probe.signatures()).toBe(0);

        // Removed on the settings page, the next request of the same page asks again.
        await options.reload();
        await options.getByRole("button", { name: "Remove localhost from this list" }).click();
        await expect.poll(listed).toEqual([]);
        const again = challengeHex();
        const asked = await requestWithChooser(context, page, { challenge: again });
        await choose(asked.chooser.getByRole("button", { name: /Synthetic passkey 1/u }));
        expectPateatAssertion(await asked.settle(), origin, again);
      });
    } finally {
      server.close();
    }
  });

  test("Immediate UI requests are answered like other requests, chooser included (ADR 0052)", async () => {
    const { server, origin } = await startRelyingParty();
    try {
      await withLoginExtension(async (context, _worker, extensionId) => {
        const probe = await probeControls(context, extensionId);
        await probe.configure();
        const page = await openRelyingParty(context, origin);
        // The page passes its own signal, as most sites do; one match signs without a window.
        const single = challengeHex();
        expectPateatAssertion(
          await clickRequest(page, { challenge: single, uiMode: "immediate" }),
          origin,
          single,
        );

        // Several matches open the chooser window, as for any other request.
        await probe.configure({ count: 2 });
        const fresh = await openRelyingParty(context, origin);
        const chosen = challengeHex();
        const several = await requestWithChooser(context, fresh, {
          challenge: chosen,
          uiMode: "immediate",
        });
        await choose(several.chooser.getByRole("button", { name: /Synthetic passkey 2/u }));
        const result = await several.settle();
        if ("error" in result) throw new Error(`Expected an assertion, got ${result.error}`);
        expect(result.id).toBe(secondCredentialId);
        expect(await probe.signatures()).toBe(2);
      });
    } finally {
      server.close();
    }
  });

  test("after Pateat signed in a tab, the next username-less request there signs again (ADR 0062)", async () => {
    const { server, origin } = await startRelyingParty();
    try {
      await withLoginExtension(async (context, _worker, extensionId) => {
        const probe = await probeControls(context, extensionId);
        await probe.configure();
        const page = await openRelyingParty(context, origin);
        const first = challengeHex();
        expectPateatAssertion(await clickRequest(page, { challenge: first }), origin, first);

        // The single match signs again without a window, as after a logout (#833).
        const again = challengeHex();
        expectPateatAssertion(await clickRequest(page, { challenge: again }), origin, again);

        // A named request, as in a re-authentication, and a new tab sign silently too.
        const named = challengeHex();
        expectPateatAssertion(
          await clickRequest(page, { challenge: named, allow: [PROBE_PASSKEY.credentialId] }),
          origin,
          named,
        );
        const other = await openRelyingParty(context, origin);
        const fresh = challengeHex();
        expectPateatAssertion(await clickRequest(other, { challenge: fresh }), origin, fresh);
        expect(await probe.signatures()).toBe(4);
        expect(await probe.remembered()).toEqual([]);
      });
    } finally {
      server.close();
    }
  });

  test("the chooser keeps the request open past the page's 15-second backstop and a settings change", async () => {
    test.setTimeout(60_000);
    const { server, origin } = await startRelyingParty();
    try {
      await withLoginExtension(async (context, _worker, extensionId) => {
        const probe = await probeControls(context, extensionId);
        await probe.configure({ count: 2 });
        const page = await openRelyingParty(context, origin);
        const challenge = challengeHex();
        // Without a heartbeat, the page would give up after 15 seconds and the background after 10.
        const waiting = await requestWithChooser(context, page, { challenge, timeout: 60_000 });
        await page.waitForTimeout(8_000);
        // A settings save, as a sync from the server also makes, leaves the window open.
        const options = await context.newPage();
        await options.goto(`chrome-extension://${extensionId}/options.html`);
        const current = await settingsRequest(options);
        await settingsRequest(options, {
          version: 1,
          type: "settings.save",
          expectedRevision: current.snapshot.revision,
          settings: current.snapshot.settings,
        });
        await options.close();
        await page.waitForTimeout(9_000);
        expect(waiting.chooser.isClosed()).toBe(false);
        await choose(waiting.chooser.getByRole("button", { name: /Synthetic passkey 1/u }));
        expectPateatAssertion(await waiting.settle(), origin, challenge);
      });
    } finally {
      server.close();
    }
  });

  test("an unanswered chooser fails the request when the site's timeout runs out", async () => {
    test.setTimeout(60_000);
    const { server, origin } = await startRelyingParty();
    try {
      await withLoginExtension(async (context, _worker, extensionId) => {
        const probe = await probeControls(context, extensionId);
        await probe.configure({ count: 2 });
        const page = await openRelyingParty(context, origin);
        // Chrome's own prompt rejects with NotAllowedError; the browser is not asked instead.
        const waiting = await requestWithChooser(context, page, {
          challenge: challengeHex(),
          timeout: 12_000,
        });
        const closed = waiting.chooser.waitForEvent("close", { timeout: 20_000 });
        expect(await waiting.settle()).toEqual({ error: "NotAllowedError" });
        await closed;
        expect(await probe.signatures()).toBe(0);
      });
    } finally {
      server.close();
    }
  });
}
