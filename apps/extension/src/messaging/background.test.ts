import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundAreas } from "./background";
import type { BackgroundProtocol } from "./protocol";

const fake = vi.hoisted(() => {
  type Listener = (
    message: unknown,
    sender: unknown,
    respond: (response: unknown) => void,
  ) => boolean | undefined;
  const listeners = new Set<Listener>();
  const state = { sender: {} as object };
  const runtime = {
    id: "synthetic-extension",
    getURL: (path: string) => `chrome-extension://synthetic-extension${path}`,
    lastError: undefined as { message: string } | undefined,
    onMessage: {
      addListener: (listener: Listener) => void listeners.add(listener),
      removeListener: (listener: Listener) => void listeners.delete(listener),
    },
    /**
     * Chrome's delivery: a copy of the message and of the browser-supplied sender to each
     * listener; when none keeps the channel open or answers, the port closes with an error.
     */
    sendMessage(message: unknown, callback: (response: unknown) => void) {
      let answered = false;
      let open = false;
      const respond = (response: unknown) => {
        if (answered) return;
        answered = true;
        callback(structuredClone(response));
      };
      for (const listener of listeners)
        if (listener(structuredClone(message), structuredClone(state.sender), respond) === true)
          open = true;
      if (open || answered) return;
      runtime.lastError = { message: "The message port closed before a response was received." };
      callback(undefined);
      runtime.lastError = undefined;
    },
  };
  // The library calls the `chrome` global, not `wxt/browser`.
  Object.assign(globalThis, { chrome: { runtime } });
  return { listeners, state, runtime };
});
vi.mock("wxt/browser", () => ({ browser: { runtime: fake.runtime } }));

const extension = "chrome-extension://synthetic-extension";
const page = (path: string) => ({ id: "synthetic-extension", url: `${extension}${path}` });
const options = page("/options.html");
const popup = page("/popup.html");
const diagnosticsPage = page("/diagnostics.html");
const chooserPage = page("/passkey-picker.html?request=synthetic");
const probePage = page("/crypto-probe.html");
const content = {
  id: "synthetic-extension",
  url: "https://login.example.com/sign-in",
  origin: "https://login.example.com",
  tab: { id: 7, active: true },
  frameId: 0,
  documentId: "document-a",
};
const otherExtension = {
  id: "other-extension",
  url: "chrome-extension://other-extension/options.html",
};

function createAreas() {
  return {
    settings: vi.fn(async (request: unknown) => ({ area: "settings", request })),
    siteAccounts: vi.fn(async (request: unknown) => ({ area: "site-accounts", request })),
    transfer: vi.fn(async (request: unknown) => ({ area: "transfer", request })),
    service: vi.fn(async (request: unknown) => ({ area: "service", request })),
    diagnostics: vi.fn(async (request: unknown) => ({ area: "diagnostics", request })),
    chooser: vi.fn((request: unknown) => Promise.resolve({ area: "chooser", request })),
    login: vi.fn(async (request: unknown, sender: unknown) => ({ area: "login", request, sender })),
    passkeyCreate: vi.fn(async (request: unknown) => ({ area: "passkey-create", request })),
    passkeys: vi.fn(async (request: unknown, sender: unknown) => ({
      area: "passkeys",
      request,
      sender,
    })),
    setupProbe: vi.fn(async (request: unknown) => ({ area: "setup-probe", request })),
    vaultProbe: vi.fn(async (request: unknown) => ({ area: "vault-probe", request })),
    cryptoProbe: vi.fn(async (request: unknown) => ({ area: "crypto-probe", request })),
    passkeyProbe: vi.fn((request: unknown) => ({ area: "passkey-probe", request })),
    failed: vi.fn(),
  } satisfies BackgroundAreas;
}

/** A fresh worker: the library keeps one listener per area in each JS context. */
async function start(mode: "production" | "probe") {
  fake.listeners.clear();
  vi.resetModules();
  vi.stubEnv("MODE", mode);
  const { listenForBackgroundMessages } = await import("./background");
  const { sendMessage } = await import("./protocol");
  const areas = createAreas();
  listenForBackgroundMessages(areas);
  const send = (sender: object, area: keyof BackgroundProtocol, request?: unknown) => {
    fake.state.sender = { ...sender };
    return sendMessage(area, request);
  };
  return { areas, send };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("background messages", () => {
  let worker: Awaited<ReturnType<typeof start>>;
  beforeEach(async () => {
    worker = await start("production");
  });

  it("answers settings from the settings page and the popup only", async () => {
    const get = { version: 1, type: "settings.get" };
    expect(await worker.send(options, "settings", get)).toEqual({ area: "settings", request: get });
    expect(await worker.send(popup, "settings", get)).toEqual({ area: "settings", request: get });
    // Reloaded after a section link: Chrome reports the URL with the fragment it loaded with.
    expect(await worker.send(page("/options.html#sync"), "settings", get)).toEqual({
      area: "settings",
      request: get,
    });
    for (const sender of [
      diagnosticsPage,
      chooserPage,
      content,
      otherExtension,
      page("/options.html?view=other"),
    ])
      // oxlint-disable-next-line no-await-in-loop
      expect(await worker.send(sender, "settings", get)).toBeUndefined();
    expect(worker.areas.settings).toHaveBeenCalledTimes(3);
  });

  it("routes settings requests by their own type", async () => {
    const accounts = { version: 1, type: "settings.site-accounts", origin: "https://a.test" };
    expect(await worker.send(popup, "settings", accounts)).toEqual({
      area: "site-accounts",
      request: accounts,
    });
    const save = { version: 1, type: "settings.save" };
    await worker.send(options, "settings", save);
    expect(worker.areas.settings).toHaveBeenCalledWith(save);
    // Another area's request under this key is not answered.
    expect(
      await worker.send(options, "settings", { version: 1, type: "service.get" }),
    ).toBeUndefined();
    expect(await worker.send(options, "settings", "settings.get")).toBeUndefined();
    expect(worker.areas.service).not.toHaveBeenCalled();
  });

  it("answers export and import from the settings page only", async () => {
    for (const type of ["settings.export", "settings.import"]) {
      const request = { version: 1, type };
      // oxlint-disable-next-line no-await-in-loop
      expect(await worker.send(page("/options.html#transfer"), "settings", request)).toEqual({
        area: "transfer",
        request,
      });
      for (const sender of [popup, diagnosticsPage, chooserPage, content, otherExtension])
        // oxlint-disable-next-line no-await-in-loop
        expect(await worker.send(sender, "settings", request)).toBeUndefined();
    }
    expect(worker.areas.transfer).toHaveBeenCalledTimes(2);
    expect(worker.areas.settings).not.toHaveBeenCalled();
  });

  it("answers service requests from the settings page only", async () => {
    const pair = { version: 1, type: "service.pair" };
    expect(await worker.send(options, "service", pair)).toEqual({ area: "service", request: pair });
    expect(await worker.send(page("/options.html#sync"), "service", pair)).toEqual({
      area: "service",
      request: pair,
    });
    for (const sender of [popup, diagnosticsPage, content, otherExtension])
      // oxlint-disable-next-line no-await-in-loop
      expect(await worker.send(sender, "service", pair)).toBeUndefined();
    expect(
      await worker.send(options, "service", { version: 1, type: "settings.get" }),
    ).toBeUndefined();
    expect(worker.areas.service).toHaveBeenCalledTimes(2);
  });

  it("answers valid diagnostics requests from the diagnostics page only", async () => {
    const status = { version: 1, type: "diagnostics.status" };
    expect(await worker.send(diagnosticsPage, "diagnostics", status)).toEqual({
      area: "diagnostics",
      request: status,
    });
    for (const sender of [options, popup, content, otherExtension])
      // oxlint-disable-next-line no-await-in-loop
      expect(await worker.send(sender, "diagnostics", status)).toBeUndefined();
    expect(
      await worker.send(diagnosticsPage, "diagnostics", { ...status, extra: true }),
    ).toBeUndefined();
    expect(worker.areas.diagnostics).toHaveBeenCalledTimes(1);
  });

  it("hands this extension's chooser requests to the chooser, which checks the page", async () => {
    const load = { version: 1, type: "passkey-chooser.load", request: "synthetic" };
    expect(await worker.send(chooserPage, "passkey-chooser", load)).toEqual({
      area: "chooser",
      request: load,
    });
    expect(worker.areas.chooser).toHaveBeenCalledWith(load, chooserPage);
    expect(await worker.send(otherExtension, "passkey-chooser", load)).toBeUndefined();
    expect(worker.areas.chooser).toHaveBeenCalledTimes(1);
    // The chooser window reaches nothing else.
    expect(
      await worker.send(chooserPage, "passkey", { version: 1, type: "passkey.get" }),
    ).toBeUndefined();
    expect(
      await worker.send(chooserPage, "login", { version: 1, type: "login.choice.get" }),
    ).toBeUndefined();
    expect(worker.areas.passkeys).not.toHaveBeenCalled();
    expect(worker.areas.login).not.toHaveBeenCalled();
  });

  it("gives login and passkey handlers the browser's sender, not the message's", async () => {
    const ready = { version: 1, type: "login.document.ready", token: "t", sender: options };
    expect(await worker.send(content, "login", ready)).toEqual({
      area: "login",
      request: ready,
      sender: content,
    });
    // Nor one the wire message names beside its data.
    fake.state.sender = { ...content };
    const forged = await new Promise((resolve) =>
      fake.runtime.sendMessage(
        { id: 1, type: "login", data: ready, timestamp: Date.now(), sender: options },
        resolve,
      ),
    );
    expect(forged).toEqual({ res: { area: "login", request: ready, sender: content } });
    const get = { version: 1, type: "passkey.get", operationId: "o" };
    expect(await worker.send(content, "passkey", get)).toEqual({
      area: "passkeys",
      request: get,
      sender: content,
    });
    const create = { version: 1, type: "passkey.create", operationId: "o" };
    expect(await worker.send(content, "passkey", create)).toEqual({
      area: "passkey-create",
      request: create,
    });
    expect(worker.areas.passkeyCreate).toHaveBeenCalledWith(create, content);
    // Another area's request under these keys reaches neither handler.
    expect(
      await worker.send(content, "login", { version: 1, type: "settings.get" }),
    ).toBeUndefined();
    expect(
      await worker.send(content, "passkey", { version: 1, type: "passkey-chooser.load" }),
    ).toBeUndefined();
    expect(worker.areas.login).toHaveBeenCalledTimes(2);
    expect(worker.areas.passkeys).toHaveBeenCalledTimes(1);
  });

  it("sends no error back when a handler fails", async () => {
    worker.areas.login.mockRejectedValueOnce(new Error("synthetic vault secret"));
    const ready = { version: 1, type: "login.document.ready", token: "t" };
    expect(await worker.send(content, "login", ready)).toBeUndefined();
    expect(worker.areas.failed).toHaveBeenCalledWith(new Error("synthetic vault secret"));
    worker.areas.diagnostics.mockImplementationOnce(() => {
      throw new Error("synthetic thrown");
    });
    expect(
      await worker.send(diagnosticsPage, "diagnostics", { version: 1, type: "diagnostics.status" }),
    ).toBeUndefined();
    expect(worker.areas.failed).toHaveBeenCalledTimes(2);
  });

  it("leaves no raw listener for the moved requests", async () => {
    fake.state.sender = options;
    await expect(
      new Promise((resolve, reject) =>
        fake.runtime.sendMessage({ version: 1, type: "settings.get" }, (response) =>
          fake.runtime.lastError
            ? reject(new Error(fake.runtime.lastError.message))
            : resolve(response),
        ),
      ),
    ).rejects.toThrow("message port closed");
    expect(worker.areas.settings).not.toHaveBeenCalled();
  });

  it("keeps the probe controls out of production", async () => {
    await expect(
      worker.send(probePage, "crypto.probe", { type: "crypto.probe", action: "lock" }),
    ).rejects.toThrow("message port closed");
    await expect(worker.send(content, "pateat.test.document")).rejects.toThrow(
      "message port closed",
    );
    const control = { type: "passkey.probe.status" };
    expect(await worker.send(options, "passkey", control)).toEqual({
      area: "passkeys",
      request: control,
      sender: options,
    });
    expect(worker.areas.cryptoProbe).not.toHaveBeenCalled();
    expect(worker.areas.passkeyProbe).not.toHaveBeenCalled();
  });
});

describe("probe build messages", () => {
  let worker: Awaited<ReturnType<typeof start>>;
  beforeEach(async () => {
    worker = await start("probe");
  });

  it("answers the crypto probe page only", async () => {
    for (const [area, type] of [
      ["setup.probe", "setup-probe"],
      ["vault.probe", "vault-probe"],
      ["crypto.probe", "crypto-probe"],
    ] as const) {
      const request = { type: area, action: "status" };
      // oxlint-disable-next-line no-await-in-loop
      expect(await worker.send(probePage, area, request)).toEqual({ area: type, request });
      // oxlint-disable-next-line no-await-in-loop
      expect(await worker.send(options, area, request)).toBeUndefined();
      // oxlint-disable-next-line no-await-in-loop
      expect(await worker.send(probePage, area, { type: "settings.get" })).toBeUndefined();
    }
    expect(worker.areas.setupProbe).toHaveBeenCalledTimes(1);
    expect(worker.areas.vaultProbe).toHaveBeenCalledTimes(1);
    expect(worker.areas.cryptoProbe).toHaveBeenCalledTimes(1);
  });

  it("answers passkey probe controls from the settings page only", async () => {
    const control = { type: "passkey.probe.status" };
    expect(await worker.send(options, "passkey", control)).toEqual({
      area: "passkey-probe",
      request: control,
    });
    expect(await worker.send(content, "passkey", control)).toEqual({
      area: "passkeys",
      request: control,
      sender: content,
    });
    expect(worker.areas.passkeyProbe).toHaveBeenCalledTimes(1);
  });

  it("tells a loopback content script its own document", async () => {
    const loopback = { ...content, url: "http://127.0.0.1:3847/fixture" };
    expect(await worker.send(loopback, "pateat.test.document")).toEqual({
      tabId: 7,
      frameId: 0,
      documentId: "document-a",
      active: true,
    });
    expect(await worker.send(content, "pateat.test.document")).toBeUndefined();
    expect(
      await worker.send({ ...loopback, tab: undefined }, "pateat.test.document"),
    ).toBeUndefined();
  });
});
