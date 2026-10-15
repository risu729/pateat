import type { LocalSettings, ProtectionSettings } from "@pateat/contracts";
import { FingerprintPattern, KeyRound, MousePointerClick, type LucideIcon } from "lucide-react";
import { Panel, Row, RowList, RowSub, RowTitle } from "./ui";

type Choice = {
  id: string;
  icon: LucideIcon;
  title: string;
  /** What happens with the box ticked, then without it. */
  on: string;
  off: string;
  checked: (protections: ProtectionSettings) => boolean;
  set: (protections: ProtectionSettings, checked: boolean) => void;
};

const CHOICES: Choice[] = [
  {
    id: "protection-passkey-presence",
    icon: MousePointerClick,
    title: "Answer passkey requests only after a click or key press on the page",
    on: "A site's passkey request made without a click or key press on its page goes to the browser.",
    off: "Pateat answers a site's passkey request without any action from you and tells the site you were present (UP).",
    checked: (protections) => protections.passkeyPresence === "activation",
    set: (protections, checked) => {
      protections.passkeyPresence = checked ? "activation" : "always";
    },
  },
  {
    id: "protection-passkey-verification",
    icon: FingerprintPattern,
    title: "Do not tell sites you were verified",
    on: "Pateat leaves user verification (UV) unset, and a request that requires it goes to the browser.",
    off: "Pateat tells the site you were verified (UV), although it checks nothing itself.",
    checked: (protections) => protections.passkeyVerification === "never",
    set: (protections, checked) => {
      protections.passkeyVerification = checked ? "never" : "always";
    },
  },
  {
    id: "protection-master-password-reprompt",
    icon: KeyRound,
    title: "Honour Bitwarden's master password re-prompt",
    on: "Vault items marked with it are never filled and their passkeys are never used: the login stops, and a passkey request goes to the browser.",
    off: "Pateat fills these items and signs with their passkeys without asking for the master password.",
    checked: (protections) => protections.masterPasswordReprompt === "honour",
    set: (protections, checked) => {
      protections.masterPasswordReprompt = checked ? "honour" : "ignore";
    },
  },
];

/**
 * The protections setting (ADR 0007): the passkey policy of every site, and whether
 * Bitwarden's master password re-prompt is honoured. It syncs like the site settings.
 */
export function Protections({
  draft,
  edit,
}: {
  draft: LocalSettings;
  edit: (update: (value: LocalSettings) => void) => boolean;
}) {
  return (
    <Panel id="protections" headingId="protections-heading" title="Protections">
      <RowList id="protection-list">
        {CHOICES.map((choice) => {
          const checked = choice.checked(draft.protections);
          return (
            <Row
              key={choice.id}
              icon={choice.icon}
              main={
                <>
                  <RowTitle>
                    <label className="checkbox-row m-0 cursor-pointer" htmlFor={choice.id}>
                      <input
                        id={choice.id}
                        type="checkbox"
                        aria-describedby={`${choice.id}-effect`}
                        checked={checked}
                        onChange={(event) => {
                          const next = event.target.checked;
                          edit((value) => choice.set(value.protections, next));
                        }}
                      />
                      <span>{choice.title}</span>
                    </label>
                  </RowTitle>
                  <RowSub id={`${choice.id}-effect`}>{checked ? choice.on : choice.off}</RowSub>
                </>
              }
            />
          );
        })}
      </RowList>
    </Panel>
  );
}
