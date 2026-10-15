import {
  localSettingsSchema,
  type ConnectionSettings,
  type LocalSettings,
  type SettingsResponse,
} from "@pateat/contracts";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bug, Globe, Info, Link, Shield, Vault, type LucideIcon } from "lucide-react";
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
import { PageSectionToggle } from "./page-section-toggle";
import { ThemeSelect } from "./theme-select";
import { Panel, StatusLines } from "./ui";

type AcceptedSettings = Extract<SettingsResponse, { ok: true }>;
// The draft keeps every change a save could not make; reloading replaces it.
const KEPT = "Your unsaved changes are kept.";
const RELOAD_DROPS = "reloading drops them.";
/** What a message adds about unsaved changes, which only an edited draft has. */
function unsaved(dirty: boolean) {
  return dirty ? { kept: ` ${KEPT}`, drops: `; ${RELOAD_DROPS}` } : { kept: "", drops: "." };
}
const emptySettings: LocalSettings = {
  connections: [],
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
            `Your vaults changed while the settings were being saved. ${KEPT} Reload saved settings before you change anything else; ${RELOAD_DROPS}`,
          );
          return;
        }
        if (!result.ok) {
          const blocked =
            result.error.code !== "invalid-settings" && result.error.code !== "invalid-request";
          setSaveBlocked(blocked);
          setMessage(
            result.error.code === "revision-conflict"
              ? `The settings changed in another window. ${KEPT} Reload saved settings to see the latest ones before you change anything else; ${RELOAD_DROPS}`
              : `${result.error.message} ${KEPT}${blocked ? ` Reload saved settings to try again; ${RELOAD_DROPS}` : ""}`,
          );
          return;
        }
        queryClient.setQueryData(SETTINGS_QUERY_KEY, result);
        lastSaveSucceeded.current = true;
        if (submitted === edits.current) {
          accept(result, `Settings saved (revision ${result.snapshot.revision}).`, false);
          return;
        }
        // Edits made while this save ran stay in the draft and are saved on top of it next.
        const next = structuredClone(result);
        acceptedRef.current = next;
        setAccepted(next);
      } catch {
        setSaveBlocked(true);
        setMessage(
          `Pateat could not confirm that the settings were saved. ${KEPT} Reload saved settings before you try again; ${RELOAD_DROPS}`,
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
      setMessage("Pateat could not read the saved settings. Reload saved settings to try again.");
    else if (!settings.data.ok)
      setMessage(`${settings.data.error.message} Reload saved settings to try again.`);
    else if (catalogGeneration.current) {
      setMessage(
        "Your vaults changed while the settings were loading. Reload saved settings to see the current vaults.",
      );
    } else {
      const next = structuredClone(settings.data);
      acceptedRef.current = next;
      setAccepted(next);
      form.reset(structuredClone(next.snapshot.settings));
      saveBlockedRef.current = false;
      setSaveBlockedState(false);
      setMessage(`Saved settings loaded (revision ${next.snapshot.revision}).`);
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
    form.setFieldValue("excludedSites", next.excludedSites);
    form.setFieldValue("siteDefaults", next.siteDefaults);
    edits.current += 1;
    setDirty(true);
    dirtyRef.current = true;
    if (saveBlockedRef.current)
      setMessage(
        `This change was kept but not saved. Reload saved settings before you change anything else; ${RELOAD_DROPS}`,
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
    const { kept, drops } = unsaved(dirtyRef.current);
    try {
      const result = await queryClient.fetchQuery({
        queryKey: SETTINGS_QUERY_KEY,
        queryFn: () => client.getSettings(),
        staleTime: 0,
        retry: false,
      });
      if (epoch !== catalogGeneration.current) {
        setMessage(
          `Your vaults changed while the settings were loading.${kept} Reload saved settings again${drops}`,
        );
        return;
      }
      if (!result.ok) {
        setMessage(`${result.error.message}${kept} Reload saved settings to try again${drops}`);
        return;
      }
      accept(result, `Saved settings loaded (revision ${result.snapshot.revision}).`, true);
    } catch {
      setMessage(
        `Pateat could not read the saved settings.${kept} Reload saved settings to try again${drops}`,
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
        setMessage("Saving settings…");
        // Sequential: each save expects the revision the previous one produced.
        // eslint-disable-next-line no-await-in-loop
        await form.handleSubmit();
        if (!form.state.isValid)
          setMessage(
            `These settings are not valid, so they were not saved. ${KEPT} Correct them, and the next change saves them again.`,
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
      const { kept, drops } = unsaved(dirtyRef.current);
      setMessage(
        `Your vaults changed.${kept} Reload saved settings to see the current vaults before you change anything else${drops}`,
      );
      return;
    }
    void reload();
  }
  const changeConnection = (id: string, update: (value: ConnectionSettings) => void) =>
    edit((value) => {
      const connection = value.connections.find((entry) => entry.connectionId === id);
      if (connection) update(connection);
    });
  const exclusionsWin = (
    <StatusLines
      muted
      lines={[
        { tone: "idle", icon: Info, text: "Exclusions win over selected groups and items." },
        {
          tone: "idle",
          icon: Info,
          text: "These limits apply to Pateat only and do not change vault permissions.",
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
          {connectionClient && (
            <BitwardenSetup
              client={connectionClient}
              onCatalogChanged={catalogChanged}
              acceptedSettings={accepted}
              reviewBlocked={dirty || busy || saveBlocked}
              renderAccess={(id) => {
                const connection = draft.connections.find((entry) => entry.connectionId === id);
                const metadata = accepted?.catalog.connections.find((entry) => entry.id === id);
                return (
                  connection &&
                  metadata && (
                    <VaultAccess
                      connection={connection}
                      metadata={metadata}
                      disabled={busy || !accepted}
                      edit={(update) => changeConnection(id, update)}
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
                        ids={draft.connections
                          .map((entry) => entry.connectionId)
                          .filter((id) => !listed.includes(id))}
                        draft={draft}
                        catalog={accepted.catalog}
                        change={changeConnection}
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
                    ids={draft.connections.map((entry) => entry.connectionId)}
                    draft={draft}
                    catalog={accepted.catalog}
                    change={changeConnection}
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

/**
 * The page's sections, the diagnostics page and this device's display choices; the section
 * in view is marked.
 */
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
      <div className="flex flex-col gap-4 px-3">
        <ThemeSelect />
        <PageSectionToggle />
      </div>
    </nav>
  );
}
