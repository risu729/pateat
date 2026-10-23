import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { ChevronRight, KeyRound, Star } from "lucide-react";
import { useEffect, useId, useState } from "react";
import * as v from "valibot";
import { Logo } from "../logo";
import { Button } from "../options/button";
import { chooserResponseSchema, type ChooserResponse, type ChooserView } from "./chooser";

const MAIN = "mx-auto flex min-h-screen max-w-md flex-col gap-4 p-5";
const HEADING = "m-0 text-xl/7 font-[650] wrap-anywhere";

export type ChooserClient = {
  /** The request token from the window's URL. */
  readonly request: string | null;
  send(message: unknown): Promise<unknown>;
  close(): void;
};

async function call(client: ChooserClient, message: unknown): Promise<ChooserResponse> {
  try {
    const response = v.safeParse(chooserResponseSchema, await client.send(message));
    return response.success ? response.output : { ok: false };
  } catch {
    return { ok: false };
  }
}

function Header({ children }: { children: React.ReactNode }) {
  return (
    <header className="flex items-center gap-2.5">
      <Logo />
      <h1 className={HEADING}>{children}</h1>
    </header>
  );
}

/**
 * Pateat's passkey chooser (ADR 0021): for several matches, or for any match after Pateat
 * signed in from the same tab. Choosing signs in with that passkey; "Use the browser"
 * or closing the window hands the request to the browser or another extension.
 */
export function ChooserApp({ client }: { client: ChooserClient }) {
  const { t } = useTranslation(undefined, { i18n });
  const [view, setView] = useState<ChooserView | "ended" | undefined>(
    client.request ? undefined : "ended",
  );
  const [makeDefault, setMakeDefault] = useState(true);
  const [sending, setSending] = useState(false);
  const checkboxId = useId();

  useEffect(() => {
    if (!client.request) return;
    const load = async () => {
      const response = await call(client, {
        version: 1,
        type: "passkey-chooser.load",
        request: client.request,
      });
      if (!response.ok || !response.view) {
        setView("ended");
        return;
      }
      setView(response.view);
      // Replacing an existing default is opt-in: it also changes the password login account.
      setMakeDefault(!response.view.replacesDefault);
    };
    void load();
  }, [client]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") client.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [client]);

  const answer = async (value: { kind: "chosen"; index: number } | { kind: "browser" }) => {
    setSending(true);
    const response = await call(client, {
      version: 1,
      type: "passkey-chooser.answer",
      request: client.request,
      answer: value.kind === "chosen" ? { ...value, makeDefault } : value,
    });
    // The background closes the window once it has the answer; an ended request cannot.
    if (!response.ok) setView("ended");
  };

  if (view === undefined) return <main className={MAIN} aria-busy="true" />;
  if (view === "ended")
    return (
      <main className={MAIN}>
        <Header>{t("Passkey request ended")}</Header>
        <p className="m-0">
          {t("The site stopped waiting, or Pateat restarted. Close this window and try again.")}
        </p>
        <div className="mt-auto flex justify-end border-t border-border pt-4">
          <Button variant="outline" onClick={() => client.close()}>
            {t("Close")}
          </Button>
        </div>
      </main>
    );
  const host = new URL(view.origin).host;
  const rows = view.entries.map((entry, index) => ({ entry, index }));
  // Choosing the site default saves nothing, so a list of only that has no checkbox.
  const canSave = view.entries.some((entry) => !entry.preferred);
  return (
    <main className={MAIN}>
      <Header>{t("Sign in to {{host}}", { host })}</Header>
      {/* Above the list, so it is seen before a choice is made. */}
      <p className="m-0 flex items-start gap-2.5" hidden={!canSave}>
        <input
          id={checkboxId}
          type="checkbox"
          checked={makeDefault && canSave}
          disabled={sending}
          onChange={(event) => setMakeDefault(event.target.checked)}
        />
        <label htmlFor={checkboxId} className="m-0 text-[15px]/6 font-normal">
          {view.replacesDefault
            ? t("Replace the default account for {{host}} with this one", { host })
            : t("Use this account for {{host}} from now on", { host })}
        </label>
      </p>
      <ul aria-label={t("Matching passkeys")} className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map(({ entry, index }) => (
          // The list never changes while the window is open, so its position is a stable key.
          <li key={index}>
            <button
              type="button"
              disabled={sending}
              className="flex min-h-14 w-full items-center gap-3 rounded-lg border border-border-strong bg-surface px-3 py-2 text-left text-ink hover:bg-surface-sunken disabled:opacity-50"
              onClick={() => void answer({ kind: "chosen", index })}
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-surface-sunken text-ink-muted">
                <KeyRound aria-hidden size={16} strokeWidth={2} />
              </span>
              {/* The passkey's user name leads; the item and its connection follow. */}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-semibold wrap-anywhere">
                  {entry.userName ?? entry.item ?? t("Unnamed item")}
                </span>
                {(entry.userName || entry.account) && (
                  <span className="text-[13px]/5 wrap-anywhere text-ink-muted">
                    {entry.userName
                      ? entry.account
                        ? t("{{item}} in {{account}}", {
                            item: entry.item ?? t("Unnamed item"),
                            account: entry.account,
                          })
                        : (entry.item ?? t("Unnamed item"))
                      : entry.account}
                  </span>
                )}
              </span>
              {entry.preferred && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent-tint px-2 text-xs/5 font-semibold text-accent-ink">
                  <Star aria-hidden size={12} strokeWidth={2} />
                  {t("Default")}
                </span>
              )}
              <ChevronRight
                aria-hidden
                size={16}
                strokeWidth={2}
                className="shrink-0 text-ink-muted"
              />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-auto flex justify-end border-t border-border pt-4">
        <Button
          variant="outline"
          disabled={sending}
          onClick={() => void answer({ kind: "browser" })}
        >
          {t("Use the browser or another extension")}
        </Button>
      </div>
    </main>
  );
}
