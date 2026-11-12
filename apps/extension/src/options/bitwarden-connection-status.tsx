import type { TFunction } from "i18next";
import type { BitwardenProfile } from "@pateat/bitwarden";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { localSyncTime } from "../time";
import {
  CircleCheck,
  CircleX,
  Clock,
  Info,
  Lock,
  LogOut,
  Pause,
  TriangleAlert,
} from "lucide-react";
import { StatusLines, type Tone } from "./ui";
import type { Connection } from "./bitwarden-setup-types";

type Line = { tone: Tone; icon: typeof Info; text: string };

/** The vault, the sync sign-in, the last sync and automatic unlock, one line each. */
export function statusLines(connection: Connection, t: TFunction, language: string): Line[] {
  const lines: Line[] = [];
  switch (connection.state) {
    case "ready":
      lines.push({ tone: "ok", icon: CircleCheck, text: t("Local vault ready") });
      break;
    case "review-required":
      lines.push({
        tone: "warn",
        icon: TriangleAlert,
        text: t("Some items need their field settings reviewed before use."),
      });
      break;
    case "configured":
      lines.push({
        tone: "warn",
        icon: TriangleAlert,
        text: t("Setup incomplete or vault locked"),
      });
      break;
    case "unavailable":
      lines.push({ tone: "err", icon: CircleX, text: t("Vault unavailable") });
      break;
    case "locked":
      lines.push({
        tone: "warn",
        icon: Lock,
        text: t("Vault locked"),
      });
      break;
    case "disabled":
      lines.push({ tone: "idle", icon: LogOut, text: t("Logged out on this device") });
      break;
  }
  switch (connection.providerSession) {
    case "active":
      lines.push({ tone: "ok", icon: CircleCheck, text: t("Sync sign-in saved on this device") });
      break;
    case "refresh-required":
      lines.push({
        tone: "ok",
        icon: CircleCheck,
        text: t("Sync sign-in saved, renewed on the next sync"),
      });
      break;
    case "reauthentication-required":
      lines.push({ tone: "warn", icon: TriangleAlert, text: t("Sign in again to sync") });
      break;
    case "none":
      lines.push({ tone: "idle", icon: Pause, text: t("Not signed in for sync") });
      break;
    case "unavailable":
      lines.push({ tone: "warn", icon: TriangleAlert, text: t("Sync sign-in unavailable") });
      break;
  }
  if (connection.syncedAt !== undefined) {
    const formatted = localSyncTime(connection.syncedAt, language);
    lines.push({
      tone: "idle",
      icon: Clock,
      text: t("Vault synced {{time}}", {
        time: formatted === "at an unknown time" ? t("at an unknown time") : formatted,
      }),
    });
  }
  // An automatic check runs unseen, so its failure stays here until a later check does not
  // fail or a sync applies. Only a refused decryption has a reason of its own: the other
  // setup messages speak of a sign-in in progress or of refreshing, which retries nothing.
  if (connection.syncFailure) {
    const { at, code, check } = connection.syncFailure;
    const formatted = localSyncTime(at, language);
    const time = formatted === "at an unknown time" ? t("at an unknown time") : formatted;
    lines.push({
      tone: "warn",
      icon: TriangleAlert,
      text:
        code === "crypto-failed" && check
          ? t("Last automatic sync failed ({{time}}). {{reason}}", {
              time,
              reason: t(
                "Pateat could not decrypt this vault's data (check: {{check}}). Report this check name.",
                { check },
              ),
            })
          : t("Last automatic sync failed ({{time}}, {{code}}). Press Sync to try again now.", {
              time,
              code,
            }),
    });
  }
  // A locked or logged-out vault has no unlock to describe.
  if (connection.state === "locked" || connection.state === "disabled") return lines;
  if (connection.autoUnlock === "enabled")
    lines.push({ tone: "ok", icon: CircleCheck, text: t("Automatic unlock on") });
  else if (connection.autoUnlock === "disabled")
    lines.push({ tone: "idle", icon: Clock, text: t("Locks at the vault timeout") });
  else lines.push({ tone: "idle", icon: Info, text: t("Automatic unlock unknown") });
  return lines;
}

export const iconButtonClass =
  "inline-grid size-10 flex-none place-items-center rounded-lg border border-transparent bg-transparent text-ink-muted hover:bg-surface-sunken disabled:opacity-50";
export const menuItemClass =
  "flex min-h-9 cursor-default items-center gap-2 rounded-md px-3 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent-tint data-[highlighted]:outline-solid data-[highlighted]:outline-2 data-[highlighted]:-outline-offset-2 data-[highlighted]:outline-focus";

/** The web vault of a connection's server, where an item can be opened by its ID. */
function webVault(environment: BitwardenProfile["environment"]): string {
  if (environment.kind === "self-hosted") return environment.baseUrl;
  return environment.region === "eu" ? "https://vault.bitwarden.eu" : "https://vault.bitwarden.com";
}

/**
 * The received items that the account mapper or strict decryption refused, which Pateat
 * leaves out (ADR 0006). Their names cannot be read, so each is named by its ID and opens in the web
 * vault, where the owner can fix or delete it.
 */
export function UnusableItems({ connection }: { connection: Connection }) {
  const { t } = useTranslation(undefined, { i18n });
  const items = connection.unusableItems;
  if (!items?.length) return null;
  const count = Math.max(connection.unusableItemCount ?? 0, items.length);
  const origin = webVault(connection.environment);
  return (
    <div className="flex flex-col gap-1">
      <StatusLines
        lines={[
          {
            tone: "warn",
            icon: TriangleAlert,
            text: t(
              "{{count}} items could not be read and are not used. Open each in Bitwarden to fix or delete it.",
              { count },
            ),
          },
        ]}
      />
      <ul className="m-0 flex list-none flex-col gap-1 p-0 ps-6 text-[0.8125rem]">
        {items.map(({ itemId, check }) => (
          <li key={itemId}>
            <a
              href={`${origin}/#/vault?itemId=${encodeURIComponent(itemId)}`}
              target="_blank"
              rel="noreferrer"
              className="underline wrap-anywhere"
            >
              {check
                ? t("Item {{itemId}} (check: {{check}})", { itemId, check })
                : t("Item {{itemId}}", { itemId })}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The items used without the fields that did not decrypt (ADR 0006), each named by its ID
 * with those fields' paths and opening in the web vault, where the owner can fix them.
 */
export function PartialItems({ connection }: { connection: Connection }) {
  const { t } = useTranslation(undefined, { i18n });
  const items = connection.partialItems;
  if (!items?.length) return null;
  const count = Math.max(connection.partialItemCount ?? 0, items.length);
  const origin = webVault(connection.environment);
  return (
    <div className="flex flex-col gap-1">
      <StatusLines
        lines={[
          {
            tone: "warn",
            icon: TriangleAlert,
            text: t(
              "{{count}} items are used without the fields that could not be read. Open each in Bitwarden to fix those fields.",
              { count },
            ),
          },
        ]}
      />
      <ul className="m-0 flex list-none flex-col gap-1 p-0 ps-6 text-[0.8125rem]">
        {items.map(({ itemId, fields, moreFieldCount }) => (
          <li key={itemId}>
            <a
              href={`${origin}/#/vault?itemId=${encodeURIComponent(itemId)}`}
              target="_blank"
              rel="noreferrer"
              className="underline wrap-anywhere"
            >
              {t("Item {{itemId}} (not read: {{fields}})", {
                itemId,
                fields: new Intl.ListFormat(i18n.language, {
                  style: "narrow",
                  type: "conjunction",
                }).format([
                  ...fields.map((path) => unreadableFieldLabel(path, t)),
                  ...(moreFieldCount ? [t("{{count}} more", { count: moreFieldCount })] : []),
                ]),
              })}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A name the owner finds in Bitwarden for a path of an item's field that could not be read.
 * Card and identity values keep their property names, as the item's field list shows them.
 */
function unreadableFieldLabel(path: string, t: TFunction): string {
  const [group, index, part] = path.split(".");
  const number = Number(index) + 1;
  if (path === "notes") return t("Notes");
  if (path === "login.username") return t("Username");
  if (path === "login.password") return t("Password");
  if (path === "login.totp") return t("Verification code");
  if (path === "passwordHistory") return t("Password history");
  if (path === "attachments") return t("Attachments");
  if (group === "fields" && part === "name") return t("Custom field {{number}} name", { number });
  if (group === "fields" && part === "value") return t("Custom field {{number}} value", { number });
  if (group === "login" && index === "uris" && part)
    return t("URI {{number}}", { number: Number(part) + 1 });
  return path;
}

/** Where a connection's vault lives, as the Server choice names it. */
export function serverName(environment: BitwardenProfile["environment"], t: TFunction): string {
  if (environment.kind === "self-hosted") return new URL(environment.baseUrl).host;
  return environment.region === "eu" ? t("Bitwarden Cloud EU") : t("Bitwarden Cloud US");
}

/** "a", "a and b", "a, b and c" of the hosts in Chrome match patterns. */
export function listHosts(patterns: string[], language: string): string {
  const hosts = patterns.map((pattern) => new URL(pattern.replace(/\/\*$/, "/")).host);
  return new Intl.ListFormat(language, { style: "long", type: "conjunction" }).format(hosts);
}

/** A connection that cannot sync until its owner signs in again. */
export function needsSignIn(connection: Connection): boolean {
  return (
    connection.state === "configured" ||
    connection.state === "unavailable" ||
    connection.state === "disabled" ||
    // A locked vault unlocks offline first; its sync sign-in waits for that.
    (connection.state !== "locked" &&
      connection.providerSession !== "active" &&
      connection.providerSession !== "refresh-required")
  );
}
