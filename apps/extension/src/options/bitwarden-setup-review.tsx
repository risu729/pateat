import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { VaultItemMetadata } from "@pateat/contracts";
import { Info, TriangleAlert } from "lucide-react";
import { i18n } from "../i18n";
import { Button } from "./button";
import { checkClass, groupClass, StatusLines } from "./ui";
import type { BitwardenSetupModel } from "./use-bitwarden-setup";

function FieldReview({
  item,
  disabled,
  onReview,
}: {
  item: VaultItemMetadata;
  disabled: boolean;
  onReview: (excludedFieldIds: string[]) => void;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const fields = item.fields.filter((field) => field.id.startsWith("custom."));
  const [excluded, setExcluded] = useState(() => fields.map((field) => field.id));
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-4"
      disabled={disabled}
    >
      <legend className="px-1 font-semibold">
        {t("Review changed fields in {{item}}", { item: item.label })}
      </legend>
      <p className="m-0 text-sm text-ink-muted">
        {t(
          "All current custom fields start excluded. Save this review before the item can be used; other saved exclusions stay in place.",
        )}
      </p>
      {fields.map((field, index) => (
        <label className={checkClass} key={field.id}>
          <input
            type="checkbox"
            aria-label={t("{{item}}: Review exclude {{field}} (field {{index}})", {
              item: item.label,
              field: field.label,
              index: index + 1,
            })}
            checked={excluded.includes(field.id)}
            onChange={(event) =>
              setExcluded((previous) =>
                event.target.checked
                  ? [...previous, field.id]
                  : previous.filter((id) => id !== field.id),
              )
            }
          />
          {t("Exclude {{field}} (field {{index}})", { field: field.label, index: index + 1 })}
        </label>
      ))}
      {!fields.length && (
        <p className="m-0 text-sm">
          {t(
            "This item has no current custom fields. Saving this review explicitly removes its old custom-field exclusions.",
          )}
        </p>
      )}
      <Button
        type="button"
        className="self-start"
        aria-label={t("{{item}}: Save reviewed field exclusions", { item: item.label })}
        onClick={() => onReview(excluded)}
      >
        {t("Save reviewed field exclusions")}
      </Button>
    </fieldset>
  );
}

export function renderFieldReviews(model: BitwardenSetupModel) {
  const {
    acceptedSettings,
    busy,
    challenge,
    reviewBlocked,
    unsavedChanges,
    t,
    start,
    receive,
    client,
  } = model;
  return acceptedSettings?.catalog.connections.map((connection) => {
    const quarantined = connection.quarantinedItemIds ?? [];
    if (!quarantined.length) return null;
    return (
      <div key={connection.id} className={groupClass}>
        <h3 className="m-0 flex items-center gap-2 text-base">
          <TriangleAlert aria-hidden size={16} strokeWidth={2} className="text-warning" />
          {t("Review changed custom fields in {{name}}", { name: connection.label })}
        </h3>
        <StatusLines
          muted
          lines={[
            {
              tone: "idle",
              icon: Info,
              text: t(
                "Affected items stay unavailable until their field settings are reviewed; refreshing does not approve them.",
              ),
            },
            ...(reviewBlocked
              ? [
                  {
                    tone: "warn" as const,
                    icon: TriangleAlert,
                    text: t(
                      unsavedChanges
                        ? "Reload saved settings to review the current fields. Your unsaved settings changes are kept until you reload."
                        : "Reload saved settings to review the current fields.",
                    ),
                  },
                ]
              : []),
          ]}
        />
        {connection.items
          .filter((item) => connection.staleItemIds?.includes(item.id))
          .map((item) => (
            <p key={item.id} className="m-0 text-sm">
              {t(
                "{{item}} was reviewed on another device against a newer copy of this vault. Sync this vault; if it is still older afterwards, review it here.",
                { item: item.label },
              )}
            </p>
          ))}
        {connection.items
          .filter(
            (item) => quarantined.includes(item.id) && !connection.staleItemIds?.includes(item.id),
          )
          .map((item) => (
            <FieldReview
              key={`${connection.snapshotId}:${acceptedSettings.snapshot.revision}:${item.id}`}
              item={item}
              disabled={busy || !!challenge || reviewBlocked || !connection.snapshotId}
              onReview={(excludedFieldIds) => {
                if (!connection.snapshotId || reviewBlocked) return;
                const input = {
                  connectionId: connection.id,
                  itemId: item.id,
                  snapshotId: connection.snapshotId,
                  expectedRevision: acceptedSettings.snapshot.revision,
                  excludedFieldIds,
                };
                start(async (epoch) => {
                  await receive(await client.review(input), epoch);
                });
              }}
            />
          ))}
      </div>
    );
  });
}
