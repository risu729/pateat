import * as v from "valibot";
import { browser } from "wxt/browser";
import { commandSchema } from "./wire";

export type ContentCommand = v.InferOutput<typeof commandSchema>;
export type ExecuteCommand = Extract<ContentCommand, { type: "login.execute" }>;
export type Respond = Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[2];
