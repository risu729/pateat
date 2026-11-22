import { afterEach, describe, expect, it, vi } from "vitest";
import { createSsoContent } from "./content-sso";

// A native login's stay-signed-in question after its submit (ADR 0065 amendment of
// 2026-11-22): read as an IdP's (`readSsoIdp`), prepared only for its Yes button, and
// pressed once in the document under the same checks before the pointer events and the
// click. A synthetic page shaped like the one UNSW Connect's sign-in showed on 2026-11-21.
const chosen = "chosen@example.test";
const other = "different@example.test";
const common = { version: 1 as const, token: "document-token" };
const attempt = { attemptId: "native-attempt", operationId: "stay-operation" };
const initialTitle = document.title;

function fixture(heading = "Stay signed in?") {
  document.title = "Sign in to your account";
  document.body.innerHTML = `<main>
    <div id=identity>${chosen}</div>
    <h1 id=heading>${heading}</h1>
    <p>Do this to reduce the number of times you are asked to sign in.</p>
    <form method=post action=/kmsi>
      <label><input type=checkbox name=dontShow> Don't show this again</label>
      <input type=button id=no value=No>
      <input type=submit id=yes value=Yes>
    </form>
  </main>`;
  const events: string[] = [];
  for (const id of ["yes", "no"])
    for (const name of ["pointerdown", "mousedown", "click"])
      document.getElementById(id)!.addEventListener(name, (event) => {
        events.push(`${id}:${name}`);
        if (name === "click") event.preventDefault();
      });
  type Options = Parameters<typeof createSsoContent>[1];
  const authorize = vi.fn<Options["authorize"]>(async () => true);
  const authorizeStay = vi.fn<NonNullable<Options["authorizeStay"]>>(async () => true);
  const cancelledAttempts = new Set<string>();
  const run = createSsoContent(document, {
    cancelled: () => false,
    authorize,
    authorizeStay,
    attemptCancelled: (attemptId) => cancelledAttempts.has(attemptId),
  });
  const prepare = (username = chosen) =>
    run({ ...common, ...attempt, type: "login.stay.prepare", username });
  const commit = async () => {
    const answer = await prepare();
    if (!("handle" in answer) || !answer.handle) throw new Error("Expected a prepared press");
    return { ...common, ...attempt, type: "login.stay.commit" as const, handle: answer.handle };
  };
  return { events, authorize, authorizeStay, cancelledAttempts, run, prepare, commit };
}
afterEach(() => {
  document.body.innerHTML = "";
  document.title = initialTitle;
});

describe("a native login's stay-signed-in question", () => {
  it("prepares the page's Yes button and presses it once, as the worker authorizes", async () => {
    const h = fixture();
    const answer = await h.prepare();
    expect(answer).toMatchObject({
      ok: true,
      url: document.URL,
      destinations: [new URL("/kmsi", document.URL).href],
    });
    const press = await h.commit();
    expect(await h.run(press)).toEqual({ ok: true });
    expect(h.events).toEqual(["yes:pointerdown", "yes:mousedown", "yes:click"]);
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.authorizeStay.mock.calls.map(([input]) => input)).toEqual(
      (["pointer", "click"] as const).map((phase) => ({ ...attempt, handle: press.handle, phase })),
    );
    // The document presses the question at most once, whatever it is asked again.
    expect(await h.prepare()).toEqual({ ok: false, reason: "already-pressed" });
    expect(await h.run(press)).toMatchObject({ ok: false });
    expect(h.events.filter((event) => event.endsWith("click"))).toHaveLength(1);
  });

  it("prepares nothing on a page that is no stay-signed-in question for the account", async () => {
    expect(await fixture().prepare(other)).toMatchObject({ ok: false });
    expect(await fixture("Choose how to sign in").prepare()).toEqual({
      ok: false,
      reason: "idp-unknown",
    });
  });

  it("presses nothing once the page changed after the preparation", async () => {
    const h = fixture();
    const press = await h.commit();
    document.getElementById("identity")!.textContent = other;
    expect(await h.run(press)).toMatchObject({ ok: false });
    expect(h.events).toEqual([]);
  });

  it("reads the page again after the pointer events, before the click", async () => {
    const h = fixture();
    const press = await h.commit();
    document.getElementById("yes")!.addEventListener("pointerdown", () => {
      document.getElementById("heading")!.textContent = "Approve sign in request";
    });
    expect(await h.run(press)).toMatchObject({ ok: false });
    expect(h.events).toContain("yes:pointerdown");
    expect(h.events).not.toContain("yes:click");
    // A press the page stopped is spent: it is never tried again in this document.
    expect(await h.prepare()).toEqual({ ok: false, reason: "already-pressed" });
  });

  it("keeps a stay-signed-in preparation apart from the SSO protocol's", async () => {
    const h = fixture();
    const press = await h.commit();
    expect(
      await h.run({
        ...common,
        type: "login.sso.commit",
        flowId: attempt.attemptId,
        operationId: attempt.operationId,
        handle: press.handle,
      }),
    ).toEqual({ ok: false, reason: "operation-gone" });
    const again = await h.commit();
    expect(await h.run({ ...again, attemptId: "another-attempt" })).toEqual({
      ok: false,
      reason: "operation-gone",
    });
    expect(h.events).toEqual([]);
  });

  it("presses nothing the worker does not authorize", async () => {
    const h = fixture();
    h.authorizeStay.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await h.run(await h.commit())).toMatchObject({ ok: false, reason: "not-authorized" });
    expect(h.events).toEqual(["yes:pointerdown", "yes:mousedown"]);
  });

  it("presses nothing for a native attempt the SSO coordinator cancelled", async () => {
    const h = fixture();
    const press = await h.commit();
    h.cancelledAttempts.add(attempt.attemptId);
    expect(await h.run(press)).toMatchObject({ ok: false });
    expect(h.events).toEqual([]);
    const later = fixture();
    later.cancelledAttempts.add(attempt.attemptId);
    expect(await later.prepare()).toEqual({ ok: false, reason: "cancelled" });
  });

  it("checks the attempt again after the pointer events", async () => {
    const h = fixture();
    const press = await h.commit();
    document.getElementById("yes")!.addEventListener("pointerdown", () => {
      h.cancelledAttempts.add(attempt.attemptId);
    });
    expect(await h.run(press)).toMatchObject({ ok: false });
    expect(h.events).not.toContain("yes:click");
  });
});
