import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, Link2, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { describeError, type ManageClient } from "./api";
import { Button } from "./button";
import { DEVICES_QUERY_KEY } from "./devices";
import { SETTINGS_QUERY_KEY } from "./settings";
import {
  ErrorNotice,
  Line,
  Lines,
  PAGE_TITLE_CLASSES,
  Panel,
  ROW_CLASSES,
  RowIcon,
  RowList,
  RowMain,
  SuccessNotice,
} from "./ui";

export const PROFILES_QUERY_KEY = ["profiles"] as const;

const STORED_PROFILE = "pateat.manage.profile";

/** The profile the Sites pages edit in this tab; reloads and site pages keep it. */
export function storedProfile(): string | undefined {
  try {
    return sessionStorage.getItem(STORED_PROFILE) ?? undefined;
  } catch {
    return undefined;
  }
}

export function storeProfile(profileId: string) {
  try {
    sessionStorage.setItem(STORED_PROFILE, profileId);
  } catch {
    // Without storage the choice lasts until the next page load.
  }
}

const INPUT_CLASSES =
  "min-h-10 rounded-lg border border-border-strong bg-surface px-3 text-sm text-ink focus-visible:outline-2 focus-visible:outline-focus";

/**
 * The owner's settings profiles (ADR 0076): each holds site exclusions, sites that ask
 * for the master password and saved accounts, and every device uses one. Bindings are the owner's, shared by all of them.
 */
export function ProfilesPage({ client }: { client: ManageClient }) {
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: PROFILES_QUERY_KEY, queryFn: () => client.profiles() });
  const devices = useQuery({ queryKey: DEVICES_QUERY_KEY, queryFn: () => client.devices() });
  const [renaming, setRenaming] = useState<string>();
  const [newName, setNewName] = useState("");
  const [deleting, setDeleting] = useState<string>();
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [copyFrom, setCopyFrom] = useState("");
  const ids = useId();
  const refresh = () => queryClient.invalidateQueries({ queryKey: PROFILES_QUERY_KEY });
  const rename = useMutation({
    mutationFn: ({ id, name: next }: { id: string; name: string }) =>
      client.renameProfile(id, next),
    onSuccess: (profile) => {
      setRenaming(undefined);
      setNotice(`Renamed to ${profile.name}`);
    },
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (profile: { id: string; name: string }) => client.deleteProfile(profile.id),
    onSuccess: (_, profile) => {
      setDeleting(undefined);
      setNotice(`${profile.name} deleted`);
      if (storedProfile() === profile.id) storeProfile("");
    },
    onSettled: refresh,
  });
  const create = useMutation({
    mutationFn: ({ name: next, from }: { name: string; from: string }) =>
      client.copyProfile(next, from),
    onSuccess: async (profile) => {
      setName("");
      setNotice(`${profile.name} created`);
      await queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    },
    onSettled: refresh,
  });
  const failed = [rename, remove, create].find((mutation) => mutation.isError);
  const list = profiles.data?.profiles ?? [];
  const source = copyFrom || list[0]?.id || "";
  const busy = rename.isPending || remove.isPending || create.isPending;
  // One result shows at a time: the last action's.
  const reset = () => {
    rename.reset();
    remove.reset();
    create.reset();
    setNotice("");
  };

  return (
    <section aria-labelledby="profiles-heading" className="space-y-4">
      <h1 id="profiles-heading" className={PAGE_TITLE_CLASSES}>
        Profiles
      </h1>
      <p className="text-sm text-ink-muted">
        A profile holds site exclusions, sites that ask for the master password and saved accounts.
        Each device uses one, chosen when it pairs or on the Devices page. Account bindings are
        shared by every profile.
      </p>
      <SuccessNotice id="profiles-notice" message={notice} />
      {failed?.error && (
        <ErrorNotice id="profiles-error">{describeError(failed.error)}</ErrorNotice>
      )}
      {profiles.isPending ? (
        <output id="profiles-status" className="block">
          Loading profiles…
        </output>
      ) : profiles.isError ? (
        <ErrorNotice id="profiles-status">{describeError(profiles.error)}</ErrorNotice>
      ) : list.length === 0 ? (
        <p id="profiles-status">
          No device is paired with this account yet. Its first pairing creates a profile.
        </p>
      ) : (
        <RowList id="profiles">
          {list.map((profile) => {
            const users = (devices.data?.devices ?? [])
              .filter((device) => device.revokedAt === null && device.profileId === profile.id)
              .map((device) => device.label || "Unnamed device");
            const used = users.length > 0;
            const only = list.length === 1;
            const subId = `${ids}-${profile.id}-sub`;
            const sub = devices.isPending
              ? "Loading devices…"
              : used
                ? `Used by ${new Intl.ListFormat("en", { type: "conjunction" }).format(users)}`
                : "No device uses this profile";
            return (
              <li key={profile.id} className={ROW_CLASSES}>
                <RowIcon>
                  <Layers size={16} aria-hidden />
                </RowIcon>
                {renaming === profile.id ? (
                  <form
                    className="flex flex-[1_1_16rem] flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!newName.trim()) return;
                      reset();
                      rename.mutate({ id: profile.id, name: newName.trim() });
                    }}
                  >
                    <input
                      aria-label={`New name for ${profile.name}`}
                      className={`${INPUT_CLASSES} min-w-0 flex-1`}
                      value={newName}
                      maxLength={64}
                      autoComplete="off"
                      // The field opens on the owner's click, so focus follows it.
                      // oxlint-disable-next-line jsx-a11y/no-autofocus
                      autoFocus
                      onChange={(event) => setNewName(event.target.value)}
                    />
                    <Button type="submit" disabled={busy || !newName.trim()}>
                      Save
                    </Button>
                    <Button type="button" variant="outline" onClick={() => setRenaming(undefined)}>
                      Cancel
                    </Button>
                  </form>
                ) : deleting === profile.id ? (
                  <>
                    <RowMain
                      title={`Delete ${profile.name}?`}
                      sub="Its site exclusions, sites that ask for the master password and saved accounts are deleted. Account bindings stay."
                    />
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => {
                        reset();
                        remove.mutate(profile);
                      }}
                    >
                      Delete
                    </Button>
                    <Button variant="outline" onClick={() => setDeleting(undefined)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <RowMain title={profile.name} sub={<span id={subId}>{sub}</span>} />
                    <a
                      href="/manage/sites"
                      className="inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-accent-ink no-underline hover:bg-surface-sunken"
                      aria-label={`Edit sites of ${profile.name}`}
                      onClick={() => storeProfile(profile.id)}
                    >
                      <Link2 size={16} aria-hidden />
                      Edit sites
                    </a>
                    <Button
                      variant="outline"
                      aria-label={`Rename ${profile.name}`}
                      disabled={busy}
                      onClick={() => {
                        reset();
                        setDeleting(undefined);
                        setNewName(profile.name);
                        setRenaming(profile.id);
                      }}
                    >
                      Rename
                    </Button>
                    <Button
                      variant="danger"
                      aria-label={`Delete ${profile.name}`}
                      // Why it cannot be deleted is on the row; the service refuses too.
                      aria-describedby={used || only ? subId : undefined}
                      disabled={busy || used || only}
                      onClick={() => {
                        reset();
                        setRenaming(undefined);
                        setDeleting(profile.id);
                      }}
                    >
                      <Trash2 size={16} aria-hidden />
                      Delete
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </RowList>
      )}
      {list.length > 0 && (
        <Panel id="profile-create-heading" title="New profile">
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() && source) {
                reset();
                create.mutate({ name: name.trim(), from: source });
              }
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm font-semibold">
                Name
                <input
                  className={INPUT_CLASSES}
                  value={name}
                  maxLength={64}
                  autoComplete="off"
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-semibold">
                Copy settings from
                <select
                  className={INPUT_CLASSES}
                  value={source}
                  onChange={(event) => setCopyFrom(event.target.value)}
                >
                  {list.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div>
              <Button type="submit" disabled={busy || !name.trim()}>
                Create profile
              </Button>
            </div>
          </form>
        </Panel>
      )}
      <Lines>
        <Line icon={<Trash2 size={16} aria-hidden />}>
          A profile can be deleted once no device uses it; move devices on the Devices page
        </Line>
      </Lines>
    </section>
  );
}
