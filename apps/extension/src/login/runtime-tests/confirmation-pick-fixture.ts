// The shared setup of the popup's **Fill** tests (ADR 0035, amended 2026-11-17): a tab
// whose site Pateat did not log in to, with both items matching its pages.
import * as v from "valibot";
import { expect, vi } from "vitest";
import { parseLoginRecipe, type LocalSettings } from "@pateat/contracts";
import { manualOfferResponseSchema } from "../manual-wire";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
import { confirmationFixture } from "./confirmation-fixture";
import type { createBrowserFake } from "./browser-fake";

export function pickFixture(fake: ReturnType<typeof createBrowserFake>) {
  const base = confirmationFixture(fake);
  const {
    harness,
    origin,
    itemId,
    otherItemId,
    connectionId,
    sender,
    target,
    uriMatch,
    popup,
    executes,
    liveDefault,
    cached,
    startsOf,
    settled,
  } = base;
  type H = ReturnType<typeof harness>;

  function generation() {
    const answer = Promise.withResolvers<Awaited<ReturnType<LoginGeneration["generate"]>>>();
    const service = {
      available: vi.fn<LoginGeneration["available"]>(async () => true),
      generate: vi.fn<LoginGeneration["generate"]>(async (_request, sent) => {
        sent?.();
        return answer.promise;
      }),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    };
    return { service, answer };
  }

  /** Both items match every page of the site. */
  const both = async (_connection: string, url: string) => ({
    ok: true as const,
    data: uriMatch({
      targetOrigin: new URL(url).origin,
      candidates: [
        { itemId, matches: [{ uriIndex: 0, match: 0 }] },
        { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
      ],
    }),
  });

  /** A tab whose site Pateat did not log in to, with both items matching its pages. */
  function start(settings: Partial<LocalSettings> = {}, live: Parameters<typeof harness>[1] = {}) {
    const reports: LoginReport[] = [];
    const h = harness(
      // Both items are eligible on the site; the default is the first.
      { siteDefaults: [liveDefault()], ...settings },
      { uris: both, ...live, report: (entry) => reports.push(entry) },
    );
    return { h, reports };
  }
  const offers = async (h: H) =>
    v.parse(
      manualOfferResponseSchema,
      await h.login.handle({ version: 1, type: "login.manual.get", tabId: 1 }, popup),
    );
  async function press(h: H, item = otherItemId, frameId = 0, requestId = "fill-press") {
    const offered = await offers(h);
    if (!offered.ok) throw new Error("No page");
    const selected = offered.targets.find((entry) => entry.document.frameId === frameId);
    if (!selected) throw new Error(`No target in frame ${frameId}: ${JSON.stringify(offered)}`);
    return h.login.handle(
      {
        version: 1,
        type: "login.confirm.fill",
        requestId,
        document: selected.document,
        scope: selected.scope,
        connectionId,
        itemId: item,
      },
      popup,
    );
  }
  const clicks = () => executes().filter((entry) => entry.operation.step.kind === "click");

  /** A secret-answer page without a recipe, as the content script reports one. */
  function secretAnswer(h: H) {
    h.recipes.recipe.mockResolvedValue(undefined);
    h.recipes.routes.mockResolvedValue([]);
    h.recipes.starts.mockResolvedValue([]);
    fake.state.pageUrl = `${origin}/confirm`;
    fake.state.observedPath = "/confirm";
    fake.state.present = new Set(["password", "login"]);
    fake.state.extracted["login"] = {
      ok: true,
      observation: {
        version: 1,
        origin,
        path: "/confirm",
        language: "en",
        complete: true,
        candidates: [
          { id: "password", role: "password", target: target("password") },
          { id: "login", role: "button", target: target("login"), label: "Confirm" },
        ],
      },
    };
    return (from: Record<string, unknown> = {}) =>
      h.login.handle(
        {
          version: 1,
          type: "login.document.ready",
          token: "synthetic-token",
          unoffered: { path: "/confirm", why: "text-answer" },
        },
        sender({ documentId: "confirmation-document", ...from }),
      );
  }

  const generated = () => parseLoginRecipe({ ...cached(), pageKind: "sign-in" });
  /** The origin's recipes once the page came back as a sign-in page that starts on its path. */
  function signInCached(on: H) {
    on.recipes.routes.mockResolvedValue([generated()]);
    on.recipes.recipe.mockResolvedValue(generated());
    on.recipes.starts.mockResolvedValue(startsOf([generated().steps[0]!]));
  }
  /** The pressed page announces with its first step ready, as a sign-in form's page does. */
  const ready = (on: H) => on.hello({ documentId: "confirmation-document" });

  /** A secret-answer page a press sent for generation, which came back as a sign-in page. */
  async function heldPage(live: Parameters<typeof harness>[1] = {}) {
    const { service, answer } = generation();
    const { h } = start({}, { generation: service, custom: [], ...live });
    await secretAnswer(h)();
    fake.state.onReconnect = () => ready(h);
    expect(await press(h)).toMatchObject({ ok: true, state: "generating" });
    await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
    signInCached(h);
    answer.resolve({ outcome: "recipe", recipe: generated() });
    await vi.waitFor(async () =>
      expect(await offers(h)).toMatchObject({
        fill: { state: "blocked", reason: "not-a-verification-page" },
      }),
    );
    await settled(h);
    expect(executes()).toEqual([]);
    return h;
  }

  return {
    ...base,
    generation,
    both,
    start,
    offers,
    press,
    clicks,
    secretAnswer,
    generated,
    signInCached,
    ready,
    heldPage,
  };
}
