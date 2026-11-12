import type { TFunction } from "i18next";
import type { SettingsResponse } from "@pateat/contracts";
import type { ReactNode } from "react";
import type { SetupReply } from "../connections/types";
import type { ConnectionClient } from "./connection-client";

export type StatusReply = Extract<SetupReply, { kind: "status" }>;
export type Challenge = Extract<
  SetupReply,
  { kind: "mfa-required" | "new-device-verification-required" }
>;
export type EmailCode = "sending" | Extract<SetupReply, { kind: "email-code" }>["result"];
export type Connection = StatusReply["connections"][number];
export type Message = string | ((translate: TFunction) => string);

export type BitwardenSetupProps = {
  client: ConnectionClient;
  onCatalogChanged: () => void;
  acceptedSettings?: Extract<SettingsResponse, { ok: true }> | undefined;
  reviewBlocked?: boolean;
  /** The settings page has unsaved changes, which reloading saved settings would drop. */
  unsavedChanges?: boolean;
  /** Which items Pateat may use from a connection, shown in its row. */
  renderAccess?: (connectionId: string) => ReactNode;
  /** What goes under the rows, given the listed connections once their status was read. */
  renderOthers?: (listed: string[] | undefined) => ReactNode;
};
