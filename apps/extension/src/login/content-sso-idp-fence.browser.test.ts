import { afterEach, describe, expect, it, vi } from "vitest";
import { createSsoContent } from "./content-sso";

const chosen = "chosen@example.test";
const other = "different@example.test";
const common = { version: 1 as const, token: "document-token" };
const op = { flowId: "finite-idp-flow", operationId: "finite-idp-operation" };
const target = { by: "id" as const, value: "entry" };
const initialTitle = document.title;
type Kind = "account" | "continue" | "stay-signed-in";

function fixture(kind: Kind) {
  document.title = kind === "stay-signed-in" ? "Stay signed in?" : "Sign in";
  document.body.innerHTML =
    kind === "account"
      ? "<main><h1>Choose an account</h1><button id=entry>" + chosen + "</button></main>"
      : "<main><h1>" +
        (kind === "stay-signed-in" ? "Stay signed in?" : "Continue") +
        "</h1><p id=identity>" +
        chosen +
        "</p><button id=entry>" +
        (kind === "stay-signed-in" ? "Yes" : "Continue") +
        "</button></main>";
  const entry = document.getElementById("entry")!;
  const events: string[] = [];
  for (const name of ["pointerdown", "mousedown", "click"])
    entry.addEventListener(name, (event) => {
      events.push(name);
      if (name === "click") event.preventDefault();
    });
  const authorize = vi.fn<Parameters<typeof createSsoContent>[1]["authorize"]>(async () => true);
  const run = createSsoContent(document, { cancelled: () => false, authorize });
  const changeIdentity = () => {
    (kind === "account" ? entry : document.getElementById("identity")!).textContent = other;
  };
  const prepare = () => {
    const input = {
      ...common,
      ...op,
      type: "login.sso.prepare" as const,
      target,
      idp: { username: chosen, kind },
    };
    return run(input);
  };
  const inspect = () => run({ ...common, type: "login.sso.idp", username: chosen });
  return { entry, events, authorize, run, prepare, inspect, changeIdentity };
}
type Harness = ReturnType<typeof fixture>;
async function prepared(h: Harness) {
  expect(await h.inspect()).toMatchObject({ kind: expect.any(String), target });
  const answer = await h.prepare();
  if (!("ok" in answer) || !answer.ok || !("handle" in answer) || !answer.handle)
    throw new Error("Expected an identity-bound prepared operation");
  return { ...common, ...op, type: "login.sso.commit" as const, handle: answer.handle };
}
afterEach(() => {
  document.body.innerHTML = "";
  document.title = initialTitle;
});

describe.each(["account", "continue", "stay-signed-in"] as const)(
  "finite IdP %s identity fence",
  (kind) => {
    it("preserves an unchanged exact account through pointer and final-click authorization", async () => {
      const h = fixture(kind);
      const commit = await prepared(h);
      expect(await h.run(commit)).toMatchObject({ ok: true });
      expect(h.events.filter((event) => event === "click")).toHaveLength(1);
      expect(h.authorize.mock.calls.map(([input]) => input.phase)).toEqual(["pointer", "click"]);
    });
    it("rejects a changed identity between the initial reading and preparation", async () => {
      const h = fixture(kind);
      expect(await h.inspect()).toMatchObject({ kind, target });
      h.changeIdentity();
      expect(document.getElementById("entry")).toBe(h.entry);
      expect(await h.prepare()).toMatchObject({ ok: false });
      expect(h.authorize).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
    });
    it("rejects the same-ID control when its identity changes after preparation", async () => {
      const h = fixture(kind);
      const commit = await prepared(h);
      h.changeIdentity();
      expect(document.getElementById("entry")).toBe(h.entry);
      expect(await h.run(commit)).toMatchObject({ ok: false });
      expect(h.events).not.toContain("click");
    });
    it("rechecks the exact account after a pointerdown listener changes it", async () => {
      const h = fixture(kind);
      const commit = await prepared(h);
      h.entry.addEventListener("pointerdown", h.changeIdentity);
      expect(await h.run(commit)).toMatchObject({ ok: false });
      expect(h.events).toContain("pointerdown");
      expect(h.events).not.toContain("click");
      expect(h.authorize.mock.calls.some(([input]) => input.phase === "click")).toBe(false);
    });
    it("rejects an identity changed while pointer authorization is awaiting its answer", async () => {
      const h = fixture(kind);
      const commit = await prepared(h);
      let allow!: (result: boolean) => void;
      h.authorize.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            allow = resolve;
          }),
      );
      const pending = h.run(commit);
      expect(h.authorize).toHaveBeenCalledTimes(1);
      h.changeIdentity();
      allow(true);
      expect(await pending).toMatchObject({ ok: false });
      expect(h.events).toEqual([]);
    });
    it("rejects an identity changed during final-click authorization after pointer events", async () => {
      const h = fixture(kind);
      const commit = await prepared(h);
      let allow!: (result: boolean) => void;
      let reached!: () => void;
      const atClick = new Promise<void>((resolve) => {
        reached = resolve;
      });
      h.authorize.mockImplementation(async (input) => {
        if (input.phase === "pointer") return true;
        reached();
        return new Promise<boolean>((resolve) => {
          allow = resolve;
        });
      });
      const pending = h.run(commit);
      await atClick;
      expect(h.events).toContain("pointerdown");
      h.changeIdentity();
      allow(true);
      expect(await pending).toMatchObject({ ok: false });
      expect(h.events).not.toContain("click");
    });
  },
);
