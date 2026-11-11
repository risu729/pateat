import {
  isGeneratedRecipeId,
  loginStepEffect,
  parseRecipeBranch,
  runsLogin,
  storedBranchRoute,
  isChooserDocument,
  isLoginRecipeDocument,
  type RecipeDocument,
  storedLoginRecipeSchema,
  storedRecipeStartPath,
  type ChooserBranch,
  type LoginChooserRecipe,
  type LoginRecipe,
  type RecipeGenerationRequest,
  type RecipeGenerationResult,
  type StoredLoginRecipe,
  type SyncRecipeChange,
  layoutRecipe,
  type RecipeLanguage,
} from "@pateat/contracts";
import {
  accountListGenerationInstructions,
  accountListGenerationPromptVersion,
  carriedSlotNames,
  createFieldMappingDecider,
  createRecipeGenerator,
  fieldDecisionPromptVersion,
  generationInstructions,
  generationPromptVersion,
  passkeyOnlyGenerationInstructions,
  passkeyOnlyGenerationPromptVersion,
  type FiniteChoiceModel,
} from "@pateat/inference";
import * as v from "valibot";
import {
  CLEF_LIMITS,
  CLEF_MIN_PROBABILITY,
  type GenerationBackend,
  type UnitSources,
  type UnsentRequest,
} from "../backend";
import { chooserRepairWrite, listPasskeyRoute, repairBase, repairWrite } from "../repair";
import {
  branchUnit,
  handlerUnit,
  LIST_UNIT,
  markerUnit,
  pageUnit,
  type RecipeUnit,
} from "../units";
import {
  type UnsentAnswer,
  roleConfig,
  answerUnsent,
  unavailable,
  failed,
  modelCall,
  active,
  answerable,
  unsettled,
} from "./responses";
import {
  MIN_GENERATION_RECIPE_ROOM_BYTES,
  generatedRecipeId,
  repairWindow,
  attemptWindow,
  sameRoute,
} from "./policy";
import { stored, newLayoutMeta, markWritten, buildLoginLayout } from "./layout";

/**
 * `POST /v1/recipes/generate`. Returns `undefined` when `base` names a recipe ID that is
 * not a generated one (`gen-…`), which the route answers as a bad request; a generated ID
 * of another origin or start path answers `recipe-conflict`.
 *
 * A page that lists accounts (ADR 0028) starts a chooser recipe; a page sent with a
 * `branch` is the next page of that chooser branch: its first, after the click on the
 * list, or a later one after an advance. Either answers with the chooser.
 */
export async function generateRecipe(
  backend: GenerationBackend,
  request: RecipeGenerationRequest,
): Promise<RecipeGenerationResult | undefined> {
  const { observation, slots, base, branch, passkeyOnly, signedIn, repair } = request;
  const { origin, path } = observation;
  // A first page starts its own recipe; a later page continues the one in `base`, and a
  // repair names the recipe whose page it is (ADR 0041).
  const recipeId = base?.recipeId ?? repair?.recipeId ?? (await generatedRecipeId(origin, path));
  if (!isGeneratedRecipeId(recipeId)) return undefined;
  // A start page's repair is of the recipe that starts on its path.
  if (repair && repair.layout === undefined && (await generatedRecipeId(origin, path)) !== recipeId)
    return undefined;
  const list = observation.accounts !== undefined;
  const headAtStart = await backend.readHead(recipeId);
  const attemptBranch = branch ?? "";
  // What the request log keeps of the request, sent or not (ADR 0012).
  const logged = {
    role: "generate",
    // Only a list of accounts gets the list line (ADR 0028), and a passkey-only page its
    // own instructions (ADR 0053).
    promptVersion: await (
      passkeyOnly
        ? passkeyOnlyGenerationPromptVersion
        : list
          ? accountListGenerationPromptVersion
          : generationPromptVersion
    )(),
    origin,
    path,
    request: {
      instructions: passkeyOnly
        ? passkeyOnlyGenerationInstructions
        : list
          ? accountListGenerationInstructions
          : generationInstructions,
      slots,
      ...(passkeyOnly ? { passkeyOnly } : {}),
      // The device's hint for the page's kind, sent to the model as well (ADR 0035).
      ...(signedIn === undefined ? {} : { signedIn }),
      observation,
    },
    // A recipe generated again after its revocation has a tombstone but no base: its page
    // starts the recipe, as a new one's does.
    recipe: {
      recipeId,
      branch: attemptBranch,
      baseRevision: headAtStart?.revision ?? 0,
      page: base || repair?.layout !== undefined ? "continuation" : "first",
    },
  } satisfies UnsentRequest;
  const unsent = (answer: Extract<RecipeGenerationResult, UnsentAnswer>) =>
    answerUnsent(backend, logged, answer);
  if (!observation.complete) return unsent(failed("incomplete-observation"));
  // A list of accounts is only ever a recipe's first page.
  if (list && base) return unsent(failed("invalid-request"));
  // Only a layout's own route replaces its final click, never a chooser branch's (ADR 0018).
  const replacesLast = base?.replacesLast === true;
  if (replacesLast && branch !== undefined && parseRecipeBranch(branch)?.branch !== undefined)
    return unsent(failed("invalid-request"));
  /** Whether a stored recipe is the one generated for this origin under this ID. */
  const generatedHere = async (recipe: StoredLoginRecipe) =>
    recipe.origin === origin &&
    recipe.id === recipeId &&
    (await generatedRecipeId(origin, storedRecipeStartPath(recipe))) === recipeId;
  // The layout a continuation names (ADR 0060), and the chooser branch it takes, if any.
  const named = branch === undefined ? undefined : parseRecipeBranch(branch);
  const chooserSide: ChooserBranch | undefined = named?.branch;
  /**
   * Whether a stored recipe holds the kind this request writes: a list of accounts, or
   * layouts of a sign-in form. A recipe may hold both (ADR 0028, ADR 0060).
   */
  const fits = (recipe: StoredLoginRecipe) =>
    list || chooserSide ? isChooserDocument(recipe) : isLoginRecipeDocument(recipe);

  /**
   * What the stored head means for this request: an answer without a model call, or the
   * route to continue (`undefined` for a first page) with the chooser it belongs to for a
   * branch. Checked again once the request holds a call slot.
   */
  const decide = async (
    head: SyncRecipeChange | null,
  ): Promise<
    | { answer: Extract<RecipeGenerationResult, { status: "recipe" | "unavailable" }> }
    | {
        base: LoginRecipe | undefined;
        chooser?: LoginChooserRecipe;
        revoked?: number;
        /**
         * For a repair: the recipe whose layouts it adds to, or for a start page whose kind
         * changed, the recipe it replaces (ADR 0041).
         */
        repaired?: StoredLoginRecipe;
        /** For a later step's repair: the language of the layout it continues. */
        language?: RecipeLanguage | undefined;
      }
  > => {
    // A repair adds a layout to the active recipe at the revision it names (ADR 0041). A
    // newer revision answers as it is, as after another device's repair: the device tries
    // that one first. A start page is taken as it is now, a form or a list of accounts,
    // whatever kind the recipe was: a login, chooser or entry recipe (owner, 2026-10-23
    // 13:03 UTC); a later step's page continues a login recipe's layout.
    if (repair) {
      if (head?.state === "revoked") return { answer: unavailable("recipe-revoked") };
      const current = active(head);
      const answer = answerable(head);
      if (!current || !(await generatedHere(current.recipe)))
        return { answer: unavailable("recipe-conflict") };
      if (repair.layout !== undefined && !isLoginRecipeDocument(current.recipe))
        return { answer: unavailable("recipe-conflict") };
      if (current.revision !== repair.revision)
        return answer
          ? { answer: { version: 1, status: "recipe", change: answer } }
          : { answer: unavailable("recipe-conflict") };
      if (!(await backend.hasRecipeByteRoom(MIN_GENERATION_RECIPE_ROOM_BYTES)))
        return { answer: unavailable("recipe-limit") };
      const repaired = current.recipe;
      if (repair.layout === undefined || !isLoginRecipeDocument(repaired))
        return { base: undefined, repaired };
      // A later step's page continues the layout cut before the step that did not show.
      const stale = repaired.layouts.find((layout) => layout.key === repair.layout);
      const cut = stale && repairBase(layoutRecipe(repaired, stale), repair.step!);
      if (!stale || !cut) return { answer: unavailable("recipe-conflict") };
      return { base: cut, repaired, language: stale.language };
    }
    // A revoked recipe is generated again from its first page, as the revision after its
    // tombstone (owner, 2026-10-12); a later page never continues it.
    if (head?.state === "revoked") {
      if (base) return { answer: unavailable("recipe-revoked") };
      return (await backend.hasRecipeRoom()) &&
        (await backend.hasRecipeByteRoom(MIN_GENERATION_RECIPE_ROOM_BYTES))
        ? { base: undefined, revoked: head.revision }
        : { answer: unavailable("recipe-limit") };
    }
    const current = active(head);
    // Only the recipe generated here answers; a device write under the ID cannot redirect it.
    if (current && !(await generatedHere(current.recipe)))
      return { answer: unavailable("recipe-conflict") };
    // An entry recipe (ADR 0031), a chooser for a form or a route recipe for a list of this
    // origin and path is no recipe to answer with.
    const answer = answerable(head);
    if (current && (!answer || !fits(answer.recipe)))
      return { answer: unavailable("recipe-conflict") };
    if (answer && (!base || answer.revision !== base.revision))
      // Another device already generated it, or appended this page first: use that.
      return { answer: { version: 1, status: "recipe", change: answer } };
    // A first page adds a recipe, so the owner needs room for one before any model call.
    if (!base)
      return (await backend.hasRecipeRoom()) &&
        (await backend.hasRecipeByteRoom(MIN_GENERATION_RECIPE_ROOM_BYTES))
        ? { base: undefined }
        : { answer: unavailable("recipe-limit") };
    if (!current) return { answer: unavailable("recipe-conflict") };
    if (!(await backend.hasRecipeByteRoom(MIN_GENERATION_RECIPE_ROOM_BYTES)))
      return { answer: unavailable("recipe-limit") };
    // The layout the login ran, and its chooser for a branch; one the head no longer has, as
    // after its revocation from the management page, is not continued.
    const resolved = branch === undefined ? undefined : storedBranchRoute(current.recipe, branch);
    if (!resolved) return { answer: unavailable("recipe-conflict") };
    const { route, chooser } = resolved;
    // The other branch starts only with the chooser's button for it, and the passkey route
    // beside the list (ADR 0079) is stored whole, never generated as a branch's page.
    if (
      (chooserSide === "other" && !chooser?.chooser.other) ||
      (chooserSide === "passkey" && chooser)
    )
      return { answer: unavailable("recipe-conflict") };
    // A branch's first page has nothing to continue yet.
    if (chooser && !route) return { base: undefined, chooser };
    const last = route?.steps.at(-1);
    if (
      !route ||
      route.completion ||
      !last ||
      loginStepEffect(last) !== "advance" ||
      (replacesLast && last.kind !== "click")
    )
      return { answer: unavailable("recipe-conflict") };
    return { base: route, ...(chooser ? { chooser } : {}) };
  };
  /** The revision a decision's write replaces, which keys its attempt. */
  const revisionOf = (decision: {
    base?: LoginRecipe | undefined;
    chooser?: LoginChooserRecipe | undefined;
    revoked?: number | undefined;
    repaired?: StoredLoginRecipe | undefined;
  }) =>
    decision.repaired?.revision ??
    decision.chooser?.revision ??
    decision.base?.revision ??
    decision.revoked ??
    0;
  const before = await decide(headAtStart);
  if ("answer" in before) return unsent(before.answer);
  const baseRecipe = before.base;
  const chooser = before.chooser;
  const repaired = before.repaired;
  // The attempt key and the write follow the revision the new one replaces.
  const baseRevision = revisionOf(before);
  // Every variant starts on the start page, so plan validation drops a continuation's
  // alternatives rather than failing a call that was already paid for, and names its
  // slots from the kept set alone. It drops the passkey sign-in button too, which becomes
  // the `passkey` route of a recipe's first page only. A chooser branch's pages all follow
  // the click on the list, so none of them is a start page.
  const startPage = baseRecipe === undefined && chooser === undefined;
  // A custom field the owner's saved bindings of this recipe already name keeps that name,
  // on any page (ADR 0027, amended 2026-10-19), so a recipe generated again after its
  // revocation still fits its bindings. Only names and field references are read, and the
  // prompt stays the same.
  const carriedNames =
    !list && slots.some((slot) => slot.fieldName !== undefined)
      ? carriedSlotNames(slots, await backend.bindingSlots(origin, recipeId))
      : new Map<string, string>();
  let raced: Extract<RecipeGenerationResult, { status: "recipe" | "unavailable" }> | undefined;
  // A first page starts the recipe's first layout (ADR 0060), keyed by when it was made and
  // in the page's language; only a repair adds another (ADR 0041). Its key is chosen before
  // the call, so the request log names the layout the answer creates.
  const meta = newLayoutMeta(observation.language, Date.now());

  // Another device may have stored this recipe while this request waited for a call slot.
  const recheck = async () => {
    const latest = await decide(await backend.readHead(recipeId));
    if ("answer" in latest) {
      raced = latest.answer;
      return "recipe-conflict" as const;
    }
    // A recipe generated and revoked meanwhile would make this call's write fail.
    return revisionOf(latest) !== baseRevision ? ("recipe-conflict" as const) : undefined;
  };

  const call = await backend.call({
    ...logged,
    device: request.deviceModel,
    // A repair's answer may merge into a layout or write nothing, so it names none.
    recipe: {
      ...logged.recipe,
      baseRevision,
      ...(base || repair ? {} : { layout: meta.key }),
    },
    // A repair is limited to one a UTC day per recipe and device instead of the page's retry
    // window (ADR 0041).
    ...(repair
      ? repairWindow(backend, { recipeId, baseRevision }, recheck)
      : attemptWindow(
          backend,
          { recipeId, branch: attemptBranch, origin, path, baseRevision },
          recheck,
          request.manual === true,
        )),
    invoke: (model) =>
      createRecipeGenerator({ model, ...roleConfig })({
        observation,
        slots,
        startPage,
        carriedNames,
        ...(passkeyOnly ? { passkeyOnly } : {}),
        ...(signedIn === undefined ? {} : { signedIn }),
      }),
    // Clef answers a sign-in form first (ADR 0083); a list of accounts, a passkey-only
    // page and a page the device saw signed in go to generation alone.
    ...(list || passkeyOnly || signedIn === true || slots.length === 0
      ? {}
      : {
          firstChoice: {
            promptVersion: await fieldDecisionPromptVersion(),
            invoke: (model: FiniteChoiceModel) =>
              createFieldMappingDecider({
                model,
                limits: CLEF_LIMITS,
                minProbability: CLEF_MIN_PROBABILITY,
              })({ observation, slots, startPage, carriedNames }),
          },
        }),
    logValue: (value) => {
      if ("accountList" in value)
        return {
          accountList: true,
          ...(value.other ? { other: value.other.candidate } : {}),
          ...(value.continue ? { continue: value.continue.candidate } : {}),
          ...(value.passkey ? { passkeyButton: value.passkey.candidate } : {}),
        };
      const { pageKind, irreversible, fields, action, accountSwitch, alternatives, passkeyButton } =
        value;
      return {
        // The answered kind and the evaluation answer, which no recipe keeps (ADR 0035).
        pageKind,
        irreversible,
        fields,
        action,
        ...(accountSwitch ? { accountSwitch } : {}),
        ...(passkeyButton ? { passkeyButton } : {}),
        ...(alternatives?.length
          ? {
              alternatives: alternatives.map((entry) => ({
                fields: entry.fields,
                action: entry.action,
              })),
            }
          : {}),
      };
    },
  });
  if (call.status === "unavailable") return unsent(raced ?? unavailable(call.reason));
  if (call.status === "device-call") return modelCall(call);
  const { logId, served } = call;
  /** The provenance of the units this call's write adds (ADR 0060). */
  const generated = (units: RecipeUnit[]): UnitSources => ({
    origin: "generated",
    units,
    served,
    promptVersion: call.promptVersion ?? logged.promptVersion,
    logId,
  });
  const result = unsettled(call.outcome);
  // A request the role refused locally, as one too large, was never sent; the roles refuse
  // locally only with a failure.
  if ("answer" in result)
    return call.outcome.calls === 0 && result.answer.status === "failed"
      ? unsent(result.answer)
      : result.answer;
  /**
   * Writes the recipe after `baseRevision` and answers with it, with `customSlots` when
   * given, or with what won the race: only the recipe this call wrote has a mapping to
   * answer with. A page lost to a write of another layout or of the chooser layout's
   * other branch, such as a judgement or a removal there, is written once more onto that
   * head, so the paid answer is kept. `units` are the units the page adds, recorded with
   * each write, the rebased one too (ADR 0060), and `copied` the rows a layout a repair
   * adds takes over from the layout it continues (ADR 0041).
   */
  const save = async (
    recipe: StoredLoginRecipe,
    units: RecipeUnit[],
    customSlots: { slot: string; offered: string }[] = [],
    rebase?: (head: SyncRecipeChange | null) => Promise<StoredLoginRecipe | undefined>,
    copied?: { from: string; to: string; units: string[]; branch?: ChooserBranch },
  ): Promise<RecipeGenerationResult> => {
    let next = recipe;
    let expectedRevision = baseRevision;
    for (let tries = 0; ; tries += 1) {
      // eslint-disable-next-line no-await-in-loop
      const written = await backend.writeRecipe(
        recipeId,
        { version: 1, state: "active", expectedRevision, recipe: next },
        { sources: generated(units), ...(copied ? { copied } : {}) },
      );
      if (written.ok) {
        // eslint-disable-next-line no-await-in-loop
        await backend.keepLogRevision(logId, written.change.revision);
        // eslint-disable-next-line no-await-in-loop
        if (branch !== undefined) await markWritten(backend, recipeId, branch);
        const change = answerable(written.change);
        if (!change) return unavailable("recipe-conflict");
        return {
          version: 1,
          status: "recipe",
          change,
          ...(customSlots.length ? { customSlots } : {}),
        };
      }
      if (written.limited) return unavailable("recipe-limit");
      // eslint-disable-next-line no-await-in-loop
      const moved = tries === 0 ? await rebase?.(written.current) : undefined;
      if (!moved) {
        // A write lost to another device answers with that device's recipe, as above.
        // eslint-disable-next-line no-await-in-loop
        const lost = await decide(written.current);
        return "answer" in lost ? lost.answer : unavailable("recipe-conflict");
      }
      next = moved;
      expectedRevision = moved.revision - 1;
    }
  };
  const { value } = result;
  // The role answers a list only for a list and a plan only for a form; checked again here.
  if ("accountList" in value !== list) return failed("invalid-output");
  // A recipe generated again follows its tombstone's revision.
  const revision = baseRevision + 1;
  /** A new recipe document, checked as devices check what they sync. */
  const document = (recipe: StoredLoginRecipe) =>
    v.is(storedLoginRecipeSchema, recipe) ? recipe : undefined;
  /** The current recipe as the answer to a repair that writes nothing. */
  const unchanged = async (): Promise<RecipeGenerationResult> => {
    const current = answerable(await backend.readHead(recipeId));
    return current
      ? { version: 1, status: "recipe", change: current }
      : unavailable("recipe-conflict");
  };
  if ("accountList" in value) {
    // The passkey button beside the list is the layout's passkey route (ADR 0079): a
    // passkey-only recipe whose start page became the list keeps its layout for the same
    // button, with what it learned.
    const passkey =
      value.passkey &&
      listPasskeyRoute(
        path,
        value.passkey.target,
        repaired && isLoginRecipeDocument(repaired) ? repaired : undefined,
      );
    const passkeyUnit = { layout: meta.key, unit: branchUnit("passkey", pageUnit(0)) };
    // The list becomes a chooser recipe with one layout and no branches; each branch is
    // generated once a login takes it (ADR 0028).
    const layout = {
      ...meta,
      ...(value.other ? { other: value.other.target } : {}),
      ...(value.continue ? { continue: value.continue.target } : {}),
      ...(passkey ? { passkey: passkey.route } : {}),
    };
    // A chooser's repaired list is a layout beside its others (ADR 0041).
    if (repaired && isChooserDocument(repaired)) {
      const uses = await backend.layoutUses(recipeId);
      const written = chooserRepairWrite(repaired, layout, (key) => uses?.get(key));
      if (written.kind === "same") return unchanged();
      const recipe = document(written.recipe);
      if (!recipe) return failed("recipe-invalid");
      const button = { ...passkeyUnit, layout: written.layout };
      return save(
        recipe,
        written.kind === "merged"
          ? [button]
          : [{ layout: written.layout, unit: LIST_UNIT }, ...(passkey ? [button] : [])],
      );
    }
    // A recipe whose start page showed a sign-in form keeps its layouts, and the list is
    // added beside them: the same URL shows either by the state of the browser's session
    // (ADR 0041 section 6, owner 2026-11-04). An entry recipe whose page became a list is
    // replaced by the chooser.
    // A recipe whose two kinds together would pass its slot or size limit takes the list
    // alone, as before the kinds were held together.
    const kept = repaired && isLoginRecipeDocument(repaired) ? repaired : undefined;
    const listOnly: RecipeDocument = {
      version: 1,
      id: recipeId,
      revision,
      origin,
      chooser: { path, layouts: [layout] },
    };
    const recipe = (kept && document({ ...listOnly, layouts: kept.layouts })) || document(listOnly);
    if (!recipe) return failed("recipe-invalid");
    // This call named the button again, so the passkey route's page is its own; a copied
    // layout's handlers and markers keep the calls that made them.
    const copiedFrom = passkey?.from;
    const route = passkey?.route;
    const learned = route
      ? [
          ...(route.handlers ?? []).map((_, index) => handlerUnit(index)),
          ...(route.completion ?? []).map((_, index) => markerUnit(index)),
        ]
      : [];
    return save(
      recipe,
      [{ layout: meta.key, unit: LIST_UNIT }, ...(passkey ? [passkeyUnit] : [])],
      undefined,
      undefined,
      copiedFrom !== undefined && learned.length
        ? { from: copiedFrom, to: meta.key, branch: "passkey", units: learned }
        : undefined,
    );
  }
  const built = buildLoginLayout(
    baseRecipe,
    {
      id: recipeId,
      origin,
      observation,
      slots,
      value,
      startPage,
      carriedNames,
      // The first page's kind (ADR 0035): a continuation keeps the layout's own, and every
      // page of a chooser branch follows a list of accounts, a sign-in page.
      pageKind: chooserSide ? "sign-in" : value.pageKind,
      ...(replacesLast ? { replacesLast: true } : {}),
    },
    meta,
  );
  if (!built.ok) return built.answer;
  const { customSlots } = built;
  const next = { ...built.recipe, revision };
  // A recipe of a list alone whose start page showed a form gets the form's layout beside
  // its list, and an entry recipe whose page became a form is replaced by a login recipe
  // (ADR 0041 section 6), unless the answer is no sign-in page.
  if (repaired && !isLoginRecipeDocument(repaired) && !runsLogin(next)) return unchanged();
  if (repaired && isLoginRecipeDocument(repaired)) {
    const uses = await backend.layoutUses(recipeId);
    // An answer that is no sign-in page, as a maintenance page answered 200 that kept an
    // input, would be a layout no login ever chooses (ADR 0035), holding one of the
    // recipe's places: it writes nothing, as a page a layout already matches.
    const written = runsLogin(next)
      ? repairWrite(repaired, next, {
          createdAt: meta.createdAt,
          language: repair?.layout === undefined ? meta.language : before.language,
          lastUsed: (key) => uses?.get(key),
          later: repair?.layout !== undefined,
          shown: observation.candidates.map((candidate) => candidate.target),
        })
      : ({ kind: "same" } as const);
    // A layout already does what the answer does, as on a page that was only slow: the
    // recipe stays as it is.
    if (written.kind === "same") return unchanged();
    const recipe = document(written.recipe);
    if (!recipe) return failed("recipe-invalid");
    // A start page's answer is its layout's start page, merged or new; a later step's is
    // the page after the stale layout's cut, whose earlier pages and handlers keep the
    // calls that made them.
    const stale = repair?.layout;
    const cut = stale === undefined ? undefined : baseRecipe;
    return save(
      recipe,
      [{ layout: written.layout, unit: pageUnit(cut?.steps.length ?? 0) }],
      customSlots,
      undefined,
      cut && stale !== undefined
        ? {
            from: stale,
            to: written.layout,
            units: [
              ...cut.steps.map((_, index) => pageUnit(index)),
              ...(cut.handlers ?? []).map((_, index) => handlerUnit(index)),
            ],
          }
        : undefined,
    );
  }
  if (!branch) {
    // A recipe whose two kinds together would pass its slot or size limit takes the form
    // alone, as before the kinds were held together.
    const held = repaired && isChooserDocument(repaired) ? repaired.chooser : undefined;
    const formOnly: RecipeDocument = {
      version: 1,
      id: recipeId,
      revision,
      origin,
      layouts: [built.layout],
    };
    const recipe = (held && document({ ...formOnly, chooser: held })) || document(formOnly);
    return recipe
      ? save(recipe, [{ layout: meta.key, unit: pageUnit(0) }], customSlots)
      : failed("recipe-invalid");
  }
  // A continuation goes back as the layout it continues, beside the head's others: the
  // head the decision read, which the recheck in the call slot found unchanged.
  const head = active(headAtStart);
  const written = head && stored(head.recipe, branch, next);
  if (!written || !named) return failed("recipe-invalid");
  // The page's steps follow the route's: a branch's first page starts at 0 (ADR 0060), and
  // a page that replaces the final click starts where that click stood (ADR 0018). A
  // rebased write keeps them, as it takes only a head whose route is still `baseRecipe`.
  const units = [
    {
      layout: named.layout,
      unit: branchUnit(
        chooserSide,
        pageUnit((baseRecipe?.steps.length ?? 0) - (replacesLast ? 1 : 0)),
      ),
    },
  ];
  return save(written, units, customSlots, async (latest) => {
    // A write of another layout, or of the chooser layout's other branch, meanwhile keeps
    // this page: only a head whose own route of the layout, or branch, is still the one
    // this page continues takes it.
    const current = active(latest);
    const resolved = current && storedBranchRoute(current.recipe, branch);
    if (
      !current ||
      !resolved ||
      !(await generatedHere(current.recipe)) ||
      !sameRoute(resolved.route, baseRecipe) ||
      (chooserSide === "other" && !resolved.chooser?.chooser.other)
    )
      return undefined;
    return stored(current.recipe, branch, { ...next, revision: current.revision + 1 });
  });
}
