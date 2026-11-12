import { expect, it } from "vitest";
import { rawV1Account, rawV2Account } from "../../src/__fixtures__/account";
import type { AccountTestRaw as Raw } from "../../src/account.test";
import type { SameAccountUriContext } from "./context";

export function registerSameAccountUriCases({ mapRaw }: SameAccountUriContext) {
  const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherOrganizationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const policy = (organizationIdValue: string, detection: unknown, enabled: unknown = true) => ({
    id: crypto.randomUUID(),
    organizationId: organizationIdValue,
    type: 16,
    data: { uriMatchDetection: detection },
    enabled,
    object: "policy",
  });
  function context(raw: Raw) {
    const result = mapRaw(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Synthetic account rejected");
    return result.data.uriMatchContext;
  }
  function withOrganization(membership: Record<string, unknown>, policies: unknown[]) {
    // No organization item is received, so a keyless membership still maps.
    const raw = rawV2Account();
    Object.assign(raw.sync.profile, {
      organizations: [{ id: organizationId, enabled: true, status: 2, ...membership }],
    });
    Object.assign(raw.sync, { policies, policiesNew: [] });
    return { raw, id: organizationId };
  }

  it("retains received equivalent domains with the provider's Domain default", () => {
    const raw = rawV2Account();
    Object.assign(raw.sync, {
      domains: {
        object: "domains",
        equivalentDomains: [["Example.com", "example.net"]],
        globalEquivalentDomains: [{ type: 3, domains: ["example.org"], excluded: false }],
      },
    });
    expect(context(raw)).toEqual({
      equivalentDomains: [["example.com", "example.net"], ["example.org"]],
      defaultMatch: 0,
    });
    expect(context(rawV1Account())).toEqual({ equivalentDomains: [], defaultMatch: 0 });
  });

  it("marks malformed received domains unavailable without rejecting the account", () => {
    const raw = rawV2Account();
    Object.assign(raw.sync, { domains: { equivalentDomains: [["https://example.com/login"]] } });
    expect(context(raw)).toEqual({ equivalentDomains: "unavailable", defaultMatch: 0 });
  });

  it("applies an enforced organization URI match default", () => {
    const { raw, id } = withOrganization({ type: 2, usePolicies: true }, []);
    Object.assign(raw.sync, { policies: [policy(id, 3)] });
    expect(context(raw)?.defaultMatch).toBe(3);
  });

  it.each([
    ["owner", { type: 0 }],
    ["admin", { type: 1 }],
    ["policies unavailable", { type: 2, usePolicies: false }],
    ["disabled organization", { type: 2, enabled: false }],
  ])("does not enforce the default for an exempt %s membership", (_label, membership) => {
    const { raw, id } = withOrganization(membership, []);
    Object.assign(raw.sync, { policies: [policy(id, 3)] });
    expect(context(raw)?.defaultMatch).toBe(0);
  });

  it("exempts a provider user and ignores a disabled policy", () => {
    const { raw, id } = withOrganization({ type: 2 }, []);
    Object.assign(raw.sync.profile, { providerOrganizations: [{ id, enabled: true }] });
    Object.assign(raw.sync, { policies: [policy(id, 3)] });
    expect(context(raw)?.defaultMatch).toBe(0);
    const disabled = withOrganization({ type: 2 }, []);
    Object.assign(disabled.raw.sync, { policies: [policy(disabled.id, 3, false)] });
    expect(context(disabled.raw)?.defaultMatch).toBe(0);
  });

  it("enforces a policy whose organization context is missing", () => {
    const raw = rawV2Account();
    Object.assign(raw.sync, { policies: [policy(organizationId, 2)] });
    expect(context(raw)?.defaultMatch).toBe(2);
  });

  it("falls back to Domain for absent or invalid policy data", () => {
    for (const detection of [undefined, null, 6, "3"]) {
      const raw = rawV2Account();
      Object.assign(raw.sync, { policies: [policy(organizationId, detection)] });
      expect(context(raw)?.defaultMatch).toBe(0);
    }
  });

  it("fails closed when enforced organizations disagree instead of using response order", () => {
    const raw = rawV2Account();
    Object.assign(raw.sync, {
      policies: [policy(organizationId, 1), policy(otherOrganizationId, 3)],
    });
    expect(context(raw)?.defaultMatch).toBe("unavailable");
    const agreeing = rawV2Account();
    Object.assign(agreeing.sync, {
      policies: [policy(organizationId, 1), policy(otherOrganizationId, 1)],
    });
    expect(context(agreeing)?.defaultMatch).toBe(1);
  });

  it("prefers non-empty policiesNew and otherwise falls back to policies", () => {
    const raw = rawV2Account();
    Object.assign(raw.sync, {
      policies: [policy(organizationId, 1)],
      policiesNew: [policy(organizationId, 3)],
    });
    expect(context(raw)?.defaultMatch).toBe(3);
    Object.assign(raw.sync, { policiesNew: [] });
    expect(context(raw)?.defaultMatch).toBe(1);
    Object.assign(raw.sync, { policiesNew: null });
    expect(context(raw)?.defaultMatch).toBe(1);
  });

  it.each([{ enabled: "true" }, { organizationId: "not-a-uuid" }])(
    "marks a malformed URI default policy unavailable case %#",
    (change) => {
      const raw = rawV2Account();
      Object.assign(raw.sync, { policies: [{ ...policy(organizationId, 1), ...change }] });
      expect(context(raw)?.defaultMatch).toBe("unavailable");
    },
  );

  it("ignores unrelated policy types", () => {
    const raw = rawV2Account();
    Object.assign(raw.sync, {
      policies: [
        { ...policy(organizationId, 3), type: 11 },
        { type: 99, enabled: "odd" },
      ],
    });
    expect(context(raw)?.defaultMatch).toBe(0);
  });
}
