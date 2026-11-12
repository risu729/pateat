import type { LocalSettings, LoginDetail, SettingsResponse } from "@pateat/contracts";
import type { TFunction } from "i18next";
import type { Dispatch, SetStateAction } from "react";
import { SETTINGS_QUERY_KEY, type SettingsClient } from "../options/client";
import {
  pickFailure,
  switchRefusal,
  type ChoiceClient,
  type PauseLength,
} from "../login/choice-wire";
import { detailFillFailure, detailName, type DetailClient } from "../login/detail-wire";
import { PAUSE_CHOICES, siteRules } from "./pause";
import type { PopupHost } from "./site-app";
import type { DetailSource } from "./site-details";
import type { useSiteQueries } from "./site-queries";

type Saved = Extract<SettingsResponse, { ok: true }>;
export type NoticeText = (translate: TFunction) => string;
export type SiteNotice = { text?: NoticeText; tone: "progress" | "success" | "error" };
type SiteQueries = ReturnType<typeof useSiteQueries>;

/** Creates this render's operations; SiteApp owns their shared busy and notice state. */
export function createSiteActions({
  saved,
  busy,
  setReprompting,
  setBusy,
  say,
  client,
  queryClient,
  choice,
  settings,
  tabId,
  choices,
  host,
  inPrivate,
  refreshPause,
  origin,
  timedPause,
  details,
  pageDetails,
  setNotice,
}: {
  saved: Saved | undefined;
  busy: boolean;
  setReprompting: Dispatch<SetStateAction<boolean | undefined>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  say: (text: NoticeText, tone: SiteNotice["tone"]) => void;
  client: SettingsClient;
  queryClient: SiteQueries["queryClient"];
  choice: SiteQueries["choice"];
  settings: SiteQueries["settings"];
  tabId: number | undefined;
  choices: ChoiceClient;
  host: PopupHost;
  inPrivate: boolean;
  refreshPause: SiteQueries["refreshPause"];
  origin: string | undefined;
  timedPause: number | undefined;
  details: DetailClient;
  pageDetails: SiteQueries["pageDetails"];
  setNotice: Dispatch<SetStateAction<SiteNotice>>;
}) {
  /** Saves a change to the settings; false when it was not saved. */
  async function change(
    update: (value: LocalSettings) => void,
    done: NoticeText,
  ): Promise<boolean> {
    if (!saved || busy) {
      setReprompting(undefined);
      return false;
    }
    const next = structuredClone(saved.snapshot.settings);
    update(next);
    setBusy(true);
    say((translate) => translate("Saving…"), "progress");
    try {
      const response = await client.saveSettings({
        version: 1,
        type: "settings.save",
        expectedRevision: saved.snapshot.revision,
        settings: next,
      });
      if (response.ok) {
        queryClient.setQueryData<Saved>(SETTINGS_QUERY_KEY, response);
        say(done, "success");
        // A default saved for the site can end a waiting choice; the background clears it.
        if (choice.isEnabled) void choice.refetch();
        return true;
      }
      if (response.error.code === "revision-conflict") {
        await settings.refetch();
        say(
          (translate) =>
            translate(
              "The settings changed elsewhere, so this change was not saved. The popup now shows them.",
            ),
          "error",
        );
      } else
        say(
          (translate) =>
            translate("The change could not be saved. Reopen this popup and try again."),
          "error",
        );
    } catch {
      // The store may still have saved it; reopening shows the saved settings.
      say(
        (translate) =>
          translate(
            "The change may not have been saved. Reopen this popup to see the saved settings.",
          ),
        "error",
      );
    } finally {
      setBusy(false);
      setReprompting(undefined);
    }
    return false;
  }

  async function pick(
    offered: Extract<Awaited<ReturnType<ChoiceClient["get"]>>, { ok: true }>,
    selected: { connectionId: string; itemId: string; name: string },
    asDefault: boolean,
    isDefault: boolean,
  ) {
    if (tabId === undefined || busy) return;
    setBusy(true);
    say((translate) => translate("Starting the login…"), "progress");
    try {
      const response = await choices.pick({
        tabId,
        documentId: offered.documentId,
        connectionId: selected.connectionId,
        itemId: selected.itemId,
        makeDefault: asDefault,
      });
      if (response.ok) {
        say(
          (translate) =>
            asDefault
              ? translate(
                  "Logging in with {{name}}. It becomes the default once the login succeeds.",
                  {
                    name: selected.name,
                  },
                )
              : translate("Logging in with {{name}}.", { name: selected.name }),
          "success",
        );
        // The login runs in the page from here; the popup has nothing left to show.
        host.close();
        return;
      }
      // The saved default stays when its own pick fails, so only another account is said
      // not to have become the default.
      say(
        (translate) =>
          pickFailure(
            response.reason,
            selected.name,
            asDefault && !isDefault,
            translate,
            inPrivate,
          ),
        "error",
      );
      await choice.refetch();
    } catch {
      say(
        (translate) =>
          translate("The login could not be started. Reopen this popup and try again."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function switchTo(
    selected: { connectionId: string; itemId: string; name: string },
    asDefault: boolean,
  ) {
    if (tabId === undefined || busy) return;
    setBusy(true);
    say(
      (translate) => translate("Logging out to switch to {{name}}…", { name: selected.name }),
      "progress",
    );
    try {
      const response = await choices.switchTo({
        tabId,
        connectionId: selected.connectionId,
        itemId: selected.itemId,
        makeDefault: asDefault,
      });
      // The page section follows the switch from here.
      if (response.ok) setNotice({ tone: "success" });
      else say((translate) => switchRefusal(response.reason, selected.name, translate), "error");
      await refreshPause();
    } catch {
      say(
        (translate) =>
          translate("The switch could not be started. Reopen this popup and try again."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Allows the tab's site, which the allowed sites leave out (ADR 0077): its registrable
   * site with its subdomains, the site a pause covers, so automatic login runs there again.
   */
  async function allowSite(site: string) {
    if (
      await change(
        (value) => {
          value.allowedSites = [
            ...(value.allowedSites ?? []).filter((rule) => rule.hostname !== site),
            { hostname: site, includeSubdomains: true },
          ];
        },
        (translate) => translate("{{site}} and its subdomains are now allowed sites.", { site }),
      )
    )
      void refreshPause();
  }
  /**
   * Pauses automatic login of the tab's site for `length`, until turned back on with an
   * exclusion rule, or resumes it, also removing the site's own rules (ADR 0062).
   */
  async function setPause(length: PauseLength | "rule" | undefined) {
    if (tabId === undefined || busy || !origin) return;
    const rules = saved && siteRules(saved.snapshot.settings, origin);
    if (length === "rule") {
      if (
        rules &&
        (await change(
          (value) => rules.pause(value),
          (translate) => translate("Automatic login on this site is paused until turned back on."),
        ))
      )
        void refreshPause();
      return;
    }
    // Resume removes the site's own rule first; a pause of a length then ends too.
    if (length === undefined && rules?.rules.length) {
      const removed = await change(
        (value) => rules.resume(value),
        (translate) => translate("Automatic login on this site resumed."),
      );
      if (!removed || timedPause === undefined) {
        void refreshPause();
        return;
      }
    }
    setBusy(true);
    say((translate) => translate(length ? "Pausing…" : "Resuming…"), "progress");
    try {
      const response = await choices.pause(
        tabId,
        length ? { paused: true, length } : { paused: false },
      );
      if (response.ok) {
        const lengthChosen = PAUSE_CHOICES.find((entry) => entry.length === length);
        say(
          (translate) =>
            lengthChosen
              ? lengthChosen.done(translate)
              : translate("Automatic login on this site resumed."),
          "success",
        );
        await refreshPause();
        if (choice.isEnabled) void choice.refetch();
      } else
        say(
          (translate) =>
            translate(
              response.reason === "no-site"
                ? "This tab has no site to pause."
                : "The pause could not be saved. Try again.",
            ),
          "error",
        );
    } catch {
      say(
        (translate) =>
          translate("The pause could not be changed. Reopen this popup and try again."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function fillDetail(documentId: string, detail: LoginDetail, source: DetailSource) {
    if (tabId === undefined || busy) return;
    setBusy(true);
    say((translate) => translate("Filling…"), "progress");
    try {
      const response = await details.fill({
        tabId,
        documentId,
        detail,
        connectionId: source.connectionId,
        itemId: source.itemId,
        fieldId: source.fieldId,
      });
      say(
        (translate) =>
          response.ok
            ? translate(
                "Filled. Check it and submit the form; Pateat saves this choice once you are signed in.",
              )
            : detailFillFailure(response.reason, translate),
        response.ok ? "success" : "error",
      );
      await pageDetails.refetch();
    } catch {
      say(
        (translate) => translate("Nothing was filled. Reopen this popup and try again."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function removeDetail(detail: LoginDetail) {
    if (tabId === undefined || busy) return;
    setBusy(true);
    say((translate) => translate("Removing…"), "progress");
    try {
      const response = await details.remove(tabId, detail);
      if (response.ok)
        say(
          (translate) =>
            translate("Removed. Pateat no longer fills {{detail}} on this site.", {
              detail: detailName(detail, translate),
            }),
          "success",
        );
      else if (response.reason === "no-link")
        say((translate) => translate("This link was already removed."), "success");
      else
        say(
          (translate) =>
            translate("The link could not be removed. Reopen this popup and try again."),
          "error",
        );
      await pageDetails.refetch();
    } catch {
      say(
        (translate) =>
          translate("The link may not have been removed. Reopen this popup to see the links."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function askAgain() {
    if (tabId === undefined || busy) return;
    setBusy(true);
    say((translate) => translate("Opening the master password window…"), "progress");
    try {
      // Answered once the window is done; the popup closes on its own as the window opens.
      const response = await choices.reprompt(tabId);
      if (response.ok) {
        // The window asks from here; the popup would stay over it.
        host.close();
        return;
      }
      say(
        (translate) =>
          response.reason === "unavailable"
            ? translate(
                "The master password window could not open. It opens only for the active tab outside incognito, one window at a time.",
              )
            : response.reason === "closed"
              ? translate("The master password window was closed before the vault item was used.")
              : translate("This page no longer waits for the master password. Reload it."),
        "error",
      );
    } catch {
      say(
        (translate) =>
          translate("The master password window could not open. Reopen this popup and try again."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  return { change, pick, switchTo, allowSite, setPause, fillDetail, removeDetail, askAgain };
}
