import { useMutation } from "@tanstack/react-query";
import { FileDown, Info, TriangleAlert } from "lucide-react";
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
/** The sites a preview names before it counts the rest. */
const LISTED_SITES = 10;

/** Exports and imports what a pairing shares (ADR 0040), through the service worker. */
export interface TransferClient {
  exportFile(): Promise<TransferResponse>;
  /** `apply` false asks what the import would change; true imports. */
  importFile(file: unknown, apply: boolean): Promise<TransferResponse>;
}

export function createTransferClient(send: (message: unknown) => Promise<unknown>): TransferClient {
  return {
    exportFile: async () =>
      v.parse(transferResponseSchema, await send({ version: 1, type: "settings.export" })),
    importFile: async (file, apply) =>
      v.parse(
        transferResponseSchema,
        await send({ version: 1, type: "settings.import", file, apply }),
      ),
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
  "too-large":
    "The file's settings or recipes do not fit with the ones on this device. Nothing was imported.",
  "storage-unavailable": "Pateat could not read or write its storage. Try again.",
} as const;

type Preview = Extract<TransferResponse, { type: "settings.import-preview" }>;

/**
 * Export and import (ADR 0040): a file with the settings a pairing shares, the bindings
 * and the recipes logins use, to pass to a device without the sync service. Importing
 * keeps every entry this device has, and the file's entry wins where both hold one; the
 * owner first sees what it would change.
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
  const setMessage = (value: LocalizedMessage | undefined) => setMessageValue(() => value);
  // The file read and what importing it would change, until it is imported or dropped.
  const [pending, setPending] = useState<{ file: unknown; preview: Preview }>();
  const input = useRef<HTMLInputElement>(null);
  const failed =
    (response: TransferResponse): LocalizedMessage =>
    (translate) =>
      translate(failures[response.ok ? "invalid-file" : response.error]);
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
        setMessage(failed(response));
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
  const previewFile = useMutation({
    mutationFn: async (chosen: File) => {
      if (chosen.size > MAX_TRANSFER_FILE_BYTES) return undefined;
      let file: unknown;
      try {
        file = JSON.parse(await chosen.text());
      } catch {
        return undefined;
      }
      return { file, response: await client.importFile(file, false) };
    },
    onMutate: () => {
      setPending(undefined);
      setMessage((translate) => translate("Reading the file…"));
    },
    onSuccess: (read) => {
      if (!read) {
        setMessage((translate) => translate(failures["invalid-file"]));
        return;
      }
      const { file, response } = read;
      if (!response.ok || response.type !== "settings.import-preview") {
        setMessage(failed(response));
        return;
      }
      setMessage(undefined);
      setPending({ file, preview: response });
    },
    onError: () => setMessage((translate) => translate(failures["storage-unavailable"])),
  });
  const importFile = useMutation({
    mutationFn: (file: unknown) => client.importFile(file, true),
    onMutate: () => setMessage((translate) => translate("Importing…")),
    onSuccess: (response) => {
      setPending(undefined);
      if (!response.ok || response.type !== "settings.import") {
        setMessage(failed(response));
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
  const busy = exportFile.isPending || previewFile.isPending || importFile.isPending;
  const preview = pending?.preview;
  const listed = preview?.sites.slice(0, LISTED_SITES) ?? [];
  const unchanged =
    preview !== undefined &&
    preview.sites.length + preview.policies + preview.others + preview.recipes === 0;
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
            const chosen = event.target.files?.[0];
            // The same file can be chosen again.
            event.target.value = "";
            if (chosen) previewFile.mutate(chosen);
          }}
        />
      </div>
      <output id="transfer-message" className="text-sm" aria-live="polite">
        {message?.(t)}
      </output>
      {preview && (
        <section
          id="transfer-preview"
          aria-labelledby="transfer-preview-heading"
          className="flex flex-col gap-3 rounded-lg border border-border p-4 text-sm"
        >
          <h3 id="transfer-preview-heading" className="m-0 text-[0.95rem]">
            {unchanged ? t("This file changes nothing here.") : t("Importing this file will:")}
          </h3>
          {!unchanged && (
            <ul className="m-0 flex flex-col gap-1.5 pl-5">
              {preview.sites.length > 0 && (
                <li>
                  <span>
                    {t("Choose which of your vault items Pateat uses on {{count}} site:", {
                      count: preview.sites.length,
                    })}
                  </span>
                  <ul id="transfer-sites" className="m-0 pl-5">
                    {listed.map((site) => (
                      <li key={site}>{site}</li>
                    ))}
                    {preview.sites.length > listed.length && (
                      <li>
                        {t("and {{count}} more", { count: preview.sites.length - listed.length })}
                      </li>
                    )}
                  </ul>
                </li>
              )}
              {preview.policies > 0 && (
                <li>{t("Change {{count}} vault limit.", { count: preview.policies })}</li>
              )}
              {preview.others > 0 && (
                <li>{t("Change {{count}} site rule.", { count: preview.others })}</li>
              )}
              {preview.recipes > 0 && (
                <li>{t("Keep {{count}} new or newer recipe.", { count: preview.recipes })}</li>
              )}
            </ul>
          )}
          {!unchanged && (
            <StatusLines
              lines={[
                {
                  tone: "warn",
                  icon: TriangleAlert,
                  text: t(
                    "Import only a file you exported yourself or got from someone you trust: it can let Pateat use your vault items on the sites it names.",
                  ),
                },
              ]}
            />
          )}
          <div className="flex flex-wrap gap-3">
            {!unchanged && (
              <Button
                id="transfer-confirm"
                type="button"
                disabled={busy || blocked}
                onClick={() => importFile.mutate(pending.file)}
              >
                {t("Import")}
              </Button>
            )}
            <Button
              id="transfer-cancel"
              type="button"
              variant="ghost"
              disabled={importFile.isPending}
              onClick={() => setPending(undefined)}
            >
              {unchanged ? t("Close") : t("Cancel")}
            </Button>
          </div>
        </section>
      )}
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
              "Importing keeps everything this device has; where both hold the same entry, the file's wins. A recipe replaces one kept here only at a newer revision. A paired device uploads the imported ones at its next sync, unless its service already holds a recipe of that ID.",
            ),
          },
        ]}
      />
    </Panel>
  );
}
