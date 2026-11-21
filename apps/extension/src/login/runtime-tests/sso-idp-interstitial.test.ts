// An SSO flow through IBMid in the owner's Chrome on 2026-11-21 (build `c2e54686`): after the
// IdP's own login submitted its password, the IdP's risk check
// (`/risk/v3.0/authz/pages/compute`), a page that posts itself on at once, was refused
// `sso-username-unavailable` at 19:26:54 and ended the flow, so its method chooser and TOTP
// page were never read. The tab had moved on to the chooser while the risk page's admission
// read the account's username from the vault.
import { describe, expect, it, vi } from "vitest";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
const io = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  getItems: vi.fn(),
  setItems: vi.fn(),
}));
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.mock("wxt/utils/storage", () => ({ storage: io }));
const { ssoAdmit } = await import("../runtime/sso/flow");
const { allowed } = await import("../runtime/plan-2");
const { ssoReturnFixture } = await import("./sso-return-fixture");
const { rp, idp, idpReadings, identities, harness, idpChild, step, click, fill } = ssoReturnFixture(
  fake,
  io,
);

/** The IdP's own login, its password submitted on its sign-in form. */
async function submitted() {
  const h = await harness();
  const form = h.page(idp, "idp-form", "/authsvc", "?PolicyId=password");
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
  /** The tab's next IdP page, admitted with the IdP's own login. */
  const next = async (documentId: string, path: string, reading: Record<string, unknown>) => {
    idpReadings.set(documentId, reading);
    const shown = h.page(idp, documentId, path, "?PolicyId=" + documentId);
    expect(await ssoAdmit(h.rt, shown.ctx)).toBeUndefined();
    expect(shown.ctx.refuse).not.toHaveBeenCalled();
    run.live = shown.live;
    step(run, [{ type: "NAVIGATED", document: shown.live.document }]);
    expect(await allowed(h.rt, run)).toBeDefined();
    return shown;
  };
  return { h, run, next };
}

describe("an IdP page that posts itself on while it is read", () => {
  for (const moment of ["username", "reading"] as const)
    it(
      "ends nothing, and the method chooser and TOTP page after it are read (tab left at its " +
        moment +
        ")",
      async () => {
        const { h, run, next } = await submitted();
        // The risk check, which posts itself on to the method chooser while it is read.
        idpReadings.set("idp-risk", { kind: "unknown", controls: false });
        const risk = h.page(idp, "idp-risk", "/risk/v3.0/authz/pages/compute", "?txn=1");
        const chooserUrl = idp + "/mfa?PolicyId=macotp";
        const leave = () => {
          fake.state.tabUrls[7] = chooserUrl;
        };
        if (moment === "username")
          vi.mocked(h.rt.fields).mockImplementationOnce(async () => {
            leave();
            return "Synthetic value";
          });
        else {
          const reading = idpReadings.get("idp-risk")!;
          idpReadings.set("idp-risk", {
            get kind() {
              leave();
              return reading["kind"];
            },
            controls: false,
          });
        }
        expect(await ssoAdmit(h.rt, risk.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
        expect(risk.ctx.refuse).toHaveBeenCalledWith("sso-in-progress", "idp:left");
        expect(h.work.ended).toBe(false);
        expect(h.report).not.toHaveBeenCalledWith(
          expect.objectContaining({ reason: "sso-username-unavailable" }),
        );
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
        // The RP's signed-in page completes the flow.
        identities.set("rp-home", "match");
        const home = h.page(rp, "rp-home", "/home");
        expect(await ssoAdmit(h.rt, home.ctx)).toEqual({ ok: false, reason: "sso-completed" });
        expect(h.work.parent).toMatchObject({ state: "authenticated" });
      },
    );
  it("reads the flow's mapping once while it admits an IdP page", async () => {
    const { h } = await submitted();
    const validate = vi.mocked(h.rt.options.sso!.validate);
    validate.mockClear();
    idpReadings.set("idp-risk", { kind: "unknown", controls: false });
    const risk = h.page(idp, "idp-risk", "/risk/v3.0/authz/pages/compute", "?txn=1");
    expect(await ssoAdmit(h.rt, risk.ctx)).toBeUndefined();
    expect(validate).toHaveBeenCalledTimes(1);
  });
});
