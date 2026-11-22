import * as v from "valibot";
import { sameLoginDocument } from "@pateat/contracts";
import { newId } from "@pateat/contracts/ids";
import { ssoInspectResultSchema, stayAuthorizeSchema } from "../sso-operation-wire";
import { type Execution, type Sender } from "./types";
import { current, send } from "./attempt";
import { allowed } from "./plan-2";
import { destinationRefusal } from "./plan";
import { ssoChild } from "./sso-state";
import { moveUsername } from "./moves";
import { credentialSent, notJudged } from "./judge";
import { passkeyStepAnswered } from "./reconcile";
import { identify } from "./messages";
import type { Runtime } from "./state";

/** Whether this login pressed a stay-signed-in question, or was about to, in any document. */
const pressedBy = (rt: Runtime, run: Execution) =>
  rt.stayPresses.get(run.live.document.tabId) === run.metadata.id;

/**
 * Presses Yes on a stay-signed-in question a native login's page asks once the attempt sent
 * its credential, as the SSO flow does on an IdP's (ADR 0065 amendment of 2026-11-22, ADR
 * 0026): before the page would go to the judge, in the tab's page on the recipe's own
 * origin, for a login that is not watched (ADR 0027), has no stop (ADR 0036) and is no SSO
 * flow's IdP login, which that flow answers itself. The document reads the page as an IdP
 * page (`readSsoIdp`) with the login's own username, which never leaves it, and prepares
 * only a `stay-signed-in` reading's single Yes button; its destinations off the page's
 * origin must pass the login's own destination rule (ADR 0051), and the document checks the
 * page again, and asks `authorizeStay`, before the pointer events and before the click. At
 * most one press per attempt, so a question shown again goes to the judge, and the
 * document allows one too. Returns whether the button was pressed, also when the document
 * went away with the answer after its click was authorized; the page is then not judged
 * and nothing is learned from it, and the login goes on to its next page.
 */
export async function pressStaySignedIn(rt: Runtime, run: Execution): Promise<boolean> {
  const { metadata, recipe, live } = run;
  if (
    live.document.frameId !== 0 ||
    live.document.origin !== recipe.origin ||
    metadata.watch !== undefined ||
    metadata.settled === true ||
    metadata.stopAt !== undefined ||
    metadata.fillOnly === true ||
    metadata.signInFill === true ||
    ssoChild(rt.sso, metadata) ||
    pressedBy(rt, run) ||
    !(credentialSent(rt, run) || passkeyStepAnswered(rt, run))
  )
    return false;
  const scoped = () => current(rt, run) && run.live === live && run.metadata.id === metadata.id;
  if (!(await allowed(rt, run)) || !scoped()) return false;
  let username = await moveUsername(rt, metadata);
  if (!username || !scoped()) return false;
  const operationId = newId();
  const command = { attemptId: metadata.id, operationId };
  const prepared = v.safeParse(
    ssoInspectResultSchema,
    await send(rt, live, { type: "login.stay.prepare", ...command, username }).catch(
      () => undefined,
    ),
  );
  username = "";
  if (
    !prepared.success ||
    !prepared.output.ok ||
    !prepared.output.handle ||
    prepared.output.url !== live.url ||
    !scoped()
  )
    return false;
  const { handle } = prepared.output;
  for (const value of prepared.output.destinations) {
    const destination = URL.parse(value);
    if (
      !destination ||
      (destination.origin !== live.document.origin &&
        // eslint-disable-next-line no-await-in-loop -- each destination is checked in turn
        (await destinationRefusal(rt, run, destination)) !== undefined)
    )
      return false;
  }
  if (!(await allowed(rt, run)) || !scoped() || pressedBy(rt, run)) return false;
  rt.stayPresses.set(live.document.tabId, metadata.id);
  const operation: NonNullable<Execution["stayOperation"]> = {
    operationId,
    handle,
    stage: "intent",
  };
  run.stayOperation = operation;
  let pressed: boolean;
  try {
    const answer = await send(rt, live, { type: "login.stay.commit", ...command, handle });
    pressed = answer !== null && typeof answer === "object" && "ok" in answer && answer.ok === true;
  } catch {
    // The click may submit the page's form and take the answer with the document, also to
    // the same URL: only a click this worker authorized counts, and the tab's next page
    // resumes the login.
    pressed = operation.stage === "spent";
  } finally {
    if (run.stayOperation === operation) delete run.stayOperation;
  }
  if (pressed && current(rt, run)) notJudged(rt, run, "stay-signed-in");
  return pressed;
}

/**
 * Authorizes a phase of the stay-signed-in press `pressStaySignedIn` sent, for the document
 * it was sent to, while the login is current and its policy holds: the pointer events
 * once, then the click once (`spent`).
 */
export async function authorizeStay(
  rt: Runtime,
  message: unknown,
  sender: Sender,
): Promise<{ ok: boolean }> {
  const parsed = v.safeParse(stayAuthorizeSchema, message);
  if (!parsed.success) return { ok: false };
  const request = parsed.output;
  const document = await identify(rt, sender);
  const run = document && rt.attempts.get(document.tabId);
  const operation = run?.stayOperation;
  if (!document || !run || !operation) return { ok: false };
  const valid = () =>
    run.stayOperation === operation &&
    operation.stage === (request.phase === "pointer" ? "intent" : "pointer") &&
    run.metadata.id === request.attemptId &&
    operation.operationId === request.operationId &&
    operation.handle === request.handle &&
    run.live.token === request.token &&
    sameLoginDocument(run.live.document, document) &&
    current(rt, run);
  if (!valid() || !(await allowed(rt, run)) || !valid()) return { ok: false };
  operation.stage = request.phase === "pointer" ? "pointer" : "spent";
  return { ok: true };
}
