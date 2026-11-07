import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";

import { useState, type ReactNode } from "react";

import { Button } from "./button";
import { controlClass, RowTitle } from "./ui";

/**
 * One site in the list: what it is, its state lines, and the controls that act on it. Each
 * kind of row passes its own controls, so another per-site setting adds controls here.
 */
export function SiteRow({
  title,
  badges,
  lines,
  controls,
}: {
  title: string;
  badges?: ReactNode;
  lines?: ReactNode;
  controls: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-1">
        <RowTitle>
          <span>{title}</span>
          {badges}
        </RowTitle>
        {lines}
      </div>
      <div className="flex flex-[2_1_380px] flex-wrap items-center justify-end gap-2">
        {controls}
      </div>
    </li>
  );
}

/** The default account control of an origin row: its select and an explicit Save. */
export function DefaultAccountEditor({
  idPrefix,
  origin,
  options,
  current,
  save,
}: {
  idPrefix: string;
  origin: string;
  options: { value: string; text: string }[];
  current: string;
  save: (value: string) => string | undefined;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const [choice, setChoice] = useState<string>();
  const [error, setError] = useState("");
  // A choice the list no longer offers falls back to the saved value.
  const shown =
    choice !== undefined && options.some((entry) => entry.value === choice) ? choice : current;
  const errorId = `${idPrefix}site-default-error-${origin}`;
  return (
    <>
      <label className="contents">
        <span className="visually-hidden">{t("Default account for {{origin}}", { origin })}</span>
        <select
          className={`${controlClass} max-w-[18.75rem] flex-[1_1_220px]`}
          value={shown}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => {
            setChoice(event.target.value);
            setError("");
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.text}
            </option>
          ))}
        </select>
      </label>
      <Button
        type="button"
        variant="outline"
        aria-label={t("Save default for {{origin}}", { origin })}
        disabled={shown === current}
        onClick={() => {
          const failure = save(shown);
          setError(failure ?? "");
          if (!failure) setChoice(undefined);
        }}
      >
        {t("Save")}
      </Button>
      {error && (
        <p id={errorId} className="validation-error m-0 basis-full text-right" role="alert">
          {t(error)}
        </p>
      )}
    </>
  );
}
