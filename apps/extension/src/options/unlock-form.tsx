import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { LockOpen, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "./button";
import { controlClass, fieldClass, StatusLines } from "./ui";

export type UnlockResult = { ok: true } | { ok: false; error: "wrong-password" | "unavailable" };

/**
 * The master password form of a locked vault (ADR 0075). It only shows the field and the
 * answer; `onSubmit` unlocks, and the field is emptied after each try, so the password
 * stays in the page no longer than one request.
 */
export function UnlockForm({
  onSubmit,
  submitLabel,
  accountLabel,
  autoFocus = false,
  disabled = false,
}: {
  onSubmit: (password: string) => Promise<UnlockResult>;
  submitLabel?: string;
  /** The vault's name or email, shown above the field. */
  accountLabel?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<"wrong-password" | "unavailable">();
  // Once the field is enabled again, a finished try leaves the cursor in it for the next.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current || disabled || pending) return;
    refocus.current = false;
    input.current?.focus();
  }, [disabled, pending]);
  async function submit() {
    if (!password || pending || disabled) return;
    const value = password;
    setPassword("");
    if (input.current) input.current.value = "";
    setPending(true);
    setFailed(undefined);
    try {
      const result = await onSubmit(value);
      if (!result.ok) setFailed(result.error);
    } catch {
      setFailed("unavailable");
    } finally {
      refocus.current = true;
      setPending(false);
    }
  }
  return (
    <form
      className="m-0 flex min-w-0 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {accountLabel && <p className="m-0 text-sm font-semibold wrap-anywhere">{accountLabel}</p>}
      <label className={`${fieldClass} max-w-[26rem]`}>
        {t("Master password")}
        <input
          id={`${id}-password`}
          ref={input}
          className={controlClass}
          type="password"
          autoComplete="current-password"
          // The form is the one thing the person came to do when it opens.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocus}
          disabled={disabled || pending}
          aria-invalid={failed === "wrong-password" || undefined}
          aria-describedby={failed ? `${id}-error` : undefined}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      {failed && (
        <StatusLines
          id={`${id}-error`}
          lines={[
            {
              tone: "err",
              icon: TriangleAlert,
              text:
                failed === "wrong-password"
                  ? t("Invalid master password.")
                  : t("The vault could not be unlocked. Refresh and try again."),
            },
          ]}
        />
      )}
      <Button type="submit" className="self-start" disabled={disabled || pending || !password}>
        <LockOpen aria-hidden size={16} strokeWidth={2} />
        {submitLabel ?? t("Unlock")}
      </Button>
    </form>
  );
}
