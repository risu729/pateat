import { describe, expect, it, vi } from "vitest";
import {
  exclude,
  hostnames,
  include,
  settingsDevice,
  settingsService,
} from "./__fixtures__/settings-devices";

// A sync records its merge base before each write it makes. Each test loses one write's
// answer or record, then another device changes the same entry: that change must stand.

async function paired() {
  const service = settingsService();
  const laptop = settingsDevice(service, 1);
  const phone = settingsDevice(service, 2);
  expect(await laptop.run()).toBe("synced");
  expect(await phone.run()).toBe("synced");
  return { service, laptop, phone };
}

describe("an upload whose base was not recorded", () => {
  it("keeps another device's removal after the upload's answer was lost", async () => {
    const { service, laptop, phone } = await paired();
    await laptop.edit(exclude("x.example"));
    laptop.faults.upload = "answer-lost";
    expect(await laptop.run()).toBe("unreachable");
    expect(hostnames(service.state().settings)).toEqual(["x.example"]);

    expect(await phone.run()).toBe("synced");
    await phone.edit(include("x.example"));
    expect(await phone.run()).toBe("synced");

    expect(await laptop.run()).toBe("synced");
    expect(hostnames(service.state().settings)).toEqual([]);
    expect(hostnames(laptop.settings())).toEqual([]);
  });

  it("keeps another device's removal after the worker stopped once the upload committed", async () => {
    const { service, laptop, phone } = await paired();
    await laptop.edit(exclude("x.example"));
    // Every base write after the pending upload's own stops the worker.
    laptop.faults.base = (next) => (next["pending"] ? undefined : "hangs");
    void laptop.run();
    await vi.waitFor(() => expect(laptop.stopped()).toBe(true));
    expect(hostnames(service.state().settings)).toEqual(["x.example"]);
    delete laptop.faults.base;
    laptop.restart();

    expect(await phone.run()).toBe("synced");
    await phone.edit(include("x.example"));
    expect(await phone.run()).toBe("synced");

    expect(await laptop.run()).toBe("synced");
    expect(hostnames(service.state().settings)).toEqual([]);
  });

  it("remembers a committed upload when the next one fails before it is sent", async () => {
    const { service, laptop, phone } = await paired();
    await laptop.edit(exclude("x.example"));
    laptop.faults.upload = "answer-lost";
    expect(await laptop.run()).toBe("unreachable");
    // This sync learns the first upload committed; its own upload never arrives.
    await laptop.edit(exclude("y.example"));
    laptop.faults.upload = "unsent";
    expect(await laptop.run()).toBe("unreachable");

    expect(await phone.run()).toBe("synced");
    await phone.edit(include("x.example"));
    expect(await phone.run()).toBe("synced");

    expect(await laptop.run()).toBe("synced");
    expect(hostnames(service.state().settings)).toEqual(["y.example"]);
    expect(hostnames(laptop.settings())).toEqual(["y.example"]);
  });
});

describe("a download whose base was not recorded", () => {
  it("keeps another device's removal of an entry it downloaded", async () => {
    const { service, laptop, phone } = await paired();
    await phone.edit(exclude("x.example"));
    expect(await phone.run()).toBe("synced");
    // The local write lands; the base recorded after it is lost.
    laptop.faults.base = (next) => (next["localWrite"] === undefined ? "fails" : undefined);
    expect(await laptop.run()).toBe("synced");
    expect(hostnames(laptop.settings())).toEqual(["x.example"]);
    delete laptop.faults.base;

    await phone.edit(include("x.example"));
    expect(await phone.run()).toBe("synced");

    expect(await laptop.run()).toBe("synced");
    expect(hostnames(service.state().settings)).toEqual([]);
    expect(hostnames(laptop.settings())).toEqual([]);
  });

  it("uploads the person's removal of an entry it downloaded", async () => {
    const { service, laptop, phone } = await paired();
    await phone.edit(exclude("x.example"));
    expect(await phone.run()).toBe("synced");
    laptop.faults.base = (next) => (next["localWrite"] === undefined ? "fails" : undefined);
    expect(await laptop.run()).toBe("synced");
    delete laptop.faults.base;

    // The person takes the downloaded entry back out before the next sync.
    await laptop.edit(include("x.example"));
    expect(await laptop.run()).toBe("synced");
    expect(hostnames(service.state().settings)).toEqual([]);
    expect(await phone.run()).toBe("synced");
    expect(hostnames(phone.settings())).toEqual([]);
  });

  it("writes nothing locally when its base cannot be recorded first", async () => {
    const { laptop, phone } = await paired();
    await phone.edit(exclude("x.example"));
    expect(await phone.run()).toBe("synced");
    laptop.faults.base = () => "fails";
    expect(await laptop.run()).toBe("storage-unavailable");
    expect(hostnames(laptop.settings())).toEqual([]);
  });
});
