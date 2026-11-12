import { expect, it, vi } from "vitest";
import { snapshotGetOptions } from "../../src/passkeys/page";
import { PAGE_CHANNEL, PAGE_MAX_WAIT_MS, PAGE_TIMEOUT_MS } from "../../src/passkeys/wire";
import type { PageFixtures } from "../../src/passkeys/page.test";

export function registerPageGetCases({
  fakePage,
  publicKey,
  answer,
}: Pick<PageFixtures, "fakePage" | "publicKey" | "answer">) {
  it("delegates with the caller's exact arguments, signal included", async () => {
    const page = fakePage(answer({ kind: "delegate" }));
    const options = { publicKey, signal: new AbortController().signal };
    await expect(page.container.get(options)).resolves.toBe("native");
    expect(page.nativeGet).toHaveBeenCalledOnce();
    expect(page.nativeGet.mock.calls[0]).toEqual([options]);
    expect(page.nativeGet.mock.calls[0]![0]).toBe(options);
    expect(page.nativeGet.mock.contexts[0]).toBe(page.container);
  });

  it("hands a request the background cancelled to the browser, as after a page is restored", async () => {
    const page = fakePage(answer({ kind: "cancelled" }));
    const options = { publicKey };
    await expect(page.container.get(options)).resolves.toBe("native");
    expect(page.nativeGet).toHaveBeenCalledOnce();
    expect(page.nativeGet.mock.calls[0]![0]).toBe(options);
  });

  it("preserves Immediate UI uiMode and delegates the caller's exact call", async () => {
    const page = fakePage(answer({ kind: "delegate" }));
    const options = { publicKey, uiMode: "immediate" };
    await expect(page.container.get(options)).resolves.toBe("native");
    expect(page.posted[0]).toMatchObject({
      type: "get",
      request: { uiMode: "immediate" },
    });
    expect(page.nativeGet.mock.calls[0]![0]).toBe(options);
  });

  it("keeps uiMode beside mediation and leaves other uiMode values to the browser", () => {
    for (const extra of [{ uiMode: 1 }, { uiMode: "other" }])
      expect(snapshotGetOptions({ publicKey, ...extra })).toBeUndefined();
    expect(
      snapshotGetOptions({ publicKey, uiMode: "immediate", mediation: "optional" }),
    ).toMatchObject({
      uiMode: "immediate",
      mediation: "optional",
    });
  });

  it("relays Immediate UI with a signal or an allow list as it relays other requests", () => {
    expect(
      snapshotGetOptions({ publicKey, uiMode: "immediate", signal: new AbortController().signal }),
    ).toMatchObject({ uiMode: "immediate" });
    expect(
      snapshotGetOptions({
        publicKey: {
          ...publicKey,
          allowCredentials: [{ type: "public-key", id: new Uint8Array([1]) }],
        },
        uiMode: "immediate",
      }),
    ).toMatchObject({ uiMode: "immediate", allowCredentials: [{ id: "AQ" }] });
  });

  it.each([
    ["password", { password: true }],
    ["identity", { identity: { providers: [] } }],
  ])("hands Immediate UI %s options directly to the original provider", async (_, extra) => {
    const page = fakePage();
    const options = { publicKey, uiMode: "immediate", ...extra };
    await expect(page.container.get(options)).resolves.toBe("native");
    expect(page.posted).toHaveLength(0);
    expect(page.nativeGet.mock.calls[0]![0]).toBe(options);
    expect(page.nativeGet.mock.contexts[0]).toBe(page.container);
  });

  it("delegates promptly when no relay acknowledges", async () => {
    vi.useFakeTimers();
    const page = fakePage();
    const result = page.container.get({ publicKey });
    await vi.advanceTimersByTimeAsync(999);
    expect(page.nativeGet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("native");
    expect(page.posted.map((message) => message.type)).toEqual(["get", "cancel"]);
  });

  it("delegates once the relay falls silent, and keeps waiting while it repeats its ack", async () => {
    vi.useFakeTimers();
    const page = fakePage((message) =>
      message.type === "get" ? [{ type: "ack", id: message.id }] : [],
    );
    const silent = page.container.get({ publicKey });
    await vi.advanceTimersByTimeAsync(PAGE_TIMEOUT_MS - 1);
    expect(page.nativeGet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(silent).resolves.toBe("native");

    const held = page.container.get({ publicKey });
    await vi.advanceTimersByTimeAsync(0);
    const id = page.posted.at(-1)!.id;
    const heartbeat = setInterval(
      () => page.post({ channel: PAGE_CHANNEL, type: "ack", id }),
      PAGE_TIMEOUT_MS / 3,
    );
    await vi.advanceTimersByTimeAsync(PAGE_MAX_WAIT_MS - 1);
    expect(page.nativeGet).toHaveBeenCalledOnce();
    // The absolute limit holds even while the relay keeps answering.
    await vi.advanceTimersByTimeAsync(1);
    await expect(held).resolves.toBe("native");
    expect(page.nativeGet).toHaveBeenCalledTimes(2);
    clearInterval(heartbeat);
  });

  it("rejects with the caller's abort reason and cancels the operation", async () => {
    const page = fakePage((message) =>
      message.type === "get" ? [{ type: "ack", id: message.id }] : [],
    );
    const controller = new AbortController();
    const result = page.container.get({ publicKey, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reason = { synthetic: "abort" };
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.posted.map((message) => message.type)).toEqual(["get", "cancel"]);
    expect(page.nativeGet).not.toHaveBeenCalled();
  });

  it("fails like the browser's prompt when the chooser window's wait runs out", async () => {
    const page = fakePage(answer({ kind: "not-allowed" }));
    const result = page.container.get({ publicKey });
    await expect(result).rejects.toBeInstanceOf(DOMException);
    await expect(result).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(page.nativeGet).not.toHaveBeenCalled();
    // The background already ended the request; nothing is left to cancel.
    expect(page.posted.map((message) => message.type)).toEqual(["get"]);
  });

  it("keeps a withheld conditional request pending until the page aborts it (ADR 0034)", async () => {
    const page = fakePage(answer({ kind: "withheld" }));
    const controller = new AbortController();
    let settled = false;
    const result = page.container.get({
      publicKey,
      mediation: "conditional",
      signal: controller.signal,
    });
    result.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.waitFor(() => expect(page.posted).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(page.nativeGet).not.toHaveBeenCalled();
    const reason = { synthetic: "abort" };
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    // The background already ended the request, so nothing is cancelled or handed on.
    expect(page.posted.map((message) => message.type)).toEqual(["get"]);
    expect(page.nativeGet).not.toHaveBeenCalled();
  });

  it("rejects a withheld conditional request at once when the page aborted as it arrived", async () => {
    const page = fakePage(answer({ kind: "withheld" }));
    const controller = new AbortController();
    const reason = { synthetic: "abort" };
    // The page aborts right after the wrapper took the relay's answer.
    page.listen((event) => {
      if (event.data.type === "result") controller.abort(reason);
    });
    const result = page.container.get({
      publicKey,
      mediation: "conditional",
      signal: controller.signal,
    });
    await expect(result).rejects.toBe(reason);
    expect(page.posted.map((message) => message.type)).toEqual(["get"]);
    expect(page.nativeGet).not.toHaveBeenCalled();
  });

  it("hands a withheld request on when it was not conditional", async () => {
    const page = fakePage(answer({ kind: "withheld" }));
    const options = { publicKey, signal: new AbortController().signal };
    await expect(page.container.get(options)).resolves.toBe("native");
    expect(page.nativeGet).toHaveBeenCalledOnce();
    expect(page.nativeGet.mock.calls[0]![0]).toBe(options);
  });

  it("lets a conditional request wait past the absolute limit while the relay answers", async () => {
    vi.useFakeTimers();
    const page = fakePage((message) =>
      message.type === "get" ? [{ type: "ack", id: message.id }] : [],
    );
    const held = page.container.get({ publicKey, mediation: "conditional" });
    await vi.advanceTimersByTimeAsync(0);
    const id = page.posted.at(-1)!.id;
    const heartbeat = setInterval(
      () => page.post({ channel: PAGE_CHANNEL, type: "ack", id }),
      PAGE_TIMEOUT_MS / 3,
    );
    await vi.advanceTimersByTimeAsync(PAGE_MAX_WAIT_MS * 3);
    expect(page.nativeGet).not.toHaveBeenCalled();
    expect(page.posted.map((message) => message.type)).toEqual(["get"]);
    // The login's decision still arrives, here to hand the request on.
    page.post({ channel: PAGE_CHANNEL, type: "result", id, result: { kind: "delegate" } });
    await vi.advanceTimersByTimeAsync(0);
    await expect(held).resolves.toBe("native");
    clearInterval(heartbeat);
    // Without the relay's answers it is handed on as any request is.
    const silent = page.container.get({ publicKey: { ...publicKey }, mediation: "conditional" });
    await vi.advanceTimersByTimeAsync(0);
    const silentId = page.posted.at(-1)!.id;
    page.post({ channel: PAGE_CHANNEL, type: "ack", id: silentId });
    await vi.advanceTimersByTimeAsync(PAGE_TIMEOUT_MS);
    await expect(silent).resolves.toBe("native");
    expect(page.posted.at(-1)).toMatchObject({ type: "cancel", id: silentId });
  });

  it("leaves a non-AbortSignal signal to the browser without relaying", async () => {
    const page = fakePage(answer({ kind: "cancelled" }));
    const options = { publicKey, signal: { aborted: false, addEventListener() {} } };
    await expect(page.container.get(options as never)).resolves.toBe("native");
    expect(page.posted).toEqual([]);
  });

  it("returns a credential with native prototypes for a valid assertion", async () => {
    const assertion = {
      credentialId: "AQID",
      clientDataJSON: "e30",
      authenticatorData: "AA",
      signature: "MAA",
      userHandle: null,
    };
    const page = fakePage(answer({ kind: "assertion", assertion }));
    const credential = (await page.container.get({ publicKey })) as unknown as {
      id: string;
      toJSON(): unknown;
    };
    expect(page.nativeGet).not.toHaveBeenCalled();
    expect(credential.id).toBe("AQID");
    expect(Object.getPrototypeOf(credential)).toBe(page.prototypes.credential);
    expect(credential.toJSON()).toMatchObject({ id: "AQID", type: "public-key" });
  });
}
