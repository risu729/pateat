import * as v from "valibot";
import type { PasskeyChoice, PasskeyChooser } from "./runtime";
import type { PasskeyDisplay } from "./select";

/** The chooser window's page (ADR 0021). */
export const CHOOSER_PAGE = "/passkey-picker.html";
const WINDOW_WIDTH = 440;
const WINDOW_HEIGHT = 520;
/** More would not fit a window; a request offering more still delegates. */
export const MAX_CHOOSER_ENTRIES = 50;

const request = v.pipe(v.string(), v.uuid());
const name = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
export const chooserViewSchema = v.strictObject({
  origin: v.pipe(v.string(), v.maxLength(2048)),
  rpId: v.pipe(v.string(), v.maxLength(253)),
  entries: v.pipe(
    v.array(
      v.strictObject({
        item: name,
        userName: v.optional(name),
        account: v.optional(name),
      }),
    ),
    v.minLength(2),
    v.maxLength(MAX_CHOOSER_ENTRIES),
  ),
  replacesDefault: v.boolean(),
});
export type ChooserView = v.InferOutput<typeof chooserViewSchema>;

/** Messages the chooser page sends; the background accepts them only from that page. */
export const chooserMessageSchema = v.variant("type", [
  v.strictObject({ version: v.literal(1), type: v.literal("passkey-chooser.load"), request }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("passkey-chooser.answer"),
    request,
    answer: v.variant("kind", [
      v.strictObject({
        kind: v.literal("chosen"),
        index: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_CHOOSER_ENTRIES - 1)),
        makeDefault: v.boolean(),
      }),
      v.strictObject({ kind: v.literal("browser") }),
    ]),
  }),
]);
export const chooserResponseSchema = v.variant("ok", [
  v.strictObject({ ok: v.literal(true), view: v.optional(chooserViewSchema) }),
  v.strictObject({ ok: v.literal(false) }),
]);
export type ChooserResponse = v.InferOutput<typeof chooserResponseSchema>;

type Bounds = {
  left?: number | undefined;
  top?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
};
export interface ChooserBrowser {
  /** The chooser page's full extension URL. */
  readonly pageUrl: string;
  createWindow(options: {
    url: string;
    type: "popup";
    focused: true;
    width: number;
    height: number;
    left?: number;
    top?: number;
  }): Promise<{ id?: number | undefined } | undefined>;
  removeWindow(windowId: number): Promise<void>;
  /** The bounds of the window holding this tab, to centre the chooser over it. */
  tabWindowBounds(tabId: number): Promise<Bounds | undefined>;
  onWindowRemoved(listener: (windowId: number) => void): void;
  onTabRemoved(listener: (tabId: number) => void): void;
  /** Keeps the service worker running while a person decides. */
  keepAlive<T>(work: Promise<T>): Promise<T>;
}

type Open = {
  readonly token: string;
  readonly tabId: number;
  readonly view: ChooserView;
  windowId?: number;
  readonly opened: Promise<number | undefined>;
  /** `windowGone` when the window was already closed by the user. */
  settle(choice: PasskeyChoice, windowGone?: boolean): void;
};

function centred(bounds: Bounds | undefined) {
  if (
    bounds?.left === undefined ||
    bounds.top === undefined ||
    bounds.width === undefined ||
    bounds.height === undefined
  )
    return {};
  return {
    left: Math.round(bounds.left + Math.max(0, (bounds.width - WINDOW_WIDTH) / 2)),
    top: Math.round(bounds.top + Math.max(0, (bounds.height - WINDOW_HEIGHT) / 3)),
  };
}

/**
 * One chooser window at a time. It belongs to the request that opened it: it closes when that
 * request is aborted, and the request delegates when the window is closed, its tab is closed,
 * or another request already holds the window.
 */
export function createPasskeyChooser(browser: ChooserBrowser): PasskeyChooser & {
  /** Answers the chooser page; `undefined` when the sender is not that page. */
  handle(
    message: unknown,
    sender: { url?: string | undefined; tab?: { windowId?: number | undefined } | undefined },
  ): Promise<ChooserResponse> | undefined;
} {
  let open: Open | undefined;
  browser.onWindowRemoved((windowId) => {
    if (open?.windowId === windowId) open.settle({ kind: "closed" }, true);
  });
  browser.onTabRemoved((tabId) => {
    if (open?.tabId === tabId) open.settle({ kind: "closed" });
  });
  const page = new URL(browser.pageUrl);

  return {
    async choose(input) {
      if (open || input.signal.aborted || input.entries.length > MAX_CHOOSER_ENTRIES)
        return { kind: "unavailable" };
      const view = v.safeParse(chooserViewSchema, {
        origin: input.origin,
        rpId: input.rpId,
        entries: input.entries.map((entry) => ({
          item: entry.item.slice(0, 1024) || "Unnamed item",
          ...(entry.userName ? { userName: entry.userName.slice(0, 1024) } : {}),
          ...(entry.account ? { account: entry.account.slice(0, 1024) } : {}),
        })) satisfies PasskeyDisplay[],
        replacesDefault: input.replacesDefault,
      });
      if (!view.success) return { kind: "unavailable" };
      const token = crypto.randomUUID();
      let resolveOpened!: (windowId: number | undefined) => void;
      const opened = new Promise<number | undefined>((resolve) => (resolveOpened = resolve));
      const answer = new Promise<PasskeyChoice>((resolve) => {
        const entry: Open = {
          token,
          tabId: input.tabId,
          view: view.output,
          opened,
          settle(choice, windowGone = false) {
            if (open !== entry) return;
            open = undefined;
            input.signal.removeEventListener("abort", onAbort);
            if (!windowGone && entry.windowId !== undefined)
              void browser.removeWindow(entry.windowId).catch(() => undefined);
            resolve(choice);
          },
        };
        // The request ended elsewhere; the window goes with it.
        const onAbort = () => entry.settle({ kind: "closed" });
        open = entry;
        input.signal.addEventListener("abort", onAbort, { once: true });
        void (async () => {
          const url = new URL(page);
          url.searchParams.set("request", token);
          let windowId: number | undefined;
          try {
            const bounds = await browser.tabWindowBounds(input.tabId).catch(() => undefined);
            windowId = (
              await browser.createWindow({
                url: url.href,
                type: "popup",
                focused: true,
                width: WINDOW_WIDTH,
                height: WINDOW_HEIGHT,
                ...centred(bounds),
              })
            )?.id;
          } catch {
            windowId = undefined;
          }
          resolveOpened(windowId);
          if (windowId === undefined) return entry.settle({ kind: "unavailable" });
          entry.windowId = windowId;
          // Settled while the window was being created: it is not wanted any more.
          if (open !== entry) void browser.removeWindow(windowId).catch(() => undefined);
        })();
      });
      return browser.keepAlive(answer);
    },

    handle(message, sender) {
      let url: URL;
      try {
        url = new URL(sender.url ?? "");
      } catch {
        return undefined;
      }
      if (url.origin !== page.origin || url.pathname !== page.pathname) return undefined;
      return (async (): Promise<ChooserResponse> => {
        const parsed = v.safeParse(chooserMessageSchema, message);
        const current = open;
        if (
          !parsed.success ||
          !current ||
          parsed.output.request !== current.token ||
          url.searchParams.get("request") !== current.token
        )
          return { ok: false };
        // Only the window opened for this request may read or answer it.
        const windowId = await current.opened;
        if (windowId === undefined || sender.tab?.windowId !== windowId || open !== current)
          return { ok: false };
        const command = parsed.output;
        if (command.type === "passkey-chooser.load") return { ok: true, view: current.view };
        if (command.answer.kind === "chosen" && command.answer.index >= current.view.entries.length)
          return { ok: false };
        current.settle(command.answer);
        return { ok: true };
      })();
    },
  };
}
