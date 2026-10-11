import { useEffect, useId, useState } from "react";
import * as v from "valibot";
import { Button } from "../options/button";
import { chooserResponseSchema, type ChooserResponse, type ChooserView } from "./chooser";

const MAIN = "mx-auto max-w-md p-5 [&_h1]:text-2xl";

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

/**
 * Pateat's passkey chooser (ADR 0021). Choosing signs in with that passkey; "Use the browser"
 * or closing the window hands the request to the browser or another extension.
 */
export function ChooserApp({ client }: { client: ChooserClient }) {
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
        <h1>Passkey request ended</h1>
        <p>The site stopped waiting, or Pateat restarted. Close this window and try again.</p>
        <Button variant="outline" onClick={() => client.close()}>
          Close
        </Button>
      </main>
    );
  const host = new URL(view.origin).host;
  return (
    <main className={MAIN}>
      <h1>Choose a passkey</h1>
      <p>
        <strong>{host}</strong> asks for a passkey. {view.entries.length} in your vault match.
      </p>
      <ul aria-label="Matching passkeys" className="my-4 flex list-none flex-col gap-2 p-0">
        {view.entries.map((entry, index) => (
          // The list never changes while the window is open, so its contents are a stable key.
          <li key={JSON.stringify(entry)}>
            <button
              type="button"
              disabled={sending}
              className="flex w-full flex-col items-start rounded-lg border border-slate-300 bg-white px-4 py-3 text-left hover:bg-slate-100 focus-visible:ring-3 focus-visible:ring-teal-700/50 disabled:opacity-50"
              onClick={() => void answer({ kind: "chosen", index })}
            >
              <span className="font-semibold break-all">{entry.item}</span>
              {entry.userName && <span className="text-sm break-all">{entry.userName}</span>}
              {entry.account && (
                <span className="text-sm break-all text-slate-600">{entry.account}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <p className="my-4 flex items-start gap-2">
        <input
          id={checkboxId}
          type="checkbox"
          checked={makeDefault}
          disabled={sending}
          onChange={(event) => setMakeDefault(event.target.checked)}
        />
        <label htmlFor={checkboxId}>
          {view.replacesDefault
            ? `Replace the default account for ${host} with this one`
            : `Use this account for ${host} from now on`}
        </label>
      </p>
      <Button variant="outline" disabled={sending} onClick={() => void answer({ kind: "browser" })}>
        Use the browser or another extension
      </Button>
    </main>
  );
}
