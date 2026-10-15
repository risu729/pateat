import { localSettingsSchema, type LocalSettings, type SettingsResponse } from "@pateat/contracts";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bug,
  Globe,
  Info,
  Link,
  Shield,
  TriangleAlert,
  Vault,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Logo } from "../logo";
import { Button } from "./button";
import { SETTINGS_QUERY_KEY, type SettingsClient } from "./client";
import { VaultAccess, VaultRows } from "./connections";
import { SitePolicy } from "./site-policy";
import { BitwardenSetup } from "./bitwarden-setup";
import type { ConnectionClient } from "./connection-client";
import type { ServiceClient } from "./service-client";
import { ServiceConnection } from "./service-connection";
import { ThemeSelect } from "./theme-select";
import { Panel, StatusLines } from "./ui";

type AcceptedSettings = Extract<SettingsResponse, { ok: true }>;
const emptySettings: LocalSettings = {
  connections: [],
  accountPolicies: [],
  itemPolicies: [],
  customFieldReviews: [],
  excludedSites: [],
  siteDefaults: [],
  bindings: [],
};

export function SettingsApp({
  client,
  connectionClient,
  serviceClient,
}: {
  client: SettingsClient;
  connectionClient?: ConnectionClient;
  serviceClient?: ServiceClient;
}) {
  const queryClient = useQueryClient();
  const [accepted, setAccepted] = useState<AcceptedSettings>();
  const acceptedRef = useRef<AcceptedSettings | undefined>(undefined);
  const initialHandled = useRef(false);
  // Acquire synchronously before any await: React state alone cannot prevent racing events.
  const operation = useRef<"load" | "save" | undefined>("load");
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveBlocked, setSaveBlockedState] = useState(true);
  const saveBlockedRef = useRef(true);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  // Each edit counts, so a save that finishes after a later edit keeps that edit and saves again.
  const edits = useRef(0);
  const submittedEdits = useRef(0);
  const submittedCatalog = useRef(0);
  const lastSaveSucceeded = useRef(false);
  const catalogGeneration = useRef(0);
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
  function setSaveBlocked(blocked: boolean) {
    saveBlockedRef.current = blocked;
    setSaveBlockedState(blocked);
  }
  const form = useForm({
    // Match reset's accepted defaults so a later hook update cannot restore the empty draft.
    defaultValues: accepted?.snapshot.settings ?? emptySettings,
    validators: { onSubmit: localSettingsSchema },
    onSubmit: async ({ value }) => {
      const previous = acceptedRef.current;
      if (!previous || operation.current !== "save" || saveBlockedRef.current) return;
      const submitted = submittedEdits.current;
      // The catalog this draft was edited against, read before validation could yield.
      const epoch = submittedCatalog.current;
      try {
        const result = await saveMutation.mutateAsync({
          version: 1,
          type: "settings.save",
          expectedRevision: previous.snapshot.revision,
          settings: structuredClone(value),
        });
        if (epoch !== catalogGeneration.current) {
          setSaveBlocked(true);
          setMessage(
            "Vault metadata changed while settings were being saved. Your draft has been preserved. Reload saved settings before saving again. Reloading discards the draft.",
          );
          return;
        }
        if (!result.ok) {
          const blocked =
            result.error.code !== "invalid-settings" && result.error.code !== "invalid-request";
          setSaveBlocked(blocked);
          setMessage(
            result.error.code === "revision-conflict"
              ? "Settings changed in another window. Your unsaved draft has been preserved. Reload saved settings to review the latest version before saving. Reloading discards the draft."
              : `${result.error.message} Your unsaved draft has been preserved.${blocked ? " Reload saved settings to retry. Reloading discards the draft." : ""}`,
          );
          return;
        }
        queryClient.setQueryData(SETTINGS_QUERY_KEY, result);
        lastSaveSucceeded.current = true;
        if (submitted === edits.current) {
          accept(result, `Settings saved locally. Revision ${result.snapshot.revision}`, false);
          return;
        }
        // Edits made while this save ran stay in the draft and are saved on top of it next.
        const next = structuredClone(result);
        acceptedRef.current = next;
        setAccepted(next);
      } catch {
        setSaveBlocked(true);
        setMessage(
          "Unable to confirm saved settings. Your unsaved draft has been preserved. Reload saved settings before trying again. Reloading discards the draft.",
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
    dirtyRef.current = false;
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
        "Unable to read saved settings. Your existing draft has been preserved. Reload saved settings to retry. Reloading discards the draft.",
      );
    else if (!settings.data.ok)
      setMessage(
        `${settings.data.error.message} Reload saved settings to retry. Your existing draft has been preserved. Reloading discards the draft.`,
      );
    else if (catalogGeneration.current) {
      setMessage(
        "Vault metadata changed while settings were loading. Reload saved settings to read the current catalog.",
      );
    } else {
      const next = structuredClone(settings.data);
      acceptedRef.current = next;
      setAccepted(next);
      form.reset(structuredClone(next.snapshot.settings));
      saveBlockedRef.current = false;
      setSaveBlockedState(false);
      setMessage(`Saved settings loaded. Revision ${next.snapshot.revision}`);
    }
    operation.current = undefined;
    setBusy(false);
  }, [settings.data, settings.isError, settings.isFetched, form]);
  // oxlint-enable react/set-state-in-effect
  /** Applies one edit to the draft and saves it at once; a running save picks it up after. */
  function edit(update: (value: LocalSettings) => void) {
    if (operation.current === "load" || !acceptedRef.current) return false;
    const next = structuredClone(form.state.values);
    update(next);
    form.setFieldValue("connections", next.connections);
    form.setFieldValue("accountPolicies", next.accountPolicies);
    form.setFieldValue("itemPolicies", next.itemPolicies);
    form.setFieldValue("excludedSites", next.excludedSites);
    form.setFieldValue("siteDefaults", next.siteDefaults);
    edits.current += 1;
    setDirty(true);
    dirtyRef.current = true;
    if (saveBlockedRef.current)
      setMessage(
        "This change is kept in the draft but was not saved. Reload saved settings before editing; reloading discards the draft.",
      );
    void save();
    return true;
  }
  async function reload() {
    if (operation.current) return;
    operation.current = "load";
    setBusy(true);
    setSaveBlocked(true);
    setMessage("Loading saved settings…");
    const epoch = catalogGeneration.current;
    try {
      const result = await queryClient.fetchQuery({
        queryKey: SETTINGS_QUERY_KEY,
        queryFn: () => client.getSettings(),
        staleTime: 0,
        retry: false,
      });
      if (epoch !== catalogGeneration.current) {
        setMessage(
          "Vault metadata changed while settings were loading. Your draft has been preserved. Reload saved settings again. Reloading discards the draft.",
        );
        return;
      }
      if (!result.ok) {
        setMessage(
          `${result.error.message} Reload saved settings to retry. Your existing draft has been preserved. Reloading discards the draft.`,
        );
        return;
      }
      accept(result, `Saved settings loaded. Revision ${result.snapshot.revision}`, true);
    } catch {
      setMessage(
        "Unable to read saved settings. Your existing draft has been preserved. Reload saved settings to retry. Reloading discards the draft.",
      );
    } finally {
      operation.current = undefined;
      setBusy(false);
    }
  }
  /**
   * Saves the draft until it has no unsaved edit. A failed or unknown outcome stops here and is
   * never retried; a blocked draft waits for an explicit reload.
   */
  async function save() {
    if (operation.current) return;
    operation.current = "save";
    setSaving(true);
    try {
      while (dirtyRef.current && !saveBlockedRef.current && acceptedRef.current) {
        submittedEdits.current = edits.current;
        submittedCatalog.current = catalogGeneration.current;
        lastSaveSucceeded.current = false;
        setMessage("Saving local settings…");
        // Sequential: each save expects the revision the previous one produced.
        // eslint-disable-next-line no-await-in-loop
        await form.handleSubmit();
        if (!form.state.isValid)
          setMessage(
            "Invalid settings. Your unsaved draft has been preserved. Review this draft; the next change saves it again.",
          );
        // A failure is never retried as is; an edit made meanwhile is a new draft to save.
        if (
          !lastSaveSucceeded.current &&
          (saveBlockedRef.current || submittedEdits.current === edits.current)
        )
          break;
      }
    } finally {
      operation.current = undefined;
      setSaving(false);
    }
  }
  function catalogChanged() {
    ++catalogGeneration.current;
    if (dirtyRef.current || operation.current || saveBlockedRef.current) {
      setSaveBlocked(true);
      setMessage(
        "Vault metadata changed. Your unsaved draft has been preserved. Reload saved settings to review the latest catalog before saving. Reloading discards the draft.",
      );
      return;
    }
    void reload();
  }
  const exclusionsWin = (
    <StatusLines
      muted
      lines={[
        { tone: "idle", icon: Info, text: "Exclusions win over selected groups and items" },
        {
          tone: "idle",
          icon: Info,
          text: "These limits apply to Pateat only and do not change vault permissions",
        },
      ]}
    />
  );
  const sections: NavSection[] = [
    connectionClient
      ? { id: "bitwarden", label: "Bitwarden", icon: Shield }
      : { id: "demo-vaults", label: "Demo vaults", icon: Vault },
    { id: "sites", label: "Sites", icon: Globe },
    ...(serviceClient ? [{ id: "sync", label: "Sync service", icon: Link }] : []),
  ];
  return (
    <div className="mx-auto flex max-w-[70rem] flex-col gap-8 px-6 pt-8 pb-12 max-sm:px-4">
      <header className="flex flex-wrap items-center gap-3">
        <Logo className="size-7 shrink-0" />
        <h1 className="m-0 flex-1">Settings</h1>
        <Button
          id="reload-settings"
          type="button"
          variant="ghost"
          disabled={busy || saving}
          onClick={() => void reload()}
        >
          Reload saved settings
        </Button>
      </header>
      <output
        id="settings-status"
        className="settings-status -mt-4 flex items-start gap-2 text-sm leading-5"
        aria-live="polite"
        aria-atomic="true"
      >
        {message && (
          <>
            <Info
              aria-hidden
              size={16}
              strokeWidth={2}
              className="mt-0.5 flex-none text-accent-ink"
            />
            <span>{message}</span>
          </>
        )}
      </output>
      <div className="flex flex-wrap items-start gap-8">
        <SectionNav sections={sections} />
        <main className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
          {!connectionClient && (
            <StatusLines
              muted
              lines={[
                {
                  tone: "idle",
                  icon: Info,
                  text: "This preview cannot collect credentials, connect to Bitwarden or an AI service, fill forms, or sign passkey requests.",
                },
              ]}
            />
          )}
          {accepted?.catalog.settingsSyncPending && (
            <StatusLines
              lines={[
                {
                  tone: "warn",
                  icon: TriangleAlert,
                  text: "Pateat uses no vault item until this device completes its first settings sync with the sync service.",
                },
              ]}
            />
          )}
          {connectionClient && (
            <BitwardenSetup
              client={connectionClient}
              onCatalogChanged={catalogChanged}
              acceptedSettings={accepted}
              reviewBlocked={dirty || busy || saveBlocked}
              renderAccess={(id) => {
                const metadata = accepted?.catalog.connections.find((entry) => entry.id === id);
                return (
                  accepted &&
                  metadata && (
                    <VaultAccess
                      draft={draft}
                      catalog={accepted.catalog}
                      metadata={metadata}
                      disabled={busy}
                      edit={edit}
                    />
                  )
                );
              }}
              renderOthers={(listed) => (
                <>
                  {accepted && listed && (
                    <fieldset
                      className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
                      disabled={busy}
                    >
                      <legend className="visually-hidden">Other saved vault settings</legend>
                      <VaultRows
                        ids={accepted.catalog.connections
                          .map((entry) => entry.id)
                          .filter((id) => !listed.includes(id))}
                        draft={draft}
                        catalog={accepted.catalog}
                        edit={edit}
                      />
                    </fieldset>
                  )}
                  {exclusionsWin}
                </>
              )}
            />
          )}
          <fieldset
            id="settings-controls"
            className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0"
            disabled={busy || !accepted}
          >
            <legend className="visually-hidden">Local settings</legend>
            {!connectionClient && (
              <Panel id="demo-vaults" headingId="connections-heading" title="Demo vaults">
                {accepted ? (
                  <VaultRows
                    ids={accepted.catalog.connections.map((entry) => entry.id)}
                    draft={draft}
                    catalog={accepted.catalog}
                    edit={edit}
                  />
                ) : (
                  <ul id="connections" className="hidden" />
                )}
                {exclusionsWin}
              </Panel>
            )}
            {accepted ? (
              <SitePolicy
                key={generation}
                draft={draft}
                catalog={accepted.catalog}
                edit={edit}
                findSiteAccounts={client.findSiteAccounts}
              />
            ) : (
              <Panel id="sites" headingId="sites-heading" title="Sites">
                <ul id="site-list" className="hidden" />
              </Panel>
            )}
          </fieldset>
          {serviceClient && <ServiceConnection client={serviceClient} />}
          <footer className="flex flex-wrap gap-4 text-[0.8125rem] leading-5 text-ink-muted">
            <a href="legal.html" target="_blank" rel="noreferrer">
              Licenses and source
            </a>
            <span>GPL-3.0-only, no warranty</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

type NavSection = { id: string; label: string; icon: LucideIcon };
const navLinkClass =
  "flex min-h-10 items-center gap-2.5 rounded-lg px-3 text-sm font-medium text-ink no-underline hover:bg-surface aria-[current]:bg-surface aria-[current]:font-[650] aria-[current]:text-accent-ink aria-[current]:shadow-[inset_0_0_0_1px_var(--border)]";

/** The page's sections, the diagnostics page and the theme; the section in view is marked. */
function SectionNav({ sections }: { sections: NavSection[] }) {
  const [current, setCurrent] = useState(sections[0]?.id);
  const ids = sections.map((section) => section.id).join(" ");
  useEffect(() => {
    const visible = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting);
        // The first section in page order that is in the upper part of the window.
        const first = ids.split(" ").find((id) => visible.get(id));
        if (first) setCurrent(first);
      },
      { rootMargin: "0px 0px -60% 0px" },
    );
    for (const id of ids.split(" ")) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [ids]);
  return (
    <nav
      aria-label="Sections"
      className="flex max-w-60 flex-[1_1_200px] flex-col gap-6 lg:sticky lg:top-8"
    >
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {sections.map(({ id, label, icon: Icon }) => (
          <li key={id}>
            <a
              href={`#${id}`}
              className={navLinkClass}
              aria-current={current === id ? "location" : undefined}
              onClick={() => setCurrent(id)}
            >
              <Icon aria-hidden size={16} strokeWidth={2} />
              {label}
            </a>
          </li>
        ))}
        <li>
          <a
            id="diagnostics-link"
            href="diagnostics.html"
            target="_blank"
            rel="noreferrer"
            className={navLinkClass}
          >
            <Bug aria-hidden size={16} strokeWidth={2} />
            Diagnostics
          </a>
        </li>
      </ul>
      <div className="px-3">
        <ThemeSelect />
      </div>
    </nav>
  );
}
