import { useMutation } from "@tanstack/react-query";
import { FileDown, Info } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";
import { transferResponseSchema, type TransferResponse } from "@pateat/contracts";
import { i18n } from "../i18n";
import { Button } from "./button";
import { Panel, StatusLines, type LocalizedMessage } from "./ui";

/**
 * The largest file the page reads: the recipes and settings a device keeps, with room for
 * an indented file.
 */
export const MAX_TRANSFER_FILE_BYTES = 8 * 1024 * 1024;

/** Exports and imports what a pairing shares (ADR 0040), through the service worker. */
export interface TransferClient {
  exportFile(): Promise<TransferResponse>;
  importFile(file: unknown): Promise<TransferResponse>;
}

export function createTransferClient(send: (message: unknown) => Promise<unknown>): TransferClient {
  return {
    exportFile: async () =>
      v.parse(transferResponseSchema, await send({ version: 1, type: "settings.export" })),
    importFile: async (file) =>
      v.parse(transferResponseSchema, await send({ version: 1, type: "settings.import", file })),
  };
}

/** Hands the file to the browser's downloads, as a link the page clicks. */
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // After the click has handed the file over.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const failures = {
  "invalid-file": "This is not a Pateat export file, or its settings do not fit with these.",
  "too-large": "The recipes do not fit with the ones this device keeps. Nothing was imported.",
  "storage-unavailable": "Pateat could not read or write its storage. Try again.",
} as const;

/**
 * Export and import (ADR 0040): a file with the settings a pairing shares, the bindings
 * and the recipes logins use, to pass to a device without the sync service. Importing
 * keeps every entry this device has, and the file's entry wins where both hold one.
 */
export function TransferPanel({
  client,
  blocked,
  onImported,
  save = download,
  now = Date.now,
}: {
  client: TransferClient;
  /** While the page holds unsaved changes, an import would make them conflict. */
  blocked: boolean;
  /** Called after an import, so the page loads the merged settings. */
  onImported: () => void;
  save?: (name: string, text: string) => void;
  now?: () => number;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const [message, setMessageValue] = useState<LocalizedMessage>();
  const setMessage = (value: LocalizedMessage) => setMessageValue(() => value);
  const input = useRef<HTMLInputElement>(null);
  const failed = (response: TransferResponse): LocalizedMessage | undefined =>
    response.ok ? undefined : (translate) => translate(failures[response.error]);
  const exportFile = useMutation({
    mutationFn: () => client.exportFile(),
    onMutate: () => setMessage((translate) => translate("Exporting…")),
    onSuccess: (response) => {
      if (!response.ok && response.error === "too-large") {
        setMessage((translate) =>
          translate("The settings or recipes are larger than an export file holds."),
        );
        return;
      }
      if (!response.ok || response.type !== "settings.export") {
        setMessage(failed(response) ?? ((translate) => translate(failures["invalid-file"])));
        return;
      }
      const day = new Date(now()).toISOString().slice(0, 10);
      save(`pateat-export-${day}.json`, `${JSON.stringify(response.file, null, 2)}\n`);
      setMessage((translate) =>
        translate("Exported the settings and {{count}} recipe.", {
          count: response.file.recipes.length,
        }),
      );
    },
    onError: () => setMessage((translate) => translate(failures["storage-unavailable"])),
  });
  const importFile = useMutation({
    mutationFn: async (file: File): Promise<TransferResponse> => {
      if (file.size > MAX_TRANSFER_FILE_BYTES)
        return { version: 1, ok: false, error: "invalid-file" };
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        return { version: 1, ok: false, error: "invalid-file" };
      }
      return client.importFile(parsed);
    },
    onMutate: () => setMessage((translate) => translate("Importing…")),
    onSuccess: (response) => {
      if (!response.ok || response.type !== "settings.import") {
        setMessage(failed(response) ?? ((translate) => translate(failures["invalid-file"])));
        return;
      }
      setMessage((translate) =>
        translate("Imported the settings and {{count}} new or newer recipe.", {
          count: response.recipes,
        }),
      );
      onImported();
    },
    onError: () => setMessage((translate) => translate(failures["storage-unavailable"])),
  });
  const busy = exportFile.isPending || importFile.isPending;
  return (
    <Panel id="transfer" headingId="transfer-heading" title={t("Export and import")}>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          id="transfer-export"
          type="button"
          disabled={busy}
          onClick={() => exportFile.mutate()}
        >
          {t("Export to a file")}
        </Button>
        <Button
          id="transfer-import"
          type="button"
          variant="ghost"
          disabled={busy || blocked}
          aria-describedby="transfer-note"
          onClick={() => input.current?.click()}
        >
          {t("Import from a file")}
        </Button>
        <input
          ref={input}
          id="transfer-file"
          className="hidden"
          type="file"
          accept="application/json,.json"
          aria-label={t("Pateat export file")}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // The same file can be chosen again.
            event.target.value = "";
            if (file) importFile.mutate(file);
          }}
        />
      </div>
      <output id="transfer-message" className="text-sm" aria-live="polite">
        {message?.(t)}
      </output>
      <StatusLines
        id="transfer-note"
        muted
        lines={[
          ...(blocked
            ? [
                {
                  tone: "warn" as const,
                  icon: Info,
                  text: t("Save or reload the settings above before you import."),
                },
              ]
            : []),
          {
            tone: "idle",
            icon: FileDown,
            text: t(
              "The file holds what a paired sync service keeps: the site settings, the vault policies with their account and item names, the accounts chosen for sites, and the recipes logins use. It never holds vault keys or values, the sync service's sign-in or the AI key.",
            ),
          },
          {
            tone: "idle",
            icon: Info,
            text: t(
              "Importing keeps everything this device has; where both hold the same entry, the file's wins. A recipe replaces one kept here only at a newer revision. A paired device uploads the imported ones at its next sync.",
            ),
          },
        ]}
      />
    </Panel>
  );
}
