/**
 * The fake extension browser the login runtime's production tests share, and its state.
 * Each test file creates it in `vi.hoisted` and mocks `wxt/browser` with it, so it exists
 * before any module that reads `chrome` loads.
 */
export const fake = (() => {
  const state = {
    storage: {} as Record<string, unknown>,
    messages: [] as {
      type: string;
      values?: { slot: string; value: string }[];
      account?: { username: string };
      accountSwitch?: unknown;
      outcome?: string;
      /** `login.state`: the sign-in elements of a form shown again in a new document. */
      fields?: unknown[];
    }[],
    /** Overrides the document's answer to an execution, such as a wrong-account refusal. */
    executeReply: undefined as
      | undefined
      | {
          ok: boolean;
          reason?: string;
          detail?: string;
          switchable?: true;
          mutation?: "none" | "possible";
        },
    /** The document's answer to clicking an account switch. */
    switchReply: { ok: true } as { ok: boolean },
    /** What the document says a chooser login would click on its list (ADR 0028). */
    chosen: { ok: true, click: "entry" } as { ok: boolean; click?: string; miss?: object },
    /**
     * What the page shows for a continuation, when an observation asks (ADR 0018): `true`
     * for a loaded page with a password input other than the asked targets, `false` for
     * one still loading, or the answer's parts.
     */
    signIn: false as boolean | { password?: boolean; identifier?: boolean },
    granted: true,
    pageUrl: "https://login.example/signin",
    onExecute: undefined as
      | undefined
      | ((message: Record<string, unknown>, tabId: number) => Promise<void>),
    /** Per-tab URLs; other tabs use `pageUrl`. */
    tabUrls: {} as Record<number, string>,
    /** Completion, then rejection target states reported by observation. */
    observed: ["unique", "missing"],
    observedPath: "/signin",
    /** When set, each requested target is reported unique only if its value is listed. */
    present: undefined as Set<string> | undefined,
    /** The document's answer while it waits for a step's elements. */
    awaited: { ok: true } as { ok: boolean; reason?: string },
    /** Runs while the document waits for a step's elements. */
    onAwait: undefined as undefined | (() => void),
    /** Overrides `awaited` for one wait when it answers, as a chooser's list does. */
    awaitReply: undefined as
      | undefined
      | ((readiness: { accounts?: boolean }) => { ok: boolean; reason?: string } | undefined),
    /** Documents that went away with their page; messages to them fail. */
    gone: new Set<string>(),
    /** Every runtime's tab-closed listener, so a test can close its tabs afterwards. */
    removed: [] as ((tabId: number) => void)[],
    /** Every runtime's tab-replaced listener, as Chrome calls it for a discarded tab. */
    replaced: [] as ((added: number, removed: number) => void)[],
    /** The document's description of itself, by the page asked for. */
    extracted: {} as Record<string, unknown>,
    /**
     * The page signs the document reports for ADR 0029, or a function of the `login.state`
     * message that gives them; none when unset.
     */
    signs: undefined as
      | undefined
      | Record<string, boolean | string>
      | ((message: Record<string, unknown>) => Record<string, boolean | string>),
    /** Whether the document says it has finished loading, with its signs. */
    loaded: true,
    /** `chrome.storage.session`. */
    session: {} as Record<string, unknown>,
    /** Present elements that are hidden or disabled, for an observation that asks. */
    unusable: new Set<string>(),
    /** Elements that match more than once. */
    ambiguous: new Set<string>(),
    /** Tab-specific toolbar badge text and title. */
    badges: {} as Record<number, { text?: string; title?: string }>,
    /** Each `login.reconnect` and the document it was sent to. */
    reconnects: [] as { tabId: number; frameId?: number; documentId?: string }[],
    /** The document's announce in answer to `login.reconnect`, as the content script does. */
    onReconnect: undefined as undefined | (() => Promise<unknown>),
    /** The document's answers about a site's sign-in entry (ADR 0031). */
    entry: {
      hosts: { ok: true, hosts: [] as string[] } as unknown,
      inspect: undefined as unknown,
      press: { ok: true } as unknown,
      check: { ok: true, signIn: true, start: false, signUp: false } as unknown,
    },
    /** Runs when the document presses its sign-in entry. */
    onPress: undefined as undefined | (() => void),
  };
  const browser = {
    runtime: {
      id: "synthetic-extension",
      getURL: (path: string) => `chrome-extension://synthetic-extension${path}`,
    },
    permissions: { contains: async () => state.granted },
    action: {
      setBadgeText: async ({ tabId, text }: { tabId: number; text: string }) => {
        state.badges[tabId] = { ...state.badges[tabId], text };
      },
      setTitle: async ({ tabId, title }: { tabId: number; title: string }) => {
        state.badges[tabId] = { ...state.badges[tabId], title };
      },
      setBadgeBackgroundColor: async () => undefined,
      setBadgeTextColor: async () => undefined,
    },
    storage: {
      session: {
        get: async (keys: string | string[]) =>
          Object.fromEntries(
            [keys]
              .flat()
              .filter((key) => key in state.session)
              .map((key) => [key, state.session[key]]),
          ),
        set: async (values: Record<string, unknown>) => {
          Object.assign(state.session, structuredClone(values));
        },
      },
      local: {
        setAccessLevel: async () => undefined,
        get: async (keys: string | string[]) =>
          Object.fromEntries(
            [keys]
              .flat()
              .filter((key) => key in state.storage)
              .map((key) => [key, state.storage[key]]),
          ),
        set: async (values: Record<string, unknown>) => {
          Object.assign(state.storage, structuredClone(values));
        },
        remove: async (keys: string | string[]) => {
          for (const key of [keys].flat()) delete state.storage[key];
        },
      },
    },
    tabs: {
      query: async () => [],
      get: async (id: number) => ({ id, url: state.tabUrls[id] ?? state.pageUrl }),
      sendMessage: async (
        _tabId: number,
        message: Record<string, unknown>,
        options?: { frameId?: number; documentId?: string },
      ) => {
        if (options?.documentId && state.gone.has(options.documentId))
          throw new Error("Could not establish connection. Receiving end does not exist.");
        state.messages.push(structuredClone(message) as (typeof state.messages)[number]);
        if (message["type"] === "login.reconnect") {
          state.reconnects.push({ tabId: _tabId, ...options });
          return (await state.onReconnect?.()) ?? { ok: false };
        }
        if (message["type"] === "login.await") {
          state.onAwait?.();
          return (
            state.awaitReply?.(message["readiness"] as { accounts?: boolean }) ?? state.awaited
          );
        }
        /** A target's state with `present`, as the content script reports it. */
        const stateOf = (value: string, require: string | undefined) =>
          !state.present!.has(value)
            ? "missing"
            : state.ambiguous.has(value)
              ? "ambiguous"
              : [undefined, "present"].includes(require) === false && state.unusable.has(value)
                ? "unusable"
                : "unique";
        if (message["type"] === "login.observe")
          return {
            path: state.observedPath,
            targets: state.present
              ? (message["targets"] as { value: string }[]).map((entry, index) =>
                  stateOf(entry.value, (message["require"] as string[] | undefined)?.[index]),
                )
              : [...state.observed],
            ...(message["signIn"]
              ? {
                  signIn:
                    typeof state.signIn === "boolean"
                      ? { loaded: state.signIn, password: state.signIn, identifier: false }
                      : {
                          loaded: true,
                          password: state.signIn.password === true,
                          identifier: state.signIn.identifier === true,
                        },
                }
              : {}),
          };
        if (message["type"] === "login.switch") return state.switchReply;
        if (message["type"] === "login.choose") return state.chosen;
        if (message["type"] === "login.entry.hosts") return state.entry.hosts;
        if (message["type"] === "login.entry.inspect") return state.entry.inspect;
        if (message["type"] === "login.entry.check") return state.entry.check;
        if (message["type"] === "login.entry.press") {
          state.onPress?.();
          return state.entry.press;
        }
        if (message["type"] === "login.state")
          return state.signs
            ? {
                ok: true,
                signs: typeof state.signs === "function" ? state.signs(message) : state.signs,
                loaded: state.loaded,
              }
            : { ok: false };
        if (message["type"] === "login.extract")
          return (
            state.extracted[message["page"] as string] ?? { ok: false, reason: "no-candidates" }
          );
        if (message["type"] === "login.execute") {
          // An advance's next step, measured just before the click or the first input.
          const next = message["next"] as
            | { require: string; targets: { value: string }[] }
            | undefined;
          const before =
            next && state.present
              ? next.targets.map((entry) => stateOf(entry.value, next.require))
              : undefined;
          await state.onExecute?.(message, _tabId);
          const operation = message["operation"] as {
            operationId: string;
            document: { documentId: string };
          };
          return {
            ok: true,
            operationId: operation.operationId,
            documentId: operation.document.documentId,
            mutation: state.executeReply && !state.executeReply.ok ? "none" : "possible",
            ...(before && state.executeReply?.ok !== false ? { before } : {}),
            ...state.executeReply,
          };
        }
        return { ok: true };
      },
      onRemoved: {
        addListener: (listener: (tabId: number) => void) => {
          state.removed.push(listener);
        },
      },
      onReplaced: {
        addListener: (listener: (added: number, removed: number) => void) => {
          state.replaced.push(listener);
        },
      },
    },
  };
  // WXT storage reads `chrome` when it loads.
  Object.assign(globalThis, { chrome: browser });
  return { state, browser };
})();
