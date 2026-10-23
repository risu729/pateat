import * as v from "valibot";
import type { PasskeyChoice, PasskeyChooser } from "./runtime";
import type { PasskeyDisplay } from "./select";
import { newId } from "@pateat/contracts/ids";

/** The chooser window's page (ADR 0021). */
export const CHOOSER_PAGE = "/passkey-picker.html";
const WINDOW_WIDTH = 440;
const WINDOW_HEIGHT = 520;
/** Longest the chooser waits for its window to close and the tab to regain focus. */
const RESTORE_LIMIT_MS = 2_000;
/** More would not fit a window; a request offering more still delegates. */
export const MAX_CHOOSER_ENTRIES = 50;
/** Longer than any master password Bitwarden's clients accept. */
const MAX_PASSWORD_LENGTH = 4096;
/**
 * Wrong master passwords one window takes before its request ends. Each check costs the
 * account's KDF, and the master password also opens the vault on other devices.
 */
export const MAX_WRONG_PASSWORDS = 5;

const request = v.pipe(v.string(), v.uuid());
const name = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
export const chooserViewSchema = v.strictObject({
  origin: v.pipe(v.string(), v.maxLength(2048)),
  rpId: v.pipe(v.string(), v.maxLength(253)),
  entries: v.pipe(
    v.array(
      v.strictObject({
        item: v.optional(name),
        userName: v.optional(name),
        account: v.optional(name),
        /** The site default; listed first. */
        preferred: v.optional(v.literal(true)),
        /**
         * Bitwarden asks for the master password before this item is used, and the site's
         * settings honour that: choosing it asks for the password first.
         */
        reprompt: v.optional(v.literal(true)),
      }),
    ),
    v.minLength(1),
    v.maxLength(MAX_CHOOSER_ENTRIES),
  ),
  replacesDefault: v.boolean(),
  /**
   * Automatic login of the site is paused (ADR 0062): no entry is the default, and the box
   * that makes the choice the default starts unticked.
   */
  paused: v.optional(v.literal(true)),
  /**
   * The window asks for the master password before a password login uses its one entry,
   * instead of choosing a passkey; absent for a passkey request.
   */
  purpose: v.optional(v.literal("login")),
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
      /** "Just once" hands this request on; "Always for this site" every later one too. */
      v.strictObject({ kind: v.literal("browser") }),
      v.strictObject({ kind: v.literal("browser-site") }),
    ]),
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("passkey-chooser.verify"),
    request,
    index: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_CHOOSER_ENTRIES - 1)),
    password: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_PASSWORD_LENGTH)),
    makeDefault: v.boolean(),
  }),
]);
export const chooserResponseSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    view: v.optional(chooserViewSchema),
    /** The answer to a master password check; on `true` the window's choice is made. */
    matches: v.optional(v.boolean()),
  }),
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
  /** Brings the window holding this tab to the front again. */
  focusTab(tabId: number): Promise<void>;
  onWindowRemoved(listener: (windowId: number) => void): void;
  onTabRemoved(listener: (tabId: number) => void): void;
  /** Keeps the service worker running while a person decides. */
  keepAlive<T>(work: Promise<T>): Promise<T>;
}

type Open = {
  readonly token: string;
  readonly tabId: number;
  readonly view: ChooserView;
  readonly verify: ((index: number, password: string) => Promise<boolean>) | undefined;
  /** A master password check is running; another waits for none and is refused. */
  checking: boolean;
  wrong: number;
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
  // A window closed before `createWindow` answered is recognised once its ID is known.
  let lastRemoved: number | undefined;
  browser.onWindowRemoved((windowId) => {
    if (open?.windowId === windowId) open.settle({ kind: "closed" }, true);
    else lastRemoved = windowId;
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
          ...(entry.item ? { item: entry.item.slice(0, 1024) } : {}),
          ...(entry.userName ? { userName: entry.userName.slice(0, 1024) } : {}),
          ...(entry.account ? { account: entry.account.slice(0, 1024) } : {}),
          ...(entry.preferred === true ? { preferred: true as const } : {}),
          ...(entry.reprompt === true ? { reprompt: true as const } : {}),
        })) satisfies PasskeyDisplay[],
        replacesDefault: input.replacesDefault,
        ...(input.paused === true ? { paused: true as const } : {}),
        ...(input.purpose === "login" ? { purpose: "login" } : {}),
      });
      if (!view.success) return { kind: "unavailable" };
      // An entry that asks for the master password can be chosen only through the check.
      if (view.output.entries.some((entry) => entry.reprompt) && !input.verify)
        return { kind: "unavailable" };
      const token = newId();
      const { promise: opened, resolve: resolveOpened } = Promise.withResolvers<
        number | undefined
      >();
      const answer = new Promise<PasskeyChoice>((resolve) => {
        const entry: Open = {
          token,
          tabId: input.tabId,
          view: view.output,
          verify: input.verify,
          checking: false,
          wrong: 0,
          opened,
          settle(choice, windowGone = false) {
            if (open !== entry) return;
            open = undefined;
            input.signal.removeEventListener("abort", onAbort);
            const windowId = windowGone ? undefined : entry.windowId;
            // The browser's own prompt needs the page focused, so delegate only once the window
            // is gone and the tab's window is in front again. Neither step may hold the request.
            const bounded = (work: Promise<unknown>) =>
              Promise.race([
                work.catch(() => undefined),
                new Promise((done) => setTimeout(done, RESTORE_LIMIT_MS)),
              ]);
            void (async () => {
              if (windowId !== undefined) await bounded(browser.removeWindow(windowId));
              if (choice.kind !== "chosen" && entry.windowId !== undefined)
                await bounded(browser.focusTab(input.tabId));
              resolve(choice);
            })();
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
          else if (lastRemoved === windowId) entry.settle({ kind: "closed" }, true);
        })();
      });
      return browser.keepAlive(answer);
    },

    handle(message, sender) {
      const url = URL.parse(sender.url ?? "");
      if (!url) return undefined;
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
        if (command.type === "passkey-chooser.verify") {
          const entry = current.view.entries[command.index];
          if (!entry?.reprompt || !current.verify || current.checking) return { ok: false };
          current.checking = true;
          let matches: boolean;
          try {
            matches = await current.verify(command.index, command.password);
          } catch {
            // The vault could not check it, as when it locked meanwhile: the request ends.
            current.checking = false;
            if (open === current) current.settle({ kind: "unavailable" });
            return { ok: false };
          }
          current.checking = false;
          if (open !== current) return { ok: false };
          if (matches)
            current.settle({
              kind: "chosen",
              index: command.index,
              makeDefault: command.makeDefault,
            });
          else if (++current.wrong >= MAX_WRONG_PASSWORDS) {
            current.settle({ kind: "closed" });
            return { ok: false };
          }
          return { ok: true, matches };
        }
        if (command.answer.kind === "chosen") {
          const entry = current.view.entries[command.answer.index];
          if (!entry || entry.reprompt || current.view.purpose === "login") return { ok: false };
        }
        current.settle(command.answer);
        return { ok: true };
      })();
    },
  };
}
