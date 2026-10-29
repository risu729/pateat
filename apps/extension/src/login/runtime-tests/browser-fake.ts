export function createBrowserFake() {
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
      /**
       * `login.observe`: the targets read, such as signed-in markers, and the state each
       * must reach.
       */
      targets?: unknown[];
      require?: string[];
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
    /**
     * Whether the document answers an advance with its next step's measurement; without
     * it, as a document that took none, the advance cannot be confirmed on its path.
     */
    measures: true,
    /** The document's answer to clicking an account switch. */
    switchReply: { ok: true } as { ok: boolean },
    /** What the document says a chooser login would click on its list (ADR 0028). */
    chosen: { ok: true, click: "entry" } as { ok: boolean; click?: string; miss?: object },
    /**
     * Which username the value the page set in its account input equals (ADR 0028
     * amendment of 2026-10-23).
     */
    siteAccount: { ok: false } as { ok: boolean; index?: number },
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
    /** Tabs in an incognito window. */
    incognito: new Set<number>(),
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
    /** The open windows, by whether each is incognito. */
    windows: [false] as boolean[],
    /** Every runtime's window-closed listener. */
    windowRemoved: [] as ((windowId: number) => void)[],
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
    /**
     * Present elements that still show but are disabled or busy: unusable for every
     * requirement but `present` and `shown`, as a "Verifying" button is.
     */
    disabled: new Set<string>(),
    /**
     * Present elements that a step's wait counts as usable but the page's description does
     * not see: hidden from assistive technology, transparent, tiny or off-screen, as a
     * password input an email form keeps for the browser.
     */
    faint: new Set<string>(),
    /** Elements that match more than once. */
    ambiguous: new Set<string>(),
    /** The document's answer to the popup's fill of a personal detail (ADR 0061). */
    detailFillReply: undefined as unknown,
    /** An observation that asks for one of these answers nothing readable. */
    unobservable: new Set<string>(),
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
    /** The document's answer to an account switch's logout click (ADR 0063). */
    logoutClick: { ok: true } as unknown,
    /** Runs when the document presses a logout click, as the page then changes. */
    onLogoutClick: undefined as undefined | ((message: Record<string, unknown>) => void),
    /** The document's control that says it logs out by its words (ADR 0063). */
    logoutLocal: { ok: false, reason: "none" } as unknown,
    /** The open tabs `tabs.query` lists, by ID; none when unset. */
    openTabs: undefined as number[] | undefined,
    /** The document's answer about the card it shows beside a card detail (ADR 0061). */
    cardHints: undefined as unknown,
    /**
     * The secret question the page shows beside an answer input (ADR 0061), compared with
     * the names a `login.detail.question` sends as the content script does: the entry with
     * an alternative contained in it, after the same normalization. None when unset.
     */
    question: undefined as string | undefined,
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
      query: async () =>
        (state.openTabs ?? []).map((id) => ({
          id,
          url: state.tabUrls[id] ?? state.pageUrl,
          incognito: state.incognito.has(id),
        })),
      get: async (id: number) => ({
        id,
        url: state.tabUrls[id] ?? state.pageUrl,
        incognito: state.incognito.has(id),
      }),
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
              : ([undefined, "present"].includes(require) === false && state.unusable.has(value)) ||
                  ([undefined, "present", "shown"].includes(require) === false &&
                    state.disabled.has(value)) ||
                  (require?.startsWith("described-") === true && state.faint.has(value))
                ? "unusable"
                : "unique";
        /** Why a target has its state, as the content script explains it for the log. */
        const checkOf = (value: string, require: string | undefined) => {
          const found = stateOf(value, require);
          if (found === "unique") return "ok";
          if (found === "missing") return "missing";
          if (found === "ambiguous") return "matches-2";
          if (require?.startsWith("described-") === true && state.faint.has(value))
            return "transparent";
          return require?.endsWith("writable") === true ? "not-writable" : "unusable";
        };
        if (
          message["type"] === "login.observe" &&
          (message["targets"] as { value: string }[]).some((entry) =>
            state.unobservable.has(entry.value),
          )
        )
          return { ok: false };
        if (message["type"] === "login.observe")
          return {
            ...(message["explain"] && state.present
              ? {
                  checks: (message["targets"] as { value: string }[]).map((entry, index) =>
                    checkOf(entry.value, (message["require"] as string[] | undefined)?.[index]),
                  ),
                }
              : {}),
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
        if (message["type"] === "login.detail.card" && state.cardHints) return state.cardHints;
        if (message["type"] === "login.detail.question") {
          const shown = state.question;
          if (shown === undefined) return { ok: true };
          // As the document compares them: a name within the text, a confirmed question as
          // the whole question after its label.
          const normalized = (text: string) =>
            text
              .normalize("NFKC")
              .trim()
              .replace(/[?:]+$/u, "");
          const page = normalized(shown);
          const whole = [page, normalized(page.slice(page.indexOf(":") + 1))];
          const index = (message["names"] as ({ name: string } | { question: string })[]).findIndex(
            (ask) =>
              "name" in ask
                ? page.includes(normalized(ask.name))
                : whole.includes(normalized(ask.question)),
          );
          return index < 0 ? { ok: true } : { ok: true, index };
        }
        if (message["type"] === "login.switch") return state.switchReply;
        if (message["type"] === "login.detail.fill") return state.detailFillReply ?? { ok: true };
        if (message["type"] === "login.choose") return state.chosen;
        if (message["type"] === "login.site.account") return state.siteAccount;
        if (message["type"] === "login.entry.hosts") return state.entry.hosts;
        if (message["type"] === "login.entry.inspect") return state.entry.inspect;
        if (message["type"] === "login.entry.check") return state.entry.check;
        if (message["type"] === "login.logout.click") {
          state.onLogoutClick?.(message);
          return state.logoutClick;
        }
        if (message["type"] === "login.logout.local") return state.logoutLocal;
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
            next && state.present && state.measures
              ? next.targets.map((entry) => stateOf(entry.value, next.require))
              : undefined;
          // And another layout's next steps on the same path (ADR 0060).
          const siblings = message["siblings"] as
            | { require: string; targets: { value: string }[] }[]
            | undefined;
          const siblingsBefore =
            siblings && state.present && state.measures
              ? siblings.map((sibling) =>
                  sibling.targets.map((entry) => stateOf(entry.value, sibling.require)),
                )
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
            ...(siblingsBefore && state.executeReply?.ok !== false ? { siblingsBefore } : {}),
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
    windows: {
      getAll: async () => state.windows.map((incognito, id) => ({ id, incognito })),
      onRemoved: {
        addListener: (listener: (windowId: number) => void) => {
          state.windowRemoved.push(listener);
        },
      },
    },
  };
  // WXT storage reads `chrome` when it loads.
  Object.assign(globalThis, { chrome: browser });
  return { state, browser };
}
