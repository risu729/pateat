import * as fc from "fast-check";
import { expect, it } from "vitest";
import {
  hostnames,
  settingsDevice,
  settingsService,
  site,
  type Commit,
} from "./__fixtures__/settings-devices";

// Two devices edit two entries and sync at the same time, in an order the scheduler
// picks, while uploads, their answers and base writes fail and workers stop. What each
// person sets is owed until that device stores it on the service. An upload may change an
// entry only to a value still owed; anything else puts back what another device changed.
// A sync may write over an owed value locally only when the other device changed that
// entry after the service revision of this device's recorded merge base when the person
// set it: the merge takes the service's side of a change both made since that base. A
// sync that wrote nothing records its new base only at its end, and Pateat does not
// handle losing that record (docs/architecture.md): values set while it is lost may be
// written over too. With the faults gone, both devices end where the
// service is.

const KEYS = ["x.example", "y.example"];

const fault = <T>(faults: T[]) =>
  fc.record({ at: fc.integer({ min: 0, max: 3 }), fault: fc.constantFrom(...faults) });
const deviceStep = fc.record(
  {
    edit: fc.constantFrom(0, 1),
    sync: fc.record(
      {
        upload: fault(["unsent" as const, "answer-lost" as const]),
        base: fault(["fails" as const, "hangs" as const]),
      },
      { requiredKeys: [] },
    ),
  },
  { requiredKeys: [] },
);
const rounds = fc.array(fc.tuple(deviceStep, deviceStep), { minLength: 1, maxLength: 6 });

/** Fails the `at`-th call of a sync, counted from 0. */
function nth<T>(planned: { at: number; fault: T } | undefined) {
  let calls = 0;
  return () => (planned && calls++ === planned.at ? planned.fault : undefined);
}

/**
 * A value a person set, the revision of its device's recorded merge base then, and
 * whether that base missed the end of a sync that wrote nothing.
 */
type Owed = { value: boolean; seen: number; unrecorded: boolean };

it("never puts back or drops another device's change, whatever fails and in any order", async () => {
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), rounds, async (scheduler, steps) => {
      const broken: string[] = [];
      /** Per device and entry, the values its person set that are still owed, oldest first. */
      const owed = [new Map<string, Owed[]>(), new Map<string, Owed[]>()];
      /** Per entry, the revisions at which each device's upload changed it. */
      const changed = KEYS.map(() => [[] as number[], [] as number[]]);
      const has = (settings: Commit["after"] | null, key: string) =>
        hostnames(settings).includes(key);
      const service = settingsService((commit) => {
        const index = devices.findIndex((d) => d.connection.credential === commit.credential);
        const revision = service.state().revision + 1;
        KEYS.forEach((key, k) => {
          const value = has(commit.after, key);
          if (value !== has(commit.before, key)) changed[k]![index]!.push(revision);
          const values = owed[index]!.get(key) ?? [];
          // A merge that read a later edit may carry an earlier one's value no longer.
          const at = values.findIndex((entry) => entry.value === value);
          if (value !== has(commit.before, key) && at === -1)
            broken.push(`device ${index + 1} set ${key} to ${value} unasked`);
          if (at !== -1) owed[index]!.set(key, values.slice(at + 1));
        });
      });
      /** Per device, the service revision of its recorded merge base. */
      const held = [0, 0];
      /** Per device, whether its run so far wrote the local settings. */
      const wroteLocally = [false, false];
      /** Per device, whether its base missed the end of a sync that wrote nothing. */
      const unrecorded = [false, false];
      const holds = (index: number) => {
        const base = devices[index]!.base() as { revision?: number } | undefined;
        held[index] = base?.revision ?? 0;
      };
      const devices = [1, 2].map((number) =>
        settingsDevice(service, number, (snapshot) => {
          // The merge read every edit before this write. Where it took the service's value
          // over the person's latest, the other device must have changed that entry since.
          const index = number - 1;
          for (const [key, values] of owed[index]!) {
            const latest = values.at(-1);
            if (!latest || has(snapshot.settings, key) === latest.value) continue;
            const other = changed[KEYS.indexOf(key)]![1 - index]!;
            if (!latest.unrecorded && !other.some((revision) => revision > latest.seen))
              broken.push(`device ${number} dropped its person's ${key}: ${latest.value}`);
            owed[index]!.delete(key);
          }
          wroteLocally[index] = true;
          holds(index);
        }),
      );
      /** A sync whose outcome means the local copy holds what the service holds. */
      const sync = async (index: number) => {
        wroteLocally[index] = false;
        const outcome = await devices[index]!.run();
        if (outcome === "synced") holds(index);
        return outcome;
      };
      // oxlint-disable-next-line no-await-in-loop -- the devices pair one after the other
      for (const index of [0, 1]) expect(await sync(index)).toBe("synced");

      for (const round of steps) {
        const tasks: Promise<unknown>[] = [];
        round.forEach((step, index) => {
          const device = devices[index]!;
          const owedHere = owed[index]!;
          if (step.edit !== undefined) {
            const key = KEYS[step.edit]!;
            tasks.push(
              scheduler.schedule(Promise.resolve()).then(() =>
                device.edit((settings) => {
                  const value = !has(settings, key);
                  // Owed before it is written, so no upload can carry it first.
                  owedHere.set(key, [
                    ...(owedHere.get(key) ?? []),
                    { value, seen: held[index]!, unrecorded: unrecorded[index]! },
                  ]);
                  return {
                    ...settings,
                    excludedSites: value
                      ? [...settings.excludedSites, site(key)]
                      : settings.excludedSites.filter((entry) => entry.hostname !== key),
                  };
                }),
              ),
            );
          }
          if (step.sync) {
            device.faults.upload = nth(step.sync.upload);
            const base = nth(step.sync.base);
            device.faults.base = (next) => {
              const planned = base();
              if (planned && !next["localWrite"] && !next["pending"] && !wroteLocally[index])
                unrecorded[index] = true;
              if (!planned && !next["pending"]) unrecorded[index] = false;
              return planned;
            };
            device.faults.pause = () => scheduler.schedule(Promise.resolve());
            // A stopped worker's run never ends.
            tasks.push(
              Promise.race([
                scheduler.schedule(Promise.resolve()).then(() => sync(index)),
                device.whenStopped(),
              ]),
            );
          }
        });
        // Each round ends with its runs, so one device never runs twice at once, as in the
        // extension.
        // oxlint-disable-next-line no-await-in-loop -- rounds follow one another
        await scheduler.waitFor(Promise.all(tasks));
        for (const device of devices) if (device.stopped()) device.restart();
      }

      for (const device of devices) {
        delete device.faults.upload;
        delete device.faults.base;
        delete device.faults.pause;
      }
      for (const _ of [0, 1])
        // oxlint-disable-next-line no-await-in-loop -- each sync sees the one before
        for (const index of [0, 1]) expect(await sync(index)).toBe("synced");
      expect(broken).toEqual([]);
      for (const device of devices)
        expect(hostnames(device.settings())).toEqual(hostnames(service.state().settings));
    }),
    { numRuns: 300 },
  );
});
