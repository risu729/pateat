import { ChevronLeft, Info, RefreshCw, User } from "lucide-react";
import { useId, useState } from "react";
import { describeError, type ManageClient } from "./api";
import { SiteBindings } from "./bindings";
import { Button } from "./button";
import { SiteRecipes } from "./recipes";
import {
  allowSite,
  defaultAccountLabel,
  exclusionLabel,
  exclusionsCovering,
  excludeSite,
  siteHostname,
  useSettings,
  useSettingsEdit,
  type SettingsEdit,
} from "./settings";
import {
  ErrorNotice,
  Line,
  Lines,
  PAGE_TITLE_CLASSES,
  Panel,
  ROW_CLASSES,
  RowIcon,
  RowList,
  RowMain,
  SuccessNotice,
} from "./ui";

/** One origin's default account, recipes and bindings, and whether Pateat runs there. */
export function SitePage({ client, origin }: { client: ManageClient; origin: string }) {
  const settings = useSettings(client);
  const edit = useSettingsEdit(client);
  const [notice, setNotice] = useState("");
  const reasonId = useId();
  const { host } = new URL(origin);
  const hostname = siteHostname(origin);

  function change(next: SettingsEdit) {
    setNotice("");
    edit.mutate(next, { onSuccess: () => setNotice(next.done) });
  }

  const current = settings.data?.settings ?? null;
  const rules = exclusionsCovering(current, hostname);
  // The switch pauses automatic login on this hostname until turned back on, or resumes it
  // (ADR 0062); it adds or removes only the hostname's own rule, and a rule that also covers
  // other sites is changed on the Sites list.
  const broader = rules.find((rule) => rule.includeSubdomains);
  const siteDefault = current?.siteDefaults.find((entry) => entry.origin === origin);
  const bindings = (current?.bindings ?? []).filter((entry) => entry.origin === origin);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <a
          href="/manage/sites"
          className="inline-flex items-center gap-1 text-[13px]/5 text-accent-ink underline hover:text-accent-hover"
        >
          <ChevronLeft size={14} aria-hidden />
          Sites
        </a>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className={`${PAGE_TITLE_CLASSES} min-w-0 flex-[1_1_16rem] [overflow-wrap:anywhere]`}>
            {origin}
          </h1>
          {settings.data && (
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm has-disabled:cursor-default">
              <input
                type="checkbox"
                // A checkbox exposes its own checked state to the switch role.
                // oxlint-disable-next-line jsx-a11y/role-has-required-aria-props
                role="switch"
                checked={rules.length === 0}
                disabled={edit.isPending || broader !== undefined}
                aria-describedby={broader ? reasonId : undefined}
                onChange={(event) =>
                  change(
                    event.target.checked
                      ? allowSite(hostname, `${hostname} resumed`)
                      : excludeSite(hostname, false),
                  )
                }
                className="relative h-5 w-9 flex-none cursor-pointer appearance-none rounded-full bg-border-strong transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-surface after:transition-[left] after:content-[''] checked:bg-accent checked:after:left-[18px] disabled:cursor-default disabled:opacity-50"
              />
              Automatic login on this site
            </label>
          )}
        </div>
        {broader && (
          <p id={reasonId} className="text-[13px]/5 text-ink-muted">
            Paused with {exclusionLabel(broader)}; resume it on the Sites list
          </p>
        )}
      </div>
      <SuccessNotice id="site-saved" message={notice} />
      {edit.isError && <ErrorNotice id="settings-error">{describeError(edit.error)}</ErrorNotice>}
      {settings.isPending ? (
        <output id="settings-status" className="block">
          Loading settings…
        </output>
      ) : settings.isError ? (
        <ErrorNotice id="settings-status">{describeError(settings.error)}</ErrorNotice>
      ) : (
        <Panel id="default-heading" title="Default account">
          {siteDefault ? (
            <RowList>
              <li className={ROW_CLASSES}>
                <RowIcon>
                  <User size={16} aria-hidden />
                </RowIcon>
                <RowMain title={defaultAccountLabel(siteDefault)} />
                <Button
                  variant="danger"
                  aria-label={`Remove default account for ${origin}`}
                  disabled={edit.isPending}
                  onClick={() =>
                    change({
                      apply: (value) => ({
                        ...value,
                        siteDefaults: value.siteDefaults.filter((saved) => saved.origin !== origin),
                      }),
                      done: `Default account for ${origin} removed`,
                    })
                  }
                >
                  Remove
                </Button>
              </li>
            </RowList>
          ) : (
            <p>No default account</p>
          )}
          <Lines>
            <Line icon={<Info size={16} aria-hidden />}>
              Choose {siteDefault ? "another" : "an"} account from the Pateat popup on {host}
            </Line>
          </Lines>
        </Panel>
      )}
      <SiteRecipes
        client={client}
        origin={origin}
        announce={setNotice}
        shownError={settings.isError ? describeError(settings.error) : undefined}
      />
      {settings.data && <SiteBindings bindings={bindings} busy={edit.isPending} edit={change} />}
      <Lines>
        <Line icon={<RefreshCw size={16} aria-hidden />}>
          Devices apply a change on their next sync
        </Line>
      </Lines>
    </div>
  );
}
