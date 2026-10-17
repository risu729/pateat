import { describe, expect, it } from "vitest";
import { decideSignInState, reachedReturnTarget, type SignInSigns } from "./sign-in-state";

const none: SignInSigns = {
  s1: false,
  s2: false,
  s3: false,
  s4: false,
  s5: false,
  f1: false,
  f2: false,
  e1: false,
  e2: false,
  e3: false,
};

describe("decideSignInState", () => {
  it("follows ADR 0029's table", () => {
    expect(decideSignInState({ ...none, s1: true })).toBe("unknown");
    expect(decideSignInState({ ...none, s1: true, f1: true })).toBe("rejected");
    expect(decideSignInState({ ...none, s1: true, f2: true, e1: true })).toBe("rejected");
    // Another sign-in step outweighs evidence of a sign-in.
    expect(decideSignInState({ ...none, s3: true, e2: true })).toBe("continuing");
    expect(decideSignInState({ ...none, s2: true })).toBe("continuing");
    expect(decideSignInState({ ...none, s4: true })).toBe("continuing");
    expect(decideSignInState({ ...none, s5: true, e1: true })).toBe("continuing");
    for (const evidence of ["e1", "e2", "e3"] as const)
      expect(decideSignInState({ ...none, [evidence]: true })).toBe("signed-in");
    expect(decideSignInState(none)).toBe("judge");
  });
  it("never rejects a sign-in form shown again in a new document with a CAPTCHA", () => {
    const reshown = { ...none, s1: true, reshown: true } as const;
    expect(decideSignInState({ ...reshown, f1: true })).toBe("rejected");
    expect(decideSignInState({ ...reshown, f2: true })).toBe("rejected");
    expect(decideSignInState(reshown)).toBe("unknown");
    expect(decideSignInState({ ...reshown, s4: true, f1: true, f2: true })).toBe("unknown");
    // In the submitted document a CAPTCHA does not hold a failure off.
    expect(decideSignInState({ ...none, s1: true, s4: true, f2: true })).toBe("rejected");
  });
});

describe("reachedReturnTarget", () => {
  const start = "https://login.example/signin";
  it("accepts a same-origin path or URL named by any query value", () => {
    expect(
      reachedReturnTarget(`${start}?return_to=/settings`, "https://login.example/settings", []),
    ).toBe(true);
    expect(
      reachedReturnTarget(
        `${start}?next=%2Fmypage%3Ftab%3D1`,
        "https://login.example/mypage?x",
        [],
      ),
    ).toBe(true);
    expect(
      reachedReturnTarget(
        `${start}?continue=${encodeURIComponent("https://login.example/home")}`,
        "https://login.example/home",
        [],
      ),
    ).toBe(true);
  });
  it("refuses malformed current URLs and skips malformed return values", () => {
    for (const current of ["https://[", "/settings"])
      expect(reachedReturnTarget(`${start}?r=/settings`, current, [])).toBe(false);
    const invalid = encodeURIComponent("https://[");
    expect(reachedReturnTarget(`${start}?r=${invalid}`, "https://login.example/settings", [])).toBe(
      false,
    );
    expect(
      reachedReturnTarget(
        `${start}?r=${invalid}&next=/settings`,
        "https://login.example/settings",
        [],
      ),
    ).toBe(true);
  });
  it("refuses other origins, the top page, sign-in paths and the start page", () => {
    expect(
      reachedReturnTarget(`${start}?r=//evil.example/home`, "https://login.example/home", []),
    ).toBe(false);
    expect(
      reachedReturnTarget(`${start}?r=https://evil.example/home`, "https://evil.example/home", []),
    ).toBe(false);
    expect(reachedReturnTarget(`${start}?r=/`, "https://login.example/", [])).toBe(false);
    expect(reachedReturnTarget(`${start}?r=/signin`, "https://login.example/signin", [])).toBe(
      false,
    );
    expect(
      reachedReturnTarget(`${start}?r=/password`, "https://login.example/password", ["/password"]),
    ).toBe(false);
    // A page the query did not name, and a start URL without a query.
    expect(reachedReturnTarget(`${start}?r=/settings`, "https://login.example/home", [])).toBe(
      false,
    );
    expect(reachedReturnTarget(start, "https://login.example/home", [])).toBe(false);
    expect(reachedReturnTarget("not a url", "https://login.example/home", [])).toBe(false);
  });
  it("compares paths as observations carry them, token-like segments as [id] (ADR 0039)", () => {
    const tenant = "123e4567-e89b-12d3-a456-426614174000";
    const tenantStart = `https://login.example/${tenant}/signin`;
    // The current path comes from the content script, already with `[id]`.
    expect(
      reachedReturnTarget(
        `${tenantStart}?return_to=${encodeURIComponent(`/${tenant}/settings`)}`,
        "https://login.example/[id]/settings",
        [],
      ),
    ).toBe(true);
    // The sign-in page itself, and a recipe's sign-in path, still do not count.
    expect(
      reachedReturnTarget(
        `${tenantStart}?r=${encodeURIComponent(`/${tenant}/signin`)}`,
        "https://login.example/[id]/signin",
        [],
      ),
    ).toBe(false);
    expect(
      reachedReturnTarget(
        `${tenantStart}?r=${encodeURIComponent(`/${tenant}/password`)}`,
        "https://login.example/[id]/password",
        ["/[id]/password"],
      ),
    ).toBe(false);
  });
});
