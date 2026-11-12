import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeSso, ssoPress } from "./sso-effects";
import type { Runtime } from "./state";
import type { SsoWork } from "./sso-state";
const seams = vi.hoisted(() => ({
  send: vi.fn(),
  identify: vi.fn(),
  current: vi.fn(),
  scope: vi.fn(),
  destination: vi.fn(),
  tab: vi.fn(),
}));
vi.mock("wxt/browser", () => ({ browser: { tabs: { get: seams.tab } } }));
vi.mock("./attempt", () => ({ send: seams.send }));
vi.mock("./messages", () => ({ identify: seams.identify }));
vi.mock("./sso-scope", () => ({ ssoCurrent: seams.current, ssoScope: seams.scope }));
vi.mock("./plan", () => ({ accountDestinationRefusal: seams.destination }));
const rp = "https://rp.example.test";
const idp = "https://idp.example.test";
const target = { by: "id" as const, value: "entry" };
const sender = {} as never;
function harness() {
  const document = { origin: rp, tabId: 7, frameId: 0, documentId: "rp-document" };
  const live = {
    document,
    token: "document-token",
    url: rp + "/signin",
    path: "/signin",
    seenAt: 1,
    timing: { since: 1, serviceMs: 0, networkMs: 0, personMs: 0 },
  };
  const work = {
    id: "flow",
    account: { origin: rp, connectionId: "rp-vault", itemId: "rp-item" },
    selected: { origin: idp, account: { connectionId: "idp-vault", itemId: "idp-item" } },
    rpLive: live,
    live,
    used: new Set(),
    deliveryFence: () => true,
    saved: { snapshot: { revision: 3 } },
  } as unknown as SsoWork;
  const write = vi.fn(async () => undefined);
  const rt = { sso: { flows: new Map([[7, work]]), write } } as unknown as Runtime;
  seams.identify.mockResolvedValue(document);
  seams.send.mockImplementation(async (_rt, _live, message) =>
    message.type === "login.sso.prepare"
      ? { ok: true, url: live.url, destinations: [idp + "/signin"], handle: "prepared-handle" }
      : { ok: true },
  );
  seams.tab.mockResolvedValue({ id: 7, url: live.url });
  const authorization = (phase: "pointer" | "click" = "click") => ({
    phase,
    version: 1,
    type: "login.sso.authorize",
    token: live.token,
    flowId: work.id,
    operationId: work.operation!.id,
    handle: work.operation!.handle,
  });
  const intent = () => {
    work.operation = {
      id: "operation",
      handle: "prepared-handle",
      live,
      destinations: [idp + "/signin"],
      stage: "pointer",
    };
  };
  return { rt, work, live, write, authorization, intent };
}
beforeEach(() => {
  for (const seam of Object.values(seams)) seam.mockReset();
  seams.current.mockReturnValue(true);
  seams.scope.mockResolvedValue(true);
  seams.destination.mockResolvedValue(undefined);
});
describe("single-use SSO mutation intents", () => {
  it("persists one intent before committing and does not serialize the prepared authority in a command", async () => {
    const h = harness();
    h.write.mockImplementation(async () => {
      expect(h.work.operation?.stage).toBe("intent");
      expect(seams.send).toHaveBeenCalledTimes(1);
    });
    expect(await ssoPress(h.rt, h.work, h.live, target, "rp-entry")).toBe(true);
    const sent = seams.send.mock.calls.map((call) => call[2]);
    expect(sent).toEqual([
      { type: "login.sso.prepare", flowId: "flow", operationId: expect.any(String), target },
      {
        type: "login.sso.commit",
        flowId: "flow",
        operationId: sent[0].operationId,
        handle: "prepared-handle",
      },
    ]);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(await ssoPress(h.rt, h.work, h.live, target, "rp-entry")).toBe(false);
    expect(seams.send).toHaveBeenCalledTimes(2);
  });
  it("does not commit after an unknown durable intent acknowledgement and never replays it", async () => {
    const h = harness();
    h.write.mockRejectedValue(new Error("unknown write acknowledgement"));
    await expect(ssoPress(h.rt, h.work, h.live, target, "rp-entry")).rejects.toThrow(
      "unknown write acknowledgement",
    );
    expect(seams.send).toHaveBeenCalledTimes(1);
    expect(await ssoPress(h.rt, h.work, h.live, target, "rp-entry")).toBe(false);
  });
  it("withdraws authority if scope changes while intent is persisted", async () => {
    const h = harness();
    h.write.mockImplementation(async () => {
      seams.scope.mockResolvedValue(false);
    });
    expect(await ssoPress(h.rt, h.work, h.live, target, "rp-entry")).toBe(false);
    expect(seams.send).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ok: true, url: rp + "/other", destinations: [], handle: "handle" },
    { ok: true, url: rp + "/signin", destinations: [] },
    { ok: true, url: rp + "/signin", destinations: [], handle: "handle", username: "private" },
    { ok: false, reason: "unsafe-page" },
    undefined,
  ])("refuses malformed or mismatched prepared reply %# before durable intent", async (reply) => {
    const h = harness();
    seams.send.mockResolvedValue(reply);
    expect(await ssoPress(h.rt, h.work, h.live, target, "rp-entry")).toBe(false);
    expect(h.write).not.toHaveBeenCalled();
    expect(seams.send).toHaveBeenCalledTimes(1);
  });
  it.each([
    "https://unexpected.example.test/",
    "http://idp.example.test/",
    "https://user:password@idp.example.test/",
    "javascript:void(0)",
    "not-a-url",
  ])("refuses the unapproved observed destination %s", async (destination) => {
    const h = harness();
    seams.send.mockResolvedValue({
      ok: true,
      url: h.live.url,
      destinations: [destination],
      handle: "handle",
    });
    expect(await ssoPress(h.rt, h.work, h.live, target, "rp-entry")).toBe(false);
    expect(h.write).not.toHaveBeenCalled();
    expect(seams.send).toHaveBeenCalledTimes(1);
  });
  it("retains the RP item's full-URI rule for an RP-local destination", async () => {
    const h = harness();
    seams.send.mockResolvedValue({
      ok: true,
      url: h.live.url,
      destinations: [rp + "/not-permitted"],
      handle: "handle",
    });
    seams.destination.mockResolvedValue("uri-mismatch");
    expect(await ssoPress(h.rt, h.work, h.live, target, "rp-entry")).toBe(false);
    expect(seams.destination).toHaveBeenCalledWith(
      h.rt,
      { origin: rp, account: h.work.account, policyRevision: 3 },
      new URL(rp + "/not-permitted"),
    );
    expect(h.write).not.toHaveBeenCalled();
  });
  it("consumes a content authorization before durable acknowledgement and grants once", async () => {
    const h = harness();
    h.intent();
    h.write.mockImplementation(async () => {
      expect(h.work.operation?.stage).toBe("spent");
    });
    expect(await authorizeSso(h.rt, h.authorization(), sender)).toEqual({ ok: true });
    expect(await authorizeSso(h.rt, h.authorization(), sender)).toEqual({ ok: false });
    expect(h.write).toHaveBeenCalledTimes(1);
  });
  it.each(["token", "flowId", "operationId", "handle"] as const)(
    "refuses mismatched %s before authorization",
    async (field) => {
      const h = harness();
      h.intent();
      expect(await authorizeSso(h.rt, { ...h.authorization(), [field]: "other" }, sender)).toEqual({
        ok: false,
      });
      expect(h.write).not.toHaveBeenCalled();
      expect(h.work.operation?.stage).toBe("pointer");
    },
  );
  it.each(["tabId", "frameId", "documentId", "origin"] as const)(
    "requires the browser-identified %s",
    async (field) => {
      const h = harness();
      h.intent();
      seams.identify.mockResolvedValue({
        ...h.live.document,
        [field]: field.endsWith("Id") && field !== "documentId" ? 99 : "other",
      });
      expect(await authorizeSso(h.rt, h.authorization(), sender)).toEqual({ ok: false });
      expect(h.write).not.toHaveBeenCalled();
    },
  );
  it("does not grant after scope changes while a spent journal is acknowledged", async () => {
    const h = harness();
    h.intent();
    h.write.mockImplementation(async () => {
      seams.scope.mockResolvedValue(false);
    });
    expect(await authorizeSso(h.rt, h.authorization(), sender)).toEqual({ ok: false });
    expect(h.work.operation?.stage).toBe("spent");
    expect(await authorizeSso(h.rt, h.authorization(), sender)).toEqual({ ok: false });
    expect(h.write).toHaveBeenCalledTimes(1);
  });
  it("does not restore a consumed operation after an unknown spent acknowledgement", async () => {
    const h = harness();
    h.intent();
    h.write.mockRejectedValue(new Error("unknown spent acknowledgement"));
    await expect(authorizeSso(h.rt, h.authorization(), sender)).rejects.toThrow(
      "unknown spent acknowledgement",
    );
    expect(h.work.operation?.stage).toBe("spent");
    expect(await authorizeSso(h.rt, h.authorization(), sender)).toEqual({ ok: false });
    expect(h.write).toHaveBeenCalledTimes(1);
  });
  it("grants at most once when duplicate authorization requests overlap asynchronous checks", async () => {
    const h = harness();
    h.intent();
    const result = await Promise.all([
      authorizeSso(h.rt, h.authorization(), sender),
      authorizeSso(h.rt, h.authorization(), sender),
    ]);
    expect(result.filter((reply) => reply.ok)).toHaveLength(1);
    expect(h.write).toHaveBeenCalledTimes(1);
  });
  it("reserves an operation before awaits so overlapping entry presses cannot both commit", async () => {
    const h = harness();
    let preparations = 0;
    let releaseSecond: (() => void) | undefined;
    seams.send.mockImplementation(async (_rt, _live, message) => {
      if (message.type === "login.sso.prepare") {
        preparations++;
        const number = preparations;
        if (number === 2)
          await new Promise<void>((resolve) => {
            releaseSecond = resolve;
          });
        return { ok: true, url: h.live.url, destinations: [], handle: "handle-" + number };
      }
      releaseSecond?.();
      return { ok: true };
    });
    await Promise.all([
      ssoPress(h.rt, h.work, h.live, target, "rp-entry"),
      ssoPress(h.rt, h.work, h.live, target, "rp-entry"),
    ]);
    expect(
      seams.send.mock.calls.filter((call) => call[2].type === "login.sso.commit"),
    ).toHaveLength(1);
    expect(h.write).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])("an unknown commit result is never replayed (spent=%s)", async (spent) => {
    const h = harness();
    seams.send.mockImplementation(async (_rt, _live, message) => {
      if (message.type === "login.sso.prepare")
        return { ok: true, url: h.live.url, destinations: [], handle: "handle" };
      if (spent) h.work.operation!.stage = "spent";
      throw new Error("document closed before acknowledgement");
    });
    seams.tab.mockResolvedValue({ id: 7, url: idp + "/signin" });
    expect(await ssoPress(h.rt, h.work, h.live, target, "rp-entry")).toBe(spent);
    expect(await ssoPress(h.rt, h.work, h.live, target, "rp-entry")).toBe(false);
    expect(seams.send).toHaveBeenCalledTimes(2);
  });
  it("checks the synchronous delivery fence after the durable intent await", async () => {
    const h = harness();
    h.write.mockImplementation(async () => {
      h.work.deliveryFence = () => false;
    });
    expect(await ssoPress(h.rt, h.work, h.live, target, "rp-entry")).toBe(false);
    expect(seams.send).toHaveBeenCalledTimes(1);
  });
  it("checks the synchronous delivery fence after awaited destination validation", async () => {
    const h = harness();
    h.intent();
    h.work.operation!.destinations = [rp + "/submit"];
    seams.destination.mockImplementationOnce(async () => {
      h.work.deliveryFence = () => false;
      return undefined;
    });
    expect(await authorizeSso(h.rt, h.authorization(), sender)).toEqual({ ok: false });
    expect(h.write).not.toHaveBeenCalled();
  });
  it("does not grant if the final asynchronous scope result becomes stale before its continuation", async () => {
    const h = harness();
    h.intent();
    seams.scope.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
      queueMicrotask(() => {
        h.work.deliveryFence = () => false;
      });
      return true;
    });
    expect(await authorizeSso(h.rt, h.authorization(), sender)).toEqual({ ok: false });
    expect(h.work.operation?.stage).toBe("spent");
    expect(await authorizeSso(h.rt, h.authorization(), sender)).toEqual({ ok: false });
  });
  it("requires a pointer grant before a separately durable final click grant", async () => {
    const h = harness();
    h.intent();
    h.work.operation!.stage = "intent";
    expect(await authorizeSso(h.rt, h.authorization("click"), sender)).toEqual({ ok: false });
    expect(h.write).not.toHaveBeenCalled();
    expect(await authorizeSso(h.rt, h.authorization("pointer"), sender)).toEqual({ ok: true });
    expect(h.work.operation?.stage).toBe("pointer");
    expect(await authorizeSso(h.rt, h.authorization("pointer"), sender)).toEqual({ ok: false });
    expect(await authorizeSso(h.rt, h.authorization("click"), sender)).toEqual({ ok: true });
    expect(h.work.operation?.stage).toBe("spent");
    expect(await authorizeSso(h.rt, h.authorization("click"), sender)).toEqual({ ok: false });
    expect(h.write).toHaveBeenCalledTimes(2);
  });
  it.each(["pointer", "click"] as const)(
    "atomically grants the %s phase once under concurrent requests",
    async (phase) => {
      const h = harness();
      h.intent();
      h.work.operation!.stage = phase === "pointer" ? "intent" : "pointer";
      const replies = await Promise.all([
        authorizeSso(h.rt, h.authorization(phase), sender),
        authorizeSso(h.rt, h.authorization(phase), sender),
      ]);
      expect(replies.filter((reply) => reply.ok)).toHaveLength(1);
      expect(h.write).toHaveBeenCalledTimes(1);
    },
  );
  it("withdraws click authority when background scope changed after the pointer grant", async () => {
    const h = harness();
    h.intent();
    h.work.operation!.stage = "intent";
    expect(await authorizeSso(h.rt, h.authorization("pointer"), sender)).toEqual({ ok: true });
    seams.scope.mockResolvedValue(false);
    expect(await authorizeSso(h.rt, h.authorization("click"), sender)).toEqual({ ok: false });
    expect(h.work.operation?.stage).toBe("pointer");
    expect(h.write).toHaveBeenCalledTimes(1);
  });
});

describe("IdP expectation remains a local prepared-content comparison", () => {
  const idpExpectation = { username: "exact.private@example.test", kind: "continue" as const };
  it("passes the exact expectation to selected IdP prepare but keeps it out of the operation journal and commit", async () => {
    const h = harness();
    h.live.document.origin = idp;
    h.live.url = idp + "/signin";
    h.write.mockImplementation(async () => {
      expect(JSON.stringify(h.work.operation)).not.toContain(idpExpectation.username);
      expect(h.work.operation).not.toHaveProperty("idp");
    });
    expect(await ssoPress(h.rt, h.work, h.live, target, "idp-continue", idpExpectation)).toBe(true);
    expect(seams.send.mock.calls[0]![2]).toMatchObject({
      type: "login.sso.prepare",
      idp: idpExpectation,
    });
    expect(seams.send.mock.calls[1]![2]).not.toHaveProperty("idp");
    expect(JSON.stringify(seams.send.mock.calls[1]![2])).not.toContain(idpExpectation.username);
  });
  it.each([rp, "https://unselected.example.test"])(
    "refuses an IdP expectation on nonselected origin %s before any delivery",
    async (origin) => {
      const h = harness();
      h.live.document.origin = origin;
      h.live.url = origin + "/signin";
      expect(await ssoPress(h.rt, h.work, h.live, target, "idp-continue", idpExpectation)).toBe(
        false,
      );
      expect(seams.send).not.toHaveBeenCalled();
      expect(h.write).not.toHaveBeenCalled();
    },
  );
  it("requires an exact bounded identity expectation before preparing any selected IdP operation", async () => {
    const h = harness();
    h.live.document.origin = idp;
    h.live.url = idp + "/signin";
    expect(await ssoPress(h.rt, h.work, h.live, target, "idp-continue")).toBe(false);
    expect(
      await ssoPress(h.rt, h.work, h.live, target, "idp-continue", {
        ...idpExpectation,
        username: "",
      }),
    ).toBe(false);
    expect(seams.send).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });
});
