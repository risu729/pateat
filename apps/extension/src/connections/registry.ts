import * as v from "valibot";
import { normalizeBitwardenProfile } from "@pateat/bitwarden";
import { browser } from "wxt/browser";
import type { BitwardenConnectionConfiguration, ConnectionRegistry } from "./types";

const key = "pateat.bitwarden-connections.v1";
const schema = v.pipe(
  v.array(
    v.strictObject({
      profile: v.unknown(),
      label: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      email: v.pipe(v.string(), v.email(), v.maxLength(320)),
      deviceIdentifier: v.pipe(v.string(), v.uuid()),
    }),
  ),
  v.maxLength(100),
);
export function admitConnectionConfigurations(input: unknown): BitwardenConnectionConfiguration[] {
  const entries = v.parse(schema, input);
  const seen = new Set<string>();
  return entries.map((entry) => {
    const profile = normalizeBitwardenProfile(entry.profile);
    if (!profile.ok || seen.has(profile.data.connectionId))
      throw new Error("invalid-configuration");
    seen.add(profile.data.connectionId);
    return { ...entry, profile: profile.data };
  });
}
/** One background writes this value-free configuration. A configured ID never changes provider. */
export function createConnectionRegistry(storage: {
  read(): Promise<unknown>;
  write(input: unknown): Promise<void>;
}): ConnectionRegistry {
  let queue = Promise.resolve();
  const list = async () => {
    const stored = await storage.read();
    return stored === undefined ? [] : admitConnectionConfigurations(stored);
  };
  return {
    list,
    async get(id) {
      return (await list()).find((entry) => entry.profile.connectionId === id);
    },
    put(input) {
      const captured = admitConnectionConfigurations([structuredClone(input)])[0]!;
      const pending = queue.then(async () => {
        const entries = await list();
        const prior = entries.find(
          (entry) => entry.profile.connectionId === captured.profile.connectionId,
        );
        if (prior) {
          if (JSON.stringify(prior) !== JSON.stringify(captured))
            throw new Error("immutable-configuration");
          return undefined;
        }
        await storage.write(admitConnectionConfigurations([...entries, captured]));
        return undefined;
      });
      queue = pending.catch(() => undefined);
      return pending;
    },
  };
}
export function createBrowserConnectionRegistry(): ConnectionRegistry {
  let access: Promise<void> | undefined;
  const restricted = () =>
    (access ??= browser.storage.local
      .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
      .catch((error: unknown) => {
        access = undefined;
        throw error;
      }));
  return createConnectionRegistry({
    async read() {
      await restricted();
      return (await browser.storage.local.get(key))[key];
    },
    async write(value) {
      await restricted();
      await browser.storage.local.set({ [key]: value });
    },
  });
}
