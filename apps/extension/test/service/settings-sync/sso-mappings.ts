import type { SsoMapping } from "@pateat/contracts";
import { expect, it } from "vitest";
import { mergeSyncedSettings, syncedSettings } from "../../../src/service/settings-sync";
import type { SettingsSyncFixtures } from "../../../src/service/settings-sync.test";

export type SsoMappingsContext = Pick<
  SettingsSyncFixtures,
  | "setup"
  | "settingsOf"
  | "state"
  | "baseOf"
  | "CONNECTION"
  | "never"
  | "localConnection"
  | "site"
  | "OTHER_PROFILE"
>;

const owner = { provider: "bitwarden", server: "cloud-us", userId: "synthetic-user" };
const link = (
  method: number,
  idpItem = "idp-item",
  origin = "https://idp.example",
): SsoMapping => ({
  ...owner,
  itemId: "site-item",
  method,
  idp: { ...owner, itemId: idpItem, origin },
});

/** SSO mappings (ADR 0085): owner parts that name two items, a method and the IdP origin. */
export function registerSsoMappings({
  setup,
  settingsOf,
  state,
  baseOf,
  CONNECTION,
  never,
  localConnection,
  site,
  OTHER_PROFILE,
}: SsoMappingsContext) {
  it("uploads this device's SSO mappings and downloads another device's", async () => {
    const local = settingsOf({ connections: [localConnection], ssoMappings: [link(1)] });
    const first = setup({ local });
    expect(await first.sync.run(CONNECTION, never)).toBe("synced");
    expect(first.service().settings?.ssoMappings).toEqual([link(1)]);

    const agreed = settingsOf({ ssoMappings: [link(1)] });
    const second = setup({
      local: { ...agreed, connections: [localConnection] },
      service: state(5, settingsOf({ ssoMappings: [link(1), link(2)] })),
      base: baseOf(4, agreed),
    });
    expect(await second.sync.run(CONNECTION, never)).toBe("synced");
    expect(second.local()?.settings.ssoMappings).toEqual([link(1), link(2)]);
    expect(second.transport.saveSettings).not.toHaveBeenCalled();
  });

  it("merges per method: the service's change wins, and each side's other edits stay", () => {
    const base = syncedSettings(
      settingsOf({ ssoMappings: [link(1), link(2), link(3), link(4), link(5)] }),
    );
    // This device remapped method 1, removed method 3 and moved method 4 to another
    // origin; the service remapped method 1 elsewhere, removed method 2 and moved method 5.
    const local = syncedSettings(
      settingsOf({
        ssoMappings: [
          link(1, "local-idp"),
          link(2),
          link(4, "idp-item", "https://a.example"),
          link(5),
        ],
      }),
    );
    const service = syncedSettings(
      settingsOf({
        ssoMappings: [
          link(1, "service-idp"),
          link(3),
          link(4),
          link(5, "idp-item", "https://b.example"),
        ],
      }),
    );
    expect(mergeSyncedSettings({ service: base, local: base }, local, service).ssoMappings).toEqual(
      [
        link(1, "service-idp"),
        link(4, "idp-item", "https://a.example"),
        link(5, "idp-item", "https://b.example"),
      ],
    );
  });

  it("keeps this device's SSO mappings when it adopts another profile, as bindings", async () => {
    // Mappings belong to the owner, not to a profile (ADR 0076): a profile's site settings
    // replace this device's, while both sides' mappings merge.
    const local = settingsOf({
      excludedSites: [site("local-only.example")],
      ssoMappings: [link(1)],
    });
    const remote = settingsOf({
      excludedSites: [site("intranet.example")],
      ssoMappings: [link(2)],
    });
    const h = setup({ local, service: state(3, remote) });
    expect(await h.sync.run(CONNECTION, never)).toBe("synced");
    const merged = settingsOf({
      excludedSites: [site("intranet.example")],
      ssoMappings: [link(2), link(1)],
    });
    expect(h.service()).toEqual(state(4, merged));
    expect(h.local()?.settings).toEqual(merged);
  });

  it("does not bring back an SSO mapping removed while this device moved to a new profile", async () => {
    const agreed = settingsOf({ ssoMappings: [link(1), link(2)] });
    const h = setup({
      local: agreed,
      service: {
        ...state(6, settingsOf({ ssoMappings: [link(2)] })),
        profileId: OTHER_PROFILE,
        newProfile: true,
      },
      base: baseOf(4, agreed),
    });
    expect(await h.sync.run(CONNECTION, never)).toBe("synced");
    expect(h.local()?.settings.ssoMappings).toEqual([link(2)]);
    expect(h.service().settings?.ssoMappings).toEqual([link(2)]);
  });
}
