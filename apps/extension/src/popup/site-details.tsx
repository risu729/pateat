import {
  CalendarDays,
  CreditCard,
  IdCard,
  KeyRound,
  MessageCircleQuestionMark,
  Smartphone,
  TextCursorInput,
} from "lucide-react";
import type { LoginDetail } from "@pateat/contracts";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { Button } from "../options/button";
import { detailName, type DetailResponse } from "../login/detail-wire";

type DetailOffer = NonNullable<Extract<DetailResponse, { ok: true }>["offer"]>;
export type DetailSource = DetailOffer["details"][number]["candidates"][number];
type DetailLink = Extract<DetailResponse, { ok: true }>["links"][number];

const DETAIL_ICON = {
  "birth-date": CalendarDays,
  "phone-last-4": Smartphone,
  "card-last-4": CreditCard,
  "card-code": CreditCard,
  "card-number": CreditCard,
  "card-expiry": CreditCard,
  pin: KeyRound,
  "secret-answer": MessageCircleQuestionMark,
  "member-id": IdCard,
} as const satisfies Record<LoginDetail, unknown>;

const sourceValue = (source: DetailSource) =>
  JSON.stringify([source.connectionId, source.itemId, source.fieldId]);
/** How the popup names a vault field: only its item's and its own labels, never its value. */
const sourceLabel = (source: { itemLabel: string; fieldLabel: string }) =>
  `${source.itemLabel} › ${source.fieldLabel}`;
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The vault fields that could give a detail, as native radios styled as cards. */
function DetailChoices({
  detail,
  candidates,
  checked,
  disabled,
  onChange,
}: {
  detail: LoginDetail;
  candidates: DetailSource[];
  checked: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const Icon = DETAIL_ICON[detail];
  const seen = new Map<string, number>();
  for (const source of candidates)
    seen.set(sourceLabel(source), (seen.get(sourceLabel(source)) ?? 0) + 1);
  return (
    <div className="popup-choices">
      {candidates.map((source) => {
        const title = sourceLabel(source);
        // Fields that would read the same add their item ID's first 8 characters.
        const sub =
          (seen.get(title) ?? 0) > 1
            ? t("ID {{id}}", { id: source.itemId.slice(0, 8) })
            : undefined;
        return (
          <label key={sourceValue(source)} className="popup-choice">
            <input
              type="radio"
              name={`popup-detail-${detail}`}
              value={sourceValue(source)}
              checked={checked === sourceValue(source)}
              disabled={disabled}
              aria-label={sub ? t("{{title}}, {{sub}}", { title, sub }) : title}
              onChange={() => onChange(sourceValue(source))}
            />
            <span className="popup-avatar">
              <Icon size={16} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className="popup-choice-main">
              <span className="popup-choice-title">{title}</span>
              {sub && <span className="popup-choice-sub">{sub}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * The page's personal details (ADR 0061): what the page asks for with the vault fields
 * that could give it, the best guess selected, and the site's links, each removable.
 */
export function DetailSection({
  t,
  offer,
  links,
  picks,
  busy,
  onPick,
  onFill,
  onRemove,
}: {
  t: TFunction;
  offer: DetailOffer | undefined;
  links: DetailLink[];
  picks: Partial<Record<LoginDetail, string>>;
  busy: boolean;
  onPick: (detail: LoginDetail, value: string) => void;
  onFill: (detail: LoginDetail, source: DetailSource) => void;
  onRemove: (detail: LoginDetail) => void;
}) {
  return (
    <>
      {offer?.details.map(({ detail, format, candidates, preselect, question }) => {
        const picked = picks[detail];
        // A detail whose candidates are no guess starts with none selected.
        const shown =
          candidates.find((source) => sourceValue(source) === picked) ??
          (preselect === false ? undefined : candidates[0]);
        return (
          <fieldset key={detail} className="popup-fieldset popup-detail">
            <legend id={`popup-detail-${detail}`} className="popup-detail-ask">
              {question
                ? t("This page asks \u201C{{question}}\u201D.", { question })
                : t("This page asks for {{detail}}.", { detail: detailName(detail, t, format) })}
            </legend>
            {question && (
              // The AI's pairing of the question with a field named otherwise is only a
              // proposal: Fill confirms it (ADR 0061).
              <p id={`popup-detail-paired-${detail}`} className="popup-choice-sub">
                {t(
                  "Pateat\u2019s AI thinks this field holds the answer. Fill only if it does; Pateat then fills it whenever this question shows.",
                )}
              </p>
            )}
            <DetailChoices
              detail={detail}
              candidates={candidates}
              checked={shown ? sourceValue(shown) : ""}
              disabled={busy}
              onChange={(value) => onPick(detail, value)}
            />
            <Button
              id={`popup-detail-fill-${detail}`}
              type="button"
              className="w-full gap-2"
              // Kept focusable while a fill runs, since Chrome moves focus away from a
              // focused control that becomes disabled.
              disabled={busy || !shown}
              focusableWhenDisabled
              aria-describedby={
                question
                  ? `popup-detail-${detail} popup-detail-paired-${detail}`
                  : `popup-detail-${detail}`
              }
              onClick={() => shown && onFill(detail, shown)}
            >
              <TextCursorInput size={16} strokeWidth={2} aria-hidden="true" />
              {t("Fill")}
            </Button>
          </fieldset>
        );
      })}
      {links.length > 0 && (
        <ul
          id="popup-detail-links"
          className="popup-rules"
          aria-label={t("Personal details Pateat fills on this site")}
        >
          {links.map((link) => {
            const Icon = DETAIL_ICON[link.detail];
            return (
              <li key={link.detail} id={`popup-detail-link-${link.detail}`}>
                <Icon className="popup-detail-icon" size={16} strokeWidth={2} aria-hidden="true" />
                <span className="popup-choice-main">
                  <span className="popup-choice-title">
                    {capitalized(detailName(link.detail, t))}
                  </span>
                  <span className="popup-choice-sub">
                    {link.pending
                      ? t("Filled from {{field}} (not saved yet)", { field: sourceLabel(link) })
                      : t("Filled from {{field}}", { field: sourceLabel(link) })}
                  </span>
                </span>
                <Button
                  id={`popup-detail-remove-${link.detail}`}
                  type="button"
                  variant="outline"
                  disabled={busy}
                  focusableWhenDisabled
                  aria-label={t("Remove the link for {{detail}}", {
                    detail: detailName(link.detail, t),
                  })}
                  onClick={() => onRemove(link.detail)}
                >
                  {t("Remove")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
