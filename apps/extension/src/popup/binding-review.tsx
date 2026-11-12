import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { Button } from "../options/button";
import type { BindingReviewClient } from "../login/binding-review-wire";

/** Names only: no vault field values are requested to review a failed binding. */
export function BindingReviewSection({
  client,
  tabId,
  onOpenSettings,
}: {
  client: BindingReviewClient;
  tabId: number;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const query = useQuery({
    queryKey: ["popup", "binding-review", tabId],
    queryFn: () => client.get(tabId),
    refetchInterval: 1000,
    staleTime: 0,
    gcTime: 0,
  });
  const repair = query.data?.repair;
  const blocked = query.data?.blocked ?? [];
  const keyFor = (slot: string) => `${repair?.reviewId}:${slot}`;
  async function retry() {
    if (!repair || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await client.pick({
        tabId,
        reviewId: repair.reviewId,
        picks: repair.slots.map(({ slot }) => ({ slot, fieldId: picks[keyFor(slot)]! })),
      });
      setMessage(
        result.ok
          ? t(
              "Pateat is retrying this login. The repaired fields are saved only after sign-in succeeds.",
            )
          : result.reason === "not-a-candidate"
            ? t("Choose a current allowed field for every input, then try again.")
            : result.reason === "stale-review"
              ? t(
                  "The page, vault or settings changed. Reload the page to review its fields again.",
                )
              : t(
                  "Pateat could not restart this login. No repaired fields were saved. Try again from the page.",
                ),
      );
      await query.refetch();
    } catch {
      setMessage(t("The field review could not be read. Try again."));
    } finally {
      setBusy(false);
    }
  }
  if (!repair && !blocked.length && !message) return null;
  return (
    <section className="popup-section" aria-labelledby="popup-binding-review-heading">
      <h2 id="popup-binding-review-heading">{t("Review vault fields")}</h2>
      {repair && (
        <>
          <p className="popup-muted">
            {t(
              "A saved field of {{item}} no longer matches. Choose the field to use on {{hostname}}.",
              { item: repair.item, hostname: new URL(repair.origin).hostname },
            )}
          </p>
          {repair.slots.map((slot, index) => (
            <label key={`${repair.reviewId}:${slot.slot}`} className="field">
              <span>{t("Input {{number}}: {{name}}", { number: index + 1, name: slot.name })}</span>
              <select
                aria-label={t("Input {{number}}: {{name}}", { number: index + 1, name: slot.name })}
                value={picks[keyFor(slot.slot)] ?? ""}
                disabled={busy}
                onChange={(event) =>
                  setPicks((value) => ({ ...value, [keyFor(slot.slot)]: event.target.value }))
                }
              >
                <option value="">{t("Choose a field")}</option>
                {slot.candidates.map((candidate) => (
                  <option key={candidate.fieldId} value={candidate.fieldId}>
                    {candidate.name}
                  </option>
                ))}
              </select>
              {!slot.candidates.length && (
                <span className="popup-muted">
                  {t(
                    "No allowed named field can fill this input. Check the item and its field exclusions in settings.",
                  )}
                </span>
              )}
            </label>
          ))}
          <Button
            type="button"
            disabled={
              busy ||
              !repair.slots.length ||
              !repair.slots.every((slot) =>
                slot.candidates.some((candidate) => candidate.fieldId === picks[keyFor(slot.slot)]),
              )
            }
            onClick={() => void retry()}
          >
            {t("Use these fields and retry")}
          </Button>
          <p className="popup-muted">
            {t(
              "Only field names are shown. Nothing is saved if sign-in is rejected or cannot be confirmed.",
            )}
          </p>
        </>
      )}
      {blocked.length > 0 && (
        <>
          <p>
            {t("Some vault items need their field exclusions reviewed before they can be used.")}
          </p>
          <ul>
            {blocked.map((item) => (
              <li key={item.id}>{t("{{item}} — {{connection}}", item)}</li>
            ))}
          </ul>
        </>
      )}
      <Button type="button" variant="outline" disabled={busy} onClick={onOpenSettings}>
        {t("Review fields in settings")}
      </Button>
      <output aria-live="polite">{message}</output>
    </section>
  );
}
