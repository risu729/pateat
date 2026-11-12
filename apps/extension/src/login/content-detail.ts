import { formAccounts, showsOtherAccount } from "../page/accounts";
import { formOf } from "../page/shadow";
import { targetState, writable } from "../page/target-state";
import {
  clickDestinations,
  formDestinations,
  submitterDestinations,
} from "../page/form-destination";
import { nextFrame } from "../page/frames";
import { sendMessage } from "../messaging/protocol";
import { acceptsSecret, maskedSecret } from "./inputs";
import { chooseFor } from "../page/choice-radio";
import { askedQuestion } from "../page/question";
import { cardHints } from "../page/card-hints";
import { stopSiteValues } from "../page/site-values";
import type { ContentState } from "./content-state";
import type { ContentCommand, Respond } from "./content-command";
import {
  pagePath,
  matches,
  stillAsks,
  type Control,
  takes,
  fitsControl,
  enter,
  isOnly,
} from "./content-dom";

type DetailState = Pick<ContentState, "cancelled" | "token">;

export type DetailCommand = Extract<
  ContentCommand,
  { type: "login.detail.question" | "login.detail.card" | "login.detail.fill" }
>;
export function handleDetailCommand(
  state: DetailState,
  command: DetailCommand,
  respond: Respond,
): boolean {
  if (command.type === "login.detail.question") {
    const found = state.cancelled || pagePath() !== command.path ? [] : matches(command.target);
    const input = found.length === 1 ? found[0] : undefined;
    const index = writable(input) ? askedQuestion(input, command.names) : undefined;
    respond(index === undefined ? { ok: true } : { ok: true, index });
    return false;
  }
  if (command.type === "login.detail.card") {
    // Only the hint tokens leave this handler, never the page's text (ADR 0061).
    const found = state.cancelled || pagePath() !== command.path ? [] : matches(command.target);
    const input = found.length === 1 ? found[0] : undefined;
    respond(
      writable(input)
        ? { ok: true, ...cardHints(input, document.title) }
        : { ok: true, last4: [], brands: [] },
    );
    return false;
  }
  if (command.type === "login.detail.fill") {
    // The popup's fill of a personal detail (ADR 0061): its input, or every input of a
    // split value, each checked before any is filled, a radio first, and nothing
    // pressed. The values and the username never leave this handler.
    // What the page sets in its inputs from now on may be Pateat's own filling.
    stopSiteValues(window);
    const fields = command.fields.map((field) => ({ ...field }));
    for (const field of command.fields) field.value = "";
    const username = command.account?.username;
    if (command.account) command.account.username = "";
    const clear = () => {
      for (const field of fields) field.value = "";
    };
    void (async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      const controls = fields.map((field) => {
        const found = matches(field.target);
        return found.length === 1 ? found[0] : undefined;
      });
      const usable = (control: Element | undefined, field: (typeof fields)[number]) =>
        takes(control, field.secret) &&
        acceptsSecret(control as Control, field.secret) &&
        stillAsks(control as Control, field.question) &&
        fitsControl(control as Control, field);
      if (
        state.cancelled ||
        pagePath() !== command.path ||
        !setter ||
        fields.some((field, position) => !usable(controls[position], field))
      )
        return { ok: false };
      // Every part is in one form, or every part outside any form, as a login's fill
      // requires (`fields-split`).
      const form = formOf(controls[0] as Control);
      if (controls.some((control) => formOf(control as Control) !== form)) return { ok: false };
      if (new Set(controls).size !== controls.length) return { ok: false };
      // A popup fill leaves submission to the person, so check every control that can
      // submit the form too, the shown button and the default button a pressed Enter
      // uses with their overrides, before putting any value into the form (ADR 0051).
      const buttons = matches(command.submit);
      const button = buttons.length === 1 ? buttons[0] : undefined;
      if (!button || targetState(document, command.submit, "shown") !== "unique")
        return { ok: false };
      const destinations = () => [
        ...controls.flatMap((control) => formDestinations(control as Control, "fill")),
        ...submitterDestinations(controls as Control[]),
        ...clickDestinations(button),
      ];
      const before = destinations();
      if (before.some((entry) => entry.kind === "refused")) return { ok: false };
      const unchanged = () =>
        !state.cancelled &&
        command.origin === self.origin &&
        pagePath() === command.path &&
        Date.now() < command.expiresAt &&
        isOnly(matches(command.submit), button) &&
        targetState(document, command.submit, "shown") === "unique" &&
        fields.every(
          (field, position) =>
            isOnly(matches(field.target), controls[position]!) &&
            usable(controls[position], field) &&
            formOf(controls[position] as Control) === form,
        ) &&
        JSON.stringify(destinations()) === JSON.stringify(before);
      if (!unchanged()) return { ok: false };
      const authorized: unknown = await sendMessage("login", {
        version: 1,
        type: "login.detail.authorize",
        token: state.token,
        fillId: command.fillId,
        destinations: [
          ...new Set(before.flatMap((entry) => (entry.kind === "other-origin" ? [entry.url] : []))),
        ],
      }).catch(() => undefined);
      if (authorized !== true || !unchanged()) return { ok: false };
      // A value goes only to the login item's account when the page shows one, as a
      // login's fill does (owner decision, 2026-10-11).
      if (
        username !== undefined &&
        showsOtherAccount(formAccounts(document, form), username, {
          masked: fields.some((field) => maskedSecret(field.secret)),
        })
      )
        return { ok: false, reason: "other-account" };
      for (const [position, field] of fields.entries()) {
        const control = controls[position] as Control;
        // The page's handlers for the previous input run first.
        // eslint-disable-next-line no-await-in-loop
        if (position > 0) await nextFrame();
        // The radio's click may change the input, so its checks run again.
        if (!unchanged() || !chooseFor(control) || !unchanged()) return { ok: false };
        // eslint-disable-next-line no-await-in-loop
        const stopped = await enter(control, field, setter, {
          between: () => (!unchanged() ? "field-changed" : undefined),
        });
        if (stopped !== undefined || !unchanged()) return { ok: false };
      }
      return { ok: true };
    })()
      .finally(clear)
      .then(respond, () => respond({ ok: false }));
    return true;
  }
  return false;
}
