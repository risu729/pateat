import {
  attemptPlan,
  attemptUsesCode,
  handlerFact,
  handlerSteps,
  handlerTargets,
  manualDetails,
  loginStepEffect,
  passwordVariants,
  routeSignInPaths,
  sameLoginTarget,
  transitionLoginAttempt,
  type LoginAttemptEvent,
  type LoginStep,
} from "@pateat/contracts";
import { type Execution, type DetailWait } from "./types";
import { observe, passkeyStepAnswered } from "./reconcile";
import { handlerOrder, codeFieldOf, markerProof, autoSubmitted } from "./steps";
import { readSignInState, reconcileBounded } from "./sign-in";
import { current, report, change, reportHandlerMiss } from "./attempt";
import { type LoginReport } from "./report";
import { detailInput, asksAnotherQuestion, forgetDetail, offerDetails } from "./detail-fill";
import { popupDetailFill } from "./detail-popup";
import { allowed } from "./plan-2";
import type { Runtime } from "./state";

/**
 * Enters a handler of the recipe on this path all of whose elements show (ADR 0027).
 * Several shown: the first not yet entered whose fact the item has, a `passkey` handler
 * before a `totp` handler, as the routes put the passkey first and it types nothing. A
 * `totp` handler is never entered by a login that already types a code, and needs the
 * item's code field (`codeFieldOf`). Returns whether the attempt moved on: to the handler's
 * steps, or to `challenge` when no shown handler qualifies or the attempt's budget has
 * no room for it. At a login's stop before its item's missing password (`stop`, ADR
 * 0036), only a `passkey` handler is entered, before the stop step, and the login ends
 * there with `stop.end` instead. A `password` handler goes first, and only for a login
 * that types its password and has not filled it yet; one shown but refused ends the login
 * as `challenge` rather than letting another handler beside it be entered (ADR 0048).
 * An `authenticator` handler, which goes on to the code page, comes after a `totp` one,
 * needs what a `totp` handler needs, and is pressed only in the tab's top document on the
 * recipe's own origin by a login that does not only fill (ADR 0081).
 * `held` when the handler whose click this document holds shows again here, before the
 * login settled: the page is held as while its button still shows (ADR 0027), since the
 * button may show again for a moment before the site moves on.
 */
export async function enterHandler(
  rt: Runtime,
  run: Execution,
  path: string,
  stop?: { end: () => Promise<void> },
): Promise<boolean | "held"> {
  // A fresh handler's elements must be usable: its code field a shown writable input and
  // its button shown, enabled or not, as a Verify button disabled until the code is typed
  // is; so a hidden code input rendered with the sign-in form never stands for a code
  // page. The click step itself waits for the button to be enabled. A `totp` handler whose
  // button is also a route step's on this path, as in a form that asks for the code after
  // the password, needs every fill field of the route there gone: while one shows, the
  // page is still the sign-in page. A handler that already ran counts as shown again
  // whenever its elements are there, hidden or disabled, so it never runs twice; only in
  // the document that holds its click is one the page hid gone instead.
  const routeFields = passwordVariants(run.recipe)
    .flatMap((variant) => variant.steps)
    .filter((step) => step.path === path)
    .flatMap((step) => (step.kind === "fill" ? step.fields.map((field) => field.target) : []))
    .filter(
      (target, index, all) => all.findIndex((other) => sameLoginTarget(other, target)) === index,
    );
  const routeClicks = passwordVariants(run.recipe)
    .flatMap((variant) => variant.steps)
    .filter((step) => step.path === path)
    .flatMap((step) => (step.kind === "click" ? [step.target] : []));
  // A login that may still type its password, on the `password` route without a stop, never
  // enters a `passkey` handler on a path where its plan still has a route step to run that
  // fills the password, nor while a fill field of the route shows on this path, as one
  // learned beside the password field at another login's stop (ADR 0036): the button never
  // pre-empts the password it types, even while the page swaps its identifier for its
  // password field. A route step still to run that fills only another slot, as a code on
  // the page after the password, does not keep it out. A login with a stop, recorded when
  // it started and kept whatever the vault later holds, never types it.
  const typesPassword = run.metadata.route === "password" && run.metadata.stopAt === undefined;
  // The first plan step not yet run: the one after the step in flight, or the current one.
  const unrun =
    run.metadata.operationId === undefined ? run.metadata.stepIndex : run.metadata.stepIndex + 1;
  const plan = attemptPlan(run.recipe, run.metadata) ?? [];
  const passwordAhead =
    typesPassword &&
    plan.some(
      (entry, index) =>
        index >= unrun &&
        entry.handler === undefined &&
        entry.step.kind === "fill" &&
        entry.step.path === path &&
        entry.step.fields.some((field) => field.slot === "password"),
    );
  // A `password` handler's button goes on to the password this login types (ADR 0048): only
  // a login that types it, does not only fill, runs on the recipe's own origin, in the
  // tab's page or a frame of it (ADR 0086), and has not filled its password yet presses it.
  const choosesPassword =
    typesPassword &&
    run.metadata.fillOnly !== true &&
    run.live.document.origin === run.recipe.origin &&
    !plan.some(
      (entry, index) =>
        index < unrun &&
        entry.step.kind === "fill" &&
        entry.step.fields.some((field) => field.slot === "password"),
    );
  // An `authenticator` handler's button goes on to the code page (ADR 0081): only a login
  // whose credential went back already, a password it filled or Pateat's answer to its
  // step's passkey request, whatever the route (owner, 2026-11-08), that does not only fill
  // and runs on the recipe's own origin presses it, so a button that offers a code instead
  // of the password or passkey never skips that first factor.
  const choosesAuthenticator =
    (plan.some(
      (entry, index) =>
        index < unrun &&
        entry.step.kind === "fill" &&
        entry.step.fields.some((field) => field.slot === "password"),
    ) ||
      passkeyStepAnswered(rt, run)) &&
    run.metadata.fillOnly !== true &&
    run.live.document.origin === run.recipe.origin;
  // The handler whose click this document performed and holds: its button the page only
  // hid is gone, as for the hold, not shown again (ADR 0027).
  const held =
    run.heldClick === run.metadata.stepIndex ? plan[run.metadata.stepIndex]?.handler : undefined;
  const entries = (run.recipe.handlers ?? []).flatMap((handler, index) => {
    if (
      handler.path !== path ||
      (run.metadata.signInFill === true &&
        (handler.kind !== "detail" ||
          run.metadata.handlers.some((entry) => entry.index === index))) ||
      (stop && handler.kind !== "passkey") ||
      (passwordAhead && handler.kind === "passkey") ||
      (!choosesPassword && handler.kind === "password") ||
      (!choosesAuthenticator && handler.kind === "authenticator")
    )
      return [];
    const ran = run.metadata.handlers.some((entered) => entered.index === index);
    // A `password` or `authenticator` handler is pressed only while none of the route's
    // fill fields shows on its path: a page that shows one gets it filled instead.
    const sameForm =
      !ran &&
      ((handler.kind === "totp" &&
        routeClicks.some(
          (target) => handler.target !== undefined && sameLoginTarget(target, handler.target),
        )) ||
        (handler.kind === "passkey" && typesPassword) ||
        handler.kind === "password" ||
        handler.kind === "authenticator");
    const targets = handlerTargets(handler);
    return [
      {
        handler,
        index,
        targets: [...targets, ...(sameForm ? routeFields : [])],
        require: [
          ...(ran
            ? targets.map(() => (index === held ? ("shown" as const) : ("present" as const)))
            : handler.kind === "totp"
              ? (["writable", "shown"] as const).slice(0, targets.length)
              : handler.kind === "detail"
                ? // Its inputs present, as a choice page may disable all but one, and its
                  // button shown (ADR 0061).
                  ([...targets.slice(0, -1).map(() => "present" as const), "shown"] as const)
                : handler.kind === "password"
                  ? // Shown, and its rendered text names the password choice (ADR 0048).
                    (["password-choice"] as const)
                  : handler.kind === "authenticator"
                    ? // Shown, and its text names an authenticator app's code (ADR 0081).
                      (["authenticator-choice"] as const)
                    : (["shown"] as const)),
          ...(sameForm ? routeFields.map(() => "writable" as const) : []),
        ],
        own: targets.length,
      },
    ];
  });
  if (!entries.length) return false;
  // A separate observation, so the recipe's own bound of 24 elements still holds; past it,
  // the handlers that do not fit are not entered.
  let room = 24;
  const observable = entries.filter((entry) => {
    if (entry.targets.length > room) return false;
    room -= entry.targets.length;
    return true;
  });
  if (!observable.length) return false;
  const reportHandler = (
    entry: (typeof entries)[number],
    outcome: Extract<LoginReport, { type: "handler" }>["outcome"],
  ) =>
    report(rt, run.live.document, {
      type: "handler",
      tabId: run.live.document.tabId,
      origin: run.live.document.origin,
      recipeId: run.recipe.id,
      recipeRevision: run.recipe.revision,
      handler: entry.index,
      kind: entry.handler.kind,
      outcome,
      steps: handlerSteps(entry.handler).length,
    });
  const byOrder = (left: (typeof entries)[number], right: (typeof entries)[number]) =>
    handlerOrder[left.handler.kind] - handlerOrder[right.handler.kind];
  // The page did not show a handler this login has not run yet as it needs: the reason
  // for the first such handler in entry order is kept, and logged once the login leaves
  // the page to the person (`handlerMiss`), as a code page left to the person (#1381) must
  // be told apart in the log from one Pateat filled (ADR 0019); in a watch, where the page
  // is already the person's, it is logged at once. `moved` when the page left the path
  // before it was read; otherwise each own target's check, as `ok.missing` for a code
  // field there and a button gone, or several (`matches-2`), hidden or not usable.
  const notShown = (why: (entry: (typeof observable)[number]) => string, at = path) => {
    const fresh = observable
      .filter((entry) => !run.metadata.handlers.some((entered) => entered.index === entry.index))
      .sort(byOrder)[0];
    if (!fresh) return;
    run.handlerMiss = {
      documentId: run.live.document.documentId,
      path: at,
      handler: fresh.index,
      kind: fresh.handler.kind,
      steps: handlerSteps(fresh.handler).length,
      why: codes(why(fresh)),
    };
    if (run.metadata.state === "watching") reportHandlerMiss(rt, run);
  };
  // Only this reading's miss is kept: an earlier one is of a page read again now.
  delete run.handlerMiss;
  const observed = await observe(
    rt,
    run,
    observable.flatMap((entry) => entry.targets),
    observable.flatMap((entry) => entry.require),
    { explain: true },
  );
  if (!observed) return false;
  if (observed.path !== path) {
    // Named by the path the page moved to, which the line's URL shows.
    notShown(() => "moved", observed.path);
    return false;
  }
  let offset = 0;
  const offsets = new Map<number, number>();
  let shown = observable
    .filter((entry) => {
      offsets.set(entry.index, offset);
      const states = observed.targets.slice(offset, offset + entry.targets.length);
      offset += entry.targets.length;
      return (
        states.length === entry.targets.length &&
        states.slice(0, entry.own).every((state) => state === "unique") &&
        states.slice(entry.own).every((state) => state !== "unique")
      );
    })
    .sort(byOrder);
  if (!shown.length) {
    notShown((entry) => {
      const from = offsets.get(entry.index) ?? 0;
      const own = (observed.checks ?? observed.targets).slice(from, from + entry.own);
      // A route field still shown beside a code page's button keeps it the sign-in page.
      const besideForm = observed.targets
        .slice(from + entry.own, from + entry.targets.length)
        .some((state) => state === "unique");
      return [...own, ...(besideForm ? ["sign-in-shown"] : [])].join(".");
    });
    return false;
  }
  // A `detail` handler learned beside the sign-in form on a route path (ADR 0061) is not
  // entered for the first time while that form shows a failure beside its fields: the
  // password was wrong, and the login ends rejected rather than with the handler.
  if (
    shown.some(
      (entry) =>
        entry.handler.kind === "detail" &&
        !run.metadata.handlers.some((entered) => entered.index === entry.index),
    ) &&
    routeSignInPaths(run.recipe, run.metadata.route).includes(path)
  ) {
    const reading = await readSignInState(rt, run);
    if (!current(rt, run)) return true;
    if (reading?.decision === "rejected") {
      shown = shown.filter(
        (entry) =>
          entry.handler.kind !== "detail" ||
          run.metadata.handlers.some((entered) => entered.index === entry.index),
      );
      if (!shown.length) return false;
    }
  }
  const challenge = () =>
    stop
      ? stop.end()
      : change(rt, run, { type: "OBSERVED", result: "challenge", document: run.live.document });
  // A handler page shown again after its handler ran is left to the person, and so is a
  // second code in one login, so a wrong code or key is never retried into a lockout.
  const refusal = (entry: (typeof entries)[number]) => {
    if (run.metadata.handlers.some((entered) => entered.index === entry.index))
      return "shown-again" as const;
    const { handler } = entry;
    // A `detail` handler fills a value of a vault item linked to the login (ADR 0061):
    // one whose inputs ask only for details Pateat never fills is left to the person as
    // such, and so is one with no linked value for a writable input.
    if (handler.kind === "detail") {
      if (detailPicks.get(entry.index) !== undefined) return undefined;
      if (detailWaits.has(entry.index)) return "detail-reprompt" as const;
      return handler.fields.every((field) => manualDetails.includes(field.detail))
        ? ("detail-manual" as const)
        : ("detail-unlinked" as const);
    }
    const fact = handlerFact[handler.kind];
    if (!run.metadata.facts[fact]) return "missing-fact" as const;
    // A login that already typed or means to type a code never goes on to another one,
    // through the code field or the button that leads to it (ADR 0081).
    return (handler.kind === "totp" || handler.kind === "authenticator") &&
      attemptUsesCode(run.recipe, run.metadata)
      ? ("code-used" as const)
      : undefined;
  };
  // Which input of each shown `detail` handler this login fills: the first with a linked
  // value it may read and that is writable now (ADR 0061).
  const detailPicks = new Map<number, number | undefined>();
  // A handler whose only linked value is in an item that waits for the master password.
  const detailWaits = new Map<number, DetailWait>();
  for (const entry of shown)
    if (
      entry.handler.kind === "detail" &&
      !run.metadata.handlers.some((entered) => entered.index === entry.index)
    )
      detailPicks.set(
        entry.index,
        await detailInput(rt, run, entry.handler, (wait) => detailWaits.set(entry.index, wait)),
      );
  if (!current(rt, run)) return true;
  // A `password` handler goes first; refused, as when its button shows again after its
  // press, it ends the login there, so the passkey button beside it is never pressed by a
  // login that types its password (ADR 0048).
  const fresh =
    shown[0]!.handler.kind === "password" && refusal(shown[0]!) !== undefined
      ? undefined
      : shown.find((entry) => refusal(entry) === undefined);
  // The handler this document clicked, shown again while the click is held: read as the
  // hold reads its button, so a page drawn again on the way to the signed-in page
  // (VRChat, 2026-11-08 04:48 UTC) neither ends the login, logs `shown-again`, nor drops
  // a `detail` handler's link.
  if (
    !fresh &&
    !stop &&
    held !== undefined &&
    run.metadata.settled !== true &&
    shown.some((entry) => entry.index === held)
  )
    return "held";
  // A `detail` handler's page shown again after its fill means the site refused the
  // value, so its link is not used again (ADR 0061); one that now asks another of the
  // item's secret questions asks a new question instead, so the answer's link stays.
  const newQuestion = new Set<number>();
  for (const entry of shown) {
    const answered = run.answers?.get(entry.index);
    if (
      entry.handler.kind === "detail" &&
      answered !== undefined &&
      refusal(entry) === "shown-again" &&
      // eslint-disable-next-line no-await-in-loop
      (await asksAnotherQuestion(rt, run, entry.handler, answered))
    )
      newQuestion.add(entry.index);
    if (!current(rt, run)) return true;
  }
  if (shown.some((entry) => entry.handler.kind === "detail" && refusal(entry) === "shown-again")) {
    await forgetDetail(rt, run, newQuestion);
    if (!current(rt, run)) return true;
  }
  if (!fresh && run.metadata.signInFill) return false;
  if (!fresh) {
    const refused = refusal(shown[0]!)!;
    reportHandler(shown[0]!, refused);
    // The popup proposes the vault fields that could give the details (ADR 0061), and a
    // link whose value the page asked for again is not used again.
    const handler = shown[0]!.handler;
    if (
      handler.kind === "detail" &&
      (refused === "detail-unlinked" ||
        refused === "detail-reprompt" ||
        newQuestion.has(shown[0]!.index)) &&
      !stop
    )
      await offerDetails(rt, run, handler, shown[0]!.index);
    await challenge();
    // The linked value's item waits for the master password (owner, 2026-10-23 21:50
    // UTC): the window asks, and once the vault accepts it the value is filled as the
    // popup's Fill fills it, leaving the button to the person.
    const wait = detailWaits.get(shown[0]!.index);
    if (refused === "detail-reprompt" && wait && !stop)
      void popupDetailFill(
        rt,
        {
          version: 1,
          type: "login.detail.fill",
          tabId: run.live.document.tabId,
          documentId: run.live.document.documentId,
          detail: wait.detail,
          connectionId: run.metadata.account.connectionId,
          itemId: wait.itemId,
          fieldId: wait.fieldId,
        },
        { targets: wait.targets },
      ).catch(() => undefined);
    return true;
  }
  if (fresh.handler.kind === "totp" || fresh.handler.kind === "authenticator") {
    // The code is made from the item's code field: its built-in TOTP, or the Text or
    // Hidden custom field its saved binding names, which the account must allow. The
    // button that goes on to the code is pressed only for a code the login can type.
    const authorized = await allowed(rt, run);
    if (!authorized) return true;
    const code = codeFieldOf(
      authorized.connection,
      run.metadata.account.itemId,
      authorized.bindings,
      run.recipe,
    );
    if (!code || !authorized.fieldIds.includes(code)) {
      reportHandler(fresh, "missing-fact");
      await challenge();
      return true;
    }
  }
  const field = fresh.handler.kind === "detail" ? detailPicks.get(fresh.index) : undefined;
  const steps = handlerSteps(fresh.handler, field);
  const event: LoginAttemptEvent = {
    type: "HANDLER",
    handler: fresh.index,
    ...(field === undefined ? {} : { field }),
    steps: steps.length,
    effects: steps.filter((step) => {
      const effect = loginStepEffect(step);
      return effect === "advance" || effect === "submit";
    }).length,
    document: run.live.document,
  };
  // At a stop the attempt stays ready either way: only an entered handler counts.
  const entered = transitionLoginAttempt(run.metadata, event);
  if (entered.state !== "ready" || entered.handlers.length === run.metadata.handlers.length) {
    reportHandler(fresh, "no-room");
    if (run.metadata.signInFill) return false;
    await challenge();
    return true;
  }
  reportHandler(fresh, "entered");
  await change(rt, run, event);
  return true;
}

/** Dot-joined check codes cut to whole codes within the log's 64 characters. */
function codes(joined: string): string {
  if (joined.length <= 64) return joined;
  const cut = joined.slice(0, 65);
  return cut.slice(0, cut.lastIndexOf("."));
}

/**
 * After a `totp` handler's fill, whether the page moved on by itself before the click
 * found its button (ADR 0027): to another path, or to a signed-in marker or the rejection
 * without the button. A button still shown is clicked once as planned.
 */
export async function submittedByPage(
  rt: Runtime,
  run: Execution,
  click: Extract<LoginStep, { kind: "click" }>,
): Promise<boolean> {
  const { rejection } = run.recipe;
  const proof = markerProof(run.recipe);
  const observed = await observe(
    rt,
    run,
    [click.target, ...proof.targets, ...(rejection ? [rejection] : [])],
    ["shown", ...proof.shown, ...(rejection ? ["present" as const] : [])],
    proof.links.length > 0
      ? { links: [false, ...proof.links], hidden: [false, ...proof.hidden] }
      : {},
  );
  if (!observed || !current(rt, run)) return false;
  if (observed.path !== click.path) return true;
  if (observed.targets[0] === "unique") return false;
  return (
    proof.proves(observed.targets, 1) ||
    (rejection !== undefined && observed.targets[1 + proof.targets.length] === "unique")
  );
}

/**
 * The page submitted a TOTP code by itself, a `totp` handler's or a route step's: the
 * code's click counts as done, and the page is settled as after a click. The code is
 * never filled again.
 * Returns whether the attempt took it.
 */
export async function codeSubmitted(rt: Runtime, run: Execution): Promise<boolean> {
  await change(rt, run, autoSubmitted(run.recipe, run.metadata));
  if (
    !current(rt, run) ||
    run.metadata.state !== "reconciling" ||
    run.metadata.operationKind !== "click"
  )
    return false;
  // Held as after the click: a page that shows "Verifying" with the button still there
  // is neither judged nor settled while it verifies.
  run.heldClick = run.metadata.stepIndex;
  await reconcileBounded(rt, run);
  return true;
}
