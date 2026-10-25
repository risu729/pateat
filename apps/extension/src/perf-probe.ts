// Timing probe for the popup's account list; a measurement branch only, never merged.
import { browser } from "wxt/browser";

const workerStart = Date.now();
let marks: [string, number][] = [];
let catalogs = 0;

export function perfMark(label: string, ms: number) {
  marks.push([label, Math.round(ms)]);
}
export function perfCatalog() {
  catalogs += 1;
}
export function perfReset() {
  marks = [];
  catalogs = 0;
}
/** Stores the worker's marks of the last account listing where the popup reads them. */
export async function perfFlush(totalMs: number) {
  await browser.storage.session
    .set({
      "pateat.perf-probe": {
        workerAgeMs: Date.now() - workerStart,
        totalMs: Math.round(totalMs),
        catalogs,
        marks,
      },
    })
    .catch(() => undefined);
}
