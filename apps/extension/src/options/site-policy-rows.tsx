import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import {
  resolveSiteAccount,
  siteDefaultConnection,
  type LocalSettings,
  type SiteAccountsResponse,
  type SiteDefault,
  type VaultCatalog,
} from "@pateat/contracts";

import {
  CircleCheck,
  Info,
  LockKeyhole,
  Pause,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { pauseSite } from "../login/pause";
import { unavailableReason } from "./unavailable-reason";
import { Button } from "./button";
import { Badge, controlClass, RowTitle, StatusLines, type Tone } from "./ui";

import type { TFunction } from "i18next";
import type { RefObject } from "react";
import {
  siteAccountOptions,
  matchedBy,
  NO_DEFAULT,
  SAVED_ELSEWHERE,
  defaultFor,
  replaceDefault,
  hostOf,
  ruleFor,
} from "./site-policy-rules";

type ExcludedSite = LocalSettings["excludedSites"][number];

function ruleName(rule: ExcludedSite): string {
  return rule.includeSubdomains
    ? i18n.t("{{hostname}} and subdomains", { hostname: rule.hostname })
    : rule.hostname;
}

/**
 * One site in the list: what it is, its state lines, and the controls that act on it. Each
 * kind of row passes its own controls, so another per-site setting adds controls here.
 */
function SiteRow({
  title,
  badges,
  lines,
  controls,
}: {
  title: string;
  badges?: ReactNode;
  lines?: ReactNode;
  controls: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-1">
        <RowTitle>
          <span>{title}</span>
          {badges}
        </RowTitle>
        {lines}
      </div>
      <div className="flex flex-[2_1_380px] flex-wrap items-center justify-end gap-2">
        {controls}
      </div>
    </li>
  );
}

/** The default account control of an origin row: its select and an explicit Save. */
function DefaultAccountEditor({
  idPrefix,
  origin,
  options,
  current,
  save,
}: {
  idPrefix: string;
  origin: string;
  options: { value: string; text: string }[];
  current: string;
  save: (value: string) => string | undefined;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const [choice, setChoice] = useState<string>();
  const [error, setError] = useState("");
  // A choice the list no longer offers falls back to the saved value.
  const shown =
    choice !== undefined && options.some((entry) => entry.value === choice) ? choice : current;
  const errorId = `${idPrefix}site-default-error-${origin}`;
  return (
    <>
      <label className="contents">
        <span className="visually-hidden">{t("Default account for {{origin}}", { origin })}</span>
        <select
          className={`${controlClass} max-w-[18.75rem] flex-[1_1_220px]`}
          value={shown}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => {
            setChoice(event.target.value);
            setError("");
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.text}
            </option>
          ))}
        </select>
      </label>
      <Button
        type="button"
        variant="outline"
        aria-label={t("Save default for {{origin}}", { origin })}
        disabled={shown === current}
        onClick={() => {
          const failure = save(shown);
          setError(failure ?? "");
          if (!failure) setChoice(undefined);
        }}
      >
        {t("Save")}
      </Button>
      {error && (
        <p id={errorId} className="validation-error m-0 basis-full text-right" role="alert">
          {t(error)}
        </p>
      )}
    </>
  );
}

/** Renders the site's saved defaults and policy rows from the current render's state. */
export function createSitePolicyRows({ t, idPrefix, draft, catalog, edit, savedMatch, originInput }: {
  t: TFunction;
  idPrefix: string;
  draft: LocalSettings;
  catalog: VaultCatalog;
  edit: (update: (value: LocalSettings) => void) => boolean;
  savedMatch: (origin: string) => Extract<SiteAccountsResponse, { ok: true }> | undefined;
  originInput: RefObject<HTMLInputElement | null>;
}) {
  /** An origin row: its default account, editable in place, and a way to exclude its host. */
  function originRow(selected: SiteDefault) {
    const { origin } = selected;
    const mapped = siteDefaultConnection(selected, catalog);
    const connection = mapped.ok
      ? catalog.connections.find((entry) => entry.id === mapped.connectionId)
      : undefined;
    const item = connection?.items.find((entry) => entry.id === selected.itemId);
    const resolved = resolveSiteAccount(draft, catalog, origin);
    // A live vault item has no static origins; its URI rules (or a passkey) are
    // checked against each page, so the draft policy cannot call it a mismatch.
    const liveItem = Boolean(item && connection?.snapshotId);
    const matches = savedMatch(origin);
    const match = liveItem
      ? matches?.accounts.find(
          (entry) => entry.connectionId === connection?.id && entry.itemId === item?.id,
        )
      : undefined;
    let line: { tone: Tone; icon: LucideIcon; text: string } | undefined;
    if (resolved.ok) line = undefined;
    else if (!liveItem || resolved.reason !== "item-origin-mismatch")
      line = { tone: "warn", icon: TriangleAlert, text: t(unavailableReason(resolved.reason)) };
    else if (match)
      line = {
        tone: "ok",
        icon: CircleCheck,
        text: t("Matches this origin by {{method}}. It is checked again at each login.", {
          method: t(matchedBy({ uri: match.uri, passkey: match.passkey })),
        }),
      };
    else if (matches?.complete && !connection?.quarantinedItemIds?.includes(selected.itemId))
      line = {
        tone: "warn",
        icon: TriangleAlert,
        text: t(
          "No URI rule or passkey of this item matches this origin. A URI rule on a longer path is checked at each login.",
        ),
      };
    else
      line = {
        tone: "idle",
        icon: Info,
        text: t(
          "Whether it matches a page is checked against its URI rules or passkeys at each login.",
        ),
      };
    const unavailable = !resolved.ok && (!liveItem || resolved.reason !== "item-origin-mismatch");
    const current = connection && item ? JSON.stringify([connection.id, item.id]) : SAVED_ELSEWHERE;
    const offered = siteAccountOptions(catalog, matches, false, draft);
    const currentText = t("{{item}} in {{account}}{{availability}}", {
      item: `${item?.label ?? selected.itemName ?? selected.itemId}${match?.username ? ` · ${match.username}` : ""}`,
      account:
        connection?.label ?? selected.accountName ?? t("account {{id}}", { id: selected.userId }),
      availability: !connection
        ? t(" (not available here)")
        : unavailable
          ? t(" (unavailable)")
          : "",
    });
    const options = [
      ...(offered.some((entry) => entry.value === current)
        ? []
        : [{ value: current, text: currentText }]),
      ...offered.map((entry) => ({
        value: entry.value,
        text:
          entry.value === current
            ? currentText
            : t("{{item}} in {{account}}", { item: entry.label, account: entry.connectionLabel }),
      })),
      { value: NO_DEFAULT, text: t("No default") },
    ];
    const site = pauseSite(origin) ?? hostOf(origin);
    return (
      <SiteRow
        key={`origin ${origin}`}
        title={origin}
        lines={line && <StatusLines small lines={[line]} />}
        controls={
          <>
            <DefaultAccountEditor
              idPrefix={idPrefix}
              origin={origin}
              options={options}
              current={current}
              save={(value) => {
                if (value === NO_DEFAULT) {
                  // The row goes away with its default, so focus moves to the add form.
                  if (edit((settings) => replaceDefault(settings, origin)))
                    originInput.current?.focus();
                  return undefined;
                }
                const next = defaultFor(
                  origin,
                  offered.find((entry) => entry.value === value),
                  catalog,
                );
                if (!next.ok) return next.message;
                edit((settings) => replaceDefault(settings, origin, next.value));
                return undefined;
              }}
            />
            <Button
              type="button"
              variant="outline"
              aria-label={t(
                "Pause automatic login on {{site}} and its subdomains, which includes {{origin}}",
                { site, origin },
              )}
              onClick={() => {
                // As the popup pauses it: the registrable site with its subdomains (ADR 0062).
                edit((settings) => {
                  settings.excludedSites = settings.excludedSites.filter(
                    (entry) => entry.hostname !== site,
                  );
                  settings.excludedSites.push({ hostname: site, includeSubdomains: true });
                });
                originInput.current?.focus();
              }}
            >
              <Pause aria-hidden size={16} strokeWidth={2} />
              {t("Pause")}
            </Button>
          </>
        }
      />
    );
  }

  /**
   * An exclusion rule, which pauses automatic login of its hosts until it is removed
   * (ADR 0062), with the defaults it keeps from being used by themselves.
   */
  function ruleRow(rule: ExcludedSite) {
    const name = ruleName(rule);
    const kept = draft.siteDefaults.filter(
      (entry) => ruleFor(draft.excludedSites, entry.origin) === rule,
    );
    return (
      <SiteRow
        key={`rule ${rule.hostname}`}
        title={name}
        badges={
          <Badge muted icon={Pause}>
            {t("Paused")}
          </Badge>
        }
        lines={kept.map((entry) => (
          <div key={entry.origin} className="flex flex-wrap items-center gap-x-2">
            <StatusLines
              small
              lines={[
                {
                  tone: "idle",
                  icon: Info,
                  text: t(
                    "The default for {{origin}} is kept; while the site is paused it is only listed first in the popup.",
                    { origin: entry.origin },
                  ),
                },
              ]}
            />
            <Button
              type="button"
              variant="ghost"
              aria-label={t("Remove default for {{origin}}", { origin: entry.origin })}
              onClick={() => {
                if (edit((settings) => replaceDefault(settings, entry.origin)))
                  originInput.current?.focus();
              }}
            >
              {t("Remove default")}
            </Button>
          </div>
        ))}
        controls={
          <Button
            type="button"
            variant="outline"
            aria-label={t("Resume {{name}}", { name })}
            onClick={() => {
              edit((settings) => {
                settings.excludedSites = settings.excludedSites.filter(
                  (entry) => entry.hostname !== rule.hostname,
                );
              });
              originInput.current?.focus();
            }}
          >
            {t("Resume")}
          </Button>
        }
      />
    );
  }

  /** A site that asks for the master password before a re-prompt item is used. */
  function repromptRow(rule: ExcludedSite) {
    const name = ruleName(rule);
    return (
      <SiteRow
        key={`reprompt ${rule.hostname}`}
        title={name}
        badges={
          <Badge muted icon={LockKeyhole}>
            {t("Asks for the master password")}
          </Badge>
        }
        controls={
          <Button
            type="button"
            variant="outline"
            aria-label={t("Stop asking for the master password on {{name}}", { name })}
            onClick={() => {
              edit((settings) => {
                settings.repromptSites = settings.repromptSites.filter(
                  (entry) => entry.hostname !== rule.hostname,
                );
              });
              originInput.current?.focus();
            }}
          >
            {t("Stop asking")}
          </Button>
        }
      />
    );
  }

  return { originRow, ruleRow, repromptRow };
}
