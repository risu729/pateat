import { describe, expect, it } from "vitest";
import { documentLoaded } from "./document-load";

/** A document whose ready state the test sets, firing `readystatechange` as a page does. */
function loading() {
  const target = new EventTarget() as EventTarget & { readyState: DocumentReadyState };
  target.readyState = "loading";
  const move = (state: DocumentReadyState) => {
    target.readyState = state;
    target.dispatchEvent(new Event("readystatechange"));
  };
  return { document: target as unknown as Document, move };
}

describe("documentLoaded", () => {
  it("answers at once for a document that has loaded", async () => {
    const page = loading();
    page.move("complete");
    expect(await documentLoaded(page.document, Date.now() + 10_000)).toBe(true);
  });

  it("answers once the document reaches complete, not at interactive", async () => {
    const page = loading();
    let answer: boolean | undefined;
    const waiting = documentLoaded(page.document, Date.now() + 10_000).then(
      (loaded) => (answer = loaded),
    );
    page.move("interactive");
    await Promise.resolve();
    expect(answer).toBeUndefined();
    page.move("complete");
    expect(await waiting).toBe(true);
  });

  it("answers false at its bound, or once stopped, while the document still loads", async () => {
    const page = loading();
    expect(await documentLoaded(page.document, Date.now() + 20)).toBe(false);
    const stop = new AbortController();
    const stopped = documentLoaded(page.document, Date.now() + 10_000, stop.signal);
    stop.abort();
    expect(await stopped).toBe(false);
    expect(await documentLoaded(page.document, Date.now() + 10_000, stop.signal)).toBe(false);
  });
});
