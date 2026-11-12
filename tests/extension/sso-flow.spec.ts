import { expect, test } from "@playwright/test";
import { sendToBackground as send } from "./background-message";
import { settingsRequest, setupProbe, setupRequest } from "./connection-fixture";
import { withStoppedLoginWorker } from "./login-fixture";
import {
  chooseExample,
  configureSso,
  confirmationProofs,
  items,
  openSsoPopup,
  origins,
  ssoStatus,
  unchangedIdpDefault,
  type SsoScenario,
} from "./sso-fixture";
import { withVaultProfile } from "./vault-fixture";
import type { SsoResponse } from "../../apps/extension/src/login/sso-wire";

test("encrypted RP SSO maps the exact saved IdP account, executes its native recipe and proves only the RP return", async () => {
  await withVaultProfile(async (open) => {
    const browser = await open();
    const { options, evidence } = await configureSso(browser);
    const page = await browser.context.newPage();
    await page.goto(origins.rp + "/login");
    const popup = await openSsoPopup(browser, options, page);
    await chooseExample(popup);
    try {
      await expect(page.locator("#authenticated")).toBeVisible({ timeout: 15_000 });
    } catch (error) {
      throw new Error(
        "Synthetic SSO failed before RP authentication: " +
          JSON.stringify({ url: page.url(), evidence, status: await ssoStatus(options) }),
        { cause: error },
      );
    }
    await expect
      .poll(async () =>
        (await ssoStatus(options)).attempts.find((attempt) => attempt.route === "sso"),
      )
      .toMatchObject({
        state: "authenticated",
        outcome: "authenticated",
        account: { origin: origins.rp, itemId: items.rp },
      });
    expect(evidence).toEqual({ entries: 1, posts: 1, matched: true, returns: 1, unsafeClicks: 0 });
    const attempts = (await ssoStatus(options)).attempts;
    expect(attempts.find((attempt) => attempt.account.origin === origins.idp)?.account.itemId).toBe(
      items.idp,
    );
    await unchangedIdpDefault(options);
    const proofs = (await confirmationProofs(browser))?.proofs ?? [];
    expect(proofs.some((proof) => proof.origin === origins.idp)).toBe(false);
    expect(proofs.some((proof) => proof.origin === origins.rp && proof.itemId === items.rp)).toBe(
      true,
    );
  });
});

test("an authenticated native IdP page alone neither completes the RP nor grants confirmed-page fill on the IdP", async () => {
  await withVaultProfile(async (open) => {
    const browser = await open();
    const { options, evidence } = await configureSso(browser, "idp-complete");
    const page = await browser.context.newPage();
    await page.goto(origins.rp + "/login");
    await chooseExample(await openSsoPopup(browser, options, page));
    await expect(page.locator("#idp-authenticated")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () =>
        (await ssoStatus(options)).attempts.some(
          (attempt) => attempt.account.origin === origins.idp,
        ),
      )
      .toBe(true);
    expect(
      (await ssoStatus(options)).attempts.some(
        (attempt) => attempt.route === "sso" && attempt.state === "authenticated",
      ),
    ).toBe(false);
    expect(
      (await confirmationProofs(browser))?.proofs?.some((proof) => proof.origin === origins.idp) ??
        false,
    ).toBe(false);
    expect(evidence).toMatchObject({ posts: 1, matched: true, returns: 0 });
    await unchangedIdpDefault(options);
  });
});

for (const scenario of [
  "consent",
  "signup",
  "sharing",
  "nested",
  "fedcm",
] satisfies SsoScenario[]) {
  test(
    "the packaged SSO parent stops on an IdP " + scenario + " page before another effect",
    async () => {
      await withVaultProfile(async (open) => {
        const browser = await open();
        const { options, evidence } = await configureSso(browser, scenario);
        const page = await browser.context.newPage();
        await page.goto(origins.rp + "/login");
        await chooseExample(await openSsoPopup(browser, options, page));
        await expect(page).toHaveURL(origins.idp + "/login");
        await expect
          .poll(
            async () =>
              (await ssoStatus(options)).attempts.find((attempt) => attempt.route === "sso")?.state,
          )
          .toBe("blocked");
        expect(evidence).toEqual({
          entries: 1,
          posts: 0,
          matched: true,
          returns: 0,
          unsafeClicks: 0,
        });
        expect((await confirmationProofs(browser))?.proofs ?? []).toEqual([]);
        await unchangedIdpDefault(options);
      });
    },
  );
}

for (const scenario of [
  "new-origin",
  "new-window",
  "target-changed",
  "exact-destination",
  "selected-origin",
] satisfies SsoScenario[]) {
  test(
    "the packaged SSO operation refuses " + scenario + " without credential submission",
    async () => {
      await withVaultProfile(async (open) => {
        const browser = await open();
        const { options, evidence } = await configureSso(browser, scenario);
        const page = await browser.context.newPage();
        await page.goto(origins.rp + "/login");
        const pages = browser.context.pages().length;
        await chooseExample(await openSsoPopup(browser, options, page));
        await expect
          .poll(
            async () => {
              const status = await ssoStatus(options);
              return (
                status.attempts.some(
                  (attempt) => attempt.route === "sso" && attempt.state === "blocked",
                ) ||
                status.documents.some(
                  (document) =>
                    document.state === "denied" &&
                    document.reason?.startsWith("sso-") &&
                    !["sso-in-progress", "sso-completed"].includes(document.reason),
                )
              );
            },
            { timeout: 15_000 },
          )
          .toBe(true)
          .catch(async (error) => {
            throw new Error(
              "Synthetic SSO refusal did not settle: " +
                JSON.stringify({
                  scenario,
                  url: page.url(),
                  evidence,
                  status: await ssoStatus(options),
                }),
              { cause: error },
            );
          });
        if (["exact-destination", "selected-origin"].includes(scenario))
          await test.info().attach("destination-refusal", {
            body: JSON.stringify({ evidence, status: await ssoStatus(options) }),
            contentType: "application/json",
          });
        expect(evidence.posts).toBe(0);
        expect(evidence.returns).toBe(0);
        if (!["exact-destination", "selected-origin"].includes(scenario)) {
          expect(evidence.entries).toBe(0);
          await expect(page).toHaveURL(origins.rp + "/login");
        }
        expect(browser.context.pages().length).toBe(pages + 1);
        await unchangedIdpDefault(options);
      });
    },
  );
}

async function staleSelection(popup: import("@playwright/test").Page) {
  const tabId = await popup.evaluate(async () => {
    const chrome = (
      globalThis as unknown as {
        chrome: {
          tabs: {
            query(value: { active: boolean; currentWindow: boolean }): Promise<{ id?: number }[]>;
          };
        };
      }
    ).chrome;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
  });
  if (tabId === undefined) throw new Error("Synthetic active tab missing");
  const read = (await send(popup, { version: 1, type: "login.sso.get", tabId })) as SsoResponse;
  if (!read.ok || !read.offer) throw new Error("Synthetic SSO offer missing");
  const method = read.offer.methods[0];
  const candidate = method?.candidates.find((entry) => entry.itemId === items.idp);
  if (!method || !candidate) throw new Error("Synthetic exact provider candidate missing");
  return {
    version: 1,
    type: "login.sso.choose",
    tabId,
    offerId: read.offer.id,
    selection: { kind: "sso", method: method.method, candidateId: candidate.id },
  };
}
for (const change of ["vault", "source", "document"] as const) {
  test("a stale popup selection cannot survive a " + change + " change", async () => {
    await withVaultProfile(async (open) => {
      const browser = await open();
      const { options, evidence, connectionId } = await configureSso(browser);
      const page = await browser.context.newPage();
      await page.goto(origins.rp + "/login");
      const popup = await openSsoPopup(browser, options, page);
      const stale = await staleSelection(popup);
      if (change === "vault") {
        expect(
          await setupRequest(options, { type: "connection.disable", connectionId }),
        ).toMatchObject({ ok: true });
      } else if (change === "source") {
        expect(
          await setupProbe(browser.page, { action: "configure", variant: "uri" }),
        ).toMatchObject({ ok: true });
        expect(
          await setupRequest(options, { type: "connection.sync", connectionId }),
        ).toMatchObject({ ok: true });
      } else {
        await page.goto(origins.rp + "/different-document");
      }
      expect(await send(popup, stale)).toMatchObject({ ok: false });
      expect(evidence).toEqual({
        entries: 0,
        posts: 0,
        matched: true,
        returns: 0,
        unsafeClicks: 0,
      });
    });
  });
}

test("worker restart discards a popup offer and cannot replay its old provider selection", async () => {
  await withVaultProfile(async (open) => {
    const browser = await open();
    const { options, evidence } = await configureSso(browser);
    const page = await browser.context.newPage();
    await page.goto(origins.rp + "/login");
    const popup = await openSsoPopup(browser, options, page);
    const stale = await staleSelection(popup);
    await popup.close();
    await withStoppedLoginWorker(
      browser.context,
      browser.background,
      options,
      async (restarted) => {
        await settingsRequest(options);
        await restarted();
      },
    );
    // The message comes from a genuine popup document, but the old opaque offer is spent.
    const reopened = await browser.context.newPage();
    await reopened.goto("chrome-extension://" + browser.extensionId + "/popup.html");
    expect(await send(reopened, stale)).toMatchObject({ ok: false });
    expect(evidence).toEqual({ entries: 0, posts: 0, matched: true, returns: 0, unsafeClicks: 0 });
    await unchangedIdpDefault(options);
  });
});

test("a spent RP entry is not replayed after worker restart while the IdP navigation is unfinished", async () => {
  await withVaultProfile(async (open) => {
    const browser = await open();
    const { options, evidence, releaseIdp } = await configureSso(browser, "return", {
      holdIdp: true,
    });
    try {
      const page = await browser.context.newPage();
      await page.goto(origins.rp + "/login");
      await chooseExample(await openSsoPopup(browser, options, page));
      await expect.poll(() => evidence.entries).toBe(1);
      await withStoppedLoginWorker(
        browser.context,
        browser.background,
        options,
        async (restarted) => {
          await settingsRequest(options);
          await restarted();
          releaseIdp();
        },
      );
      await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
      await expect
        .poll(async () => {
          const status = await ssoStatus(options);
          return (
            status.attempts.some(
              (attempt) => attempt.route === "sso" && attempt.state === "blocked",
            ) || status.documents.some((document) => document.reason?.includes("interrupted"))
          );
        })
        .toBe(true);
      await expect(page.getByLabel("Username", { exact: true })).toHaveValue("");
      await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
      expect(evidence).toEqual({
        entries: 1,
        posts: 0,
        matched: true,
        returns: 0,
        unsafeClicks: 0,
      });
      expect((await confirmationProofs(browser))?.proofs ?? []).toEqual([]);
      await unchangedIdpDefault(options);
    } finally {
      releaseIdp();
    }
  });
});

for (const change of ["vault", "source"] as const) {
  test(
    "an active SSO handoff loses credential authority when its " + change + " changes",
    async () => {
      await withVaultProfile(async (open) => {
        const browser = await open();
        const { options, evidence, connectionId, releaseIdp } = await configureSso(
          browser,
          "return",
          { holdIdp: true },
        );
        try {
          const page = await browser.context.newPage();
          await page.goto(origins.rp + "/login");
          await chooseExample(await openSsoPopup(browser, options, page));
          await expect.poll(() => evidence.entries).toBe(1);
          if (change === "vault") {
            expect(
              await setupRequest(options, { type: "connection.disable", connectionId }),
            ).toMatchObject({ ok: true });
          } else {
            expect(
              await setupProbe(browser.page, { action: "configure", variant: "uri" }),
            ).toMatchObject({ ok: true });
            expect(
              await setupRequest(options, { type: "connection.sync", connectionId }),
            ).toMatchObject({ ok: true });
          }
          releaseIdp();
          await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
          await expect
            .poll(
              async () =>
                (await ssoStatus(options)).attempts.find((attempt) => attempt.route === "sso")
                  ?.state,
            )
            .toBe("blocked");
          await expect(page.getByLabel("Username", { exact: true })).toHaveValue("");
          await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
          expect(evidence).toEqual({
            entries: 1,
            posts: 0,
            matched: true,
            returns: 0,
            unsafeClicks: 0,
          });
          expect((await confirmationProofs(browser))?.proofs ?? []).toEqual([]);
        } finally {
          releaseIdp();
        }
      });
    },
  );
}

for (const scenario of ["wrong-rp", "rp-unknown", "rp-signup"] satisfies SsoScenario[]) {
  test(
    "an RP " + scenario + " return cannot complete the SSO parent or grant confirmed fill",
    async () => {
      await withVaultProfile(async (open) => {
        const browser = await open();
        const { options, evidence } = await configureSso(browser, scenario);
        const page = await browser.context.newPage();
        await page.goto(origins.rp + "/login");
        await chooseExample(await openSsoPopup(browser, options, page));
        await expect(page).toHaveURL(origins.rp + "/complete", { timeout: 15_000 });
        await expect
          .poll(
            async () =>
              (await ssoStatus(options)).attempts.find((attempt) => attempt.route === "sso")?.state,
          )
          .toBe("blocked");
        expect(evidence).toMatchObject({ entries: 1, posts: 1, matched: true, returns: 1 });
        expect((await confirmationProofs(browser))?.proofs ?? []).toEqual([]);
        await unchangedIdpDefault(options);
      });
    },
  );
}

test("a newly matched RP account saves its own default only after authenticated return", async () => {
  await withVaultProfile(async (open) => {
    const browser = await open();
    const { options, evidence } = await configureSso(browser);
    const initial = await settingsRequest(options);
    initial.snapshot.settings.siteDefaults = initial.snapshot.settings.siteDefaults.filter(
      (entry) => entry.origin !== origins.rp,
    );
    await settingsRequest(options, {
      version: 1,
      type: "settings.save",
      expectedRevision: initial.snapshot.revision,
      settings: initial.snapshot.settings,
    });
    const page = await browser.context.newPage();
    await page.goto(origins.rp + "/login");
    const popup = await openSsoPopup(browser, options, page);
    expect(
      (await settingsRequest(options)).snapshot.settings.siteDefaults.some(
        (entry) => entry.origin === origins.rp,
      ),
    ).toBe(false);
    await chooseExample(popup);
    try {
      await expect(page.locator("#authenticated")).toBeVisible({ timeout: 15_000 });
    } catch (error) {
      throw new Error(
        "Synthetic new-RP default flow failed: " +
          JSON.stringify({ url: page.url(), evidence, status: await ssoStatus(options) }),
        { cause: error },
      );
    }
    await expect
      .poll(
        async () =>
          (await settingsRequest(options)).snapshot.settings.siteDefaults.find(
            (entry) => entry.origin === origins.rp,
          )?.itemId,
      )
      .toBe(items.rp)
      .catch(async (error) => {
        const saved = await settingsRequest(options);
        throw new Error(
          "Synthetic RP default missing: " +
            JSON.stringify({
              evidence,
              status: await ssoStatus(options),
              snapshot: saved.snapshot,
            }),
          { cause: error },
        );
      });
    await unchangedIdpDefault(options);
  });
});

test("worker restart preserves the completed IdP child's exclusion from direct-login proof and replay", async () => {
  await withVaultProfile(async (open) => {
    const browser = await open();
    const { options, evidence } = await configureSso(browser);
    const page = await browser.context.newPage();
    await page.goto(origins.rp + "/login");
    await chooseExample(await openSsoPopup(browser, options, page));
    await expect(page.locator("#authenticated")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        async () =>
          (await ssoStatus(options)).attempts.find((attempt) => attempt.route === "sso")?.state,
      )
      .toBe("authenticated");
    const before = (await ssoStatus(options)).attempts.find(
      (attempt) => attempt.account.origin === origins.idp,
    );
    expect(before?.ssoChild).toMatchObject({ parentId: expect.any(String), attemptId: before?.id });
    await withStoppedLoginWorker(
      browser.context,
      browser.background,
      options,
      async (restarted) => {
        await settingsRequest(options);
        await restarted();
      },
    );
    const after = (await ssoStatus(options)).attempts.find((attempt) => attempt.id === before?.id);
    expect(after?.ssoChild).toEqual(before?.ssoChild);
    expect(
      (await confirmationProofs(browser))?.proofs?.some((proof) => proof.origin === origins.idp) ??
        false,
    ).toBe(false);
    expect(evidence).toEqual({ entries: 1, posts: 1, matched: true, returns: 1, unsafeClicks: 0 });
    await unchangedIdpDefault(options);
  });
});

test("the exact IdP chooser, native password, continue and stay-signed-in sequence remains one scoped SSO parent", async () => {
  test.setTimeout(45_000);
  await withVaultProfile(async (open) => {
    const browser = await open();
    const { options, evidence, idpEvents } = await configureSso(browser, "intermediate");
    const page = await browser.context.newPage();
    await page.goto(origins.rp + "/login");
    await chooseExample(await openSsoPopup(browser, options, page));
    try {
      await expect(page.locator("#authenticated")).toBeVisible({ timeout: 25_000 });
    } catch (error) {
      throw new Error(
        "Synthetic finite IdP sequence failed: " +
          JSON.stringify({
            url: page.url(),
            evidence,
            idpEvents,
            status: await ssoStatus(options),
          }),
        { cause: error },
      );
    }
    await expect
      .poll(
        async () =>
          (await ssoStatus(options)).attempts.find((attempt) => attempt.route === "sso")?.state,
      )
      .toBe("authenticated");
    expect(idpEvents).toEqual(["/choice-exact", "/continue-effect", "/stay-yes"]);
    expect(evidence).toEqual({ entries: 1, posts: 1, matched: true, returns: 1, unsafeClicks: 0 });
    expect(
      (await confirmationProofs(browser))?.proofs?.some((proof) => proof.origin === origins.idp) ??
        false,
    ).toBe(false);
    await unchangedIdpDefault(options);
  });
});
