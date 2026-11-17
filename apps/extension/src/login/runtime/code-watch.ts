import * as v from "valibot";
import { parseAttemptMetadata } from "@pateat/contracts";
import { codeWatchReplySchema } from "../wire";
import { send, current, save } from "./attempt";
import { watchOver } from "./attempt-state";
import { CODE_WATCHES, WATCH_MS } from "./constants";
import { type Execution } from "./types";
import type { Runtime } from "./state";

/**
 * Asks the top document a login is watched in to say once its code field changes (ADR
 * 0027 amendment of 2026-11-17): another code page, as Luma's dialog shows the
 * authenticator app's after the emailed code in one document and one input, or none, as
 * when the person's code signed them in there. The watch reads only new documents and
 * routes otherwise, so such a page would never be read. The document compares its code
 * field's digest with the one the watch kept, recorded on the first ask and replaced by
 * each change read, so a page swapped while the worker restarted is reported too; it
 * checks at each change of the page (ADR 0082), never on a timer. One worker asks each
 * document at most `CODE_WATCHES` times.
 */
export async function watchCode(rt: Runtime, run: Execution): Promise<void> {
  const { document } = run.live;
  const { watch } = run.metadata;
  if (
    run.metadata.state !== "watching" ||
    !watch ||
    document.frameId !== 0 ||
    watch.documentId !== document.documentId ||
    watchOver(run.metadata, Date.now())
  )
    return;
  const asked = run.codeWatches?.documentId === document.documentId ? run.codeWatches : undefined;
  if (asked?.armed || (asked?.count ?? 0) >= CODE_WATCHES) return;
  run.codeWatches = {
    documentId: document.documentId,
    count: (asked?.count ?? 0) + 1,
    armed: true,
  };
  const left = WATCH_MS - (Date.now() - watch.since);
  const reply = v.safeParse(
    codeWatchReplySchema,
    await send(rt, run.live, {
      type: "login.code.watch",
      ...(watch.code ? { baseline: watch.code } : {}),
      timeoutMs: Math.max(0, Math.min(Math.ceil(left), WATCH_MS)),
    }).catch(() => undefined),
  );
  if (!reply.success) {
    if (run.codeWatches?.documentId === document.documentId) run.codeWatches.armed = false;
    return;
  }
  // The first digest is the baseline the document's later pages are compared with.
  if (
    current(rt, run) &&
    run.metadata.state === "watching" &&
    run.metadata.watch?.documentId === document.documentId &&
    run.metadata.watch.code === undefined
  ) {
    run.metadata = parseAttemptMetadata({
      ...run.metadata,
      watch: { ...run.metadata.watch, code: reply.output.digest },
    });
    await save(rt, run);
  }
}

/**
 * The document's changed code page is read now (`changedHere`): the digest it reported
 * becomes the baseline of the next ask, so a page shown while this one is read or judged
 * is reported in turn. It is recorded first, so a restarted worker does not read the same
 * change again; a change the worker restarted while reading is not read again either.
 */
export async function readChangedCode(rt: Runtime, run: Execution): Promise<void> {
  const changed = run.codeChanged;
  delete run.codeChanged;
  if (run.codeWatches) run.codeWatches.armed = false;
  const { watch } = run.metadata;
  if (!watch || !changed || watch.code === changed.digest) return;
  run.metadata = parseAttemptMetadata({
    ...run.metadata,
    watch: { ...watch, code: changed.digest },
  });
  await save(rt, run);
}
