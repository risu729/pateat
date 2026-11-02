import { describe, expect, it } from "vitest";
import { loginMoveFits, registrableSite } from "./site";

// Every pair of origins from a set covering each kind the rule tells apart, checked against
// ADR 0022's move rule (with ADR 0050 for HTTP). The table tests in site.test.ts check
// single pairs.

const hosts = [
  "login.example.com",
  "www.example.com",
  "example.com",
  "other.example",
  "a.example.co.uk",
  "b.example.co.uk",
  "co.uk",
  "alice.github.io",
  "bob.github.io",
  "localhost",
  "127.0.0.1",
  "[::1]",
];
const origins = [
  ...hosts.flatMap((host) => [`https://${host}`, `http://${host}`, `https://${host}:8443`]),
  "chrome-extension://abc",
  "not a url",
];
const cases = origins.flatMap((login) =>
  origins.flatMap((page) =>
    [false, true].map((afterSecondFactor) => ({
      login,
      page,
      afterSecondFactor,
      fits: loginMoveFits(login, page, afterSecondFactor),
    })),
  ),
);

const broken = (rule: (o: (typeof cases)[number]) => boolean) =>
  cases.filter((o) => !rule(o)).slice(0, 5);

describe("a login's move to another origin, over every pair of origins (ADR 0022)", () => {
  it("walks every pair", () => {
    expect(cases.length).toBe(origins.length ** 2 * 2);
  });

  it("never moves to a page that is not HTTPS, unless the login itself is on HTTP (ADR 0050)", () => {
    expect(
      broken(
        (o) =>
          !o.fits ||
          o.page.startsWith("https://") ||
          (o.page.startsWith("http://") && o.login.startsWith("http://")),
      ),
    ).toEqual([]);
  });

  it("moves without a second factor only within the login's registrable site, and stays on its own origin", () => {
    expect(
      broken(
        (o) =>
          (o.afterSecondFactor ||
            !o.fits ||
            (registrableSite(o.login) !== undefined &&
              registrableSite(o.page) === registrableSite(o.login))) &&
          (o.login !== o.page ||
            !/^https?:/u.test(o.page) ||
            registrableSite(o.page) === undefined ||
            o.fits),
      ),
    ).toEqual([]);
  });

  it("allows after a second factor every move it allows before one, and any site with a domain", () => {
    expect(
      broken((o) => {
        const after = loginMoveFits(o.login, o.page, true);
        const before = loginMoveFits(o.login, o.page, false);
        return (
          (!before || after) &&
          (!o.afterSecondFactor ||
            o.fits ===
              (registrableSite(o.page) !== undefined &&
                (o.page.startsWith("https://") ||
                  (o.page.startsWith("http://") && o.login.startsWith("http://")))))
        );
      }),
    ).toEqual([]);
  });

  it("never moves to a bare public suffix or a value that is no web origin", () => {
    expect(
      broken(
        (o) =>
          !o.fits ||
          !(o.page.includes("://co.uk") || o.page === "not a url" || o.page.startsWith("chrome-")),
      ),
    ).toEqual([]);
  });
});
