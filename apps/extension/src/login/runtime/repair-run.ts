import * as v from "valibot";
import {
  loginStepEffect,
  recipeStartSteps,
  type LoginChooserRecipe,
  type LoginRecipe,
  type LoginRoute,
  type LoginEntryRecipe,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import { entryCheckResultSchema, type StartMiss } from "../wire";
import { classifyStartMiss } from "../repair";
import { type LiveDocument, type Execution, type GenerationMiss } from "./types";
import { frameKey } from "./steps";
import { report, send, publish } from "./attempt";
import {
  type RecipeRepairClaim,
  type GenerationOutcome,
  type EntryGenerationOutcome,
} from "./report";
import { note, generateFor } from "./generation";
import { restartForRequest } from "./passkey";
import { showsAnyMarker } from "./markers";
import { generationSlotsFor } from "./generation-scope";
import { vaultMatches, generateEntryFor } from "./entry-press";
import { tabAttempt } from "./hold";
import { terminal } from "./attempt-state";
import type { Runtime } from "./state";

/**
 * Sends the start page of a new login's recipe the chosen item cannot run for repair (ADR
 * 0058 A, amended by ADR 0041), at most once per recipe and missing route in 3 days on
 * this device. The
 * service's recipes are pulled first: a newer revision, as after another device's repair,
 * is tried before any model call, and the page announces again for it. A repair that adds
 * the route the item needs answers a recipe, and the page announces again and starts it;
 * anything else refuses the page with the plan's own reason.
 */
export async function repairUnfit(
  rt: Runtime,
  live: LiveDocument,
  recipe: LoginRecipe,
  refusal: { reason: string; detail?: string; route: LoginRoute },
): Promise<void> {
  const key = frameKey(live.document);
  if (rt.generation?.pullRecipes) {
    await rt.generation.pullRecipes().catch(() => undefined);
    if (rt.documents.get(key) !== live) return;
    const latest = await Promise.resolve(
      rt.recipes.recipe(live.document.origin, live.path, recipe.id),
    ).catch(() => undefined);
    if (rt.documents.get(key) !== live) return;
    if (latest && latest.revision > recipe.revision) {
      report(rt, live.document, {
        type: "unfit",
        tabId: live.document.tabId,
        origin: live.document.origin,
        recipeId: recipe.id,
        recipeRevision: recipe.revision,
        route: refusal.route,
        outcome: "newer",
        detail: refusal.detail ?? refusal.reason,
      });
      await browser.tabs
        .sendMessage(
          live.document.tabId,
          { version: 1, type: "login.reconnect" },
          { frameId: live.document.frameId, documentId: live.document.documentId },
        )
        .catch(() => undefined);
      return;
    }
  }
  // A passkey-only recipe's page (ADR 0053) is sent only as a sign-in form it shows by
  // now: without a sign-in or identifier input, as with the button alone or beside an
  // entry or a list, it gives the missing route nothing to send, so it is refused at
  // once, after one read, with no claim (owner, 2026-10-25).
  const formShows =
    recipe.passkeyOnly &&
    v.safeParse(
      entryCheckResultSchema,
      await send(rt, live, { type: "login.entry.check", starts: [], timeoutMs: 0 }).catch(
        () => undefined,
      ),
    );
  if (rt.documents.get(key) !== live) return;
  const claim: RecipeRepairClaim =
    formShows && !(formShows.success && formShows.output.signIn)
      ? { outcome: "not-due", reason: "no-form" }
      : await Promise.resolve()
          .then(() => rt.generation!.claimRepair!(recipe.id, refusal.route))
          .catch((): RecipeRepairClaim => ({ outcome: "not-sent", reason: "error" }));
  report(rt, live.document, {
    type: "unfit",
    tabId: live.document.tabId,
    origin: live.document.origin,
    recipeId: recipe.id,
    recipeRevision: recipe.revision,
    route: refusal.route,
    outcome: claim.outcome,
    ...("reason" in claim && claim.reason ? { reason: claim.reason } : {}),
    detail: refusal.detail ?? refusal.reason,
  });
  let answer: GenerationOutcome | EntryGenerationOutcome | undefined;
  if (claim.outcome === "claimed") {
    answer = rt.documents.get(key) === live ? await sendRepair(rt, live, recipe) : undefined;
    // Only a request that reached the model keeps its claim. A recipe more than one
    // revision on was answered without a call, as the cache was behind: it is tried as it
    // is, and repaired in turn if it still lacks the route.
    if (
      !answer ||
      answer.outcome === "skipped" ||
      ("retry" in answer && answer.retry) ||
      (answer.outcome === "recipe" && answer.recipe.revision > recipe.revision + 1)
    )
      await claim.release().catch(() => undefined);
  }
  // A recipe answered has asked the page to announce again (`generateFor`).
  if (rt.documents.get(key) !== live || answer?.outcome === "recipe") return;
  note(rt, live.document, live.url, refusal.reason, refusal.detail);
  live.state = "denied";
  live.reason = refusal.reason;
  await publish(rt, live);
  // A request of the page that came meanwhile starts the login now.
  restartForRequest(rt, live);
}

/**
 * Sends a generated recipe's start page to be repaired once it showed a sign-in input for
 * the step wait without a ready first step and the miss counts as stale (ADR 0041,
 * proposed): only the tab's own page on the recipe's start path, with a vault item that
 * matches it as for a first page, once per document and recipe revision. The service adds
 * a layout for the page beside the recipe's others, and the page announces again and
 * starts it, as after a first page.
 */
export async function repairStale(
  rt: Runtime,
  live: LiveDocument,
  recipe: LoginRecipe,
  miss: StartMiss | undefined,
  /** The page lists accounts by email instead of asking for a sign-in (ADR 0041 section 6). */
  accounts?: true,
): Promise<void> {
  if (!rt.repairs || !rt.generation || live.document.frameId !== 0 || live.topUrl) return;
  if (!recipe.id.startsWith("gen-")) return;
  const key = frameKey(live.document);
  // Every layout's first steps on the path (ADR 0060): a page that shows one layout's
  // elements, only not usable yet, is no stale page.
  const layouts = await Promise.resolve(
    rt.recipes.layouts?.(live.document.origin, live.path),
  ).catch(() => undefined);
  if (rt.documents.get(key) !== live) return;
  const firstSteps = (layouts?.length ? layouts.map((entry) => entry.recipe) : [recipe])
    .flatMap((layout) => recipeStartSteps(layout))
    .filter((step) => step.path === live.path);
  if (!firstSteps.length) return;
  const log = repairLog(rt, live, recipe);
  const verdict = classifyStartMiss(firstSteps, miss);
  if (verdict !== "stale") {
    log("skipped", verdict);
    return;
  }
  // A page that shows the account is signed in is no stale start page, though it may hold
  // an email input, as a profile form: the tab's next page after a submitted password
  // form, or one where a signed-in marker one of the recipe's layouts learned shows.
  if (rt.afterSignIn.get(live.document.tabId) === live.document.documentId) {
    log("skipped", "after-sign-in");
    return;
  }
  if (await showsAnyMarker(rt, live, recipe)) {
    if (rt.documents.get(key) === live) log("skipped", "signed-in");
    return;
  }
  if (rt.documents.get(key) !== live) return;
  await sendRepair(rt, live, recipe, accounts ? { kind: "list" } : {});
}

/**
 * Sends the page where a generated recipe's later step did not show for repair (ADR 0041
 * section 4, proposed): a top-frame `password` login of the layout's own steps, with no
 * other variant or handler, whose `advance` reached the step's path, where the step's
 * elements never showed.
 */
export async function repairLaterStep(rt: Runtime, run: Execution, step: number): Promise<void> {
  const { live, recipe, metadata } = run;
  const before = recipe.steps[step - 1];
  if (
    !rt.repairs ||
    !rt.generation ||
    live.document.frameId !== 0 ||
    live.topUrl ||
    !recipe.id.startsWith("gen-") ||
    recipe.layout === undefined ||
    run.chooser ||
    metadata.route !== "password" ||
    (metadata.variant ?? 0) !== 0 ||
    metadata.handlers.length ||
    recipe.alternatives ||
    recipe.passkeyOnly ||
    !before ||
    !recipe.steps[step] ||
    loginStepEffect(before) !== "advance" ||
    rt.documents.get(frameKey(live.document)) !== live
  )
    return;
  await sendRepair(rt, live, recipe, { later: { layout: recipe.layout, step } });
}

/**
 * Sends a generated chooser's list for repair (ADR 0041 section 6, owner 2026-10-23 13:03
 * UTC) when the list of accounts shows but a button the chooser names does not: only the
 * tab's own page, once per document and chooser revision, as a start page's.
 */
export async function repairChooser(
  rt: Runtime,
  live: LiveDocument,
  chooser: LoginChooserRecipe,
): Promise<void> {
  if (!rt.repairs || !rt.generation || live.document.frameId !== 0 || live.topUrl) return;
  if (!chooser.id.startsWith("gen-") || rt.documents.get(frameKey(live.document)) !== live) return;
  await sendRepair(rt, live, chooser, { kind: "list", during: true });
}

/**
 * Sends a generated entry recipe's page for repair (ADR 0041 section 6) when its link no
 * longer shows on a page the site sent the visitor to before signing in (`namesReturnPath`,
 * which the press checked first): as a form or a list of accounts when the page shows one
 * now, otherwise as an entry page. A load answered outside 2xx is not sent.
 */
export async function repairEntry(
  rt: Runtime,
  live: LiveDocument,
  recipe: LoginEntryRecipe,
  inspected: { shows?: "sign-in" | "accounts" | undefined; status?: number | undefined },
): Promise<void> {
  if (!rt.repairs || !rt.generation || live.document.frameId !== 0 || live.topUrl) return;
  if (!recipe.id.startsWith("gen-") || rt.documents.get(frameKey(live.document)) !== live) return;
  const { shows, status } = inspected;
  if (status !== undefined && (status < 200 || status > 299)) {
    repairLog(rt, live, recipe)("skipped", "status");
    return;
  }
  await sendRepair(rt, live, recipe, {
    kind: shows === "sign-in" ? "form" : shows === "accounts" ? "list" : "entry",
  });
}

/** Logs whether a page of the recipe was sent for repair (`recipe.repair`, ADR 0041). */
export function repairLog(
  rt: Runtime,
  live: LiveDocument,
  recipe: { id: string; revision: number },
) {
  return (outcome: "due" | "skipped", reason?: string) =>
    report(rt, live.document, {
      type: "repair",
      tabId: live.document.tabId,
      origin: live.document.origin,
      recipeId: recipe.id,
      recipeRevision: recipe.revision,
      outcome,
      ...(reason ? { reason } : {}),
    });
}

/**
 * Sends a stale page of a generated recipe for repair (ADR 0041), once per
 * document, unless the service already answered a repair of the recipe today: the start
 * page, or with `later` the page where a layout's later step did not show. Resolves to the
 * service's answer, or `undefined` when nothing was sent.
 */
export async function sendRepair(
  rt: Runtime,
  live: LiveDocument,
  recipe: { id: string; revision: number },
  page: {
    later?: { layout: string; step: number };
    /**
     * What the page is now (ADR 0041 section 6): a form (the default), a list of accounts
     * by email (ADR 0028) or a page with neither, sent as a sign-in entry (ADR 0031).
     */
    kind?: "form" | "list" | "entry";
    /** Sent from a login that keeps running, as on a chooser's list: its status stays. */
    during?: boolean;
  } = {},
): Promise<GenerationOutcome | EntryGenerationOutcome | undefined> {
  if (!rt.repairs) return undefined;
  const { later, kind = "form", during = false } = page;
  const key = frameKey(live.document);
  const log = repairLog(rt, live, recipe);
  const claim = await rt.repairs.due({
    recipeId: recipe.id,
    revision: recipe.revision,
    documentId: live.document.documentId,
  });
  if (rt.documents.get(key) !== live) return undefined;
  if (claim !== "due") {
    log("skipped", claim);
    return undefined;
  }
  // An entry page offers no slots, so only the matching items are read for it, for the
  // usernames it hides.
  let missed: GenerationMiss = "vault-unavailable";
  const scope =
    kind === "entry"
      ? undefined
      : await generationSlotsFor(rt, live, (reason) => {
          missed = reason;
        }).catch(() => undefined);
  const matched = kind === "entry" ? await vaultMatches(rt, live).catch(() => undefined) : scope;
  if (rt.documents.get(key) !== live) return undefined;
  if (!matched) {
    log("skipped", missed);
    return undefined;
  }
  // A start page whose form showed late may have started the recipe's login meanwhile: no
  // stale page.
  const running = tabAttempt(rt, live.document.tabId);
  if (!later && !during && running?.recipeId === recipe.id && !terminal(running)) {
    log("skipped", "running");
    return undefined;
  }
  log("due");
  // A later step's page keeps the stopped login's status, and a running login its own.
  if (!later && !during) {
    live.state = "generating";
    delete live.reason;
    await publish(rt, live);
  }
  let answer: GenerationOutcome | EntryGenerationOutcome | undefined;
  const repair = {
    recipeId: recipe.id,
    revision: recipe.revision,
    ...(later ? { later } : {}),
    // An answer without a new revision holds the recipe until the next UTC day: the
    // service spent this device's repair of the day on it, or refused for that limit. That
    // includes the current recipe answered back, as when the answer equals a layout the
    // page still misses. Another request in flight (`busy`), a page not sent, or one left
    // free to send again does not.
    done: (outcome: GenerationOutcome | EntryGenerationOutcome) => {
      const held =
        outcome.outcome === "unavailable"
          ? outcome.reason !== "busy"
          : outcome.outcome === "recipe"
            ? outcome.recipe.revision <= recipe.revision
            : outcome.outcome !== "skipped" && !("retry" in outcome && outcome.retry);
      if (held) void rt.repairs!.hold(recipe.id);
      answer = outcome;
    },
  };
  if (kind === "entry") await generateEntryFor(rt, live, matched, repair);
  else
    await generateFor(
      rt,
      live,
      scope!,
      kind === "list" ? { names: [] } : undefined,
      undefined,
      false,
      repair,
    );
  return answer;
}
