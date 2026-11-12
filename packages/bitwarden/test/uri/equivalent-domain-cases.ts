import { expect, it } from "vitest";
import { matchBitwardenLoginUris } from "../../src/uri";
import type { EquivalentDomainContext } from "./context";

export function registerEquivalentDomains({
  emptyResult,
  saved,
  target,
  userDomains,
}: EquivalentDomainContext) {
  it("allows user groups for Domain only", () => {
    const options = { domains: userDomains([["example.com", "example.net"]]) };
    expect(
      matchBitwardenLoginUris(saved("https://example.net/login", 0), target, options),
    ).toMatchObject({ ok: true, data: { matched: true } });
    for (const match of [1, 2, 3, 5])
      expect(
        matchBitwardenLoginUris(saved("https://example.net/login", match), target, options),
      ).toEqual(emptyResult());
  });

  it.each([false, true])("uses only nonexcluded global group excluded=%s", (excluded) => {
    const domains = {
      equivalentDomains: null,
      globalEquivalentDomains: [{ type: 1, domains: ["example.com", "example.net"], excluded }],
    };
    expect(
      matchBitwardenLoginUris(saved("https://example.net/login"), target, { domains }),
    ).toMatchObject({ ok: true, data: { matched: !excluded } });
  });

  it("a user group still applies when an equivalent global group is excluded", () => {
    const domains = {
      equivalentDomains: [["example.com", "example.net"]],
      globalEquivalentDomains: [
        { type: 1, domains: ["example.com", "example.net"], excluded: true },
      ],
    };
    expect(
      matchBitwardenLoginUris(saved("https://example.net"), target, { domains }),
    ).toMatchObject({ ok: true, data: { matched: true } });
  });

  it("unions groups containing the target without transitive closure", () => {
    const domains = userDomains([
      ["example.com", "example.net"],
      ["example.net", "example.org"],
    ]);
    expect(matchBitwardenLoginUris(saved("https://example.org"), target, { domains })).toEqual(
      emptyResult(),
    );
    expect(
      matchBitwardenLoginUris(saved("https://example.org"), "https://example.net/", { domains }),
    ).toMatchObject({ ok: true, data: { matched: true } });
    expect(
      matchBitwardenLoginUris(saved("https://example.com"), "https://example.net/", { domains }),
    ).toMatchObject({ ok: true, data: { matched: true } });
  });

  it.each([undefined, null, { equivalentDomains: null, globalEquivalentDomains: null }])(
    "never invents omitted equivalent domains case %#",
    (domains) => {
      expect(matchBitwardenLoginUris(saved("https://example.net"), target, { domains })).toEqual(
        emptyResult(),
      );
    },
  );

  it("does not mutate caller-owned URI arrays or equivalent domain groups", () => {
    const uris = saved("https://example.net");
    const domains = userDomains([["example.com", "example.net"]]);
    const before = structuredClone({ uris, domains });
    expect(matchBitwardenLoginUris(uris, target, { domains })).toMatchObject({
      ok: true,
      data: { matched: true },
    });
    expect({ uris, domains }).toEqual(before);
  });
}
