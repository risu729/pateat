// An SSO flow's IdP login whose email step advanced to its password step, as login.ibm.com
// did in the owner's Chrome on 2026-11-21 (10:21 UTC): the password fill was logged at
// 10:21:08 and refused `cancelled` (`not-authorized`) at 10:21:24, while a direct login of
// the same recipe at 10:33 filled it. Each of the hop's scope checks reads the flow's SSO
// mapping from the vault again, so the checks and the password read before the fill's
// delivery, with the page's own authorization, took longer than the operation's 15 seconds.
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
const { drive } = await import("../runtime/run-steps");
const { allowed } = await import("../runtime/plan-2");
const { handle: dispatch } = await import("../runtime/messages");
const { ssoReturnFixture } = await import("./sso-return-fixture");
const { idp, delivery, idpReadings, harness, idpChild, step, click, fill } = ssoReturnFixture(
  fake,
  io,
);

describe("an SSO flow's IdP login on its password step after its email step", () => {
  it("has its password fill authorized although its scope checks take most of 15 seconds", async () => {
    const h = await harness();
    const form = h.page(idp, "idp-form", "/authsvc", "?PolicyId=synthetic");
    idpReadings.set("idp-form", { kind: "native" });
    const run = idpChild(h, form.live);
    expect(await ssoAdmit(h.rt, form.ctx)).toBeUndefined();
    // The email step went in and its Continue showed the password step in place.
    step(run, [...fill("username"), ...click("next"), { type: "OBSERVED", result: "continue" }]);
    expect(run.metadata).toMatchObject({ state: "ready", stepIndex: 2 });
    // Each policy check of the hop reads the flow's mapping from the vault, for both its
    // scope checks: 5 seconds each here.
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    const validate = vi.mocked(h.rt.options.sso!.validate);
    const mapped = await validate.getMockImplementation()!(undefined as never, undefined as never);
    validate.mockImplementation(async () => {
      offset += 5000;
      return mapped;
    });
    // And each vault read of the step's values takes 5 seconds.
    vi.mocked(h.rt.fields).mockImplementation(async () => {
      offset += 5000;
      return "Synthetic value";
    });
    // The page asks for each operation's authorization as it starts it, as the content
    // script does, and answers with its result.
    const answers: { kind: string; authorized: unknown; reads: number }[] = [];
    const sender = {
      id: fake.browser.runtime.id,
      tab: { id: 7, incognito: false, url: form.live.url },
      frameId: 0,
      documentId: "idp-form",
      origin: idp,
      url: form.live.url,
    } as never;
    const base = delivery.getMockImplementation()!;
    delivery.mockImplementation(async (tabId, message, options) => {
      if (message["type"] !== "login.execute") return base(tabId, message, options);
      const operation = message["operation"] as {
        attemptId: string;
        operationId: string;
        document: { documentId: string };
        step: { kind: string };
      };
      const read = validate.mock.calls.length;
      const authorized = await dispatch(
        h.rt,
        {
          version: 1,
          type: "login.operation.authorize",
          token: message["token"],
          attemptId: operation.attemptId,
          operationId: operation.operationId,
        },
        sender,
      );
      answers.push({
        kind: operation.step.kind,
        authorized,
        reads: validate.mock.calls.length - read,
      });
      // Only the password fill is followed here: its submit click is left for the page.
      if (operation.step.kind === "click") clock.mockRestore();
      return authorized === true
        ? {
            ok: true,
            operationId: operation.operationId,
            documentId: operation.document.documentId,
            mutation: "possible",
          }
        : {
            ok: false,
            reason: "cancelled",
            detail: "not-authorized",
            mutation: "none",
            operationId: operation.operationId,
            documentId: operation.document.documentId,
          };
    });
    try {
      await drive(h.rt, run);
    } finally {
      clock.mockRestore();
    }
    // The password fill ran more than 15 seconds after it was built, and was authorized.
    // Each authorization read the flow's mapping once.
    expect(answers[0]).toEqual({ kind: "fill", authorized: true, reads: 1 });
    expect(answers.every((answer) => answer.authorized === true && answer.reads === 1)).toBe(true);
    expect(run.metadata.outcome).not.toBe("cancelled");
    expect(h.report).not.toHaveBeenCalledWith(
      expect.objectContaining({ ssoChild: true, outcome: "cancelled" }),
    );
  });
  it("reads the flow's mapping once per policy check, and again at the next one", async () => {
    const h = await harness();
    const form = h.page(idp, "idp-form", "/authsvc", "?PolicyId=synthetic");
    idpReadings.set("idp-form", { kind: "native" });
    const run = idpChild(h, form.live);
    expect(await ssoAdmit(h.rt, form.ctx)).toBeUndefined();
    step(run, [...fill("username"), ...click("next"), { type: "OBSERVED", result: "continue" }]);
    const validate = vi.mocked(h.rt.options.sso!.validate);
    validate.mockClear();
    // One check of the hop's step checks its flow's scope twice, with one vault read.
    expect(await allowed(h.rt, run)).toBeDefined();
    expect(validate).toHaveBeenCalledTimes(1);
    expect(await allowed(h.rt, run)).toBeDefined();
    expect(validate).toHaveBeenCalledTimes(2);
    // A vault that no longer maps the method stops the next check.
    validate.mockResolvedValueOnce({ ok: false, reason: "scope-changed" } as never);
    expect(await allowed(h.rt, run)).toBeUndefined();
    expect(validate).toHaveBeenCalledTimes(3);
  });
});
