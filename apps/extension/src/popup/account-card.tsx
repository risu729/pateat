import { Star, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";

/** One account as a card: the username as the title, the item and its vault below. */
export type AccountCard = {
  value: string;
  title: string;
  sub: string;
  isDefault: boolean;
  /** The account of the tab's last login on the site (ADR 0063). */
  isUsed?: boolean;
};

function DefaultBadge() {
  const { t } = useTranslation(undefined, { i18n });
  return (
    <span className="popup-badge">
      <Star size={12} strokeWidth={2} aria-hidden="true" />
      {t("Default")}
    </span>
  );
}

export function CardBody({ card }: { card: Omit<AccountCard, "value"> }) {
  const { t } = useTranslation(undefined, { i18n });
  return (
    <>
      <span className="popup-avatar">
        <UserRound size={16} strokeWidth={2} aria-hidden="true" />
      </span>
      <span className="popup-choice-main">
        <span className="popup-choice-title">{card.title}</span>
        <span className="popup-choice-sub">{card.sub}</span>
      </span>
      {card.isUsed && <span className="popup-badge">{t("Used in this tab")}</span>}
      {card.isDefault && <DefaultBadge />}
    </>
  );
}
