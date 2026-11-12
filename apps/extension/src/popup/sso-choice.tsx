import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { Button } from "../options/button";
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
  if (!client || tabId === undefined || !offer || offer.origin !== origin) return null;
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
  return (
    <section className="popup-section" aria-label={t("Sign-in method")}>
      <h2>{t("Sign-in method")}</h2>
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
                ? t("Continue with {{provider}}", { provider: entry.label })
                : t("Saved identity provider")}
              {entry.automatic ? t(" (automatic)") : ""}
            </option>
          ))}
        </select>
      </label>
      {offer.methods.map((entry) => {
        const picked = picks[entry.method.number] ?? entry.selectedId ?? "";
        return (
          <fieldset key={entry.method.number} disabled={busy || offer.blocked}>
            <legend>{entry.label ?? t("Saved identity provider")}</legend>
            <label>
              {t("Saved account and sign-in origin")}
              <select
                value={picked}
                onChange={(event) =>
                  setPicks({ ...picks, [entry.method.number]: event.target.value })
                }
              >
                <option value="">{t("Choose a saved provider account")}</option>
                {entry.candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.itemLabel} — {candidate.connectionLabel} — {candidate.origin} (
                    {candidate.itemId})
                  </option>
                ))}
              </select>
            </label>
            {!entry.candidates.length && (
              <p>
                {t(
                  "No eligible provider account and origin matches this method. Check the vault and sync it.",
                )}
              </p>
            )}
            <Button
              disabled={!picked || busy}
              onClick={() =>
                void submit({ kind: "mapping", method: entry.method, candidateId: picked })
              }
            >
              {t("Save provider mapping")}
            </Button>
            {entry.selectedId && (
              <Button
                disabled={busy}
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
          {reason === "duplicate-idp"
            ? t(
                "Two methods name the same provider account. Choose distinct accounts before continuing.",
              )
            : reason === "mapping-required"
              ? t("Choose and save the provider account and origin for every enabled method.")
              : reason === "entry-required"
                ? t("Choose the provider entry displayed on this page.")
                : reason === "invalid-value" ||
                    reason === "mixed-forms" ||
                    reason === "duplicate-method" ||
                    reason === "field-name"
                  ? t(
                      "The SSO fields have invalid syntax, duplicate methods or mixed formats. Correct the vault item and sync it.",
                    )
                  : reason === "unsafe-hop"
                    ? t(
                        "An identity provider must use a different account and origin from this site.",
                      )
                    : t(
                        "This sign-in method is unavailable or changed. Check the vault and reopen the choice.",
                      )}
        </output>
      )}
      <p className="popup-muted">
        {t(
          "Provider mappings stay on this device. This method choice applies only to this sign-in.",
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
                ...(entryId ? { entryId } : {}),
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
