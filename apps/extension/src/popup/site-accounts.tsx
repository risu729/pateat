import { Star, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SiteAccountsResponse } from "@pateat/contracts";
import { siteAccountOptions } from "../options/site-policy";
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

export type AccountOption = ReturnType<typeof siteAccountOptions>[number];
export type MatchedAccounts = Extract<SiteAccountsResponse, { ok: true }>["accounts"] | undefined;

function usernameOf(option: AccountOption, accounts: MatchedAccounts): string | undefined {
  return accounts?.find(
    (account) => account.connectionId === option.connectionId && account.itemId === option.itemId,
  )?.username;
}

/** How a result message names an account: its username, else its item name. */
export function accountName(option: AccountOption, accounts: MatchedAccounts): string {
  return usernameOf(option, accounts) || option.itemName;
}

export function accountCards(
  options: AccountOption[],
  accounts: MatchedAccounts,
  currentValue: string | undefined,
  usedValue?: string,
): AccountCard[] {
  const t = i18n.t.bind(i18n);
  const cards = options.map((option) => {
    const username = usernameOf(option, accounts);
    return {
      option,
      value: option.value,
      title: username || option.itemName,
      sub: username
        ? t("{{item}} in {{account}}", { item: option.itemName, account: option.connectionLabel })
        : option.connectionLabel,
      isDefault: option.value === currentValue,
      ...(option.value === usedValue ? { isUsed: true } : {}),
    };
  });
  const seen = new Map<string, number>();
  for (const card of cards) {
    const key = JSON.stringify([card.title, card.sub]);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  // Cards that would read the same add the item ID's first 8 characters.
  return cards.map(({ option, ...card }) =>
    (seen.get(JSON.stringify([card.title, card.sub])) ?? 0) > 1
      ? {
          ...card,
          sub: t("{{item}}, ID {{id}}", { item: card.sub, id: option.itemId.slice(0, 8) }),
        }
      : card,
  );
}

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

/** Native radios styled as cards. */
export function AccountChoices({
  name,
  cards,
  checked,
  disabled,
  onChange,
}: {
  name: string;
  cards: AccountCard[];
  checked: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation(undefined, { i18n });
  return (
    <div className="popup-choices">
      {cards.map((card) => (
        <label key={card.value} className="popup-choice">
          <input
            type="radio"
            name={name}
            value={card.value}
            checked={checked === card.value}
            disabled={disabled}
            aria-label={t(
              card.isUsed
                ? card.isDefault
                  ? "{{title}}, {{sub}}, used in this tab, default"
                  : "{{title}}, {{sub}}, used in this tab"
                : card.isDefault
                  ? "{{title}}, {{sub}}, default"
                  : "{{title}}, {{sub}}",
              { title: card.title, sub: card.sub },
            )}
            onChange={() => onChange(card.value)}
          />
          <CardBody card={card} />
        </label>
      ))}
    </div>
  );
}
