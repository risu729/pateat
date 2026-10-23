import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import {
  conflictCauses,
  localSettingsSchema,
  popupPageSectionShown,
  type LocalSettings,
  type SettingsConflictCause,
  type SettingsResponse,
} from "@pateat/contracts";
import { useForm, useSelector } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bug,
  Globe,
  Info,
  KeyRound,
  Link,
  Shield,
  Timer,
  TriangleAlert,
  Vault,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as v from "valibot";
import { Logo } from "../logo";
import { Button } from "./button";
import { SETTINGS_QUERY_KEY, type SettingsClient } from "./client";
import { VaultAccess, VaultRows } from "./connections";
import { SitePolicy } from "./site-policy";
import { BitwardenSetup } from "./bitwarden-setup";
import { DeviceModelPanel, type DeviceModelClient } from "./device-model";
import type { ConnectionClient } from "./connection-client";
import { backgroundOnlyConflict, saveConflictMessage } from "./save-conflict";
import type { ServiceClient } from "./service-client";
import { ServiceConnection } from "./service-connection";
import { LanguageSelect } from "./language-select";
import { ThemeSelect } from "./theme-select";
import { VaultTimeoutPanel, type VaultTimeoutClient } from "./vault-timeout";
import { Panel, StatusLines, type LocalizedMessage } from "./ui";

type AcceptedSettings = Extract<SettingsResponse, { ok: true }>;
const emptySettings: LocalSettings = {
  connections: [],
  accountPolicies: [],
  itemPolicies: [],
  customFieldReviews: [],
  excludedSites: [],
  passkeyBrowserSites: [],
  repromptSites: [],
  siteDefaults: [],
  bindings: [],
};

export function SettingsApp({
  client,
  connectionClient,
  serviceClient,
  vaultTimeoutClient,
  deviceModelClient,
}: {
  client: SettingsClient;
  connectionClient?: ConnectionClient;
  serviceClient?: ServiceClient;
  /** This device's vault timeout (ADR 0075), shown with a real Bitwarden connection. */
  vaultTimeoutClient?: VaultTimeoutClient;
  /** This device's own Anthropic API key (ADR 0040). */
  deviceModelClient?: DeviceModelClient;
}) {
  const { t } = useTranslation(undefined, { i18n });
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
  // The edits not yet in a saved revision, oldest first, so they can be applied again to a
  // revision that only background work wrote (ADR 0025).
  const unsavedEdits = useRef<((value: LocalSettings) => void)[]>([]);
  // The vault snapshots the oldest unsaved edit was made against; a rebase keeps them, so
  // a save never vouches for custom fields the page did not show (ADR 0023).
  const draftSnapshots = useRef<{ connectionId: string; snapshotId: string }[]>([]);
  // Set once a conflict's edits were applied to the newer revision, so the next save runs
  // even with no new edit; `retried` allows that once until a save or reload succeeds.
  const rebased = useRef(false);
  const retried = useRef(false);
  const submittedEdits = useRef(0);
  const submittedCatalog = useRef(0);
  const lastSaveSucceeded = useRef(false);
  const catalogGeneration = useRef(0);
  const [message, setMessageValue] = useState<LocalizedMessage>(
    (): LocalizedMessage => (translate) => translate("Loading saved settings…"),
  );
  const setMessage = useCallback((value: LocalizedMessage) => setMessageValue(() => value), []);
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
    // Validated here, not as a form validator: TanStack Form keeps a failed submit's errors after
    // later edits, so handleSubmit would skip onSubmit even once a change fixes the draft.
    onSubmit: async ({ value }) => {
      const previous = acceptedRef.current;
      if (!previous || operation.current !== "save" || saveBlockedRef.current) return;
      if (!v.safeParse(localSettingsSchema, value).success) {
        setMessage((translate) =>
          translate(
            "These settings are not valid, so they were not saved. Your unsaved changes are kept. Correct them, and the next change saves them again.",
          ),
        );
        return;
      }
      const submitted = submittedEdits.current;
      const submittedUnsaved = unsavedEdits.current.length;
      // The catalog this draft was edited against, read before the save request yields.
      const epoch = submittedCatalog.current;
      try {
        const result = await saveMutation.mutateAsync({
          version: 1,
          type: "settings.save",
          expectedRevision: previous.snapshot.revision,
          settings: structuredClone(value),
          shownSnapshots: draftSnapshots.current,
        });
        if (epoch !== catalogGeneration.current) {
          setSaveBlocked(true);
          if (!result.ok) {
            setMessage((translate) =>
              translate(
                "Your vaults changed while the settings were being saved. Your unsaved changes are kept. Reload saved settings before you change anything else; reloading drops them.",
              ),
            );
            return;
          }
          // The save went through, so its edits are no longer unsaved; only edits made
          // while it ran still are.
          queryClient.setQueryData(SETTINGS_QUERY_KEY, result);
          lastSaveSucceeded.current = true;
          retried.current = false;
          unsavedEdits.current.splice(0, submittedUnsaved);
          const next = structuredClone(result);
          acceptedRef.current = next;
          setAccepted(next);
          const pending = submitted !== edits.current;
          if (!pending) {
            setDirty(false);
            dirtyRef.current = false;
          }
          setMessage((translate) =>
            translate(
              pending
                ? "Your vaults changed while the settings were being saved. The change was saved, and later changes are kept. Reload saved settings before you change anything else; reloading drops them."
                : "Your vaults changed while the settings were being saved. The change was saved; reload saved settings before you change anything else.",
            ),
          );
          return;
        }
        let causes = !result.ok ? result.error.causes : undefined;
        if (
          !result.ok &&
          result.error.code === "revision-conflict" &&
          !retried.current &&
          backgroundOnlyConflict(causes)
        ) {
          retried.current = true;
          const rebaseResult = await rebase(epoch, previous.snapshot.revision);
          if (rebaseResult === "rebased") return;
          if (epoch !== catalogGeneration.current) {
            setSaveBlocked(true);
            setMessage((translate) =>
              translate(
                "Your vaults changed while the settings were being saved. Your unsaved changes are kept. Reload saved settings before you change anything else; reloading drops them.",
              ),
            );
            return;
          }
          if (rebaseResult) causes = rebaseResult;
        }
        if (!result.ok) {
          const blocked =
            result.error.code !== "invalid-settings" && result.error.code !== "invalid-request";
          setSaveBlocked(blocked);
          setMessage((translate) =>
            result.error.code === "revision-conflict"
              ? saveConflictMessage(causes)(translate)
              : translate(
                  blocked
                    ? "{{error}} Your unsaved changes are kept. Reload saved settings to try again; reloading drops them."
                    : "{{error}} Your unsaved changes are kept.",
                  { error: translate(result.error.message) },
                ),
          );
          return;
        }
        queryClient.setQueryData(SETTINGS_QUERY_KEY, result);
        lastSaveSucceeded.current = true;
        retried.current = false;
        unsavedEdits.current.splice(0, submittedUnsaved);
        if (submitted === edits.current) {
          accept(
            result,
            (translate) =>
              translate("Settings saved (revision {{revision}}).", {
                revision: result.snapshot.revision,
              }),
            false,
          );
          return;
        }
        // Edits made while this save ran stay in the draft and are saved on top of it next.
        const next = structuredClone(result);
        acceptedRef.current = next;
        setAccepted(next);
      } catch {
        setSaveBlocked(true);
        setMessage((translate) =>
          translate(
            "Pateat could not confirm that the settings were saved. Your unsaved changes are kept. Reload saved settings before you try again; reloading drops any that were not saved.",
          ),
        );
      }
    },
  });
  const draft = useSelector(form.store, (state) => state.values);
  /**
   * Applies the unsaved edits to the newest saved revision after a conflict that only
   * background work caused, such as an automatic vault sync, so the save runs once more
   * against it (ADR 0025). When the newest revision was also written by another page, or
   * by a cause no longer recorded, it answers every cause since `expected` instead, and
   * undefined when the newest revision cannot be read for the catalog the draft was edited
   * against.
   */
  async function rebase(
    epoch: number,
    expected: number,
  ): Promise<"rebased" | SettingsConflictCause[] | undefined> {
    let fresh: SettingsResponse;
    try {
      fresh = await queryClient.fetchQuery({
        queryKey: SETTINGS_QUERY_KEY,
        queryFn: () => client.getSettings(),
        staleTime: 0,
        retry: false,
      });
    } catch {
      return undefined;
    }
    if (!fresh.ok || epoch !== catalogGeneration.current) return undefined;
    // Another page may have saved after the conflict was answered.
    const since = conflictCauses(fresh.snapshot, expected);
    if (!backgroundOnlyConflict(since)) return since;
    // Edits made while the newest revision was read are in the list too.
    const next = structuredClone(fresh);
    const value = structuredClone(next.snapshot.settings);
    for (const update of unsavedEdits.current) update(value);
    acceptedRef.current = next;
    setAccepted(next);
    // Field updates, not reset: a reset leaves the form untouched, and the new accepted
    // defaults would then replace the rebased draft on the next render.
    form.setFieldValue("connections", value.connections);
    form.setFieldValue("accountPolicies", value.accountPolicies);
    form.setFieldValue("itemPolicies", value.itemPolicies);
    form.setFieldValue("excludedSites", value.excludedSites);
    form.setFieldValue("repromptSites", value.repromptSites);
    form.setFieldValue("siteDefaults", value.siteDefaults);
    form.setFieldValue("bindings", value.bindings);
    form.setFieldValue("popupPageSection", value.popupPageSection);
    rebased.current = true;
    return "rebased";
  }
  function accept(
    result: AcceptedSettings,
    statusMessage: LocalizedMessage,
    resetAddForms: boolean,
  ) {
    // Accepted metadata and editable values are separate copies. Cache writes never own the draft.
    const next = structuredClone(result);
    acceptedRef.current = next;
    setAccepted(next);
    form.reset(structuredClone(next.snapshot.settings));
    unsavedEdits.current = [];
    draftSnapshots.current = [];
    retried.current = false;
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
      setMessage((translate) =>
        translate("Pateat could not read the saved settings. Reload saved settings to try again."),
      );
    else if (!settings.data.ok) {
      const error = settings.data.error.message;
      setMessage((translate) =>
        translate("{{error}} Reload saved settings to try again.", { error: translate(error) }),
      );
    } else if (catalogGeneration.current) {
      setMessage((translate) =>
        translate(
          "Your vaults changed while the settings were loading. Reload saved settings to see the current vaults.",
        ),
      );
    } else {
      const next = structuredClone(settings.data);
      acceptedRef.current = next;
      setAccepted(next);
      form.reset(structuredClone(next.snapshot.settings));
      saveBlockedRef.current = false;
      setSaveBlockedState(false);
      setMessage((translate) =>
        translate("Saved settings loaded (revision {{revision}}).", {
          revision: next.snapshot.revision,
        }),
      );
    }
    operation.current = undefined;
    setBusy(false);
  }, [settings.data, settings.isError, settings.isFetched, form, setMessage]);
  // oxlint-enable react/set-state-in-effect
  /** Applies one edit to the draft and saves it at once; a running save picks it up after. */
  function edit(update: (value: LocalSettings) => void) {
    if (operation.current === "load" || !acceptedRef.current) return false;
    const next = structuredClone(form.state.values);
    update(next);
    if (!unsavedEdits.current.length)
      draftSnapshots.current = acceptedRef.current.catalog.connections.flatMap((connection) =>
        connection.snapshotId === undefined
          ? []
          : [{ connectionId: connection.id, snapshotId: connection.snapshotId }],
      );
    unsavedEdits.current.push(update);
    form.setFieldValue("connections", next.connections);
    form.setFieldValue("accountPolicies", next.accountPolicies);
    form.setFieldValue("itemPolicies", next.itemPolicies);
    form.setFieldValue("excludedSites", next.excludedSites);
    form.setFieldValue("passkeyBrowserSites", next.passkeyBrowserSites);
    form.setFieldValue("repromptSites", next.repromptSites);
    form.setFieldValue("siteDefaults", next.siteDefaults);
    form.setFieldValue("popupPageSection", next.popupPageSection);
    edits.current += 1;
    setDirty(true);
    dirtyRef.current = true;
    if (saveBlockedRef.current)
      setMessage((translate) =>
        translate(
          "This change was kept but not saved. Reload saved settings before you change anything else; reloading drops it.",
        ),
      );
    void save();
    return true;
  }
  async function reload() {
    if (operation.current) return;
    operation.current = "load";
    setBusy(true);
    setSaveBlocked(true);
    setMessage((translate) => translate("Loading saved settings…"));
    const epoch = catalogGeneration.current;
    // Only an edited draft has unsaved changes to keep, which reloading would drop.
    const unsaved = dirtyRef.current;
    try {
      const result = await queryClient.fetchQuery({
        queryKey: SETTINGS_QUERY_KEY,
        queryFn: () => client.getSettings(),
        staleTime: 0,
        retry: false,
      });
      if (epoch !== catalogGeneration.current) {
        setMessage((translate) =>
          translate(
            unsaved
              ? "Your vaults changed while the settings were loading. Your unsaved changes are kept. Reload saved settings again; reloading drops them."
              : "Your vaults changed while the settings were loading. Reload saved settings again.",
          ),
        );
        return;
      }
      if (!result.ok) {
        setMessage((translate) =>
          translate(
            unsaved
              ? "{{error}} Your unsaved changes are kept. Reload saved settings to try again; reloading drops them."
              : "{{error}} Reload saved settings to try again.",
            { error: translate(result.error.message) },
          ),
        );
        return;
      }
      accept(
        result,
        (translate) =>
          translate("Saved settings loaded (revision {{revision}}).", {
            revision: result.snapshot.revision,
          }),
        true,
      );
    } catch {
      setMessage((translate) =>
        translate(
          unsaved
            ? "Pateat could not read the saved settings. Your unsaved changes are kept. Reload saved settings to try again; reloading drops them."
            : "Pateat could not read the saved settings. Reload saved settings to try again.",
        ),
      );
    } finally {
      operation.current = undefined;
      setBusy(false);
    }
  }
  /**
   * Saves the draft until it has no unsaved edit. A failed or unknown outcome stops here and is
   * never retried, except once after a conflict only background work caused (`rebase`); a
   * blocked draft waits for an explicit reload.
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
        rebased.current = false;
        setMessage((translate) => translate("Saving settings…"));
        // Sequential: each save expects the revision the previous one produced.
        // eslint-disable-next-line no-await-in-loop
        await form.handleSubmit();
        // A failure is never retried as is; an edit made meanwhile is a new draft to save.
        if (
          !lastSaveSucceeded.current &&
          !rebased.current &&
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
      // Only an edited draft has unsaved changes to keep, which reloading would drop.
      const unsaved = dirtyRef.current;
      setMessage((translate) =>
        translate(
          unsaved
            ? "Your vaults changed. Your unsaved changes are kept. Reload saved settings to see the current vaults before you change anything else; reloading drops them."
            : "Your vaults changed. Reload saved settings to see the current vaults before you change anything else.",
        ),
      );
      return;
    }
    void reload();
  }
  const exclusionsWin = (
    <StatusLines
      muted
      lines={[
        { tone: "idle", icon: Info, text: t("Exclusions win over selected groups and items.") },
        {
          tone: "idle",
          icon: Info,
          text: t("These limits apply to Pateat only and do not change vault permissions."),
        },
      ]}
    />
  );
  const sections: NavSection[] = [
    connectionClient
      ? { id: "bitwarden", label: "Bitwarden", icon: Shield }
      : { id: "demo-vaults", label: t("Demo vaults"), icon: Vault },
    ...(vaultTimeoutClient
      ? [{ id: "vault-timeout", label: t("Vault timeout"), icon: Timer }]
      : []),
    { id: "sites", label: t("Sites"), icon: Globe },
    ...(serviceClient ? [{ id: "sync", label: t("Sync service"), icon: Link }] : []),
    ...(deviceModelClient ? [{ id: "ai-key", label: t("AI key"), icon: KeyRound }] : []),
  ];
  return (
    <div className="mx-auto flex max-w-[70rem] flex-col gap-8 px-6 pt-8 pb-12 max-sm:px-4">
      <header className="flex flex-wrap items-center gap-3">
        <Logo className="size-7 shrink-0" />
        <h1 className="m-0 flex-1">{t("Settings")}</h1>
        <Button
          id="reload-settings"
          type="button"
          variant="ghost"
          disabled={busy || saving}
          onClick={() => void reload()}
        >
          {t("Reload saved settings")}
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
            <span>{message(t)}</span>
          </>
        )}
      </output>
      <div className="flex flex-wrap items-start gap-8">
        <SectionNav
          sections={sections}
          display={
            <label className="checkbox-row m-0 text-sm">
              <input
                id="popup-page-section"
                type="checkbox"
                checked={popupPageSectionShown(draft)}
                disabled={busy || !accepted}
                onChange={(event) => {
                  const shown = event.target.checked;
                  // Stored only when hidden, as in the synced document.
                  edit((value) => {
                    if (shown) delete value.popupPageSection;
                    else value.popupPageSection = false;
                  });
                }}
              />
              {t('Show "This page" in the popup')}
            </label>
          }
        />
        <main className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
          {!connectionClient && (
            <StatusLines
              muted
              lines={[
                {
                  tone: "idle",
                  icon: Info,
                  text: t(
                    "This preview cannot collect credentials, connect to Bitwarden or an AI service, fill forms, or sign passkey requests.",
                  ),
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
                  text: t(
                    "Pateat uses no vault item until this device completes its first settings sync with the sync service.",
                  ),
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
              unsavedChanges={dirty}
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
                      <legend className="visually-hidden">{t("Other saved vault settings")}</legend>
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
          {vaultTimeoutClient && <VaultTimeoutPanel client={vaultTimeoutClient} />}
          <fieldset
            id="settings-controls"
            className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0"
            disabled={busy || !accepted}
          >
            <legend className="visually-hidden">{t("Local settings")}</legend>
            {!connectionClient && (
              <Panel id="demo-vaults" headingId="connections-heading" title={t("Demo vaults")}>
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
              <Panel id="sites" headingId="sites-heading" title={t("Sites")}>
                <ul id="site-list" className="hidden" />
              </Panel>
            )}
          </fieldset>
          {serviceClient && <ServiceConnection client={serviceClient} settingsClient={client} />}
          {deviceModelClient && <DeviceModelPanel client={deviceModelClient} />}
          <footer className="flex flex-wrap gap-4 text-[0.8125rem] leading-5 text-ink-muted">
            <a href="legal.html" target="_blank" rel="noreferrer">
              {t("Licenses and source")}
            </a>
            <span>{t("GPL-3.0-only, no warranty")}</span>
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
 * The page's sections, the diagnostics page, the theme, the popup's display choice and the
 * language; the section in view is marked.
 */
function SectionNav({ sections, display }: { sections: NavSection[]; display: ReactNode }) {
  const { t } = useTranslation(undefined, { i18n });
  const [current, setCurrent] = useState(sections[0]?.id);
  const ids = sections.map((section) => section.id).join(" ");
  // A clicked link's section stays marked while the page jumps to it, until the person
  // scrolls or the address changes to another fragment, such as by Back.
  const clicked = useRef<string>(undefined);
  useEffect(() => {
    const update = () => {
      if (clicked.current) return;
      // Look sections up on each scroll: some remount, such as Sites once settings load.
      const tops = ids.split(" ").flatMap((id) => {
        const element = document.getElementById(id);
        return element ? [{ id, top: element.getBoundingClientRect().top }] : [];
      });
      const atBottom =
        scrollY > 0 && scrollY + innerHeight >= document.documentElement.scrollHeight - 1;
      // The last section whose top has reached the upper part of the window; at the
      // bottom of the page, where short last sections never get there, the last one shown.
      const line = atBottom ? innerHeight : innerHeight * 0.4;
      const reached = tops.findLast((section) => section.top <= line) ?? tops[0];
      if (reached) setCurrent(reached.id);
    };
    // Wheel, touch, scrollbar drags and scrolling keys start with one of these.
    const userInput = ["wheel", "pointerdown", "keydown"] as const;
    const release = () => {
      clicked.current = undefined;
    };
    // Back, Forward and other address changes from the browser bring no page input.
    const addressChanged = () => {
      if (clicked.current === undefined || location.hash === `#${clicked.current}`) return;
      release();
      update();
    };
    update();
    addEventListener("scroll", update, { passive: true });
    addEventListener("resize", update);
    addEventListener("hashchange", addressChanged);
    for (const type of userInput) addEventListener(type, release, { capture: true, passive: true });
    return () => {
      removeEventListener("scroll", update);
      removeEventListener("resize", update);
      removeEventListener("hashchange", addressChanged);
      for (const type of userInput) removeEventListener(type, release, { capture: true });
    };
  }, [ids]);
  return (
    <nav
      aria-label={t("Sections")}
      className="flex max-w-60 flex-[1_1_200px] flex-col gap-6 lg:sticky lg:top-8"
    >
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {sections.map(({ id, label, icon: Icon }) => (
          <li key={id}>
            <a
              href={`#${id}`}
              className={navLinkClass}
              aria-current={current === id ? "location" : undefined}
              onClick={() => {
                clicked.current = id;
                setCurrent(id);
              }}
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
            {t("Diagnostics")}
          </a>
        </li>
      </ul>
      <div className="flex flex-col gap-4 px-3">
        <ThemeSelect />
        {display}
        <LanguageSelect />
      </div>
    </nav>
  );
}
