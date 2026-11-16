import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginStep, SettingsChangeCause, SettingsSnapshot } from "@pateat/contracts";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, userId, itemId, harness, uriMatch } = createRuntimeTestHarness(fake);

/**
 * A settings revision another tab's SSO choice wrote (ADR 0085): it saves one mapping,
 * with its cause, as the settings store records it.
 */
function revise(settings: SettingsSnapshot, cause: SettingsChangeCause) {
  settings.revision += 1;
  settings.changes = [...(settings.changes ?? []), { revision: settings.revision, cause }];
  if (cause !== "sso-mapping") return;
  const account = { provider: "bitwarden", server: "cloud-us", userId };
  settings.settings.ssoMappings = [
    ...(settings.settings.ssoMappings ?? []),
    {
      ...account,
      itemId: `a0000000-0000-4000-8000-${String(settings.revision).padStart(12, "0")}`,
      method: 1,
      idp: { ...account, itemId, origin: "https://idp.example" },
    },
  ];
}
const attempts = () => fake.state.storage["pateat.login-attempts.v5"];

describe("running logins and SSO mapping revisions (ADR 0085)", () => {
  afterEach(() => {
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2, 3, 4]) listener(tabId);
    fake.state.replaced.length = 0;
  });
  beforeEach(() => {
    fake.state.storage = {};
    fake.state.session = {};
    fake.state.badges = {};
    fake.state.reconnects = [];
    fake.state.onReconnect = undefined;
    fake.state.messages = [];
    fake.state.granted = true;
    fake.state.pageUrl = "https://login.example/signin";
    fake.state.onExecute = undefined;
    fake.state.tabUrls = {};
    fake.state.incognito = new Set();
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin";
    fake.state.present = undefined;
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.disabled = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.siteAccount = { ok: false };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    fake.state.loaded = true;
    fake.state.openTabs = undefined;
  });

  it("keeps a login through mapping revisions while it waits, and saves its account choice", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness(
      { siteDefaults: [], bindings: [] },
      { allowedOrigins: [], uris: async () => ({ ok: true, data: uriMatch() }), report },
    );
    fake.state.onAwait = () => {
      revise(h.settings, "sso-mapping");
      revise(h.settings, "sso-mapping");
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
    await vi.waitFor(() =>
      expect(report.mock.calls.map(([entry]) => entry)).toContainEqual({
        type: "choice",
        tabId: 1,
        origin,
        outcome: "saved",
      }),
    );
    expect(h.settings.settings.siteDefaults).toMatchObject([{ origin, itemId }]);
    expect(h.settings.changes?.at(-1)?.cause).toBe("account-choice");
    // The choice is checked in the settings queue against revision 1 the login ran
    // with, which only mapping revisions followed.
    const [expected, cause, , authorize] = h.store.update.mock.calls[0]!;
    expect([expected, cause]).toEqual([undefined, "account-choice"]);
    const before = h.settings.revision - 1;
    const queued = (extra: SettingsChangeCause[]) => ({
      ...h.settings,
      revision: before + extra.length,
      changes: [
        ...(h.settings.changes ?? []).filter((entry) => entry.revision <= before),
        ...extra.map((entry, index) => ({ revision: before + index + 1, cause: entry })),
      ],
    });
    const catalog = async () => ({ connections: [] });
    expect(await authorize!(queued([]), catalog)).toBe(true);
    expect(await authorize!(queued(["vault-sync"]), catalog)).toBe(false);
  });

  it.each(["vault-sync", "account-choice"] as const)(
    "still stops a login after a revision of another cause: %s",
    async (cause) => {
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { report });
      fake.state.onAwait = () => {
        revise(h.settings, "sso-mapping");
        revise(h.settings, cause);
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(attempts()).toMatchObject([{ state: "blocked", outcome: "policy-changed" }]),
      );
      expect(report.mock.calls.at(-1)![0]).toMatchObject({ cause: "settings-revision" });
      expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.execute");
    },
  );

  it.each([
    ["resumes a login on its next page after a mapping revision", "sso-mapping", "authenticated"],
    ["stops a resumed login after a revision of another cause", "vault-sync", "blocked"],
  ] as const)("%s", async (_name, cause, state) => {
    const h = harness();
    // The click submits the form, and the page navigates before the result is observed.
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as { step: LoginStep }).step.kind === "click")
        fake.state.gone.add("synthetic-document");
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(attempts()).toMatchObject([{ state: "reconciling", stepIndex: 1 }]),
    );
    revise(h.settings, cause);
    expect(await h.hello({ documentId: "next-document" }, false)).toEqual({ ok: true });
    await vi.waitFor(() => expect(attempts()).toMatchObject([{ state }]));
  });
});
