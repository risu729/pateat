import { describe, expect, it, vi } from "vitest";
import type { Runtime } from "../state";

vi.mock("wxt/browser", () => ({ browser: {} }));
vi.mock("../attempt", () => ({ saveSession: vi.fn(async () => undefined) }));
vi.mock("../session-store", () => ({
  quietly: (_rt: unknown, work: () => Promise<unknown>) => work(),
}));
const { fenceHandoff, handoffMiss, liftHandoffFence } = await import("./handoff");

// The fence a hand-off leaves on its page (#1847): a sign-in lifts it only for its own site.
const runtime = () => ({ ssoHandoffs: new Map<string, string>() }) as unknown as Runtime;
const item = { fields: [{ id: "login.username", label: "Username", name: null, kind: "text" }] };
const observation = {
  version: 1,
  origin: "https://app.example.com",
  path: "/session",
  language: "en",
  complete: true,
  candidates: [{ id: "c1", role: "email", target: { by: "id", value: "email" }, label: "Email" }],
} as never;
const page = { tabId: 1, origin: "https://app.example.com", path: "/session", manual: false };
const miss = (rt: Runtime, manual = false) =>
  handoffMiss(rt, { ...page, manual }, item as never, ["login.username"], observation);

describe("a hand-off's page fence", () => {
  it("names why the page was fenced, typed or refused, but never for Log in now", () => {
    const rt = runtime();
    expect(miss(rt)).toBeUndefined();
    fenceHandoff(rt, 1, page.origin, page.path, "no-route:sso-identifier:fills-other");
    expect(miss(rt)).toBe("no-route:sso-identifier:fills-other");
    expect(miss(rt, true)).toBeUndefined();
    fenceHandoff(rt, 1, page.origin, page.path);
    expect(miss(rt)).toBe("typed");
  });

  it("is lifted by a sign-in of the same site in the tab, not of another site", () => {
    const rt = runtime();
    fenceHandoff(rt, 1, page.origin, page.path);
    fenceHandoff(rt, 2, page.origin, page.path);
    liftHandoffFence(rt, 1, ["https://other.example"]);
    expect(miss(rt)).toBe("typed");
    liftHandoffFence(rt, 1, ["https://portal.example.com"]);
    expect(miss(rt)).toBeUndefined();
    // The other tab's page stays fenced.
    expect(rt.ssoHandoffs.get(`2 ${page.origin}${page.path}`)).toBe("typed");
  });
});
