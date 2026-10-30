import {
  continuesRecipe,
  extendsRecipe,
  passwordVariants,
  languageDecides,
  layoutFirstSteps,
  rankLayouts,
  layoutStartTargets,
  recipeStartSteps,
  laterStartSteps,
  recoverLoginAttempt,
  routeSteps,
  transitionLoginAttempt,
  chooserRoute,
  type LoginChooserRecipe,
  type LoginRecipe,
} from "@pateat/contracts";
import { laterReadiness, loginReadiness } from "../wire";
import { probeRecipe } from "../dummy";
import { namesReturnPath } from "../entry";
import { keep } from "./session-store";
import { sameSiteAs, rawPath, logCode } from "./steps";
import {
  pressEntry,
  refuseEntry,
  switchingTab,
  entryOfferRefusal,
  generateEntryFor,
} from "./entry-press";
import { probeMode } from "./constants";
import { reportAttempt, publish } from "./attempt";
import { askFor } from "./choice";
import { type Readiness, type LayoutChoice, type GenerationMiss } from "./types";
import {
  confirmPage,
  rankedLayouts,
  listReadiness,
  showsNow,
  showsAnyMarker,
  observedLanguage,
  listedNames,
} from "./markers";
import { skipGeneration, generateFor } from "./generation";
import { tabAttempt, recordFor, signedInElsewhere } from "./hold";
import { terminal } from "./attempt-state";
import { reviewRequests } from "./passkey";
import {
  confirmRecipeOn,
  startsFor,
  offersOther,
  generationSlotsFor,
  offersGeneration,
} from "./generation-scope";
import { repairStale } from "./repair-run";
import type { Runtime } from "./state";
import { admitStart } from "./admit-start";
import type { AdmitContext, AdmitStartContext } from "./admit-context";

export async function admitRecipe(rt: Runtime, ctx: AdmitContext): Promise<Readiness> {
  // The tab asks for an account after the site rejected its login or another tab's login
  // of the origin, which shares its session, or after its own login stopped (ADR 0021 D);
  // it may fill the page once then, pressing nothing (below).
  ctx.ask = ctx.recorded ? undefined : askFor(rt, ctx.document.tabId, ctx.document.origin);

  // A tab runs one attempt at a time; another one still running holds it.
  const running = tabAttempt(rt, ctx.document.tabId);

  if (running && !terminal(running) && running.id !== ctx.recorded?.id)
    return ctx.refuse("tab-busy");

  // After an account switch, the tab's next document of that origin starts a new
  // attempt, which may use another recipe. It carries the switch, so it never clicks
  // another one.
  ctx.switched = ctx.recorded?.state === "blocked" && ctx.recorded.outcome === "account-switched";

  ctx.previous = ctx.switched ? undefined : ctx.recorded;

  // Look up the recipe first: a page without one never opens the policy catalog or vault.
  ctx.recipe =
    probeMode && ctx.document.origin === rt.vars.origin
      ? ctx.previous
        ? probeRecipe(rt.vars.origin, `/${ctx.previous.recipeId.replace(/^demo-/, "")}`)
        : probeRecipe(rt.vars.origin, ctx.live.path)
      : await rt.recipes.recipe(
          ctx.document.origin,
          ctx.live.path,
          ctx.previous?.recipeId,
          ctx.previous?.layout,
        );

  if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };

  // A new login on a recipe with several layouts (ADR 0060) takes the one whose start
  // page elements show most, then one of the page's language, then the newest; the
  // others follow in that order, and the first whose plan passes for the account runs.
  // A resumed login keeps its own layout.
  ctx.layoutChoices = [];

  ctx.layoutCount = 1;

  if (
    ctx.recipe &&
    !ctx.previous &&
    ctx.start?.path === ctx.live.path &&
    !(probeMode && ctx.document.origin === rt.vars.origin) &&
    rt.recipes.layouts
  ) {
    const candidates = await rt.recipes.layouts(ctx.document.origin, ctx.live.path).catch(() => []);
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    if (candidates.length > 1) {
      ctx.layoutCount = candidates.length;
      const ranked = await rankedLayouts(
        rt,
        ctx.live,
        candidates,
        layoutStartTargets,
        layoutFirstSteps,
        "login",
      );
      if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
      ctx.layoutChoices = ranked.map(({ recipe: layout }) => ({ recipe: layout }));
      ctx.recipe = ctx.layoutChoices[0]?.recipe ?? ctx.recipe;
    }
  }

  // A chooser recipe (ADR 0028): a new login on its list runs the route of its account
  // entry until it decides what to click, and a resumed one the route of its click.
  ctx.chooser = undefined;

  if (
    !ctx.recipe &&
    !(probeMode && ctx.document.origin === rt.vars.origin) &&
    (!ctx.previous || ctx.previous.chooser)
  ) {
    ctx.chooser = await Promise.resolve(
      rt.recipes.chooser?.(
        ctx.document.origin,
        ctx.live.path,
        ctx.previous?.recipeId,
        ctx.previous?.layout,
      ),
    ).catch(() => undefined);
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    // A new login on a chooser with several layouts takes the one whose list buttons
    // show most, then one of the page's language, then the newest (ADR 0060). Which
    // account the list holds is decided only once the layout is, so the account's plan
    // does not choose here.
    if (ctx.chooser && !ctx.previous && ctx.start?.path === ctx.live.path && rt.recipes.choosers) {
      const candidates = await rt.recipes
        .choosers(ctx.document.origin, ctx.live.path)
        .catch(() => []);
      if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
      if (candidates.length > 1) {
        ctx.layoutCount = candidates.length;
        // The list's buttons are its first step: a layout whose buttons all show fits.
        const buttons = (candidate: LoginChooserRecipe) => listReadiness(rt, candidate).targets;
        const ranked = await rankedLayouts(
          rt,
          ctx.live,
          candidates,
          buttons,
          (candidate) => [buttons(candidate)],
          "accounts",
        );
        if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
        ctx.chooser = ranked[0]?.recipe ?? ctx.chooser;
      }
    }
    if (ctx.chooser)
      ctx.recipe = chooserRoute(ctx.chooser, ctx.previous?.chooser?.click ?? "entry");
  }

  // The chooser's path shows its `other` branch's form instead of the list, as after the
  // person pressed the button for another account there: a new login starts on that
  // branch and clicks nothing on the list (ADR 0028). While the list shows, it goes first.
  ctx.shownOther = false;

  const shownRoute = ctx.chooser && chooserRoute(ctx.chooser, "other-shown");

  const shownStart = shownRoute && loginReadiness(shownRoute.steps[0]!);

  if (
    ctx.chooser &&
    shownStart?.targets.length &&
    !ctx.previous &&
    ctx.start?.path === ctx.live.path
  ) {
    const shows =
      (await showsNow(rt, ctx.live, shownStart)) &&
      !(await showsNow(rt, ctx.live, listReadiness(rt, ctx.chooser)));
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    if (shows) {
      ctx.recipe = shownRoute;
      ctx.shownOther = true;
    }
  }

  // A page that shows a later `fill` step of a recipe and none of the recipe's first
  // steps, as a password page shown again after a logout for an account the site
  // remembers, starts a new login at that step (ADR 0049, owner 2026-10-18). A first step
  // that shows goes first, another recipe's too; a chooser's branches never start there.
  ctx.later = undefined;

  if (
    !ctx.previous &&
    !ctx.chooser &&
    ctx.start?.path === ctx.live.path &&
    !(probeMode && ctx.document.origin === rt.vars.origin) &&
    rt.recipes.later
  ) {
    const candidates = await rt.recipes.later(ctx.document.origin, ctx.live.path).catch(() => []);
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    if (candidates.length) {
      // The start page's passkey button may stay beside a later step, as on a page that
      // shows it at each stage: only a `password` variant's first step goes first, and the
      // button is offered to the account as on the first page (ADR 0027).
      let firstShows = false;
      // Any layout the start page ranked best counts (ADR 0060), not only the first.
      const layoutsHere = [
        ...(ctx.recipe ? [ctx.recipe] : []),
        ...ctx.layoutChoices.slice(1).map((choice) => choice.recipe),
      ];
      /* eslint-disable no-await-in-loop */
      for (const variant of layoutsHere.flatMap((layout) => passwordVariants(layout))) {
        firstShows = await showsNow(rt, ctx.live, loginReadiness(variant.steps[0]!));
        if (firstShows) break;
      }
      const showing: {
        recipe: LoginRecipe;
        variants: Map<number, number[]>;
        partial: Set<string>;
      }[] = [];
      if (!firstShows)
        for (const candidate of candidates) {
          // A page that shows one of the recipe's signed-in markers, those of any of its
          // layouts (ADR 0060), is signed in, as a single-page app asking for the password
          // again before a sensitive action: no login starts there.
          if (await showsAnyMarker(rt, ctx.live, candidate)) continue;
          const variants = new Map<number, number[]>();
          // A step that shows whole goes before the same step with its password alone.
          const whole = new Set<string>();
          const partial = new Set<string>();
          for (const entry of laterStartSteps(candidate)) {
            const { variant, index, step, partial: part } = entry;
            const at = `${variant}:${index}`;
            if (step.path !== ctx.live.path || whole.has(at)) continue;
            if (await showsNow(rt, ctx.live, laterReadiness(entry))) {
              if (part) partial.add(at);
              else whole.add(at);
              const indices = variants.get(variant) ?? [];
              if (!indices.includes(index)) variants.set(variant, [...indices, index]);
            }
          }
          if (variants.size) showing.push({ recipe: candidate, variants, partial });
        }
      /* eslint-enable no-await-in-loop */
      if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
      const buttonShows = async (button: LoginRecipe | undefined) =>
        button?.passkey !== undefined &&
        button.passkey.path === ctx.live.path &&
        (await showsNow(
          rt,
          ctx.live,
          loginReadiness(routeSteps(button, { route: "passkey" })[0]!),
        ));
      // Two recipes whose later steps show start neither, as two first steps do (ADR 0013).
      // Layouts of one recipe are told apart as at its start page (ADR 0060): by how many
      // of their later steps show, the page's language and age, then the account's plan.
      const shownRecipes = new Set(showing.map((entry) => entry.recipe.id));
      if (shownRecipes.size === 1) {
        let ranked = showing;
        if (showing.length > 1) {
          // Each layout's language and creation time, from the recipe's layouts.
          const group = await Promise.resolve(
            rt.recipes.layouts?.(ctx.document.origin, showing[0]!.recipe.steps[0]!.path),
          ).catch(() => undefined);
          const metaOf = (entry: LoginRecipe) =>
            group?.find((candidate) => candidate.recipe.layout === entry.layout);
          const laterCandidates = showing.map((entry) => {
            const meta = metaOf(entry.recipe);
            return {
              recipe: entry,
              ...(meta?.language ? { language: meta.language } : {}),
              createdAt: meta?.createdAt ?? 0,
            };
          });
          // Each shows later steps, whole or with their password alone, so only how many
          // show tells them apart.
          const laterShown = showing.map((entry) => ({
            starts: true,
            missing: 0,
            shown: [...entry.variants.values()].reduce((sum, steps) => sum + steps.length, 0),
          }));
          let order = rankLayouts(laterCandidates, laterShown);
          if (languageDecides(order))
            order = rankLayouts(
              laterCandidates,
              laterShown,
              await observedLanguage(rt, ctx.live, "login"),
            );
          ranked = order.map(({ recipe: entry }) => entry);
        }
        ctx.layoutCount = Math.max(ctx.layoutCount, showing.length);
        const choices: LayoutChoice[] = await Promise.all(
          ranked.map(async (entry) => ({
            recipe: entry.recipe,
            later: {
              variants: entry.variants,
              partial: entry.partial,
              button: await buttonShows(entry.recipe),
            },
          })),
        );
        ctx.layoutChoices = choices.length > 1 ? choices : [];
        ctx.recipe = choices[0]!.recipe;
        ctx.later = choices[0]!.later;
      } else if (showing.length > 1) ctx.recipe = undefined;
      else if (!firstShows && !(await buttonShows(ctx.recipe)))
        // No step that may start a login shows, as when the one that announced the page
        // went, or it shows beside a signed-in marker: the document tries again, up to
        // its limit (START_TRIES).
        return { ok: false, reason: "stale-document" };
      if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    }
  }

  // A new attempt starts only once the document reports a first step of its recipe ready:
  // any route's or variant's, or the path alone when one of them needs no element. Until
  // then it watches the first steps of every recipe for its origin; this reads no
  // settings, policy catalog or vault.
  if (
    !ctx.previous &&
    (!ctx.recipe ||
      (recipeStartSteps(ctx.recipe).every((step) => loginReadiness(step).targets.length) &&
        ctx.start?.path !== ctx.live.path))
  ) {
    const starts = await startsFor(rt, ctx.document.origin);
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    // A site's sign-in entry on this path is pressed once its checks pass (ADR 0031).
    const entryRecipe =
      ctx.recipe || ctx.document.frameId !== 0 || ctx.live.topUrl
        ? undefined
        : (await rt.recipes.entries(ctx.document.origin).catch(() => [])).find(
            (candidate) => candidate.entry.path === ctx.live.path,
          );
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    if (entryRecipe) {
      ctx.live.state = "watching";
      delete ctx.live.reason;
      await publish(rt, ctx.live);
      void pressEntry(rt, ctx.live, entryRecipe).catch(() =>
        refuseEntry(rt, ctx.live, entryRecipe, "exception"),
      );
      return { ok: false, reason: "entry", starts };
    }
    // A recipe generated as `confirm` or `unclear` starts on this path: a verification
    // while signed in, which Pateat does not fill yet. The page is neither logged in to
    // nor sent for generation again, and the page only watches (ADR 0035).
    const confirm =
      ctx.recipe || ctx.document.frameId !== 0 || ctx.live.topUrl
        ? undefined
        : await confirmRecipeOn(rt, ctx.document.origin, ctx.live.path);
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    if (confirm) {
      const visit = confirmPage(rt, ctx.live, confirm);
      ctx.notStarted("confirm-unsupported", visit);
      ctx.live.state = "watching";
      delete ctx.live.reason;
      await publish(rt, ctx.live);
      return { ok: false, reason: "recipe-not-found", starts, confirm: visit.first };
    }
    // The chooser's path shows a sign-in form instead of its list, and the chooser has no
    // `other` branch yet, as after the person pressed its button for another account: the
    // page is sent as that branch's first page, as after Pateat's own click, and once
    // stored the form starts as `other-shown` (ADR 0028, owner 2026-10-17).
    const otherless =
      ctx.chooser?.chooser.other && !ctx.chooser.chooser.afterOther && !ctx.previous
        ? ctx.chooser
        : undefined;
    const otherOffer = otherless && (await offersOther(rt, ctx.live, otherless));
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    // A passkey page carries the list and entry it would be announced with otherwise
    // (ADR 0053); only a plain sign-in page counts as such below.
    const plain = ctx.signIn?.passkey ? undefined : ctx.signIn;
    const otherShown = otherless && plain?.path === ctx.live.path ? otherless : undefined;
    // Logged only for a shown form: the list may still show on this path.
    if (
      otherShown &&
      (otherOffer === "sending" || otherOffer === "sent" || otherOffer === "not-connected")
    )
      skipGeneration(rt, ctx.live, otherOffer, "other");
    if (otherShown && otherOffer === true) {
      // Nor is the page right after a sign-in, nor one of a paused site (ADR 0062).
      if (ctx.paused) skipGeneration(rt, ctx.live, "paused", "other");
      else if (rt.afterSignIn.get(ctx.document.tabId) === ctx.document.documentId)
        skipGeneration(rt, ctx.live, "after-sign-in", "other");
      // Nor a page whose list shows meanwhile: the login clicks there (ADR 0028).
      else if (await showsNow(rt, ctx.live, listReadiness(rt, otherShown))) {
        if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
        skipGeneration(rt, ctx.live, "list-shown", "other");
      } else {
        let missed: [GenerationMiss, (string | undefined)?] = ["vault-unavailable", "error"];
        const scope = await generationSlotsFor(rt, ctx.live, (...reason) => {
          missed = reason;
        }).catch(() => undefined);
        if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
        if (scope) {
          ctx.live.state = "generating";
          delete ctx.live.reason;
          await publish(rt, ctx.live);
          void generateFor(rt, ctx.live, scope, undefined, otherShown);
          return { ok: false, reason: "generating" };
        }
        skipGeneration(rt, ctx.live, missed[0], "other", missed[1]);
      }
    }
    const availability = ctx.recipe ? undefined : await offersGeneration(rt, ctx.live);
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    let offer = availability === true;
    // A paused site sends no page for generation (ADR 0062).
    if (offer && ctx.paused) {
      skipGeneration(rt, ctx.live, "paused");
      offer = false;
    }
    // Only a page that was sent is held, so the log says why it is not sent again.
    if (availability === "sending" || availability === "sent")
      skipGeneration(rt, ctx.live, availability);
    // Without the service no page is sent; logged at debug level, as every page is.
    if (availability === "not-connected") skipGeneration(rt, ctx.live, availability);
    const shownList = !plain && ctx.list?.path === ctx.live.path ? ctx.list : undefined;
    const listing = shownList && (shownList.names || !shownList.missed) ? shownList : undefined;
    // A page whose URL names another path of its site may be sent as a sign-in entry
    // once no sign-in input showed (ADR 0031); a list of accounts goes first.
    const entryPage =
      offer &&
      (namesReturnPath(new URL(ctx.live.url), sameSiteAs(ctx.live.url)) ||
        (await switchingTab(rt, ctx.live)))
        ? true
        : undefined;
    const entryOffer = !plain && ctx.entryHello?.path === ctx.live.path;
    // A page with a passkey button is sent as a passkey-only page when a matching item
    // holds a discoverable passkey; otherwise the entry it also shows is handled below as
    // on a page without the button, logged as such (ADR 0053, owner 2026-10-19 22:44 UTC).
    // With an entry to use instead, every matching item must hold one: the recipe is
    // shared, and an item without a passkey could not run it. A list of accounts beside the
    // button is sent as a list, which carries the button for the chooser's passkey route
    // (ADR 0079, owner 2026-10-25), and says nothing of the items' passkeys; the button
    // alone is sent only when the list is not, as a heading read as names no item has.
    const passkeyPage =
      offer && ctx.signIn?.passkey && ctx.signIn.path === ctx.live.path ? true : undefined;
    const passkeyOnly = async (
      fallback: boolean,
      every = fallback,
    ): Promise<Readiness | undefined> => {
      // Nor is the page right after a sign-in sent as a passkey-only page.
      if (rt.afterSignIn.get(ctx.document.tabId) === ctx.document.documentId) {
        if (!fallback) {
          skipGeneration(rt, ctx.live, "after-sign-in");
          offer = false;
        }
        return undefined;
      }
      let missed: [GenerationMiss, (string | undefined)?] = ["vault-unavailable", "error"];
      const scope = await generationSlotsFor(
        rt,
        ctx.live,
        (...reason) => {
          missed = reason;
        },
        every ? "every" : "some",
      ).catch(() => undefined);
      if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
      if (scope) {
        ctx.live.state = "generating";
        delete ctx.live.reason;
        await publish(rt, ctx.live);
        void generateFor(rt, ctx.live, scope, undefined, undefined, true);
        return { ok: false, reason: "generating" };
      }
      if (!fallback) {
        skipGeneration(rt, ctx.live, missed[0], undefined, missed[1]);
        offer = false;
      }
      return undefined;
    };
    if (passkeyPage && !listing) {
      const sent = await passkeyOnly(entryOffer);
      if (sent) return sent;
    }
    // A shown email address that is no list entry is logged only (ADR 0028).
    if (offer && shownList?.missed)
      skipGeneration(rt, ctx.live, "not-a-list", undefined, shownList.missed);
    // A list announced only for the log is never sent, but may hold the site's entry.
    if (shownList && !listing && !entryOffer) offer = false;
    // The page right after a sign-in is never sent as a list of accounts (ADR 0028) or as
    // a sign-in entry.
    if (offer && listing && rt.afterSignIn.get(ctx.document.tabId) === ctx.document.documentId) {
      // Logged for a list with an email, one with a control for another account, or an
      // offered entry only: short texts alone are ordinary browsing.
      if (!listing.names || listing.other || entryOffer)
        skipGeneration(rt, ctx.live, "after-sign-in");
      offer = false;
    }
    // Nor while another tab's login of the origin authenticated within the hour, as on a
    // signed-in dashboard listing the site's accounts by email opened in a new tab, unless
    // the tab asks for an account (ADR 0028, owner 2026-10-17).
    if (
      offer &&
      listing &&
      !ctx.ask &&
      signedInElsewhere(rt, ctx.document.tabId, ctx.document.origin)
    ) {
      if (!listing.names || listing.other || entryOffer)
        skipGeneration(rt, ctx.live, "signed-in-elsewhere");
      offer = false;
    }
    // Nor as a page that asks for an identifier alone (ADR 0016), such as a profile page
    // with an email field.
    if (
      offer &&
      ctx.signIn?.identifier &&
      rt.afterSignIn.get(ctx.document.tabId) === ctx.document.documentId
    ) {
      skipGeneration(rt, ctx.live, "after-sign-in");
      offer = false;
    }
    if (offer && (plain?.path === ctx.live.path || listing)) {
      let missed: [GenerationMiss, (string | undefined)?] = ["vault-unavailable", "error"];
      const scope = await generationSlotsFor(rt, ctx.live, (...reason) => {
        missed = reason;
      }).catch(() => undefined);
      if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
      // Without an email listed, a shown text must name a matching item's username. A
      // list on a page whose path holds one is not sent: the page would be refused as
      // `username-shown` once read (owner 2026-10-12 19:45 UTC).
      const listed =
        scope && listing
          ? await listedNames(
              rt,
              ctx.live.document.origin,
              scope,
              listing.names ?? [],
              rawPath(ctx.live),
            )
          : undefined;
      if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
      const names = listing?.names ? listed?.names : undefined;
      // Or the page shows a control to sign in with another account (ADR 0028, owner
      // 2026-10-12 19:11 UTC), as Instagram's list of a profile whose username is not the
      // item's: then every shown text is hidden from the page sent, as a possible account
      // name, and the login continues through that control.
      const otherOnly =
        !names?.length && listing?.names && listing.other ? listing.names : undefined;
      // A list by email lists no account a matching item's username that is not an email
      // can be chosen by: it is sent only for its control for another account.
      const unmatched = listing && !listing.names && !listing.other && listed?.email === false;
      if (
        scope &&
        !listed?.inPath &&
        !unmatched &&
        (!listing?.names || names?.length || otherOnly)
      ) {
        ctx.live.state = "generating";
        delete ctx.live.reason;
        await publish(rt, ctx.live);
        void generateFor(
          rt,
          ctx.live,
          scope,
          listing ? { names: otherOnly ?? names ?? [] } : undefined,
        );
        return { ok: false, reason: "generating" };
      }
      // A passkey page whose shown texts name no item's account is sent for its button
      // alone (ADR 0053, ADR 0079), which asks for no slot, so also without the list's
      // scope; otherwise it is logged as for the list alone.
      if (passkeyPage && listing?.names && !listed?.inPath && !names?.length && !otherOnly) {
        const sent = await passkeyOnly(true, entryOffer);
        if (sent) return sent;
      }
      // No vault item matches this page, the vault could not tell, or no shown text names
      // an item's username, so it is not sent. A page offered only by its short texts is
      // mostly ordinary browsing, so that is logged at debug level (ADR 0019): most pages
      // show a short text beside a button. Such a page may still hold the site's sign-in
      // entry.
      if (listed?.inPath)
        skipGeneration(rt, ctx.live, "no-listed-account", undefined, "username-in-path");
      else if (unmatched)
        skipGeneration(rt, ctx.live, "no-listed-account", undefined, "no-email-username");
      else if (!listing?.names) skipGeneration(rt, ctx.live, missed[0], undefined, missed[1]);
      else
        skipGeneration(
          rt,
          ctx.live,
          "no-listed-account",
          undefined,
          scope
            ? (listing.otherMiss ?? "no-name-match")
            : logCode(missed.filter(Boolean).join(":")),
        );
      // A page whose path holds a username is not sent as a sign-in entry either.
      if (listed?.inPath || !(listing?.names && entryOffer)) offer = false;
    }
    if (offer && entryOffer) {
      const offered = entryPage
        ? await entryOfferRefusal(rt, ctx.live)
        : { refusal: "no-return-target" };
      if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
      if ("matched" in offered) {
        ctx.live.state = "generating";
        delete ctx.live.reason;
        await publish(rt, ctx.live);
        void generateEntryFor(rt, ctx.live, offered.matched);
        return { ok: false, reason: "generating" };
      }
      skipGeneration(rt, ctx.live, offered.refusal, "entry");
      offer = false;
    }
    // A page offered for generation that showed nothing to send by the end of the step
    // wait is logged with why; mostly ordinary browsing, so at debug level (ADR 0019).
    // The tab's next document after a submitted password form is known only here. A page
    // that looks like a verification but is never sent, a secret answer of `type="text"` or
    // a frame, is counted by reason at info level when a vault item matches it, as it
    // would for a page that is sent (ADR 0035).
    // A secret answer on the tab's next document after a password submit is part of that
    // sign-in, so it is not counted.
    const framed = availability === "frame";
    const afterSubmit = rt.afterSignIn.get(ctx.document.tabId) === ctx.document.documentId;
    const unsendable =
      ctx.unoffered?.path === ctx.live.path &&
      ((offer && ctx.unoffered.why === "text-answer" && !afterSubmit) ||
        (framed && ctx.unoffered.why === "frame"))
        ? ctx.unoffered.why
        : undefined;
    let counted = false;
    if (unsendable) {
      counted = (await generationSlotsFor(rt, ctx.live).catch(() => undefined)) !== undefined;
      if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
      if (counted) skipGeneration(rt, ctx.live, unsendable);
    }
    if (
      !counted &&
      offer &&
      ctx.unoffered?.path === ctx.live.path &&
      !ctx.signIn &&
      !shownList &&
      !entryOffer
    )
      skipGeneration(
        rt,
        ctx.live,
        "nothing-offered",
        undefined,
        (ctx.unoffered.why === "no-list" || ctx.unoffered.why === "text-answer") && afterSubmit
          ? "after-sign-in"
          : ctx.unoffered.why,
      );
    // No recipe of the origin and no login in the tab: ordinary browsing (ADR 0019).
    if (!ctx.recipe && !starts.length && !offer) {
      const refused = await ctx.refuse("recipe-not-found", undefined, true);
      return framed ? { ...refused, frame: true as const } : refused;
    }
    // Only an origin with a recipe: elsewhere every sign-in page would be logged.
    if (starts.length) ctx.notStarted(ctx.recipe ? "first-step-missing" : "no-recipe-on-path");
    // A generated recipe's own start page that misses its first steps may be stale
    // (ADR 0041).
    if (
      ctx.recipe &&
      !ctx.chooser &&
      !ctx.later &&
      !(probeMode && ctx.live.document.origin === rt.vars.origin) &&
      ctx.shown?.path === ctx.live.path
    )
      void repairStale(rt, ctx.live, ctx.recipe, ctx.shown.miss, ctx.shown.accounts).catch(
        () => undefined,
      );
    ctx.live.state = "watching";
    delete ctx.live.reason;
    await publish(rt, ctx.live);
    return {
      ok: false,
      reason: ctx.recipe ? "form-not-ready" : "recipe-not-found",
      starts,
      ...(offer || (otherOffer === true && !ctx.paused) ? { generate: true as const } : {}),
      ...(offer && entryPage ? { entry: true as const } : {}),
      ...(framed ? { frame: true as const } : {}),
    };
  }

  // A resumed attempt keeps its own recipe revision; a replaced or different recipe never
  // takes it over. A newer revision that only adds handlers or markers is taken over
  // when this worker still holds the recorded one to compare (ADR 0027); after a restart
  // only the recorded revision resumes.
  ctx.revised = false;

  let replaced = false;

  if (
    ctx.previous &&
    ctx.recipe &&
    ctx.previous.recipeId === ctx.recipe.id &&
    ctx.previous.recipeRevision !== ctx.recipe.revision
  ) {
    const known = rt.attempts.get(ctx.document.tabId);
    const held =
      known?.metadata.id === ctx.previous.id &&
      known.recipe.id === ctx.previous.recipeId &&
      known.recipe.revision === ctx.previous.recipeRevision
        ? known.recipe
        : undefined;
    // A cache that lags behind the attempt keeps the attempt's own recipe.
    if (held && ctx.recipe.revision < held.revision) ctx.recipe = held;
    else if (held && extendsRecipe(held, ctx.recipe)) ctx.revised = true;
    // A revision that continues the recipe after its final advance is taken over on the
    // page, after the same checks as an answer to the continuation (ADR 0018); until then
    // the attempt keeps its own revision.
    else if (
      held &&
      ctx.previous.operationEffect === "advance" &&
      ctx.previous.stepIndex + 1 === ctx.previous.stepCount &&
      continuesRecipe(held, ctx.recipe)
    )
      ctx.recipe = held;
    else {
      ctx.recipe = undefined;
      replaced = true;
    }
  }

  if (
    !ctx.recipe ||
    ctx.recipe.origin !== ctx.document.origin ||
    (ctx.previous && ctx.previous.recipeId !== ctx.recipe.id)
  ) {
    // A resumed login its recipe no longer runs ends here: a revision replaced its own, or
    // after a restart is one this worker cannot compare, or the recipe or its layout was
    // withdrawn. Left running, every later page of the tab would resume it and be refused,
    // the recipe's first step included, until the tab closed. It moves to this page and
    // stops as under other settings, so it never submits again; the rules for a stopped
    // login apply from the tab's next page on (ADR 0021 D, ADR 0022). A lookup that could
    // not read the recipes leaves it to resume (owner, 2026-10-23).
    const ends =
      ctx.previous &&
      !(probeMode && ctx.document.origin === rt.vars.origin) &&
      (replaced ||
        // A chooser login's chooser no longer has the route of its click: a revision
        // dropped it, as the one the login ran had it.
        (ctx.previous.chooser !== undefined && ctx.chooser !== undefined && !ctx.recipe) ||
        (!ctx.recipe &&
          (await rt.recipes
            .withdrawn?.(ctx.document.origin, ctx.previous.recipeId, ctx.previous.layout)
            .catch(() => false))));
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    const latest = ends ? recordFor(rt, ctx.document.tabId, ctx.document.origin) : undefined;
    if (latest && latest.id === ctx.previous?.id && !terminal(latest)) {
      const run = rt.attempts.get(ctx.document.tabId);
      const own = run?.metadata.id === latest.id ? run : undefined;
      let ended = transitionLoginAttempt(own?.metadata ?? recoverLoginAttempt(latest), {
        type: "NAVIGATED",
        document: ctx.document,
      });
      if (!terminal(ended)) ended = transitionLoginAttempt(ended, { type: "POLICY_CHANGED" });
      if (own) own.metadata = ended;
      rt.continuations.delete(ended.id);
      reportAttempt(rt, ended, own?.recipe, { cause: "recipe-changed" });
      try {
        await keep(rt, ended);
      } catch {
        return ctx.refuse("storage-unavailable");
      }
      // A conditional request of the page waits for how this login ends (ADR 0034).
      reviewRequests(rt);
      if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    }
    return ctx.refuse("recipe-not-found");
  }

  return admitStart(rt, ctx as AdmitStartContext);
}
