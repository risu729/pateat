import { describe, expect, it } from "vitest";
import type { StatusResponse } from "../login/choice-wire";
import { pageStatusLines } from "./page-status";

type Status = Extract<StatusResponse, { ok: true }>;
const origin = "https://login.example";
const status = (fields: Partial<Status> = {}): Status => ({
  ok: true,
  origin,
  recipe: "none",
  ...fields,
});
const lines = (fields: Partial<Status> = {}) =>
  pageStatusLines(status(fields)).map(({ id, tone, text }) => [id, tone, text]);

describe("pageStatusLines", () => {
  it("names the site's recipe for the page", () => {
    expect(lines({ recipe: "page" })).toEqual([
      ["recipe", "idle", "This site has a recipe for this page."],
    ]);
    expect(lines({ recipe: "other-paths" })).toEqual([
      ["recipe", "idle", "This site has a recipe, but none starts on this page."],
    ]);
    expect(lines()).toEqual([["recipe", "idle", "This site has no recipe yet."]]);
  });

  it("shows a recipe on the page and a login that signed in", () => {
    expect(lines({ recipe: "page", login: { state: "authenticated" } })).toEqual([
      ["recipe", "idle", "This site has a recipe for this page."],
      ["login", "ok", "Logged in."],
    ]);
  });

  it("says an ended login could not be confirmed", () => {
    expect(lines({ recipe: "page", login: { state: "authenticated", unconfirmed: true } })).toEqual(
      [
        ["recipe", "idle", "This site has a recipe for this page."],
        ["login", "warn", "The login could not be confirmed."],
      ],
    );
  });

  it("says why a page without a recipe on it was not sent to the AI", () => {
    expect(lines({ page: { generationSkip: "sent" } })).toEqual([
      ["recipe", "idle", "This site has no recipe yet."],
      [
        "generation-skip",
        "idle",
        "Not sent to the AI: the AI was asked about this page within the last 10 minutes, so it is not asked again yet.",
      ],
    ]);
    // A code without a sentence shows as the log names it.
    expect(lines({ page: { generationSkip: "new-code" } })[1]).toEqual([
      "generation-skip",
      "idle",
      "Not sent to the AI: new-code.",
    ]);
    expect(lines({ page: { generationSkip: "sending" } })[1]?.[2]).toBe(
      "Not sent to the AI: another request for this page is already being sent to the AI.",
    );
    // A site whose recipe starts elsewhere may still send this page.
    expect(lines({ recipe: "other-paths", page: { generationSkip: "not-connected" } })).toEqual([
      ["recipe", "idle", "This site has a recipe, but none starts on this page."],
      [
        "generation-skip",
        "idle",
        "Not sent to the AI: Pateat cannot use the sync service on this device.",
      ],
    ]);
    // A page with a recipe says nothing about skips.
    expect(lines({ recipe: "page", page: { generationSkip: "sent" } })).toEqual([
      ["recipe", "idle", "This site has a recipe for this page."],
    ]);
  });

  it("hides an older skip while the page's request is in flight, and after it went unanswered", () => {
    const skip = { generationSkip: "sent" };
    // In flight: only the request's line, not why an earlier read was not sent.
    expect(lines({ asking: true, page: skip, generation: { outcome: "sent" } })).toEqual([
      ["recipe", "idle", "This site has no recipe yet."],
      ["generation", "busy", "The AI is making a recipe for the site's sign-in page…"],
    ]);
    // Another request in flight hides it too.
    expect(lines({ asking: true, page: skip }).map(([id]) => id)).toEqual(["recipe", "asking"]);
    expect(
      lines({
        recipe: "other-paths",
        asking: true,
        page: skip,
        generation: { outcome: "recipe" },
      }).map(([id]) => id),
    ).toEqual(["recipe", "generation", "asking"]);
    // Sent without an answer and no longer in flight: the warning shows, the skip does not.
    expect(lines({ page: skip, generation: { outcome: "sent" } })).toEqual([
      ["recipe", "idle", "This site has no recipe yet."],
      [
        "generation",
        "warn",
        "A page was sent to the AI for the site's sign-in page, and no answer was recorded.",
      ],
    ]);
  });

  it("shows the skip again once an answer is recorded", () => {
    for (const generation of [
      { outcome: "recipe" },
      { outcome: "abstained", reason: "no-form" },
      { outcome: "failed", reason: "invalid-output" },
    ])
      expect(lines({ page: { generationSkip: "not-connected" }, generation }).at(-1)).toEqual([
        "generation-skip",
        "idle",
        "Not sent to the AI: Pateat cannot use the sync service on this device.",
      ]);
  });

  it("shows a skip beside the last request's answer", () => {
    expect(
      lines({
        generation: { outcome: "abstained", reason: "no-form" },
        page: { generationSkip: "sent" },
      }).map(([id]) => id),
    ).toEqual(["recipe", "generation", "generation-skip"]);
  });

  it.each([
    [undefined, "the site's sign-in page"],
    ["accounts", "the site's list of accounts"],
    ["entry", "the site's sign-in link"],
    ["continuation", "the rest of the site's sign-in"],
    ["repair", "the site's changed sign-in page"],
  ] as const)("shows a request in flight for %s while the badge spins", (page, what) => {
    const generation = { outcome: "sent", ...(page ? { page } : {}) };
    expect(lines({ asking: true, generation })).toEqual([
      ["recipe", "idle", "This site has no recipe yet."],
      ["generation", "busy", `The AI is making a recipe for ${what}…`],
    ]);
  });

  it("does not take a page that still says generating for a request in flight", () => {
    // The page stays `generating` after the answer, and a stopped worker's page too.
    expect(lines({ page: { state: "generating" } })).toEqual([
      ["recipe", "idle", "This site has no recipe yet."],
    ]);
    expect(lines({ page: { state: "generating" }, generation: { outcome: "sent" } })[1]).toEqual([
      "generation",
      "warn",
      "A page was sent to the AI for the site's sign-in page, and no answer was recorded.",
    ]);
  });

  it("shows another request in flight apart from the page's last answer", () => {
    // Such as the judge's on a login's next page.
    expect(lines({ asking: true })).toEqual([
      ["recipe", "idle", "This site has no recipe yet."],
      ["asking", "busy", "Waiting for an answer from the AI…"],
    ]);
    expect(
      lines({ recipe: "page", asking: true, generation: { outcome: "recipe" } }).slice(1),
    ).toEqual([
      ["generation", "ok", "The AI made a recipe for the site's sign-in page."],
      ["asking", "busy", "Waiting for an answer from the AI…"],
    ]);
    // A page sent and still out shows only its own line.
    expect(lines({ asking: true, generation: { outcome: "sent" } }).map(([id]) => id)).toEqual([
      "recipe",
      "generation",
    ]);
  });

  it("shows a request whose answer was not recorded", () => {
    expect(lines({ generation: { outcome: "sent", page: "entry" } })[1]).toEqual([
      "generation",
      "warn",
      "A page was sent to the AI for the site's sign-in link, and no answer was recorded.",
    ]);
  });

  it("shows what the AI answered", () => {
    expect(
      lines({ recipe: "page", page: { state: "generating" }, generation: { outcome: "recipe" } }),
    ).toEqual([
      ["recipe", "idle", "This site has a recipe for this page."],
      ["generation", "ok", "The AI made a recipe for the site's sign-in page."],
    ]);
    expect(lines({ generation: { outcome: "abstained", reason: "no-form" } })[1]).toEqual([
      "generation",
      "warn",
      "The AI chose not to make a recipe for the site's sign-in page (no-form).",
    ]);
    expect(lines({ generation: { outcome: "abstained" } })[1]?.[2]).toBe(
      "The AI chose not to make a recipe for the site's sign-in page (abstained).",
    );
  });

  it("shows a failed request with its reason", () => {
    expect(
      lines({ generation: { outcome: "failed", reason: "invalid-output", page: "accounts" } }),
    ).toEqual([
      ["recipe", "idle", "This site has no recipe yet."],
      [
        "generation",
        "err",
        "The AI could not make a recipe for the site's list of accounts (failed: invalid-output).",
      ],
    ]);
    expect(lines({ generation: { outcome: "unavailable" } })[1]).toEqual([
      "generation",
      "err",
      "The AI could not make a recipe for the site's sign-in page (unavailable).",
    ]);
  });

  it("shows a running login and one that waits for its result", () => {
    expect(lines({ recipe: "page", login: { state: "started" } })[1]).toEqual([
      "login",
      "busy",
      "Logging in…",
    ]);
    expect(lines({ recipe: "page", login: { state: "executing" } })[1]?.[2]).toBe("Logging in…");
    expect(lines({ login: { state: "watching", outcome: "challenge" } })[1]).toEqual([
      "login",
      "warn",
      "Waiting for you to finish the site's other step, such as a code.",
    ]);
    expect(lines({ login: { state: "watching", outcome: "unknown-submit" } })[1]).toEqual([
      "login",
      "warn",
      "The result is not known yet; the next pages are checked for it.",
    ]);
  });

  it("shows a login whose result settled as unknown as watched, not as logging in", () => {
    // Its result settled as unknown, so it runs no step and checks the next pages (ADR 0027).
    expect(
      lines({ login: { state: "reconciling", outcome: "unknown-submit", settled: true } })[1],
    ).toEqual(["login", "warn", "The result is not known yet; the next pages are checked for it."]);
    // One still observing its result, as after a restart before it settled, is in flight.
    expect(lines({ login: { state: "reconciling", outcome: "unknown-submit" } })[1]).toEqual([
      "login",
      "busy",
      "Logging in…",
    ]);
  });

  it.each(["structural-mismatch", "timeout", "retry-limit"])(
    "adds that a recipe failing with %s is not made again automatically",
    (outcome) => {
      const shown = lines({ recipe: "page", login: { state: "blocked", outcome } });
      expect(shown[1]?.[0]).toBe("login");
      expect(shown[1]?.[1]).toBe("err");
      expect(shown[1]?.[2]).toMatch(/^The login did not succeed: .+\.$/);
      expect(shown[2]).toEqual([
        "login-recipe",
        "idle",
        "This recipe is not made again automatically.",
      ]);
    },
  );

  it.each(["fill-rejected", "structural-mismatch", "cancelled"])(
    "tells the person to reload a page whose keypad Pateat pressed before a %s stop (ADR 0067)",
    (outcome) => {
      const shown = lines({ login: { state: "blocked", outcome, cause: "keypad-pressed" } });
      expect(shown.at(-1)).toEqual([
        "login-keypad",
        "warn",
        "Pateat pressed keys on the page's software keyboard before it stopped. Reload the page before you enter the value.",
      ]);
      expect(
        lines({ login: { state: "blocked", outcome, cause: "keypad-key-missing" } }).map(
          ([id]) => id,
        ),
      ).not.toContain("login-keypad");
    },
  );

  it("says why a keypad login stopped without claiming that nothing was pressed (ADR 0067)", () => {
    const why = (cause: string) =>
      lines({ login: { state: "blocked", outcome: "fill-rejected", cause } })[1]?.[2];
    expect(why("keypad-pressed")).toBe(
      "The login did not succeed: the page's software keyboard did not show a key Pateat pressed, so nothing more was pressed.",
    );
    expect(why("keypad-key-missing")).toBe(
      "The login did not succeed: the page marked a filled input as invalid, so nothing was pressed.",
    );
  });

  it("names the outcome of a failed login without the recipe line", () => {
    expect(lines({ login: { state: "blocked", outcome: "credential-rejected" } }).slice(1)).toEqual(
      [["login", "err", "The login did not succeed: the site did not accept the password."]],
    );
    // An unsettled outcome is not called a failure, as the icon's title does not.
    expect(lines({ login: { state: "blocked", outcome: "left-origin" } })[1]).toEqual([
      "login",
      "warn",
      "The result of the login is not known: the tab moved to another site during the login.",
    ]);
    expect(lines({ login: { state: "blocked", outcome: "new-outcome" } })[1]?.[2]).toBe(
      "The login did not succeed: new-outcome.",
    );
    expect(lines({ login: { state: "blocked" } })[1]?.[2]).toBe(
      "The login did not succeed: no reason was recorded.",
    );
  });

  it.each(["cancelled", "account-switched", "interrupted", "policy-changed"])(
    "says a login ended as %s stopped, not failed",
    (outcome) => {
      const shown = lines({ login: { state: "blocked", outcome } }).slice(1);
      expect(shown).toHaveLength(1);
      expect(shown[0]?.[1]).toBe("idle");
      expect(shown[0]?.[2]).toMatch(/^The login stopped: .+\.$/);
    },
  );

  it("reads a login the site's pause stopped as stopped by the pause (ADR 0062)", () => {
    expect(
      lines({ login: { state: "blocked", outcome: "policy-changed", cause: "paused" } })[1],
    ).toEqual(["login", "idle", "The login stopped: automatic login of this site was paused."]);
  });

  it("reads a cancelled login as stopped", () => {
    expect(lines({ login: { state: "blocked", outcome: "cancelled" } })[1]).toEqual([
      "login",
      "idle",
      "The login stopped: the login was cancelled.",
    ]);
  });

  it("reads a login that only fills the form while the tab asks as ended by design, not stopped", () => {
    expect(lines({ login: { state: "blocked", outcome: "cancelled", fillOnly: true } })[1]).toEqual(
      [
        "login",
        "idle",
        "While this tab asks for an account, Pateat only fills the sign-in form and presses nothing; sign in when you are ready.",
      ],
    );
    // One that stopped for another reason says so as any login does.
    expect(
      lines({
        login: {
          state: "blocked",
          outcome: "cancelled",
          cause: "document-cancelled",
          fillOnly: true,
        },
      })[1]?.[2],
    ).toBe("The login stopped: the login was cancelled.");
    expect(
      lines({ login: { state: "blocked", outcome: "wrong-account", fillOnly: true } })[1]?.[2],
    ).toBe("The login did not succeed: the page shows a different account from the one chosen.");
  });

  it("says why the page's sign-in did not start a login", () => {
    expect(lines({ recipe: "page", page: { notStarted: "logged-in" } })[1]).toEqual([
      "login",
      "idle",
      "No login started: this site is already logged in.",
    ]);
    expect(
      lines({ recipe: "page", page: { state: "denied", reason: "origin-busy" } })[1]?.[2],
    ).toBe("No login started: another tab's login to this site is running or did not succeed.");
    // The tab asks for an account (ADR 0021 D), or the site was logged in again too often
    // (ADR 0062).
    expect(
      lines({ recipe: "page", page: { state: "denied", reason: "account-asked" } })[1]?.[2],
    ).toBe("No login started: Pateat waits for you to choose an account.");
    expect(
      lines({ recipe: "page", page: { state: "denied", reason: "relogin-limit" } })[1]?.[2],
    ).toBe(
      "No login started: Pateat logged in to this site twice in the last 10 minutes; choose an account to log in again.",
    );
    // A page without a recipe is ordinary browsing.
    expect(lines({ page: { state: "denied", reason: "recipe-not-found" } })).toEqual([
      ["recipe", "idle", "This site has no recipe yet."],
    ]);
  });

  it("takes a refusal as the page's latest word over an older not-started reason", () => {
    expect(
      lines({
        recipe: "page",
        page: { state: "denied", reason: "tab-busy", notStarted: "logged-in" },
      })[1],
    ).toEqual(["login", "idle", "No login started: another login runs in this tab."]);
    // A page that only watches says why its sign-in input did not start, not an old reason.
    expect(
      lines({
        recipe: "page",
        page: { state: "watching", reason: "tab-busy", notStarted: "first-step-missing" },
      })[1]?.[2],
    ).toBe("No login started: the sign-in form shows, but the recipe's first step was not found.");
    expect(lines({ recipe: "page", page: { state: "watching", reason: "tab-busy" } })).toEqual([
      ["recipe", "idle", "This site has a recipe for this page."],
    ]);
  });

  it.each([
    ["password-empty:no-passkey", "the vault item has neither a password nor a passkey"],
    [
      "password-empty:no-advance",
      "the vault item has no password, and the recipe has no way on without one. Pateat logs in with its passkey only when the passkey needs no username, and the page asks for a passkey or the recipe presses a passkey button",
    ],
    // A recipe with several variants never goes on to the item's passkey (ADR 0036), as on a
    // page with an email and a login ID tab.
    [
      "password-empty:alternatives",
      "the vault item has no password, and Pateat goes on to a passkey only on a recipe with one way to sign in. Pateat logs in with its passkey only when the passkey needs no username, and the page asks for a passkey or the recipe presses a passkey button",
    ],
    [
      "password-empty:no-password-step",
      "the vault item has no password, and the recipe neither asks for one nor goes on to another page. Pateat logs in with its passkey only when the passkey needs no username, and the page asks for a passkey or the recipe presses a passkey button",
    ],
    [
      "password-empty:fills-lacking",
      "the vault item has no password, and the recipe needs another value the item lacks before it. Pateat logs in with its passkey only when the passkey needs no username, and the page asks for a passkey or the recipe presses a passkey button",
    ],
    [
      "password-empty:password-field",
      "the vault item has no password, and the account fills its password from another field. Pateat logs in with its passkey only when the passkey needs no username, and the page asks for a passkey or the recipe presses a passkey button",
    ],
    [
      "password-empty:later-start",
      "the vault item has no password, and this page asks for it. Pateat logs in with its passkey only when the passkey needs no username, and the page asks for a passkey or the recipe presses a passkey button",
    ],
    // A frame's login never goes on without a password, whatever the item holds.
    [
      "password-empty:frame",
      "the vault item has no password, and Pateat goes on without one only in the page itself, not in a frame",
    ],
    ["password-empty", "the vault item has no password"],
    ["password-empty:unknown-why", "the vault item has no password"],
    [
      "password-not-allowed",
      "the recipe has no way to log in with this vault item (password-not-allowed)",
    ],
    [undefined, "the recipe has no way to log in with this vault item"],
  ])("says a no-route refusal with %s stopped the login", (detail, why) => {
    expect(
      lines({
        recipe: "page",
        generation: { outcome: "recipe" },
        refused: { reason: "no-route", ...(detail ? { detail } : {}) },
      }),
    ).toEqual([
      ["recipe", "idle", "This site has a recipe for this page."],
      ["generation", "ok", "The AI made a recipe for the site's sign-in page."],
      ["refused", "err", `Pateat did not log in: ${why}.`],
    ]);
  });

  it("puts a refusal after the login before it, and shows no not-started line with it", () => {
    expect(
      lines({
        recipe: "page",
        login: { state: "blocked", outcome: "timeout" },
        refused: { reason: "attempt-limit" },
      }).map(([id]) => id),
    ).toEqual(["recipe", "login", "login-recipe", "refused"]);
    expect(
      lines({
        recipe: "page",
        page: { notStarted: "logged-in" },
        refused: { reason: "storage-unavailable" },
      }),
    ).toEqual([
      ["recipe", "idle", "This site has a recipe for this page."],
      ["refused", "err", "Pateat did not log in: Pateat could not save the login's state."],
    ]);
    expect(lines({ refused: { reason: "field-unavailable", detail: "x" } })[1]).toEqual([
      "refused",
      "err",
      "Pateat did not log in: the vault item's username could not be read, so its account cannot be found on the list.",
    ]);
    expect(lines({ refused: { reason: "attempt-limit" } })[1]?.[2]).toBe(
      "Pateat did not log in: Pateat already holds as many login records as it can.",
    );
  });
});
