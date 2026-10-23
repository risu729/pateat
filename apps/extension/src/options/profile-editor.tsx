import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LocalSettings, SyncSettingsState, VaultCatalog } from "@pateat/contracts";
import { i18n } from "../i18n";
import {
  ProfileEditorError,
  type ProfileEditorFailure,
  type ProfileEditorClient,
} from "./service-client";
import type { SettingsClient } from "./client";
import { SitePolicy } from "./site-policy";
import { Button } from "./button";
import { controlClass, fieldClass } from "./ui";

const failures: Record<ProfileEditorFailure, string> = {
  "sign-in-needed":
    "Sign in to the service first: open the sign-in page, then load the profiles again. Editing profiles needs the same sign-in as the service's management page.",
  forbidden:
    "The service did not accept your sign-in. Editing profiles needs a browser that can open the service's management page.",
  conflict: "Settings changed elsewhere. Reload this profile before saving again.",
  "not-found": "That profile was deleted. Load the profiles again.",
  unreachable: "The service could not be reached. Try again later.",
  "unexpected-response": "The service gave an unexpected answer. Try again later.",
};

/** Other profiles use this browser's catalog, without changing this browser's policy. */
export function ProfileEditor({
  origin,
  service,
  local,
}: {
  origin: string;
  service: ProfileEditorClient;
  local: SettingsClient;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const [profiles, setProfiles] = useState<{ id: string; name: string }[]>([]);
  const [profileId, setProfileId] = useState("");
  const [state, setState] = useState<SyncSettingsState>();
  const [draft, setDraft] = useState<LocalSettings>();
  const [catalog, setCatalog] = useState<VaultCatalog>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [signIn, setSignIn] = useState(false);
  async function act(run: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    setSignIn(false);
    try {
      await run();
    } catch (error) {
      if (error instanceof ProfileEditorError) {
        setMessage(t(failures[error.reason]));
        setSignIn(error.reason === "sign-in-needed" || error.reason === "forbidden");
      } else setMessage(error instanceof Error ? error.message : t("Profile access failed."));
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
      ...(remote.settings ?? {
        excludedSites: [],
        repromptSites: [],
        siteDefaults: [],
        bindings: [],
      }),
      connections: metadata.snapshot.settings.connections,
    });
  }
  return (
    <section aria-labelledby="profile-editor-heading" className="flex flex-col gap-3">
      <h3 id="profile-editor-heading" className="m-0 text-base font-semibold">
        {t("Edit a settings profile")}
      </h3>
      <p className="m-0 text-sm text-ink-muted">
        {t(
          "Change another profile's site exclusions, sites that ask for the master password and saved accounts from here. Account names come from this browser's vaults. Saving does not change which profile this device uses, and account bindings stay shared by every profile.",
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              setProfiles((await service.list(origin)).profiles);
            })
          }
        >
          {t("Load profiles")}
        </Button>
        {signIn && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void service.openSignIn(origin).catch(() => undefined)}
          >
            {t("Open sign-in page")}
          </Button>
        )}
      </div>
      {profiles.length > 0 && (
        <label className={fieldClass}>
          {t("Profile to edit")}
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
              {t("Choose a profile")}
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
            idPrefix="profile-"
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
                setMessage(t("Profile saved. Devices use it after their next settings sync."));
              })
            }
          >
            {t("Save profile")}
          </Button>
        </fieldset>
      )}
      {profileId && (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void act(() => load(profileId))}
        >
          {t("Reload profile")}
        </Button>
      )}
      <output className="block text-sm leading-5" aria-live="polite">
        {message}
      </output>
    </section>
  );
}
