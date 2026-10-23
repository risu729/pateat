import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { ChevronLeft, ChevronRight, Info, KeyRound, LockKeyhole, Star } from "lucide-react";
import { useEffect, useId, useState } from "react";
import * as v from "valibot";
import { Logo } from "../logo";
import { Button } from "../options/button";
import { UnlockForm } from "../options/unlock-form";
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

type Entry = ChooserView["entries"][number];

function EntryName({ entry }: { entry: Entry }) {
  const { t } = useTranslation(undefined, { i18n });
  // The passkey's user name leads; the item and its connection follow.
  return (
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
  );
}

/**
 * Asks for the master password of an item with Bitwarden's re-prompt, with the settings
 * page's unlock form. The background checks it offline; a wrong one is asked again.
 */
function MasterPasswordForm({
  entry,
  disabled,
  onSubmit,
}: {
  entry: Entry;
  disabled: boolean;
  onSubmit: (password: string) => Promise<boolean | undefined>;
}) {
  const { t } = useTranslation(undefined, { i18n });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-sunken px-3 py-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-surface text-ink-muted">
          <LockKeyhole aria-hidden size={16} strokeWidth={2} />
        </span>
        <EntryName entry={entry} />
      </div>
      <p className="m-0 text-[15px]/6">
        {t("Bitwarden asks for your master password before this item is used.")}
      </p>
      <UnlockForm
        submitLabel={t("Log in")}
        // The field is the one thing the window asks for.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        disabled={disabled}
        onSubmit={async (password) => {
          const matches = await onSubmit(password);
          if (matches) return { ok: true };
          return { ok: false, error: matches === false ? "wrong-password" : "unavailable" };
        }}
      />
    </div>
  );
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
  // The entry whose master password the window asks for, by position.
  const [asking, setAsking] = useState<number | undefined>();
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
      // One entry that asks for the master password needs no choice first.
      if (response.view.entries.length === 1 && response.view.entries[0]?.reprompt) setAsking(0);
      // Replacing an existing default is opt-in: it also changes the password login account.
      // So is saving a passkey chosen after a sign-in in this tab, which may be a one-off switch.
      // A password login's account is chosen elsewhere, so its window saves nothing.
      setMakeDefault(
        response.view.purpose !== "login" && !response.view.replacesDefault && !response.view.again,
      );
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
  const verify = async (index: number, password: string) => {
    const response = await call(client, {
      version: 1,
      type: "passkey-chooser.verify",
      request: client.request,
      index,
      password,
      makeDefault,
    });
    if (!response.ok || response.matches === undefined) {
      setView("ended");
      return undefined;
    }
    // A right password makes the choice, and the background closes the window.
    if (response.matches) setSending(true);
    return response.matches;
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
  const login = view.purpose === "login";
  const rows = view.entries.map((entry, index) => ({ entry, index }));
  // Choosing the site default saves nothing, so a list of only that has no checkbox. A
  // password login's account is chosen elsewhere.
  const canSave = !login && view.entries.some((entry) => !entry.preferred);
  const cancel = (
    <div className="mt-auto flex justify-end border-t border-border pt-4">
      <Button variant="outline" disabled={sending} onClick={() => void answer({ kind: "browser" })}>
        {login ? t("Cancel") : t("Use the browser or another extension")}
      </Button>
    </div>
  );
  const asked = asking === undefined ? undefined : view.entries[asking];
  if (asking !== undefined && asked)
    return (
      <main className={MAIN}>
        <Header>{t("Sign in to {{host}}", { host })}</Header>
        {view.entries.length > 1 && (
          <p className="m-0">
            <Button variant="ghost" disabled={sending} onClick={() => setAsking(undefined)}>
              <ChevronLeft aria-hidden size={16} strokeWidth={2} />
              {t("Other passkeys")}
            </Button>
          </p>
        )}
        <MasterPasswordForm
          entry={asked}
          disabled={sending}
          onSubmit={(password) => verify(asking, password)}
        />
        {cancel}
      </main>
    );
  return (
    <main className={MAIN}>
      <Header>{t("Log in to {{host}}", { host })}</Header>
      {view.again && (
        <p className="m-0 flex items-center gap-1.5 text-[13px]/5 text-ink-muted">
          <Info aria-hidden size={14} strokeWidth={2} className="shrink-0" />
          {view.loggedOut
            ? t("You were logged out of this site in this tab.")
            : t("Pateat answered a passkey request from this site in this tab before.")}
        </p>
      )}
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
              onClick={() =>
                entry.reprompt ? setAsking(index) : void answer({ kind: "chosen", index })
              }
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-surface-sunken text-ink-muted">
                <KeyRound aria-hidden size={16} strokeWidth={2} />
              </span>
              <EntryName entry={entry} />
              {entry.reprompt && (
                <LockKeyhole
                  aria-label={t("Asks for the master password")}
                  size={14}
                  strokeWidth={2}
                  className="shrink-0 text-ink-muted"
                />
              )}
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
      {cancel}
    </main>
  );
}
