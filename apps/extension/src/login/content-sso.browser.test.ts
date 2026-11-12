import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginTarget } from "@pateat/contracts";
import { createSsoContent, readSsoIdp, ssoUnsafePage } from "./content-sso";
import type { SsoContentCommand } from "./sso-operation-wire";

const target: LoginTarget = { by: "id", value: "entry" };
const common = { version: 1 as const, token: "document-token" };
const op = { flowId: "flow", operationId: "operation" };
const initialTitle = document.title;
const initialUrl = location.href;
const html = (body: string, title = "Sign in") => {
  document.title = title;
  document.body.innerHTML = "<main>" + body + "</main>";
};
const command = (type: "inspect" | "prepare"): SsoContentCommand =>
  type === "inspect"
    ? { ...common, type: "login.sso.inspect", target }
    : { ...common, type: "login.sso.prepare", ...op, target };
function harness() {
  let cancelled = false;
  const authorize = vi.fn<Parameters<typeof createSsoContent>[1]["authorize"]>(async () => true);
  const run = createSsoContent(document, { cancelled: () => cancelled, authorize });
  const events: string[] = [];
  for (const type of ["pointerover", "pointerdown", "mousedown", "pointerup", "click"])
    document.getElementById("entry")?.addEventListener(type, (event) => {
      events.push(type);
      if (type === "click") event.preventDefault();
    });
  return {
    run,
    authorize,
    events,
    cancel: () => {
      cancelled = true;
    },
  };
}
type Handler = ReturnType<typeof createSsoContent>;
async function prepare(run: Handler) {
  const reply = await run(command("prepare"));
  if (!("ok" in reply) || !reply.ok || !("handle" in reply) || !reply.handle)
    throw new Error("Expected prepared DOM handle: " + JSON.stringify(reply));
  return { ...common, type: "login.sso.commit" as const, ...op, handle: reply.handle };
}
beforeEach(() => html('<button id="entry" type="button">Continue with Synthetic</button>'));
afterEach(() => {
  history.replaceState(null, "", initialUrl);
  document.title = initialTitle;
  document.body.innerHTML = "";
});

describe("SSO prepared DOM operations", () => {
  it("inspects and prepares without any page event, then authorizes before the first event and consumes once", async () => {
    const h = harness();
    expect(await h.run(command("inspect"))).toEqual({
      ok: true,
      url: document.URL,
      destinations: [],
    });
    const commit = await prepare(h.run);
    expect(h.events).toEqual([]);
    expect(h.authorize).not.toHaveBeenCalled();
    h.authorize.mockImplementation(async (input) => {
      expect(input).toMatchObject(op);
      expect(input.handle).toBe(commit.handle);
      expect(h.events).toEqual([]);
      return true;
    });
    expect(await h.run(commit)).toEqual({ ok: true });
    expect(h.events).toContain("click");
    expect(h.authorize).toHaveBeenCalledTimes(1);
    expect(await h.run(commit)).toEqual({ ok: false, reason: "operation-gone" });
    expect(h.events.filter((event) => event === "click")).toHaveLength(1);
  });
  it("consumes a handle even when authorization refuses or its acknowledgement is unknown", async () => {
    const h = harness();
    const denied = await prepare(h.run);
    h.authorize.mockResolvedValueOnce(false);
    expect(await h.run(denied)).toEqual({ ok: false, reason: "not-authorized" });
    expect(await h.run(denied)).toEqual({ ok: false, reason: "operation-gone" });
    const unknown = await prepare(h.run);
    h.authorize.mockRejectedValueOnce(new Error("unknown acknowledgement"));
    await expect(h.run(unknown)).rejects.toThrow("unknown acknowledgement");
    expect(await h.run(unknown)).toEqual({ ok: false, reason: "operation-gone" });
    expect(h.events).toEqual([]);
  });
  it("consumes before awaiting authorization, so a concurrent replay cannot mutate", async () => {
    const h = harness();
    let allow!: (allowed: boolean) => void;
    h.authorize.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          allow = resolve;
        }),
    );
    const commit = await prepare(h.run);
    const first = h.run(commit);
    expect(await h.run(commit)).toEqual({ ok: false, reason: "operation-gone" });
    expect(h.events).toEqual([]);
    allow(true);
    expect(await first).toEqual({ ok: true });
    expect(h.authorize).toHaveBeenCalledTimes(1);
    expect(h.events.filter((event) => event === "click")).toHaveLength(1);
  });
  it.each(["flowId", "operationId", "handle"] as const)(
    "rejects a mismatched %s before authorization",
    async (field) => {
      const h = harness();
      const commit = await prepare(h.run);
      expect(await h.run({ ...commit, [field]: "other" })).toEqual({
        ok: false,
        reason: "operation-gone",
      });
      expect(h.authorize).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
    },
  );
  it("withdraws the previous prepared object when a new one is prepared", async () => {
    const h = harness();
    const old = await prepare(h.run);
    const fresh = await prepare(h.run);
    expect(old.handle).not.toBe(fresh.handle);
    expect(await h.run(old)).toEqual({ ok: false, reason: "operation-gone" });
    expect(await h.run(fresh)).toEqual({ ok: true });
    expect(h.events.filter((event) => event === "click")).toHaveLength(1);
  });
  it.each(["cancel", "replace", "duplicate", "disable", "hide", "path", "unsafe"])(
    "rechecks %s after the asynchronous authorization and before any mutation",
    async (change) => {
      const h = harness();
      const commit = await prepare(h.run);
      h.authorize.mockImplementationOnce(async () => {
        const entry = document.getElementById("entry")!;
        if (change === "cancel") h.cancel();
        if (change === "replace") entry.replaceWith(entry.cloneNode(true));
        if (change === "duplicate") entry.after(entry.cloneNode(true));
        if (change === "disable") (entry as HTMLButtonElement).disabled = true;
        if (change === "hide") entry.hidden = true;
        if (change === "path") history.replaceState(null, "", location.pathname + "?changed=1");
        if (change === "unsafe") document.title = "Grant access permissions";
        return true;
      });
      expect(await h.run(commit)).toEqual({ ok: false, reason: "target-changed" });
      expect(h.events).toEqual([]);
      expect(await h.run(commit)).toEqual({ ok: false, reason: "operation-gone" });
    },
  );
  it("rechecks the exact observed navigation destination after authorization", async () => {
    html('<a id="entry" href="https://idp.example.test/authorize">Continue with Synthetic</a>');
    const h = harness();
    expect(await h.run(command("inspect"))).toMatchObject({
      ok: true,
      destinations: ["https://idp.example.test/authorize"],
    });
    const commit = await prepare(h.run);
    h.authorize.mockImplementationOnce(async () => {
      (document.getElementById("entry") as HTMLAnchorElement).href = "https://other.example.test/";
      return true;
    });
    expect(await h.run(commit)).toEqual({ ok: false, reason: "target-changed" });
    expect(h.events).toEqual([]);
  });
  it.each([
    '<a id="entry" href="https://idp.example.test/" target="_blank">Continue</a>',
    '<a id="entry" href="https://idp.example.test/" download>Continue</a>',
    '<form target="_blank"><button id="entry">Continue</button></form>',
    '<form><button id="entry" formtarget="named">Continue</button></form>',
    '<a id="entry" href="javascript:void(0)">Continue</a>',
    '<a id="entry" href="https://user:password@idp.example.test/">Continue</a>',
  ])(
    "refuses a new browsing context or unsafe destination %# before authorization",
    async (markup) => {
      html(markup);
      const h = harness();
      expect(await h.run(command("prepare"))).toMatchObject({ ok: false });
      expect(h.authorize).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
    },
  );
  it("stops when the document becomes unsafe during pointer dispatch without clicking or replaying", async () => {
    const h = harness();
    document.getElementById("entry")!.addEventListener("pointerdown", () => {
      document.title = "Share account data";
    });
    const commit = await prepare(h.run);
    await h.run(commit);
    expect(h.events).toContain("pointerdown");
    expect(h.events).not.toContain("click");
    expect(await h.run(commit)).toEqual({ ok: false, reason: "operation-gone" });
  });
  it("cancellation clears prepared handles and produces no authorization or page mutation", async () => {
    const h = harness();
    const commit = await prepare(h.run);
    h.cancel();
    expect(await h.run(commit)).toEqual({ ok: false, reason: "cancelled" });
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });
});

describe("finite local IdP page reading", () => {
  const username = "synthetic.person@example.test";
  it("recognizes native input forms without releasing or returning the username", () => {
    html(
      '<form><label>Email<input type="email" autocomplete="username"></label><button>Next</button></form>',
    );
    expect(readSsoIdp(document, username)).toEqual({ kind: "native" });
  });
  it("selects a full exact username locally and accepts surrounding whitespace and case only", () => {
    html(
      '<h1>Choose an account</h1><button id="entry">Other other@example.test</button><button id="chosen">SYNTHETIC.PERSON@EXAMPLE.TEST</button>',
    );
    expect(readSsoIdp(document, "  " + username + "  ")).toMatchObject({
      kind: "account",
      target: { by: "id", value: "chosen" },
    });
  });
  it.each([
    "s***@example.test",
    "synthetic.••••@example.test",
    "other@example.test",
    "person@example.test",
  ])("never selects a masked, partial or different identity %s", (shown) => {
    html('<h1>Choose an account</h1><button id="entry">' + shown + "</button>");
    expect(["unknown", "unsafe"]).toContain(readSsoIdp(document, username).kind);
  });
  it("refuses ambiguous controls for the same exact identity", () => {
    html(
      '<button id="entry">' + username + '</button><button id="other">' + username + "</button>",
    );
    expect(readSsoIdp(document, username)).toEqual({ kind: "unsafe", reason: "ambiguous-account" });
  });
  it.each([
    { title: "Continue", label: "Continue", kind: "continue" },
    { title: "Stay signed in?", label: "Yes", kind: "stay-signed-in" },
  ])(
    "permits only an explicit $kind with the full selected identity shown",
    ({ title, label, kind }) => {
      html(
        "<h1>" + title + "</h1><p>" + username + '</p><button id="entry">' + label + "</button>",
        title,
      );
      expect(readSsoIdp(document, username)).toMatchObject({
        kind,
        target: { by: "id", value: "entry" },
      });
    },
  );
  it("does not infer account authority from a Continue or stay-signed-in button alone", () => {
    for (const title of ["Continue", "Stay signed in?"]) {
      html("<h1>" + title + '</h1><button id="entry">Continue</button>', title);
      expect(readSsoIdp(document, username)).toEqual({ kind: "unknown" });
    }
  });
  it.each([
    "Permissions",
    "Grant access",
    "Create account",
    "Sign up",
    "Share email",
    "同意",
    "新規アカウント作成",
  ])("stops an unsafe %s heading even when an exact account control exists", (heading) => {
    html("<h1>" + heading + '</h1><button id="entry">' + username + "</button>");
    expect(ssoUnsafePage(document)).toBe(true);
    expect(readSsoIdp(document, username).kind).toBe("unsafe");
  });
  it.each([
    "This app can access your account data.",
    "Your email and account details will be shared with this site.",
    "Allow this app permission to read your data?",
  ])("stops body-only permission or sharing disclosures: %s", (disclosure) => {
    html(
      "<h1>Choose an account</h1><p>" +
        disclosure +
        '</p><button id="entry">' +
        username +
        "</button>",
    );
    expect(readSsoIdp(document, username).kind).toBe("unsafe");
  });
  it.each([
    '<h1>Sign in</h1><button id="entry">Continue with another provider</button>',
    '<h1>Choose a provider</h1><a href="https://other-idp.example.test/">Other IdP</a>',
    '<h1>Browser sign-in</h1><div data-fedcm="true"></div>',
  ])(
    "does not turn nested SSO or browser-owned identity UI into an intermediate operation %#",
    (markup) => {
      html(markup);
      expect(readSsoIdp(document, username)).toEqual({ kind: "unknown" });
    },
  );
  it("recognizes a full exact non-email username on a finite Continue page", () => {
    html('<h1>Continue</h1><p>synthetic-user</p><button id="entry">Continue</button>');
    expect(readSsoIdp(document, "synthetic-user")).toMatchObject({
      kind: "continue",
      target: { by: "id", value: "entry" },
    });
  });
  it("does not match a non-email username merely as a substring of a different identity", () => {
    html(
      '<h1>Continue</h1><p>other-synthetic-user-account</p><button id="entry">Continue</button>',
    );
    expect(["unknown", "unsafe"]).toContain(readSsoIdp(document, "synthetic-user").kind);
  });
});
