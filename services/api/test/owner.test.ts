import {
  devicePairResultSchema,
  manageDevicesSchema,
  type DevicePairResult,
  type LocalSettings,
} from "@pateat/contracts";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import {
  claims,
  deviceApi,
  forgedAccess,
  installAccessKeys,
  jwks,
  type JwksMode,
  newSubject,
  OBSOLETE_PAIR_AUDIENCE,
  ORIGIN,
  owner,
  ownerIdFor,
  rejectedTokens,
  request,
  signAccess,
  type Owner,
} from "./access-helpers";
import { profileDocument } from "../src/settings-store";
import { registerOwnerWebUiCases } from "./owner/web-ui-cases";
import { registerOwnerRecipeCases } from "./owner/recipe-cases";
import { registerOwnerRequestLogCases } from "./owner/request-log-cases";

// Synthetic Access keys, identities and extension IDs only. Every test uses fresh
// subjects so results never depend on rows written by another test.

installAccessKeys();

/** The synthetic extension ID listed in vitest.config.ts. */
const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

/** A web UI API call as its own page makes it: same origin unless `origin` says otherwise. */
function manageApi(
  path: string,
  access: string | undefined,
  method: string,
  origin: string | null = ORIGIN,
) {
  return request(path, { method, access, headers: origin ? { Origin: origin } : {} });
}

function postPair(access: string | undefined, label = "Test laptop", profileId?: string) {
  return request("/pair", {
    method: "POST",
    access,
    headers: { "Content-Type": "application/json", Origin: EXTENSION_ORIGIN },
    body: JSON.stringify({ version: 1, label, ...(profileId ? { profileId } : {}) }),
  });
}

/**
 * Pairs a device for `by` as the extension does (ADR 0020). An owner's later device takes
 * the first profile the service offers (ADR 0076).
 */
async function pairDevice(by: Owner, label = "Test laptop"): Promise<DevicePairResult> {
  let response = await postPair(by.token, label);
  if (response.status === 409) {
    const { profiles } = (await response.json()) as { profiles: { id: string }[] };
    response = await postPair(by.token, label, profiles[0]!.id);
  }
  expect(response.status).toBe(201);
  return v.parse(devicePairResultSchema, await response.json());
}

export type OwnerTestHelpers = {
  manageApi: typeof manageApi;
  pairDevice: typeof pairDevice;
};

describe("Access verification", () => {
  it("requires the signed assertion and ignores plain identity headers", async () => {
    const response = await request("/manage", {
      headers: { "Cf-Access-Authenticated-User-Email": "owner@example.com" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
  });

  it("guards every owner route", async () => {
    const responses = await Promise.all([
      postPair(undefined),
      request("/manage"),
      request("/manage/assets/app.js"),
      request("/manage/api/devices"),
      manageApi(`/manage/api/devices/${crypto.randomUUID()}/revoke`, undefined, "POST"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
    expect(await responses[0]!.json()).toEqual({ error: "unauthorized" });
    expect(await responses[3]!.json()).toEqual({ error: "unauthorized" });
    const head = await Promise.all(
      ["/manage", "/manage/assets/app.js"].map((path) => request(path, { method: "HEAD" })),
    );
    expect(head.map((response) => response.status)).toEqual([401, 401]);
    const forged = await forgedAccess(claims(newSubject()));
    expect((await request("/manage/assets/app.js", { access: forged })).status).toBe(403);
  });

  it.each(rejectedTokens)("rejects %s", async (_, token) => {
    const response = await request("/manage", { access: await token() });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("Pateat test app");
  });

  it("refuses the obsolete pairing application's audience on every owner route", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    const viaPair = {
      subject: by.subject,
      token: await signAccess(claims(by.subject, { aud: [OBSOLETE_PAIR_AUDIENCE] })),
    };
    const pages = [
      "/manage",
      "/manage/dashboard",
      "/manage/sites",
      "/manage/sites/https/bank.example",
      "/manage/vaults",
      "/manage/assets/app.js",
      "/manage/claude",
    ];
    const pageResponses = await Promise.all(
      pages.map((path) => request(path, { access: viaPair.token })),
    );
    expect(pageResponses.map((response) => response.status)).toEqual(pages.map(() => 403));
    for (const response of pageResponses)
      expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
    const pageBodies = await Promise.all(pageResponses.map((response) => response.text()));
    for (const body of pageBodies) expect(body).not.toContain("Pateat test app");
    // A well-formed same-origin write is refused by Access, not by origin or body checks.
    const claudeWrite = await request("/manage/api/claude", {
      method: "PUT",
      access: viaPair.token,
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({
        version: 1,
        identifiers: {
          federationRuleId: "fdrl_01SyntheticRule",
          organizationId: "00000000-0000-4000-8000-000000000000",
          serviceAccountId: "svac_01SyntheticAccount",
          workspaceId: "wrkspc_01SyntheticWorkspace",
        },
      }),
    });

    const apiResponses = await Promise.all([
      manageApi("/manage/api/devices", viaPair.token, "GET"),
      manageApi(`/manage/api/profiles/${crypto.randomUUID()}/settings`, viaPair.token, "GET"),
      manageApi("/manage/api/recipes", viaPair.token, "GET"),
      manageApi("/manage/api/dashboard", viaPair.token, "GET"),
      manageApi(`/manage/api/devices/${device.deviceId}/revoke`, viaPair.token, "POST"),
      manageApi("/manage/api/models", viaPair.token, "GET"),
      manageApi("/manage/api/claude", viaPair.token, "GET"),
      manageApi("/manage/api/claude/test", viaPair.token, "POST"),
      claudeWrite,
    ]);
    expect(apiResponses.map((response) => response.status)).toEqual(apiResponses.map(() => 403));
    expect(await Promise.all(apiResponses.map((response) => response.json()))).toEqual(
      apiResponses.map(() => ({ error: "forbidden" })),
    );

    // The device was not revoked, no identifiers were saved, and the parent
    // application still reaches the owner.
    expect((await deviceApi(device.credential)).status).toBe(200);
    expect(
      await env.DB.prepare("SELECT 1 FROM inference_credentials WHERE owner_id = ?")
        .bind(await ownerIdFor(viaPair.subject))
        .first(),
    ).toBeNull();
    const viaHost = await owner(viaPair.subject);
    expect((await request("/manage", { access: viaHost.token })).status).toBe(200);
    const listed = v.parse(
      manageDevicesSchema,
      await (await manageApi("/manage/api/devices", viaHost.token, "GET")).json(),
    );
    expect(listed.devices.map((entry) => entry.id)).toEqual([device.deviceId]);
  });

  /** Runs `body` while the mocked key set answers as `mode`, then restores it. */
  async function duringOutage<T>(mode: JwksMode, body: () => Promise<T>): Promise<T> {
    jwks.mode = mode;
    try {
      return await body();
    } finally {
      jwks.mode = "ok";
    }
  }

  const outages: [string, JwksMode][] = [
    ["a non-OK response", "status"],
    ["a JSON body that is not a key set", "malformed"],
    ["a body that is not JSON", "not-json"],
    ["a fetch that rejects", "reject"],
  ];

  it.each(outages)(
    "treats %s for the signing keys as an outage, not a refused sign-in",
    async (_, mode) => {
      const viaHost = await owner();
      const pairingOwner = await owner();
      const pages: [string, string][] = [
        ["/manage", viaHost.token],
        ["/manage/sites", viaHost.token],
        ["/manage/sites/https/bank.example", viaHost.token],
        ["/manage/assets/app.js", viaHost.token],
        ["/manage/claude", viaHost.token],
        ["/manage/profiles", viaHost.token],
        ["/extension/signed-in", viaHost.token],
        ["/pair/signed-in", pairingOwner.token],
      ];
      const { pageResponses, apiResponses, missing } = await duringOutage(mode, async () => ({
        pageResponses: await Promise.all(pages.map(([path, access]) => request(path, { access }))),
        apiResponses: await Promise.all([
          postPair(pairingOwner.token),
          postPair(viaHost.token),
          manageApi("/manage/api/devices", viaHost.token, "GET"),
          manageApi("/manage/api/profiles", viaHost.token, "GET"),
          manageApi(`/manage/api/devices/${crypto.randomUUID()}/revoke`, viaHost.token, "POST"),
        ]),
        // A missing token is refused before any key is fetched.
        missing: await Promise.all([request("/manage"), postPair(undefined)]),
      }));

      expect(pageResponses.map((response) => response.status)).toEqual(pages.map(() => 503));
      for (const response of pageResponses)
        expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
      for (const body of await Promise.all(pageResponses.map((response) => response.text()))) {
        expect(body).toContain("Your sign-in could not be checked. Try again later.");
        expect(body).not.toContain("Access denied");
        expect(body).not.toContain("Pateat test app");
      }
      expect(apiResponses.map((response) => response.status)).toEqual(apiResponses.map(() => 503));
      expect(await Promise.all(apiResponses.map((response) => response.json()))).toEqual(
        apiResponses.map(() => ({ error: "access_keys_unavailable" })),
      );
      expect(missing.map((response) => response.status)).toEqual([401, 401]);
      // No owner was created by the pairing attempts.
      expect(await ownerIdFor(pairingOwner.subject)).toBeNull();
      expect(await ownerIdFor(viaHost.subject)).toBeNull();

      // Once the keys answer again, the same tokens work.
      expect((await request("/manage", { access: viaHost.token })).status).toBe(200);
      expect((await postPair(pairingOwner.token)).status).toBe(201);
    },
  );

  it("gives up on signing keys that never arrive after its timeout", async () => {
    // The real timeout is 5 s; shorten the requested signal so the abort really fires.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const requested: number[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      requested.push(ms);
      return timeout(20);
    });
    try {
      const responses = await duringOutage("hang", async () =>
        Promise.all([
          request("/manage", { access: (await owner()).token }),
          postPair((await owner()).token),
        ]),
      );
      expect(responses.map((response) => response.status)).toEqual([503, 503]);
      expect(requested).toEqual([5_000, 5_000]);
    } finally {
      spy.mockRestore();
    }
  }, 2_000);

  it("fails closed without Access configuration", async () => {
    const { token } = await owner();
    const overrides = [
      { ACCESS_AUD: "" },
      { ACCESS_TEAM_DOMAIN: "" },
      { ACCESS_TEAM_DOMAIN: "attacker.example" },
    ];
    const responses = await Promise.all(
      overrides.map((override) =>
        app.request(
          `${ORIGIN}/manage`,
          { headers: { "Cf-Access-Jwt-Assertion": token } },
          { ...env, ...override },
        ),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([503, 503, 503]);
  });
});

describe("owner web UI", () => {
  registerOwnerWebUiCases({ manageApi, pairDevice });
});

describe("owner web UI settings", () => {
  const settings = {
    connections: [],
    accountPolicies: [],
    itemPolicies: [],
    customFieldReviews: [],
    excludedSites: [{ hostname: "intranet.example", includeSubdomains: true }],
    passkeyBrowserSites: [],
    repromptSites: [],
    siteDefaults: [],
    bindings: [],
  };
  const profileSettingsPath = async (by: Owner) =>
    `/manage/api/profiles/${(await ownerIdFor(by.subject)) ?? "00000000-0000-4000-8000-000000000000"}/settings`;
  const putSettings = async (by: Owner, body: unknown, origin: string | null = ORIGIN) =>
    request(await profileSettingsPath(by), {
      method: "PUT",
      access: by.token,
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(body),
    });

  it("tells an identity without a paired device to pair one, creating no owner", async () => {
    const by = await owner();
    const [read, write] = await Promise.all([
      request(await profileSettingsPath(by), { access: by.token }),
      putSettings(by, { version: 1, expectedRevision: 0, settings }),
    ]);
    expect([read.status, write.status]).toEqual([404, 404]);
    expect(await read.json()).toEqual({ error: "not_paired" });
    expect(await write.json()).toEqual({ error: "not_paired" });
    expect(await ownerIdFor(by.subject)).toBeNull();
  });

  it("keeps each owner's settings apart", async () => {
    const first = await owner();
    const second = await owner();
    await Promise.all([pairDevice(first), pairDevice(second)]);
    expect((await putSettings(first, { version: 1, expectedRevision: 0, settings })).status).toBe(
      200,
    );
    // The second owner's revision 1 does not exist; the first owner's is untouched.
    const other = { ...settings, excludedSites: [] };
    const [read, write] = await Promise.all([
      request(await profileSettingsPath(second), { access: second.token }),
      putSettings(second, { version: 1, expectedRevision: 1, settings: other }),
    ]);
    expect(await read.json()).toEqual({
      version: 1,
      profileId: expect.any(String),
      revision: 0,
      settings: null,
    });
    expect(write.status).toBe(409);
    const firstRead = await request(await profileSettingsPath(first), { access: first.token });
    expect(await firstRead.json()).toEqual({
      version: 1,
      profileId: expect.any(String),
      revision: 1,
      settings,
    });
  });

  it("updates a device-written revision and makes a stale device write conflict", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    const deviceWrite = (expectedRevision: number, body: unknown) =>
      deviceApi(device.credential, "/v1/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, expectedRevision, settings: body }),
      });
    expect((await deviceWrite(0, settings)).status).toBe(200);
    const web = { ...settings, excludedSites: [] };
    expect((await putSettings(by, { version: 1, expectedRevision: 1, settings: web })).status).toBe(
      200,
    );
    const row = await env.DB.prepare(
      "SELECT revision, updated_by_device_id FROM settings WHERE owner_id = ?",
    )
      .bind(await ownerIdFor(by.subject))
      .first<{ revision: number; updated_by_device_id: string | null }>();
    expect(row).toEqual({ revision: 2, updated_by_device_id: null });
    const stale = await deviceWrite(1, settings);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: "settings_conflict",
      current: { version: 1, profileId: expect.any(String), revision: 2, settings: web },
    });
  });

  describe("synced vault policy (ADR 0023)", () => {
    const account = {
      provider: "bitwarden",
      server: "https://vault.example",
      userId: "00000000-0000-4000-8000-000000000001",
    };
    const itemId = "00000000-0000-4000-8000-000000000002";
    const policy: LocalSettings = {
      ...settings,
      accountPolicies: [
        {
          ...account,
          accountName: "Personal vault",
          enabled: true,
          selection: { mode: "selected", groups: [{ id: "folder-1", name: "Banking" }] },
        },
        {
          ...account,
          server: "cloud-eu",
          accountName: "Work vault",
          enabled: false,
          selection: { mode: "all" },
        },
      ],
      itemPolicies: [
        {
          ...account,
          itemId,
          itemName: "Example Bank",
          selected: true,
          excluded: false,
          excludedFields: [
            "login.totp",
            { custom: "PIN", position: 2, count: 2 },
            { custom: null, position: 1, count: 1 },
          ],
        },
      ],
      customFieldReviews: [
        {
          ...account,
          itemId,
          evidence: `bitwarden-v1:sha256:${"a".repeat(64)}`,
          revisionDate: "2026-10-11T07:10:03.1234567Z",
        },
      ],
    };

    it("round-trips the policy lists between devices and the web UI with revision conflicts", async () => {
      const by = await owner();
      const device = await pairDevice(by);
      const deviceWrite = (expectedRevision: number, body: unknown) =>
        deviceApi(device.credential, "/v1/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: 1, expectedRevision, settings: body }),
        });
      // The lists are profile parts (ADR 0024): stored with the device's profile, the
      // owner's Default one here, under the owner's revision.
      const stored = async () =>
        env.DB.prepare(
          `SELECT s.revision, p.document, s.updated_by_device_id FROM settings s
          JOIN profiles p ON p.owner_id = s.owner_id AND p.id = s.owner_id WHERE s.owner_id = ?`,
        )
          .bind(await ownerIdFor(by.subject))
          .first<{ revision: number; document: string; updated_by_device_id: string | null }>();

      // A device writes the lists; the web UI reads them unchanged.
      const written = await deviceWrite(0, policy);
      expect(written.status).toBe(200);
      expect(await written.json()).toEqual({
        version: 1,
        profileId: expect.any(String),
        revision: 1,
        settings: policy,
      });
      const read = await request(await profileSettingsPath(by), { access: by.token });
      expect(await read.json()).toEqual({
        version: 1,
        profileId: expect.any(String),
        revision: 1,
        settings: policy,
      });
      const first = await stored();
      expect(first?.revision).toBe(1);
      expect(JSON.parse(first!.document)).toEqual(profileDocument(policy));

      // The web UI writes the next revision; the device reads it back.
      const web: LocalSettings = {
        ...policy,
        accountPolicies: [{ ...policy.accountPolicies[0]!, enabled: false }],
        itemPolicies: [],
      };
      const webWrite = await putSettings(by, { version: 1, expectedRevision: 1, settings: web });
      expect(webWrite.status).toBe(200);
      expect(await webWrite.json()).toEqual({
        version: 1,
        profileId: expect.any(String),
        revision: 2,
        settings: web,
      });
      expect(await (await deviceApi(device.credential)).json()).toEqual({
        version: 1,
        profileId: expect.any(String),
        revision: 2,
        settings: web,
      });
      const second = await stored();
      expect(second?.revision).toBe(2);
      expect(second?.updated_by_device_id).toBeNull();
      expect(JSON.parse(second!.document)).toEqual(profileDocument(web));

      // Stale writers on either side change nothing and get the current lists back.
      const conflict = {
        error: "settings_conflict",
        current: { version: 1, profileId: expect.any(String), revision: 2, settings: web },
      };
      const staleDevice = await deviceWrite(1, policy);
      expect(staleDevice.status).toBe(409);
      expect(await staleDevice.json()).toEqual(conflict);
      const staleWeb = await putSettings(by, { version: 1, expectedRevision: 1, settings: policy });
      expect(staleWeb.status).toBe(409);
      expect(await staleWeb.json()).toEqual(conflict);
      expect(JSON.parse((await stored())!.document)).toEqual(profileDocument(web));

      // The device rebases on the current revision.
      const rebased = await deviceWrite(2, policy);
      expect(rebased.status).toBe(200);
      expect(await rebased.json()).toEqual({
        version: 1,
        profileId: expect.any(String),
        revision: 3,
        settings: policy,
      });
      expect((await stored())?.updated_by_device_id).toBe(device.deviceId);
    });

    it("refuses lists over their limits and duplicate keys on both paths", async () => {
      const by = await owner();
      const device = await pairDevice(by);
      const accounts = Array.from({ length: 101 }, (_, index) => ({
        ...policy.accountPolicies[0]!,
        userId: `user-${index}`,
      }));
      const fields = Array.from({ length: 1001 }, (_, index) => `field.${index}`);
      const invalid = [
        { ...policy, accountPolicies: accounts },
        { ...policy, itemPolicies: [{ ...policy.itemPolicies[0]!, excludedFields: fields }] },
        { ...policy, itemPolicies: [policy.itemPolicies[0]!, policy.itemPolicies[0]!] },
        {
          ...policy,
          customFieldReviews: [
            policy.customFieldReviews[0]!,
            { ...policy.customFieldReviews[0]!, evidence: `bitwarden-v1:sha256:${"b".repeat(64)}` },
          ],
        },
        {
          ...policy,
          accountPolicies: [{ ...policy.accountPolicies[0]!, server: "http://vault.example" }],
        },
        { ...policy, fieldPolicies: [] },
      ];
      const responses = await Promise.all(
        invalid.flatMap((body) => [
          deviceApi(device.credential, "/v1/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ version: 1, expectedRevision: 0, settings: body }),
          }),
          putSettings(by, { version: 1, expectedRevision: 0, settings: body }),
        ]),
      );
      expect(responses.map((response) => response.status)).toEqual(
        invalid.flatMap(() => [400, 400]),
      );
      expect(await Promise.all(responses.map((response) => response.json()))).toEqual(
        responses.map(() => ({ error: "bad_request" })),
      );
      // At the limits, both paths accept the document.
      const atLimit = {
        ...policy,
        accountPolicies: accounts.slice(0, 100),
        itemPolicies: [{ ...policy.itemPolicies[0]!, excludedFields: fields.slice(0, 1000) }],
      };
      expect(
        (
          await deviceApi(device.credential, "/v1/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ version: 1, expectedRevision: 0, settings: atLimit }),
          })
        ).status,
      ).toBe(200);
      expect(
        (await putSettings(by, { version: 1, expectedRevision: 1, settings: atLimit })).status,
      ).toBe(200);
      expect(
        await (await request(await profileSettingsPath(by), { access: by.token })).json(),
      ).toEqual({
        version: 1,
        profileId: expect.any(String),
        revision: 2,
        settings: atLimit,
      });
    });
  });

  it("refuses a document larger than devices sync", async () => {
    const by = await owner();
    await pairDevice(by);
    const long = ["a", "b", "c"].map((letter) => letter.repeat(60)).join(".");
    const large = {
      ...settings,
      excludedSites: Array.from({ length: 530 }, (_, index) => ({
        hostname: `${long}.x${index}.example`,
        includeSubdomains: false,
      })),
    };
    const over = {
      ...settings,
      excludedSites: Array.from({ length: 600 }, (_, index) => ({
        hostname: `${long}.x${index}.example`,
        includeSubdomains: false,
      })),
    };
    const [tooLarge, overLimit] = await Promise.all([
      putSettings(by, { version: 1, expectedRevision: 0, settings: large }),
      putSettings(by, { version: 1, expectedRevision: 0, settings: over }),
    ]);
    // Over 120 KiB of document but under the body limit, then over the body limit.
    expect([tooLarge.status, overLimit.status]).toEqual([400, 413]);
    expect(await tooLarge.json()).toEqual({ error: "bad_request" });
    expect(await overLimit.json()).toEqual({ error: "payload_too_large" });
    const read = await request(await profileSettingsPath(by), { access: by.token });
    expect(await read.json()).toEqual({
      version: 1,
      profileId: expect.any(String),
      revision: 0,
      settings: null,
    });
  });

  it("writes the document devices sync, recorded as written by the web UI", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    const write = await putSettings(by, { version: 1, expectedRevision: 0, settings });
    expect(write.status).toBe(200);
    expect(await write.json()).toEqual({
      version: 1,
      profileId: expect.any(String),
      revision: 1,
      settings,
    });
    expect(await (await deviceApi(device.credential)).json()).toEqual({
      version: 1,
      profileId: expect.any(String),
      revision: 1,
      settings,
    });
    const row = await env.DB.prepare("SELECT updated_by_device_id FROM settings WHERE owner_id = ?")
      .bind(await ownerIdFor(by.subject))
      .first<{ updated_by_device_id: string | null }>();
    expect(row).toEqual({ updated_by_device_id: null });

    // A device write after it is still attributed to that device.
    const next = { ...settings, excludedSites: [] };
    const deviceWrite = await deviceApi(device.credential, "/v1/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, expectedRevision: 1, settings: next }),
    });
    expect(deviceWrite.status).toBe(200);
    const read = await request(await profileSettingsPath(by), { access: by.token });
    expect(await read.json()).toEqual({
      version: 1,
      profileId: expect.any(String),
      revision: 2,
      settings: next,
    });
  });

  it("changes nothing on a stale revision and returns the current state", async () => {
    const by = await owner();
    await pairDevice(by);
    expect((await putSettings(by, { version: 1, expectedRevision: 0, settings })).status).toBe(200);
    const stale = await putSettings(by, {
      version: 1,
      expectedRevision: 0,
      settings: { ...settings, excludedSites: [] },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: "settings_conflict",
      current: { version: 1, profileId: expect.any(String), revision: 1, settings },
    });
  });

  it("refuses vault connections, invalid documents, other media types and other origins", async () => {
    const by = await owner();
    await pairDevice(by);
    // A device-local add-form choice is valid on a device and never stored by the web UI.
    const connection = { connectionId: "connection-1", enabled: true };
    const responses = await Promise.all([
      putSettings(by, {
        version: 1,
        expectedRevision: 0,
        settings: { ...settings, connections: [connection] },
      }),
      putSettings(by, { version: 1, expectedRevision: 0, settings: { ...settings, extra: 1 } }),
      request(await profileSettingsPath(by), {
        method: "PUT",
        access: by.token,
        headers: { "Content-Type": "text/plain", Origin: ORIGIN },
        body: JSON.stringify({ version: 1, expectedRevision: 0, settings }),
      }),
      putSettings(by, { version: 1, expectedRevision: 0, settings }, "https://attacker.example"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([400, 400, 415, 403]);
    const read = await request(await profileSettingsPath(by), { access: by.token });
    expect(await read.json()).toEqual({
      version: 1,
      profileId: expect.any(String),
      revision: 0,
      settings: null,
    });
  });

  it("serves the sites list, each site's page and the vaults page", async () => {
    const { token } = await owner();
    const paths = [
      "/manage/sites",
      "/manage/sites/https/bank.example",
      "/manage/sites/http/localhost:8443",
      "/manage/vaults",
    ];
    const [signedIn, anonymous] = await Promise.all([
      Promise.all(paths.map((path) => request(path, { access: token }))),
      Promise.all(paths.map((path) => request(path))),
    ]);
    expect(signedIn.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(await signedIn[1]!.text()).toContain("Pateat test app");
    expect(await signedIn[3]!.text()).toContain("Pateat test app");
    expect(anonymous.map((response) => response.status)).toEqual([401, 401, 401, 401]);
    // Only an HTTP(S) origin has a page; the former bindings and recipes pages are gone.
    const missing = [
      "/manage/sites/ftp/bank.example",
      "/manage/sites/https/bank.example/login",
      "/manage/bindings",
      "/manage/recipes",
    ];
    const refused = await Promise.all(missing.map((path) => request(path, { access: token })));
    expect(refused.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    const post = await request("/manage/sites/https/bank.example", {
      access: token,
      method: "POST",
    });
    expect(post.status).toBe(405);
    const writes = await Promise.all(
      ["POST", "PUT", "DELETE"].map((method) =>
        request("/manage/vaults", { access: token, method }),
      ),
    );
    expect(writes.map((response) => response.status)).toEqual([405, 405, 405]);
    expect(writes[0]!.headers.get("Allow")).toBe("GET");
  });
});

describe("owner web UI recipes", () => {
  registerOwnerRecipeCases({ manageApi, pairDevice });
});

// ADR 0012: the owner deletes their whole request log from the web UI (owner, 2026-10-18).
describe("owner web UI request log", () => {
  registerOwnerRequestLogCases({ manageApi, pairDevice });
});

describe("device self-revocation", () => {
  it("revokes only the calling device", async () => {
    const by = await owner();
    const leaving = await pairDevice(by);
    const staying = await pairDevice(by);
    const response = await deviceApi(leaving.credential, "/v1/device", { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(await (await deviceApi(leaving.credential)).json()).toEqual({
      error: "device_revoked",
    });
    expect((await deviceApi(staying.credential)).status).toBe(200);
    expect((await deviceApi(leaving.credential, "/v1/device", { method: "DELETE" })).status).toBe(
      401,
    );
    expect((await request("/v1/device", { method: "DELETE" })).status).toBe(401);
    expect((await deviceApi(staying.credential, "/v1/device", { method: "PUT" })).status).toBe(405);
  });
});

describe("profiles page", () => {
  it("serves its page", async () => {
    const { token } = await owner();
    const page = await request("/manage/profiles", { access: token });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Pateat test app");
    expect((await request("/manage/profiles")).status).toBe(401);
    expect((await request("/manage/profiles", { access: token, method: "POST" })).status).toBe(405);
  });
});
