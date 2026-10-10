import { expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { withLoginExtension, withStoppedLoginWorker } from "./login-fixture";

type ProbeAction =
  | "vectors"
  | "isolation"
  | "lock"
  | "cancel"
  | "cancel-result"
  | "deadline"
  | "status"
  | "release";
type Status = {
  generation: string;
  ready: boolean;
  pending: number;
  dispatched: number;
  sessions: number;
  offscreenDocumentBound: boolean;
  checkpoint: null | "before-dispatch" | "after-result";
  reached: boolean;
};
type ExtensionChrome = {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    connect(options: { name: string }): {
      onDisconnect: { addListener(listener: () => void): void };
    };
    getContexts(
      filter: unknown,
    ): Promise<{ documentId?: string; documentUrl?: string; contextType: string }[]>;
  };
  offscreen: { closeDocument(): Promise<void> };
};

const expectedVectors = {
  authHash: true,
  v1Login: true,
  v2Blob: true,
  organization: true,
  fields: true,
  denied: true,
};

async function send(page: Page, message: unknown): Promise<unknown> {
  return page.evaluate(async (request) => {
    const { chrome } = globalThis as unknown as { chrome: ExtensionChrome };
    return chrome.runtime.sendMessage(request);
  }, message);
}

async function invoke(page: Page, action: ProbeAction): Promise<unknown> {
  return send(page, { type: "crypto.probe", action });
}

async function status(page: Page): Promise<Status> {
  const response = (await invoke(page, "status")) as { ok: boolean; data?: Status };
  expect(response.ok).toBe(true);
  expect(response.data).toBeDefined();
  return response.data!;
}

async function contexts(background: Worker) {
  return background.evaluate(async () => {
    const { chrome } = globalThis as unknown as { chrome: ExtensionChrome };
    return chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  });
}

type Target = { targetId: string; type: string; url: string };
async function observeWorkers(context: BrowserContext, page: Page, extensionId: string) {
  const session = await context.newCDPSession(page);
  const created = new Map<string, Target>();
  const destroyed = new Set<string>();
  const record = ({ targetInfo }: { targetInfo: Target }) => {
    if (
      targetInfo.type === "worker" &&
      targetInfo.url.startsWith(`chrome-extension://${extensionId}/`)
    )
      created.set(targetInfo.targetId, targetInfo);
  };
  const remove = ({ targetId }: { targetId: string }) => {
    destroyed.add(targetId);
  };
  session.on("Target.targetCreated", record);
  session.on("Target.targetInfoChanged", record);
  session.on("Target.targetDestroyed", remove);
  await session.send("Target.setDiscoverTargets", { discover: true });
  return {
    session,
    created,
    destroyed,
    async expectTerminated() {
      await expect.poll(() => created.size, { timeout: 5000 }).toBeGreaterThan(0);
      await expect
        .poll(() => [...created.keys()].every((id) => destroyed.has(id)), { timeout: 5000 })
        .toBe(true);
    },
    async dispose() {
      session.off("Target.targetCreated", record);
      session.off("Target.targetInfoChanged", record);
      session.off("Target.targetDestroyed", remove);
      await session.detach();
    },
  };
}

async function controller(context: BrowserContext, extensionId: string) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/crypto-probe.html`);
  return page;
}

function prohibitExternalRequests(context: BrowserContext) {
  const external: string[] = [];
  context.on("request", (request) => {
    if (/^https?:/u.test(request.url())) external.push(request.url());
  });
  return external;
}

test("actual offscreen sender binds its browser document and real native sessions resolve only granted fields", async () => {
  await withLoginExtension(async (context, background, extensionId) => {
    const external = prohibitExternalRequests(context);
    const page = await controller(context, extensionId);
    const observed = await observeWorkers(context, page, extensionId);
    try {
      expect(await contexts(background)).toEqual([]);
      expect(await invoke(page, "vectors")).toEqual({ ok: true, data: expectedVectors });
      const active = await contexts(background);
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({
        contextType: "OFFSCREEN_DOCUMENT",
        documentUrl: `chrome-extension://${extensionId}/crypto-offscreen.html`,
      });
      expect(active[0]!.documentId).toMatch(/^[0-9a-f-]{36}$/iu);
      expect(await status(page)).toMatchObject({
        ready: true,
        pending: 0,
        dispatched: 0,
        sessions: 0,
        offscreenDocumentBound: true,
        checkpoint: null,
        reached: false,
      });
      await observed.expectTerminated();
      expect(external).toEqual([]);
    } finally {
      await observed.dispose();
    }
  });
});

test("a same-extension options page cannot impersonate the background or invoke native operations", async () => {
  await withLoginExtension(async (context, background, extensionId) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const reply = await send(page, {
      type: "crypto.probe",
      action: "vectors",
      role: "background",
      sender: { id: extensionId, url: `chrome-extension://${extensionId}/crypto-probe.html` },
    });
    expect((reply as { ok?: boolean } | undefined)?.ok).not.toBe(true);
    const disconnected = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const { chrome } = globalThis as unknown as { chrome: ExtensionChrome };
          const port = chrome.runtime.connect({ name: "pateat.crypto-host.v1" });
          const timer = setTimeout(() => resolve(false), 2000);
          port.onDisconnect.addListener(() => {
            clearTimeout(timer);
            resolve(true);
          });
        }),
    );
    expect(disconnected).toBe(true);
    expect(await contexts(background)).toEqual([]);
    const trusted = await controller(context, extensionId);
    expect(await status(trusted)).toMatchObject({
      ready: false,
      pending: 0,
      sessions: 0,
      offscreenDocumentBound: false,
    });
  });
});

for (const action of ["isolation", "lock"] as const) {
  test(`native sessions reject ${action === "isolation" ? "cross-connection references" : "access after lock"}`, async () => {
    await withLoginExtension(async (context, _background, extensionId) => {
      const external = prohibitExternalRequests(context);
      const page = await controller(context, extensionId);
      const observed = await observeWorkers(context, page, extensionId);
      try {
        expect(await invoke(page, action)).toEqual({ ok: true, data: { rejected: true } });
        await observed.expectTerminated();
        expect(await status(page)).toMatchObject({ pending: 0, sessions: 0 });
        expect(external).toEqual([]);
      } finally {
        await observed.dispose();
      }
    });
  });
}

for (const action of ["cancel", "deadline"] as const) {
  test(`native KDF ${action} terminates the dispatched Worker and permits fresh known-answer work`, async () => {
    await withLoginExtension(async (context, _background, extensionId) => {
      const external = prohibitExternalRequests(context);
      const page = await controller(context, extensionId);
      const observed = await observeWorkers(context, page, extensionId);
      try {
        expect(await invoke(page, action)).toEqual({ ok: true, data: { withheld: true } });
        // The warmup and expensive dispatched job must both have existed and died.
        await expect.poll(() => observed.created.size, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
        await observed.expectTerminated();
        const previous = new Set(observed.created.keys());
        expect(await invoke(page, "vectors")).toEqual({ ok: true, data: expectedVectors });
        expect([...observed.created.keys()].some((id) => !previous.has(id))).toBe(true);
        await observed.expectTerminated();
        expect(await status(page)).toMatchObject({ pending: 0, sessions: 0 });
        expect(external).toEqual([]);
      } finally {
        await observed.dispose();
      }
    });
  });
}

test("closing the offscreen document invalidates its host binding and recreates a fresh real SDK host", async () => {
  await withLoginExtension(async (context, background, extensionId) => {
    const external = prohibitExternalRequests(context);
    const page = await controller(context, extensionId);
    expect(await invoke(page, "vectors")).toEqual({ ok: true, data: expectedVectors });
    const old = (await contexts(background))[0]!;
    await background.evaluate(async () => {
      const { chrome } = globalThis as unknown as { chrome: ExtensionChrome };
      await chrome.offscreen.closeDocument();
    });
    await expect
      .poll(() => status(page), { timeout: 5000 })
      .toMatchObject({ ready: false, pending: 0, sessions: 0, offscreenDocumentBound: false });
    expect(await invoke(page, "vectors")).toEqual({ ok: true, data: expectedVectors });
    const current = (await contexts(background))[0]!;
    expect(current.documentId).not.toBe(old.documentId);
    expect(external).toEqual([]);
  });
});

test("cancelling a completed field result terminates its retained native session Worker", async () => {
  await withLoginExtension(async (context, _background, extensionId) => {
    const external = prohibitExternalRequests(context);
    const page = await controller(context, extensionId);
    const observed = await observeWorkers(context, page, extensionId);
    try {
      expect(await invoke(page, "cancel-result")).toEqual({
        ok: true,
        data: { withheld: true, locked: true },
      });
      await observed.expectTerminated();
      expect(await status(page)).toMatchObject({ pending: 0, sessions: 0, checkpoint: null });
      expect(await invoke(page, "vectors")).toEqual({ ok: true, data: expectedVectors });
      await observed.expectTerminated();
      expect(external).toEqual([]);
    } finally {
      await observed.dispose();
    }
  });
});

test("service-worker restart destroys the held native session and replaces the old offscreen generation", async () => {
  await withLoginExtension(async (context, background, extensionId) => {
    const external = prohibitExternalRequests(context);
    const page = await controller(context, extensionId);
    const observed = await observeWorkers(context, page, extensionId);
    try {
      expect(
        await send(page, { type: "crypto.probe", action: "arm", checkpoint: "after-result" }),
      ).toEqual({ ok: true, data: { armed: true } });
      await page.evaluate(() => {
        const state = globalThis as unknown as {
          chrome: ExtensionChrome;
          pateatOldHostReply?: { state: string; reply?: unknown };
        };
        state.pateatOldHostReply = { state: "pending" };
        // Unlike the vector action's completed authentication hash, lock first
        // opens a V1 native session. Hold that open reply while its keys remain live.
        void state.chrome.runtime.sendMessage({ type: "crypto.probe", action: "lock" }).then(
          (reply) => {
            return (state.pateatOldHostReply = { state: "settled", reply });
          },
          () => {
            return (state.pateatOldHostReply = { state: "closed" });
          },
        );
      });
      await expect
        .poll(() => status(page), { timeout: 10_000 })
        .toMatchObject({
          pending: 1,
          checkpoint: "after-result",
          reached: true,
          ready: true,
          offscreenDocumentBound: true,
        });
      const oldGeneration = (await status(page)).generation;
      const oldDocument = (await contexts(background))[0]!.documentId;
      await expect.poll(() => observed.created.size, { timeout: 5000 }).toBeGreaterThan(0);
      const retained = [...observed.created.keys()].filter((id) => !observed.destroyed.has(id));
      expect(retained.length).toBeGreaterThan(0);
      await withStoppedLoginWorker(context, background, page, async (expectRestarted) => {
        const current = await status(page); // This trusted fixed probe wakes the new service worker.
        await expectRestarted();
        expect(current.generation).not.toBe(oldGeneration);
        expect(current).toMatchObject({
          ready: false,
          pending: 0,
          sessions: 0,
          offscreenDocumentBound: false,
          checkpoint: null,
          reached: false,
        });
        await expect
          .poll(() => retained.every((id) => observed.destroyed.has(id)), { timeout: 5000 })
          .toBe(true);
        expect(await invoke(page, "vectors")).toEqual({ ok: true, data: expectedVectors });
        expect((await contexts(background))[0]!.documentId).not.toBe(oldDocument);
      });
      // Require completion/closed-channel evidence for the original request, rather
      // than a transient empty result before asynchronous reconciliation finishes.
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                (globalThis as unknown as { pateatOldHostReply?: { state: string } })
                  .pateatOldHostReply?.state,
            ),
          { timeout: 5000 },
        )
        .not.toBe("pending");
      const previous = await page.evaluate(
        () =>
          (
            globalThis as unknown as {
              pateatOldHostReply?: { state: string; reply?: { ok?: boolean } };
            }
          ).pateatOldHostReply,
      );
      expect(previous?.reply?.ok).not.toBe(true);
      expect(await status(page)).toMatchObject({ pending: 0, sessions: 0, checkpoint: null });
      await observed.expectTerminated();
      expect(external).toEqual([]);
    } finally {
      await observed.dispose();
    }
  });
});
