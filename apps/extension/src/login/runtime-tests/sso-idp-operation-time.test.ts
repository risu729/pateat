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

/** The IdP's own login, its email step done, ready to fill its password on its page. */
async function atPasswordStep() {
  const h = await harness();
  const form = h.page(idp, "idp-form", "/authsvc", "?PolicyId=synthetic");
  idpReadings.set("idp-form", { kind: "native" });
  const run = idpChild(h, form.live);
  expect(await ssoAdmit(h.rt, form.ctx)).toBeUndefined();
  // The email step went in and its Continue showed the password step in place.
  step(run, [...fill("username"), ...click("next"), { type: "OBSERVED", result: "continue" }]);
  expect(run.metadata).toMatchObject({ state: "ready", stepIndex: 2 });
  return { h, form, run };
}
type Delivered = {
  attemptId: string;
  operationId: string;
  expiresAt: number;
  document: { documentId: string };
  step: { kind: string };
};
/**
 * The page asks for each operation's authorization as it starts it, as the content script
 * does, after `before`, and answers with its result.
 */
function answerSteps(
  { h, form, run }: Awaited<ReturnType<typeof atPasswordStep>>,
  before: (operation: Delivered) => void = () => undefined,
) {
  const validate = vi.mocked(h.rt.options.sso!.validate);
  const answers: { kind: string; authorized: unknown; reads: number; kept: boolean }[] = [];
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
    const operation = message["operation"] as Delivered;
    // The login keeps the operation it delivered as the one the page's checks validate.
    const kept = run.operation === operation;
    before(operation);
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
      kept,
    });
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
  return answers;
}

describe("an SSO flow's IdP login on its password step after its email step", () => {
  it("has its password fill authorized although its scope checks take most of 15 seconds", async () => {
    const at = await atPasswordStep();
    const { h, run } = at;
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
    const answers = answerSteps(at);
    try {
      await drive(h.rt, run);
    } finally {
      clock.mockRestore();
    }
    // The password fill ran more than 15 seconds after it was built, and was authorized.
    // Each authorization read the flow's mapping once.
    expect(answers[0]).toEqual({ kind: "fill", authorized: true, reads: 1, kept: true });
    expect(
      answers.every((answer) => answer.authorized === true && answer.reads === 1 && answer.kept),
    ).toBe(true);
    expect(run.metadata.outcome).not.toBe("cancelled");
    expect(h.report).not.toHaveBeenCalledWith(
      expect.objectContaining({ ssoChild: true, outcome: "cancelled" }),
    );
  });
  it("has its delivered fill refused once 15 seconds passed since its delivery", async () => {
    const at = await atPasswordStep();
    const { h, run } = at;
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    let delivered: number | undefined;
    // The page asks for the fill's authorization 15,001 ms after it was delivered.
    const answers = answerSteps(at, (operation) => {
      delivered = Date.now();
      expect(operation.expiresAt).toBeGreaterThan(delivered);
      expect(operation.expiresAt).toBeLessThanOrEqual(delivered + 15_000);
      offset += 15_001;
    });
    try {
      await drive(h.rt, run);
    } finally {
      clock.mockRestore();
    }
    expect(delivered).toBeDefined();
    expect(answers).toEqual([{ kind: "fill", authorized: false, reads: 1, kept: true }]);
    expect(run.metadata).toMatchObject({ state: "blocked", outcome: "cancelled" });
  });
  it("reads the flow's mapping once per policy check, and again at the next one", async () => {
    const { h, run } = await atPasswordStep();
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
  it("reads the mapping again when a choice-only save lands between the scope checks", async () => {
    const { h, run } = await atPasswordStep();
    const validate = vi.mocked(h.rt.options.sso!.validate);
    const mapped = await validate.getMockImplementation()!(undefined as never, undefined as never);
    if (!mapped.ok) throw new Error("The synthetic mapping is refused");
    const settings = vi.mocked(h.rt.settings.handle);
    const before = await settings.getMockImplementation()!({ version: 1, type: "settings.get" });
    if (!before.ok) throw new Error("The synthetic settings are unavailable");
    // Another tab saves a choice of SSO method once the first scope check read the mapping:
    // a revision that writes only a choice stops nothing running (`CHOICE_ONLY_CAUSES`).
    const saved = {
      ...before,
      snapshot: {
        ...before.snapshot,
        revision: 4,
        changes: [{ revision: 4, cause: "sso-mapping" as const }],
      },
    };
    validate.mockClear();
    validate.mockImplementationOnce(async () => {
      settings.mockImplementation(async () => structuredClone(saved));
      validate.mockImplementation(async () => ({
        ...mapped,
        data: { ...mapped.data, policyRevision: 4 },
      }));
      return mapped;
    });
    expect(await allowed(h.rt, run)).toBeDefined();
    // The second scope check read the mapping again, under the newer settings.
    expect(validate).toHaveBeenCalledTimes(2);
  });
});
