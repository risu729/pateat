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
// picks, while uploads, their answers and base writes fail and workers stop. An upload
// may change an entry only to a value its own device's person set that is still owed:
// not yet stored on the service by that device, and not replaced by one of its local
// writes. Anything else puts back what another device changed. With the faults gone,
// both devices end where the service is.

const KEYS = ["x.example", "y.example"];

const deviceStep = fc.record(
  {
    edit: fc.constantFrom(0, 1),
    sync: fc.record(
      {
        upload: fc.constantFrom("unsent" as const, "answer-lost" as const),
        base: fc.record({
          at: fc.integer({ min: 0, max: 3 }),
          fault: fc.constantFrom("fails" as const, "hangs" as const),
        }),
      },
      { requiredKeys: [] },
    ),
  },
  { requiredKeys: [] },
);
const rounds = fc.array(fc.tuple(deviceStep, deviceStep), { minLength: 1, maxLength: 6 });

it("never puts back another device's change, whatever fails and in any order", async () => {
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), rounds, async (scheduler, steps) => {
      const broken: string[] = [];
      /** Per device and entry, the values its person set that are still owed, oldest first. */
      const owed = [new Map<string, boolean[]>(), new Map<string, boolean[]>()];
      const has = (settings: Commit["after"] | null, key: string) =>
        hostnames(settings).includes(key);
      const service = settingsService((commit) => {
        const index = devices.findIndex((d) => d.connection.credential === commit.credential);
        for (const key of KEYS) {
          const value = has(commit.after, key);
          const values = owed[index]!.get(key) ?? [];
          // A merge that read a later edit may carry an earlier one's value no longer.
          const at = values.indexOf(value);
          if (value !== has(commit.before, key) && at === -1)
            broken.push(`device ${index + 1} set ${key} to ${value} unasked`);
          if (at !== -1) owed[index]!.set(key, values.slice(at + 1));
        }
      });
      const devices = [1, 2].map((number) =>
        settingsDevice(service, number, (snapshot) => {
          // The merge read every edit before this write; where it took the service's
          // value over the person's latest, those edits are gone.
          for (const [key, values] of owed[number - 1]!)
            if (has(snapshot.settings, key) !== values.at(-1)) owed[number - 1]!.delete(key);
        }),
      );
      // oxlint-disable-next-line no-await-in-loop -- the devices pair one after the other
      for (const device of devices) expect(await device.run()).toBe("synced");

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
                  owedHere.set(key, [...(owedHere.get(key) ?? []), value]);
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
            const { upload, base } = step.sync;
            if (upload) device.faults.upload = upload;
            else delete device.faults.upload;
            let writes = 0;
            device.faults.base = () => (base && writes++ === base.at ? base.fault : undefined);
            device.faults.request = () => scheduler.schedule(Promise.resolve());
            // A stopped worker's run never ends.
            tasks.push(
              Promise.race([
                scheduler.schedule(Promise.resolve()).then(() => device.run()),
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
        delete device.faults.request;
      }
      for (const _ of [0, 1])
        // oxlint-disable-next-line no-await-in-loop -- each sync sees the one before
        for (const device of devices) expect(await device.run()).toBe("synced");
      expect(broken).toEqual([]);
      for (const device of devices)
        expect(hostnames(device.settings())).toEqual(hostnames(service.state().settings));
    }),
    { numRuns: 300 },
  );
});
