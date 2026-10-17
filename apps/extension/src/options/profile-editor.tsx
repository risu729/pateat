import { useState } from "react";
import type { LocalSettings, SyncSettingsState, VaultCatalog } from "@pateat/contracts";
import type { ServiceClient } from "./service-client";
import type { SettingsClient } from "./client";
import { SitePolicy } from "./site-policy";
import { Button } from "./button";
import { controlClass, fieldClass } from "./ui";

/** Other profiles use this browser's catalog, without changing this browser's policy. */
export function ProfileEditor({
  origin,
  service,
  local,
}: {
  origin: string;
  service: NonNullable<ServiceClient["profileEditor"]>;
  local: SettingsClient;
}) {
  const [profiles, setProfiles] = useState<{ id: string; name: string }[]>([]);
  const [profileId, setProfileId] = useState("");
  const [state, setState] = useState<SyncSettingsState>();
  const [draft, setDraft] = useState<LocalSettings>();
  const [catalog, setCatalog] = useState<VaultCatalog>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function act(run: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await run();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Profile access failed.");
    } finally {
      setBusy(false);
    }
  }
  async function load(id: string) {
    setState(undefined);
    setDraft(undefined);
    const [remote, metadata] = await Promise.all([service.read(origin, id), local.getSettings()]);
    if (!metadata.ok) throw new Error(metadata.error.message);
    setState(remote);
    setCatalog(metadata.catalog);
    setDraft({
      ...(remote.settings ?? { excludedSites: [], siteDefaults: [], bindings: [] }),
      connections: metadata.snapshot.settings.connections,
    });
  }
  return (
    <section aria-label="Edit another settings profile" className="flex flex-col gap-3">
      <h3>Edit a settings profile</h3>
      <p>
        Uses this browser's vault catalog. Saving does not change which profile this device uses.
        Bindings remain shared.
      </p>
      <Button
        type="button"
        disabled={busy}
        onClick={() =>
          void act(async () => {
            setProfiles((await service.list(origin)).profiles);
          })
        }
      >
        Load profiles
      </Button>
      {profiles.length > 0 && (
        <label className={fieldClass}>
          Profile to edit
          <select
            className={controlClass}
            value={profileId}
            disabled={busy}
            onChange={(event) => {
              const id = event.target.value;
              setProfileId(id);
              void act(() => load(id));
            }}
          >
            <option value="" disabled>
              Choose a profile
            </option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {draft && catalog && (
        <fieldset disabled={busy} className="border-0 p-0">
          <SitePolicy
            key={profileId}
            draft={draft}
            catalog={catalog}
            findSiteAccounts={local.findSiteAccounts}
            edit={(update) => {
              const next = structuredClone(draft);
              update(next);
              setDraft(next);
              return true;
            }}
          />
          <Button
            type="button"
            onClick={() =>
              void act(async () => {
                if (!state) return;
                const saved = await service.save(origin, profileId, state.revision, {
                  ...draft,
                  connections: [],
                });
                setState(saved);
                setMessage("Profile saved. Devices use it after their next settings sync.");
              })
            }
          >
            Save profile
          </Button>
        </fieldset>
      )}
      {profileId && (
        <Button type="button" disabled={busy} onClick={() => void act(() => load(profileId))}>
          Reload profile
        </Button>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
