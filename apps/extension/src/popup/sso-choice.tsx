import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { Button } from "../options/button";
import { ssoReasonText } from "./sso-reasons";
import type { SsoActionResponse, SsoClient, SsoSelection } from "../login/sso-wire";

/** A method choice belongs to an already chosen site account, never another account card. */
export function PopupSsoChoice({
  client,
  tabId,
  origin,
}: {
  client: SsoClient | undefined;
  tabId: number | undefined;
  origin: string | undefined;
}) {
  const query = useQuery({
    queryKey: ["popup", "sso", tabId],
    queryFn: () => client!.get(tabId!),
    enabled: client !== undefined && tabId !== undefined,
    refetchInterval: 1000,
  });
  const response = query.data;
  const offer = response?.ok ? response.offer : undefined;
  if (!client || tabId === undefined || !offer || (offer.origin !== origin && !offer.frame))
    return null;
  return (
    <SsoOffer
      key={offer.id}
      client={client}
      tabId={tabId}
      offer={offer}
      refresh={() => query.refetch()}
    />
  );
}
type Offer = NonNullable<Extract<Awaited<ReturnType<SsoClient["get"]>>, { ok: true }>["offer"]>;
function SsoOffer({
  client,
  tabId,
  offer,
  refresh,
}: {
  client: SsoClient;
  tabId: number;
  offer: Offer;
  refresh: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function act(action: () => Promise<SsoActionResponse>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      const answer = await action();
      if (!alive.current) return;
      if (!answer.ok) setNotice(answer.reason);
      await refresh();
    } catch {
      if (alive.current) setNotice("unavailable");
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const submit = (selection: SsoSelection) =>
    act(() => client.choose({ tabId, offerId: offer.id, selection }));
  const cancel = () => act(() => client.cancel(tabId, offer.id));
  const { t } = useTranslation(undefined, { i18n });
  const heading = useId();
  const [method, setMethod] = useState("");
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [entryId, setEntryId] = useState("");
  const selected = offer.methods.find((entry) => String(entry.method.number) === method);
  const candidateId = selected && (picks[selected.method.number] ?? selected.selectedId);
  const canContinue =
    method === "passkey" ||
    method === "password" ||
    (candidateId && (selected?.form !== "url" || entryId));
  const reason = notice || offer.reason;
  const methodName = (entry: Offer["methods"][number]) =>
    entry.label ?? t("Saved identity provider");
  return (
    <section className="popup-section" aria-labelledby={heading}>
      <h2 id={heading}>{t("Sign-in method")}</h2>
      <p>{t("Choose how to sign in as {{account}}.", { account: offer.accountLabel })}</p>
      <label>
        {t("Method for this sign-in")}
        <select
          value={method}
          disabled={busy || offer.blocked}
          onChange={(event) => setMethod(event.target.value)}
        >
          <option value="">{t("Choose a method")}</option>
          {offer.passkey && <option value="passkey">{t("Passkey")}</option>}
          {offer.password && <option value="password">{t("Password")}</option>}
          {offer.methods.map((entry) => (
            <option key={entry.method.number} value={entry.method.number}>
              {entry.label
                ? t("SSO with {{provider}}", { provider: entry.label })
                : t("SSO with the saved identity provider")}
              {entry.automatic ? t(" (automatic)") : ""}
            </option>
          ))}
        </select>
      </label>
      {offer.methods.map((entry) => {
        const picked = picks[entry.method.number] ?? entry.selectedId ?? "";
        const name = methodName(entry);
        return (
          <fieldset key={entry.method.number} disabled={busy || offer.blocked}>
            <legend>{name}</legend>
            <label>
              {t("Saved account and sign-in origin")}
              <select
                value={picked}
                onChange={(event) =>
                  setPicks({ ...picks, [entry.method.number]: event.target.value })
                }
              >
                <option value="">{t("Choose a saved provider account")}</option>
                {candidateTexts(entry.candidates).map(({ id, text }) => (
                  <option key={id} value={id}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
            {!entry.candidates.length && !entry.reason && (
              <p>
                {t(
                  "No eligible provider account and origin matches this method. Check the vault and sync it.",
                )}
              </p>
            )}
            {entry.reason && (
              <p>
                {entry.field && t("SSO field: {{field}}. ", { field: entry.field })}
                {ssoReasonText(t, entry.reason)}
              </p>
            )}
            <Button
              disabled={!picked || busy}
              aria-label={t("Save provider mapping for {{method}}", { method: name })}
              onClick={() =>
                void submit({ kind: "mapping", method: entry.method, candidateId: picked })
              }
            >
              {t("Save provider mapping")}
            </Button>
            {entry.selectedId && entry.candidates.length < 2 && (
              <Button
                disabled={busy}
                aria-label={t("Show other provider accounts for {{method}}", { method: name })}
                onClick={() => void submit({ kind: "discover", method: entry.method })}
              >
                {t("Show other provider accounts")}
              </Button>
            )}
            {(entry.selectedId || entry.mapped) && (
              <Button
                disabled={busy}
                aria-label={t("Remove provider mapping for {{method}}", { method: name })}
                onClick={() => void submit({ kind: "unmap", method: entry.method })}
              >
                {t("Remove provider mapping")}
              </Button>
            )}
          </fieldset>
        );
      })}
      {selected?.form === "url" && (
        <label>
          {t("Entry shown on this page")}
          <select
            value={entryId}
            disabled={busy}
            onChange={(event) => setEntryId(event.target.value)}
          >
            <option value="">{t("Choose the provider entry")}</option>
            {offer.entries.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {reason && (
        <output>
          {offer.field && t("SSO field: {{field}}. ", { field: offer.field })}
          {ssoReasonText(t, reason)}
        </output>
      )}
      <p className="popup-muted">
        {t(
          "Provider mappings sync with your settings. This method choice applies only to this sign-in.",
        )}
      </p>
      <div className="popup-actions">
        <Button
          disabled={busy || offer.blocked || !canContinue}
          onClick={() => {
            if (method === "passkey" || method === "password")
              void submit({ kind: "native", route: method });
            else if (selected && candidateId)
              void submit({
                kind: "sso",
                method: selected.method,
                candidateId,
                ...(selected.form === "url" && entryId ? { entryId } : {}),
              });
          }}
        >
          {t("Continue")}
        </Button>
        <Button disabled={busy} onClick={() => void cancel()}>
          {t("Cancel")}
        </Button>
      </div>
    </section>
  );
}

/** Each candidate's item, vault and origin; a number tells apart two that read the same. */
function candidateTexts(list: Offer["methods"][number]["candidates"]) {
  const texts = list.map(
    (candidate) => `${candidate.itemLabel} — ${candidate.connectionLabel} — ${candidate.origin}`,
  );
  return list.map((candidate, index) => {
    const same = texts.filter((text) => text === texts[index]);
    const nth = texts.slice(0, index + 1).filter((text) => text === texts[index]).length;
    return { id: candidate.id, text: same.length > 1 ? `${texts[index]} (${nth})` : texts[index]! };
  });
}

export type { SsoClient } from "../login/sso-wire";
