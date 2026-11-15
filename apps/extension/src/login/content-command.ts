import type * as v from "valibot";
import type { browser } from "wxt/browser";
import type { commandSchema } from "./wire";

/** The command `executeNative` runs: the one the listener's other branches leave. */
export type ExecuteCommand = Extract<
  v.InferOutput<typeof commandSchema>,
  { type: "login.execute" }
>;
/** The listener's `respond`. */
export type Respond = Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[2];
