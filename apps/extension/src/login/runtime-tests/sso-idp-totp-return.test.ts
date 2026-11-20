// An SSO flow through an IdP that asks for its password, shows a risk check with nothing
// to choose, a method chooser its own login's handler answers and a TOTP page, then sends
// the tab back through the RP's own callback to its signed-in page, as in the owner's
// Chrome on 2026-11-20 (14:33–14:37 UTC): the flow signed in by itself, but its parent was
// recorded `cancelled` (`sso-return-unconfirmed`), its IdP login `cancelled`
// (`sso-detached`), and about 40 `sso-scope-changed` refusals came 62 ms apart.
import { describe, expect, it, vi } from "vitest";
import type { LoginRecipe } from "@pateat/contracts";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
const io = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  getItems: vi.fn(),
  setItems: vi.fn(),
}));
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.mock("wxt/utils/storage", () => ({ storage: io }));
const { cancelSso, installSsoLifecycle, ssoAdmit } = await import("../runtime/sso/flow");
const { allowed } = await import("../runtime/plan-2");
const { reconcileBounded } = await import("../runtime/sign-in");
const { admit } = await import("../runtime/admit");
const { handle: dispatch } = await import("../runtime/messages");
const { ssoReturnFixture } = await import("./sso-return-fixture");
const {
  rp,
  idp,
  portal,
  target,
  idpRecipe,
  delivery,
  idpReadings,
  identities,
  harness,
  idpChild,
  step,
  click,
  fill,
} = ssoReturnFixture(fake, io);
describe("an SSO sign-in through the IdP's password, risk check, method chooser and TOTP", () => {
  it("records the parent signed in once the RP shows it, and the IdP's login never cancelled", async () => {
    const h = await harness();
    // The IdP's sign-in form: its own login fills the identifier and the password.
    const form = h.page(idp, "idp-form", "/authsvc", "?txn=1");
    idpReadings.set("idp-form", { kind: "native" });
    const run = idpChild(h, form.live);
    expect(await ssoAdmit(h.rt, form.ctx)).toBeUndefined();
    step(run, [
      ...fill("username"),
      ...click("next"),
      { type: "OBSERVED", result: "continue" },
      ...fill("password"),
      ...click("submit"),
    ]);
    expect(run.metadata.state).toBe("awaiting-result");
    /** The tab's next IdP page, admitted with the IdP's own login, whose steps it allows. */
    const next = async (documentId: string, path: string, reading: Record<string, unknown>) => {
      idpReadings.set(documentId, reading);
      const shown = h.page(idp, documentId, path, "?txn=" + documentId);
      expect(await ssoAdmit(h.rt, shown.ctx)).toBeUndefined();
      expect(shown.ctx.refuse).not.toHaveBeenCalled();
      run.live = shown.live;
      step(run, [{ type: "NAVIGATED", document: shown.live.document }]);
      expect(await allowed(h.rt, run)).toBeDefined();
      return shown;
    };
    // A risk check that shows nothing to choose and sends the tab on by itself.
    await next("idp-risk", "/risk/v3.0/authz/pages/compute", { kind: "unknown", controls: false });
    expect(run.metadata).toMatchObject({ state: "reconciling", outcome: "unknown-submit" });
    // The method chooser, whose authenticator method the login's own handler presses.
    const chooser = await next("idp-methods", "/mfa", { kind: "unknown", controls: true });
    step(run, [
      { type: "HANDLER", handler: 0, steps: 1, effects: 1, document: chooser.live.document },
      ...click("method"),
    ]);
    // The TOTP page, whose code the login's other handler fills and submits.
    const code = await next("idp-code", "/mfa", { kind: "unknown", controls: true });
    step(run, [
      { type: "HANDLER", handler: 1, steps: 2, effects: 1, document: code.live.document },
      ...fill("code"),
      ...click("verify"),
    ]);
    expect(run.metadata.state).toBe("awaiting-result");
    expect(h.work.ended).toBe(false);
    h.report.mockClear();
    // The RP's own callback, which shows nothing of the sign-in yet: the flow waits.
    const callback = h.page(rp, "rp-callback", "/callback", "?code=synthetic");
    expect(await ssoAdmit(h.rt, callback.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    expect(callback.ctx.refuse).toHaveBeenCalledWith("sso-in-progress", "rp-return:no-evidence");
    expect(h.work.ended).toBe(false);
    expect(h.work.parent?.state).toBe("reconciling");
    // The IdP's login no longer acts, and nothing recorded it as ended yet.
    expect(h.rt.attempts.has(7)).toBe(false);
    expect(h.report).not.toHaveBeenCalledWith(expect.objectContaining({ ssoChild: true }));
    // The RP's signed-in page, which shows the selected identity.
    identities.set("rp-home", "match");
    const home = h.page(rp, "rp-home", "/home");
    expect(await ssoAdmit(h.rt, home.ctx)).toEqual({ ok: false, reason: "sso-completed" });
    expect(h.work.parent).toMatchObject({ state: "authenticated", outcome: "authenticated" });
    expect(h.report).toHaveBeenCalledWith(
      expect.objectContaining({ type: "attempt", route: "sso", state: "authenticated" }),
    );
    // The IdP's login ends once, as the sign-in it led to, released from its IdP hold.
    const childLines = h.report.mock.calls
      .map(([line]) => line as Record<string, unknown>)
      .filter((line) => line["ssoChild"] === true);
    expect(childLines).toEqual([
      expect.objectContaining({
        state: "authenticated",
        outcome: "authenticated",
        reason: "sso-released",
      }),
    ]);
    expect(h.work.childRecord).toMatchObject({
      state: "authenticated",
      ssoChild: { released: true },
    });
    expect(h.report).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "cancelled" }));
    // The IdP's login gives no IdP default or authentication proof.
    expect(h.rt.confirmFill.proofs.some((proof) => proof.origin === idp)).toBe(false);
    expect(h.rt.settings.update).not.toHaveBeenCalled();
  });
  it("releases the IdP's login as one that left its origin when the flow ends unsigned", async () => {
    const h = await harness();
    const form = h.page(idp, "idp-form", "/authsvc", "?txn=1");
    idpReadings.set("idp-form", { kind: "native" });
    const run = idpChild(h, form.live);
    expect(await ssoAdmit(h.rt, form.ctx)).toBeUndefined();
    step(run, [
      ...fill("username"),
      ...click("next"),
      { type: "OBSERVED", result: "continue" },
      ...fill("password"),
      ...click("submit"),
    ]);
    const callback = h.page(rp, "rp-callback", "/callback", "?code=synthetic");
    expect(await ssoAdmit(h.rt, callback.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    h.report.mockClear();
    cancelSso(h.rt, 7, "sso-expired");
    await vi.waitFor(() =>
      expect(h.report).toHaveBeenCalledWith(
        expect.objectContaining({
          ssoChild: true,
          state: "blocked",
          outcome: "left-origin",
          reason: "sso-released",
        }),
      ),
    );
    expect(h.report).not.toHaveBeenCalledWith(
      expect.objectContaining({ ssoChild: true, outcome: "cancelled" }),
    );
  });
});

describe("the RP's pages on the way back", () => {
  it("asks the RP-return judge again on the RP's next document", async () => {
    const h = await harness();
    h.work.phase = "at-idp";
    const learned = structuredClone(h.ssoRecipe);
    learned.revision++;
    learned.sso.layouts[0]!.completion = [{ target: target("learned-marker") }];
    // The RP's callback is judged not signed in; its signed-in page is, and the marker the
    // judge names shows there.
    const judgeSso = vi
      .fn()
      .mockResolvedValueOnce({ signedIn: false })
      .mockImplementationOnce(async () => {
        h.rt.recipes.sso = async () => [learned];
        return { signedIn: true, recipe: learned };
      });
    h.rt.generation = {
      available: async () => true as const,
      generate: vi.fn(),
      generateEntry: vi.fn(),
      slotFields: async () => undefined,
      judge: vi.fn(),
      judgeSso,
    };
    const base = delivery.getMockImplementation()!;
    delivery.mockImplementation(async (tabId, message, options) => {
      const documentId = (options as { documentId?: string } | undefined)?.documentId;
      if (message["type"] === "login.extract")
        return {
          ok: true,
          observation: {
            version: 1,
            origin: rp,
            path: new URL(fake.state.tabUrls[7]!).pathname,
            language: "en",
            complete: true,
            candidates: [
              { id: "marker", role: "button", target: target("learned-marker"), label: "Menu" },
            ],
          },
        };
      if (
        message["type"] === "login.observe" &&
        documentId === "rp-home" &&
        (message["targets"] as { value?: string }[]).some(
          (entry) => entry.value === "learned-marker",
        )
      )
        return { path: "/home", targets: ["unique"] };
      return base(tabId, message, options);
    });
    const callback = h.page(rp, "rp-callback", "/callback", "?code=synthetic");
    expect(await ssoAdmit(h.rt, callback.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    // The same document is not judged twice.
    expect(await ssoAdmit(h.rt, callback.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    expect(judgeSso).toHaveBeenCalledTimes(1);
    const home = h.page(rp, "rp-home", "/home");
    expect(await ssoAdmit(h.rt, home.ctx)).toEqual({ ok: false, reason: "sso-completed" });
    expect(judgeSso).toHaveBeenCalledTimes(2);
    expect(h.work.parent).toMatchObject({
      state: "authenticated",
      recipeRevision: learned.revision,
    });
  });
  it("ends the flow on an RP page that is never a return, also after an IdP that showed none", async () => {
    const h = await harness();
    // The entry was spent and the tab came straight back to an RP page that asks for a
    // permission or creates an account.
    identities.set("rp-signup", "unsafe");
    const signup = h.page(rp, "rp-signup", "/signup");
    expect(await ssoAdmit(h.rt, signup.ctx)).toEqual({
      ok: false,
      reason: "sso-return-unconfirmed",
    });
    expect(h.work.ended).toBe(true);
    expect(h.work.parent?.state).toBe("blocked");
  });
  /** Answers `type` messages to the RP page with `answer`, after the IdP. */
  const answering = async (type: string, answer: (message: Record<string, unknown>) => unknown) => {
    const h = await harness();
    h.work.phase = "at-idp";
    const judgeSso = vi.fn(async () => ({ signedIn: false, rejected: true as const }));
    h.rt.generation = {
      available: async () => true as const,
      generate: vi.fn(),
      generateEntry: vi.fn(),
      slotFields: async () => undefined,
      judge: vi.fn(),
      judgeSso,
    };
    const base = delivery.getMockImplementation()!;
    delivery.mockImplementation(async (tabId, message, options) =>
      message["type"] === type ? answer(message) : base(tabId, message, options),
    );
    return { h, judgeSso, page: h.page(rp, "rp-page", "/callback") };
  };
  const ended = { ok: false, reason: "sso-return-unconfirmed" };
  it("ends the flow on an RP page that asks for an account identifier, unjudged", async () => {
    const { h, judgeSso, page } = await answering("login.observe", (message) => ({
      path: "/callback",
      targets: (message["targets"] as unknown[]).map(() => "missing"),
      ...(message["signIn"] ? { signIn: { loaded: true, password: false, identifier: true } } : {}),
    }));
    expect(await ssoAdmit(h.rt, page.ctx)).toEqual(ended);
    expect(judgeSso).not.toHaveBeenCalled();
    expect(h.work.parent).toMatchObject({ state: "blocked", outcome: "cancelled" });
  });
  it("ends the flow on an RP page that shows the sign-in rejected", async () => {
    const { h, page } = await answering("login.state", () => ({
      ok: true,
      loaded: true,
      signs: { password: false, code: false, captcha: false, invalid: false, alert: true },
    }));
    expect(await ssoAdmit(h.rt, page.ctx)).toEqual(ended);
  });
  it("ends the flow on an RP page the judge reads as a rejected sign-in", async () => {
    const { h, judgeSso, page } = await answering("login.extract", () => ({
      ok: true,
      observation: {
        version: 1,
        origin: rp,
        path: "/callback",
        language: "en",
        complete: true,
        candidates: [{ id: "retry", role: "button", target: target("retry"), label: "Retry" }],
      },
    }));
    expect(await ssoAdmit(h.rt, page.ctx)).toEqual(ended);
    expect(judgeSso).toHaveBeenCalledTimes(1);
  });
  it("waits on an RP page whose identity reading was cancelled", async () => {
    const { h, page } = await answering("login.sso.return", () => ({
      ok: false,
      reason: "cancelled",
    }));
    expect(await ssoAdmit(h.rt, page.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    expect(page.ctx.refuse).toHaveBeenCalledWith("sso-in-progress", "rp-return:unread");
    expect(h.work.ended).toBe(false);
  });
});

describe("an IdP step whose tab has left its document", () => {
  it("stops reading that document after one refusal and asks it to announce its URL", async () => {
    const h = await harness();
    const code = h.page(idp, "idp-code", "/mfa", "?txn=code");
    idpReadings.set("idp-code", { kind: "native" });
    const run = idpChild(h, code.live);
    expect(await ssoAdmit(h.rt, code.ctx)).toBeUndefined();
    step(run, [...fill("username"), ...click("next")]);
    expect(run.metadata.state).toBe("awaiting-result");
    // The page submitted its code and the tab's URL moved on, before any page announced.
    fake.state.tabUrls[7] = idp + "/mfa?txn=next";
    h.report.mockClear();
    delivery.mockClear();
    const started = Date.now();
    await reconcileBounded(h.rt, run);
    // One round, not one every 50 ms until the result's three seconds ran out.
    expect(Date.now() - started).toBeLessThan(1000);
    const refusals = h.report.mock.calls
      .map(([line]) => line as Record<string, unknown>)
      .filter((line) => line["reason"] === "sso-scope-changed");
    expect(refusals).toEqual([expect.not.objectContaining({ repeat: true })]);
    expect(refusals[0]).toMatchObject({ type: "refused", detail: "idp-step" });
    // The document is asked once to announce again, for a URL it changed in place; the
    // tab's next page announces by itself. Nothing else is read there.
    await vi.waitFor(() =>
      expect(
        delivery.mock.calls.filter(([, message]) => message["type"] === "login.reconnect"),
      ).toEqual([
        [
          7,
          expect.objectContaining({ type: "login.reconnect" }),
          expect.objectContaining({ documentId: "idp-code" }),
        ],
      ]),
    );
    expect(delivery.mock.calls.some(([, message]) => message["type"] === "login.observe")).toBe(
      false,
    );
    // The login waits for that page, unchanged.
    expect(run.metadata.state).toBe("awaiting-result");
    expect(h.rt.attempts.get(7)).toBe(run);
    expect(h.work.ended).toBe(false);
  });
});

describe("an IdP page that announces again after its login left it", () => {
  /** The IdP's login, its code submitted, whose tab's URL moved on to `url`. */
  const left = async (url: string) => {
    const h = await harness();
    const code = h.page(idp, "idp-code", "/mfa", "?txn=code");
    idpReadings.set("idp-code", { kind: "unknown", controls: true });
    const run = idpChild(h, code.live);
    expect(await ssoAdmit(h.rt, code.ctx)).toBeUndefined();
    step(run, [...fill("code"), ...click("verify")]);
    fake.state.tabUrls[7] = url;
    /** The document's announcement, as its content script sends it. */
    const announce = (documentId: string, token: string) => {
      h.rt.hellos.set(documentId, 1);
      const sender = {
        id: fake.browser.runtime.id,
        tab: { id: 7, incognito: false },
        frameId: 0,
        documentId,
        origin: idp,
        url,
      };
      return admit(h.rt, sender as never, token, documentId, 1);
    };
    return { h, run, announce };
  };
  it("resumes the login in a new run when the same document changed only its query", async () => {
    const { h, run, announce } = await left(idp + "/mfa?txn=next");
    const base = delivery.getMockImplementation()!;
    const reannounced = Promise.withResolvers<unknown>();
    delivery.mockImplementation(async (tabId, message, options) => {
      if (message["type"] !== "login.reconnect") return base(tabId, message, options);
      reannounced.resolve(await announce("idp-code", "idp-code-token"));
      return { ok: true };
    });
    await reconcileBounded(h.rt, run);
    expect(run.leftDocument).toBe(run.live);
    await reannounced.promise;
    const next = h.rt.attempts.get(7)!;
    expect(next).not.toBe(run);
    expect(next.metadata.id).toBe(run.metadata.id);
    expect(next.live.url).toBe(idp + "/mfa?txn=next");
    expect(next.leftDocument).toBeUndefined();
    expect(await allowed(h.rt, next)).toBeDefined();
  });
  it("resumes the login in a new run on the tab's next IdP document", async () => {
    const { h, run, announce } = await left(idp + "/done?txn=next");
    await reconcileBounded(h.rt, run);
    expect(run.leftDocument).toBe(run.live);
    idpReadings.set("idp-next", { kind: "unknown", controls: true });
    await announce("idp-next", "idp-next-token");
    const next = h.rt.attempts.get(7)!;
    expect(next).not.toBe(run);
    expect(next.metadata.id).toBe(run.metadata.id);
    expect(next.live.document.documentId).toBe("idp-next");
    expect(await allowed(h.rt, next)).toBeDefined();
  });
});

// HCP's broker on flow.idp.hashicorp.com hands the tab back to portal.cloud.hashicorp.com,
// another origin of its site with no recipe of its own (2026-11-20, 14:35:33 UTC).
describe("a return to another origin of the RP's site", () => {
  /** The RP's native recipe, whose login learned its signed-in marker on the portal. */
  const rpNative: LoginRecipe = {
    ...idpRecipe,
    id: "native-rp",
    revision: 2,
    origin: rp,
    handlers: undefined,
    completion: [{ target: target("account-menu"), origin: portal }],
  };
  it("completes on the RP's marker learned on that origin", async () => {
    const h = await harness();
    h.work.phase = "at-idp";
    h.rt.recipes.routes = async (origin: string) => (origin === rp ? [rpNative] : []);
    const base = delivery.getMockImplementation()!;
    delivery.mockImplementation(async (tabId, message, options) => {
      if (
        message["type"] === "login.observe" &&
        (message["targets"] as { value?: string }[]).some((entry) => entry.value === "account-menu")
      )
        return { path: "/home", targets: ["unique"] };
      return base(tabId, message, options);
    });
    const home = h.page(portal, "portal-home", "/home");
    expect(await ssoAdmit(h.rt, home.ctx)).toEqual({ ok: false, reason: "sso-completed" });
    expect(h.work.parent).toMatchObject({ state: "authenticated", account: { origin: rp } });
  });
  // HCP's case of 2026-11-20: the SSO recipe is the broker's, the portal has no recipe of
  // its own and shows neither the selected identity nor a known marker, so only the judge
  // can tell its signed-in page.
  /** The RP-return judge, which reads the portal's page as signed in once it renders. */
  const judging = async (rendered: () => boolean = () => true) => {
    const h = await harness();
    h.work.phase = "at-idp";
    const learned = structuredClone(h.ssoRecipe);
    learned.revision++;
    learned.sso.layouts[0]!.completion = [{ target: target("portal-menu") }];
    const judgeSso = vi.fn(async (): Promise<{ signedIn: boolean; recipe?: typeof learned }> => {
      h.rt.recipes.sso = async () => [learned];
      return { signedIn: true, recipe: learned };
    });
    h.rt.generation = {
      available: async () => true as const,
      generate: vi.fn(),
      generateEntry: vi.fn(),
      slotFields: async () => undefined,
      judge: vi.fn(),
      judgeSso,
    };
    const base = delivery.getMockImplementation()!;
    delivery.mockImplementation(async (tabId, message, options) => {
      if (message["type"] === "login.extract")
        return rendered()
          ? {
              ok: true,
              observation: {
                version: 1,
                origin: portal,
                path: new URL(fake.state.tabUrls[7]!).pathname,
                language: "en",
                complete: true,
                candidates: [
                  { id: "menu", role: "button", target: target("portal-menu"), label: "Account" },
                ],
              },
            }
          : { ok: false, reason: "no-candidates" };
      if (
        rendered() &&
        message["type"] === "login.observe" &&
        (message["targets"] as { value?: string }[]).some((entry) => entry.value === "portal-menu")
      )
        return { path: new URL(fake.state.tabUrls[7]!).pathname, targets: ["unique"] };
      return base(tabId, message, options);
    });
    return { h, judgeSso };
  };
  it("asks the RP-return judge about that origin's page and completes on its answer", async () => {
    const { h, judgeSso } = await judging();
    const home = h.page(portal, "portal-home", "/home");
    expect(await ssoAdmit(h.rt, home.ctx)).toEqual({ ok: false, reason: "sso-completed" });
    expect(judgeSso).toHaveBeenCalledTimes(1);
    expect(judgeSso).toHaveBeenCalledWith(
      h.ssoRecipe.id,
      expect.objectContaining({ observation: expect.objectContaining({ origin: portal }) }),
    );
    expect(h.work.parent).toMatchObject({ state: "authenticated", account: { origin: rp } });
  });
  it("asks the judge again once the same document routed in place to another path", async () => {
    const { h, judgeSso } = await judging();
    judgeSso.mockResolvedValueOnce({ signedIn: false });
    const callback = h.page(portal, "portal-doc", "/callback");
    expect(await ssoAdmit(h.rt, callback.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    expect(await ssoAdmit(h.rt, callback.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    expect(judgeSso).toHaveBeenCalledTimes(1);
    const home = h.page(portal, "portal-doc", "/home");
    expect(await ssoAdmit(h.rt, home.ctx)).toEqual({ ok: false, reason: "sso-completed" });
    expect(judgeSso).toHaveBeenCalledTimes(2);
  });
  it("reads the portal again once it renders its signed-in view in place, at the same URL", async () => {
    let rendered = false;
    const { h, judgeSso } = await judging(() => rendered);
    const home = h.page(portal, "portal-doc", "/home");
    expect(await ssoAdmit(h.rt, home.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    expect(home.ctx.refuse).toHaveBeenCalledWith("sso-in-progress", "rp-return:unobserved");
    expect(judgeSso).not.toHaveBeenCalled();
    expect(delivery).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "login.extract.watch" }),
      expect.objectContaining({ documentId: "portal-doc" }),
    );
    // The page renders its signed-in view; its content script says so, and announces again
    // when asked, as the same document at the same URL.
    rendered = true;
    const sender = {
      id: fake.browser.runtime.id,
      tab: { id: 7, incognito: false },
      frameId: 0,
      documentId: "portal-doc",
      origin: portal,
      url: home.live.url,
    };
    const base = delivery.getMockImplementation()!;
    const reannounced = Promise.withResolvers<unknown>();
    delivery.mockImplementation(async (tabId, message, options) => {
      if (message["type"] !== "login.reconnect") return base(tabId, message, options);
      h.rt.hellos.set("portal-doc", 2);
      reannounced.resolve(await admit(h.rt, sender as never, home.live.token, "portal-doc", 2));
      return { ok: true };
    });
    await dispatch(
      h.rt,
      { version: 1, type: "login.document.described", token: home.live.token },
      sender as never,
    );
    expect(await reannounced.promise).toEqual({ ok: false, reason: "sso-completed" });
    expect(judgeSso).toHaveBeenCalledTimes(1);
    expect(h.work.parent).toMatchObject({ state: "authenticated", account: { origin: rp } });
  });
  it("reads the portal again once it routed in place from its callback to its signed-in page", async () => {
    const h = await harness();
    h.work.phase = "at-idp";
    installSsoLifecycle(h.rt);
    const callback = h.page(portal, "portal-doc", "/callback", "?code=synthetic");
    expect(await ssoAdmit(h.rt, callback.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    expect(callback.ctx.refuse).toHaveBeenCalledWith("sso-in-progress", "rp-return:no-evidence");
    // The portal's own routing changes the URL of the same document, which then shows the
    // selected identity.
    delivery.mockClear();
    identities.set("portal-doc", "match");
    fake.emitUpdated(7, { url: portal + "/home" });
    await vi.waitFor(() =>
      expect(delivery).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ type: "login.reconnect" }),
        expect.objectContaining({ documentId: "portal-doc" }),
      ),
    );
    // The document announces again, as the content script does on that request.
    const home = h.page(portal, "portal-doc", "/home");
    expect(await ssoAdmit(h.rt, home.ctx)).toEqual({ ok: false, reason: "sso-completed" });
    expect(h.work.parent?.state).toBe("authenticated");
  });
  it("asks a page whose URL changed in place since it announced to announce again", async () => {
    const h = await harness();
    h.work.phase = "at-idp";
    const callback = h.page(portal, "portal-doc", "/callback", "?code=synthetic");
    fake.state.tabUrls[7] = portal + "/home";
    delivery.mockClear();
    expect(await ssoAdmit(h.rt, callback.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    expect(callback.ctx.refuse).toHaveBeenCalledWith("sso-in-progress", "rp-return:moved");
    expect(h.work.ended).toBe(false);
    await vi.waitFor(() =>
      expect(delivery).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ type: "login.reconnect" }),
        expect.objectContaining({ documentId: "portal-doc" }),
      ),
    );
  });
  it("reads one announcement of an RP page at a time, completing the flow once", async () => {
    const h = await harness();
    h.work.phase = "at-idp";
    identities.set("portal-doc", "match");
    const first = h.page(portal, "portal-doc", "/home");
    const both = await Promise.all([ssoAdmit(h.rt, first.ctx), ssoAdmit(h.rt, first.ctx)]);
    expect(both).toEqual([
      { ok: false, reason: "sso-completed" },
      { ok: false, reason: "sso-completed" },
    ]);
    const completions = h.report.mock.calls.filter(
      ([line]) =>
        (line as { route?: string; state?: string }).route === "sso" &&
        (line as { state?: string }).state === "authenticated",
    );
    expect(completions).toHaveLength(1);
  });
});
describe("the flow's end on a completion that cannot be recorded", () => {
  it("ends the flow unsigned when the page changes while its sign-in is written", async () => {
    const h = await harness();
    h.work.phase = "at-idp";
    identities.set("rp-home", "match");
    const home = h.page(rp, "rp-home", "/home");
    // The tab shows its next page while the signed-in record is being written.
    let moved = false;
    vi.mocked(h.rt.attemptRecords.write).mockImplementation(async () => {
      if (h.work.parent?.state !== "authenticated" || moved) return;
      moved = true;
      h.page(rp, "rp-next", "/next");
    });
    expect(await ssoAdmit(h.rt, home.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    expect(home.ctx.refuse).toHaveBeenCalledWith("sso-in-progress", "rp-return:incomplete");
    // Nothing is left waiting with its timer cleared: the flow ended, recorded unsigned.
    expect(h.work.ended).toBe(true);
    expect(h.rt.sso.flows.has(7)).toBe(false);
    expect(h.work.parent).toMatchObject({ state: "blocked", outcome: "cancelled" });
    await vi.waitFor(() =>
      expect(h.report).toHaveBeenCalledWith(
        expect.objectContaining({
          route: "sso",
          outcome: "cancelled",
          reason: "sso-scope-changed",
        }),
      ),
    );
    expect(h.report).not.toHaveBeenCalledWith(
      expect.objectContaining({ route: "sso", state: "authenticated" }),
    );
  });
  it("ends the flow signed in even when releasing the IdP's login fails", async () => {
    const h = await harness();
    const form = h.page(idp, "idp-form", "/authsvc", "?txn=1");
    idpReadings.set("idp-form", { kind: "native" });
    const run = idpChild(h, form.live);
    expect(await ssoAdmit(h.rt, form.ctx)).toBeUndefined();
    step(run, [...fill("username"), ...click("next")]);
    identities.set("rp-home", "match");
    const home = h.page(rp, "rp-home", "/home");
    // The write of the IdP's login's end fails.
    vi.mocked(h.rt.attemptRecords.write).mockImplementation(async (records) => {
      if (records.some((record) => record.id === "idp-child" && record.state === "authenticated"))
        throw new Error("Synthetic write failure");
    });
    expect(await ssoAdmit(h.rt, home.ctx)).toEqual({ ok: false, reason: "sso-completed" });
    expect(h.work.ended).toBe(true);
    expect(h.rt.sso.flows.has(7)).toBe(false);
    expect(h.work.parent?.state).toBe("authenticated");
  });
  it("stores the IdP's login released on the RP return, so a restart leaves it no hold", async () => {
    const h = await harness();
    const form = h.page(idp, "idp-form", "/authsvc", "?txn=1");
    idpReadings.set("idp-form", { kind: "native" });
    const run = idpChild(h, form.live);
    expect(await ssoAdmit(h.rt, form.ctx)).toBeUndefined();
    step(run, [...fill("username"), ...click("next")]);
    const callback = h.page(rp, "rp-callback", "/callback");
    expect(await ssoAdmit(h.rt, callback.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    const stored = vi.mocked(h.rt.attemptRecords.write).mock.calls.at(-1)?.[0] ?? [];
    expect(stored.find((record) => record.id === "idp-child")).toMatchObject({
      state: "awaiting-result",
      ssoChild: { released: true },
    });
    // Its end is still logged once with the flow's.
    cancelSso(h.rt, 7, "sso-expired");
    await vi.waitFor(() =>
      expect(h.report).toHaveBeenCalledWith(
        expect.objectContaining({ ssoChild: true, reason: "sso-released" }),
      ),
    );
  });
});
