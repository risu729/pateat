import { localSettingsSchema, type LocalSettings, type SettingsResponse } from "@pateat/contracts";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "./button";
import { RUNTIME_STATUS_QUERY_KEY, SETTINGS_QUERY_KEY, type SettingsClient } from "./client";
import { Connections } from "./connections";
import { SitePolicy } from "./site-policy";

type AcceptedSettings = Extract<SettingsResponse, { ok: true }>;
const emptySettings: LocalSettings = { connections: [], excludedSites: [], siteDefaults: [] };

function RuntimeStatus({ client }: { client: SettingsClient }) {
  const refreshing = useRef(false);
  const status = useQuery({
    queryKey: RUNTIME_STATUS_QUERY_KEY,
    queryFn: () => client.getStatus(),
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
  });
  async function refresh() {
    if (refreshing.current || status.isFetching) return;
    refreshing.current = true;
    try {
      await status.refetch();
    } finally {
      refreshing.current = false;
    }
  }
  const known = !status.isError && status.data;
  return (
    <section aria-labelledby="status-heading" className="panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="status-heading">Runtime status</h2>
        <span className="badge">Foundation only</span>
      </div>
      <output id="runtime-status" className="block">
        {status.isFetching
          ? "Checking extension…"
          : status.isError
            ? "Unable to read runtime status. Reload the extension and try again."
            : "Extension ready · Foundation only"}
      </output>
      <dl>
        <div>
          <dt>Vault</dt>
          <dd id="vault-status">
            {known && known.vault === "not-connected" ? "Not connected" : "Unknown"}
          </dd>
        </div>
        <div>
          <dt>Optional service</dt>
          <dd id="service-status">
            {known && known.service === "not-configured" ? "Not configured" : "Unknown"}
          </dd>
        </div>
        <div>
          <dt>Automatic login</dt>
          <dd id="login-status">
            {known && known.login === "not-implemented" ? "Not implemented" : "Unknown"}
          </dd>
        </div>
      </dl>
      <Button
        id="refresh-status"
        type="button"
        variant="outline"
        disabled={status.isFetching}
        onClick={() => void refresh()}
      >
        Refresh status
      </Button>
    </section>
  );
}

export function SettingsApp({ client }: { client: SettingsClient }) {
  const queryClient = useQueryClient();
  const [accepted, setAccepted] = useState<AcceptedSettings>();
  const acceptedRef = useRef<AcceptedSettings | undefined>(undefined);
  const initialHandled = useRef(false);
  // Acquire synchronously before any await: React state alone cannot prevent racing events.
  const operation = useRef<"load" | "save" | undefined>("load");
  const [busy, setBusy] = useState(true);
  const [saveBlocked, setSaveBlocked] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("Loading saved settings…");
  const [generation, setGeneration] = useState(0);
  const settings = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => client.getSettings(),
    retry: false,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const saveMutation = useMutation({
    mutationFn: (request: Parameters<SettingsClient["saveSettings"]>[0]) =>
      client.saveSettings(request),
    retry: false,
    gcTime: 0,
  });
  const form = useForm({
    // Match reset's accepted defaults so a later hook update cannot restore the empty draft.
    defaultValues: accepted?.snapshot.settings ?? emptySettings,
    validators: { onSubmit: localSettingsSchema },
    onSubmit: async ({ value }) => {
      const previous = acceptedRef.current;
      if (!previous || operation.current !== "save") return;
      try {
        const result = await saveMutation.mutateAsync({
          version: 1,
          type: "settings.save",
          expectedRevision: previous.snapshot.revision,
          settings: structuredClone(value),
        });
        if (!result.ok) {
          const blocked =
            result.error.code !== "invalid-settings" && result.error.code !== "invalid-request";
          setSaveBlocked(blocked);
          setMessage(
            result.error.code === "revision-conflict"
              ? "Settings changed in another window. Your unsaved draft has been preserved. Reload saved settings to review the latest version before saving."
              : `${result.error.message} Your unsaved draft has been preserved.${blocked ? " Reload saved settings to retry." : ""}`,
          );
          return;
        }
        accept(result, `Settings saved locally · Revision ${result.snapshot.revision}`, false);
        queryClient.setQueryData(SETTINGS_QUERY_KEY, result);
      } catch {
        setSaveBlocked(true);
        setMessage(
          "Unable to confirm saved settings. Your unsaved draft has been preserved. Reload saved settings before trying again.",
        );
      }
    },
  });
  const draft = useStore(form.store, (state) => state.values);
  function accept(result: AcceptedSettings, statusMessage: string, resetAddForms: boolean) {
    // Accepted metadata and editable values are separate copies. Cache writes never own the draft.
    const next = structuredClone(result);
    acceptedRef.current = next;
    setAccepted(next);
    form.reset(structuredClone(next.snapshot.settings));
    setDirty(false);
    setSaveBlocked(false);
    setMessage(statusMessage);
    if (resetAddForms) setGeneration((current) => current + 1);
  }
  // Synchronize the external query once into an independent editable snapshot.
  // oxlint-disable react/set-state-in-effect
  useEffect(() => {
    if (initialHandled.current || !settings.isFetched) return;
    initialHandled.current = true;
    if (settings.isError || !settings.data)
      setMessage(
        "Unable to read saved settings. Your existing draft has been preserved. Reload saved settings to retry.",
      );
    else if (!settings.data.ok)
      setMessage(
        `${settings.data.error.message} Reload saved settings to retry. Your existing draft has been preserved.`,
      );
    else {
      const next = structuredClone(settings.data);
      acceptedRef.current = next;
      setAccepted(next);
      form.reset(structuredClone(next.snapshot.settings));
      setSaveBlocked(false);
      setMessage(`Saved settings loaded · Revision ${next.snapshot.revision}`);
    }
    operation.current = undefined;
    setBusy(false);
  }, [settings.data, settings.isError, settings.isFetched, form]);
  // oxlint-enable react/set-state-in-effect
  function edit(update: (value: LocalSettings) => void) {
    if (operation.current || !acceptedRef.current) return false;
    const next = structuredClone(form.state.values);
    update(next);
    form.setFieldValue("connections", next.connections);
    form.setFieldValue("excludedSites", next.excludedSites);
    form.setFieldValue("siteDefaults", next.siteDefaults);
    setDirty(true);
    if (!saveBlocked) setMessage("Unsaved changes. Save settings to apply this draft.");
    return true;
  }
  async function reload() {
    if (operation.current) return;
    operation.current = "load";
    setBusy(true);
    setSaveBlocked(true);
    setMessage("Loading saved settings…");
    try {
      const result = await queryClient.fetchQuery({
        queryKey: SETTINGS_QUERY_KEY,
        queryFn: () => client.getSettings(),
        staleTime: 0,
        retry: false,
      });
      if (!result.ok) {
        setMessage(
          `${result.error.message} Reload saved settings to retry. Your existing draft has been preserved.`,
        );
        return;
      }
      accept(result, `Saved settings loaded · Revision ${result.snapshot.revision}`, true);
    } catch {
      setMessage(
        "Unable to read saved settings. Your existing draft has been preserved. Reload saved settings to retry.",
      );
    } finally {
      operation.current = undefined;
      setBusy(false);
    }
  }
  async function save() {
    if (operation.current || saveBlocked || !acceptedRef.current || !dirty) return;
    operation.current = "save";
    setBusy(true);
    setMessage("Saving local settings…");
    try {
      await form.handleSubmit();
      if (!form.state.isValid)
        setMessage(
          "Invalid settings. Your unsaved draft has been preserved. Review this draft before saving.",
        );
    } finally {
      operation.current = undefined;
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="mb-8 max-w-3xl">
        <p className="eyebrow">Pateat · Local settings preview</p>
        <h1>Settings</h1>
        <p className="intro">
          Configure local policy with demo vault metadata. No real vault is connected, and this
          preview cannot log in to websites.
        </p>
      </header>
      <output
        id="settings-status"
        className="settings-status block"
        aria-live="polite"
        aria-atomic="true"
      >
        {message}
      </output>
      <fieldset id="settings-controls" disabled={busy || !accepted}>
        <legend className="visually-hidden">Local settings</legend>
        <section aria-labelledby="connections-heading" className="panel">
          <h2 id="connections-heading">Demo vault connections</h2>
          <p className="note">
            Synthetic names and field labels only. No passwords, keys or field values.
          </p>
          {accepted ? (
            <Connections
              draft={draft}
              catalog={accepted.catalog}
              change={(id, update) =>
                edit((value) => {
                  const connection = value.connections.find((entry) => entry.connectionId === id);
                  if (connection) update(connection);
                })
              }
            />
          ) : (
            <div id="connections" />
          )}
          <p className="note">
            Exclusions always win over selected groups and items. These controls restrict Pateat
            use; they do not change vault permissions.
          </p>
        </section>
        {accepted ? (
          <SitePolicy key={generation} draft={draft} catalog={accepted.catalog} edit={edit} />
        ) : (
          <>
            <section className="panel" aria-labelledby="sites-heading">
              <h2 id="sites-heading">Excluded sites</h2>
              <ul id="excluded-sites" />
            </section>
            <section className="panel" aria-labelledby="defaults-heading">
              <h2 id="defaults-heading">Site default accounts</h2>
              <ul id="site-defaults" />
            </section>
          </>
        )}
      </fieldset>
      <form
        id="settings-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="settings-footer"
      >
        <div className="flex flex-wrap gap-3">
          <Button
            id="save-settings"
            type="submit"
            disabled={busy || saveBlocked || !accepted || !dirty}
          >
            Save settings
          </Button>
          <Button
            id="reload-settings"
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void reload()}
          >
            Reload saved settings
          </Button>
        </div>
        <p className="note">
          Edits stay in this page until saved. Reload saved settings discards this page's unsaved
          draft.
        </p>
      </form>
      <RuntimeStatus client={client} />
      <p className="note">
        This preview cannot collect credentials, connect to Bitwarden or an AI service, fill forms,
        or sign passkey requests.
      </p>
    </main>
  );
}
