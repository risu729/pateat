import { describe, expect, it } from "vitest";
import { localClock } from "../time";
import {
  createLoginPauses,
  PAUSE_LENGTHS,
  pausedByRule,
  pausedInPrivate,
  pauseSite,
} from "./pause";

function memory(initial?: unknown) {
  const box = { value: initial, writes: 0, fail: false, unreadable: 0 };
  return {
    box,
    store: {
      getValue: async () => {
        if (box.unreadable > 0) {
          box.unreadable -= 1;
          throw new Error("Synthetic read failure");
        }
        return box.value;
      },
      setValue: async (value: unknown) => {
        if (box.fail) throw new Error("Synthetic write failure");
        box.writes += 1;
        box.value = structuredClone(value);
      },
    },
  };
}

describe("pauseSite", () => {
  it("keys a page by its registrable domain", () => {
    expect(pauseSite("https://login.example.co.jp/signin")).toBe("example.co.jp");
    expect(pauseSite("https://www.example.co.jp")).toBe("example.co.jp");
    expect(pauseSite(new URL("http://127.0.0.1:8080/"))).toBe("127.0.0.1");
  });
  it("has no site for a page that is not HTTP(S) or not a URL", () => {
    expect(pauseSite("chrome://extensions/")).toBeUndefined();
    expect(pauseSite("not a url")).toBeUndefined();
  });
});

describe("pausedByRule", () => {
  it("pauses the pages an exclusion rule covers, until it is removed", () => {
    const settings = { excludedSites: [{ hostname: "example.com", includeSubdomains: true }] };
    expect(pausedByRule(settings, "https://login.example.com/")).toBe(true);
    expect(pausedByRule(settings, "http://example.com:8080/")).toBe(true);
    expect(pausedByRule(settings, "https://example.net/")).toBe(false);
    // A page Pateat does not run on is not a paused site.
    expect(pausedByRule(settings, "chrome://newtab/")).toBe(false);
  });
});

describe("pausedInPrivate", () => {
  it("pauses private windows only, until automatic login is turned on there", () => {
    expect(pausedInPrivate({}, true)).toBe(true);
    expect(pausedInPrivate({}, false)).toBe(false);
    // A window whose kind is not known is not counted as private.
    expect(pausedInPrivate({}, undefined)).toBe(false);
    expect(pausedInPrivate({ loginInPrivateWindows: true }, true)).toBe(false);
  });
});

describe("localClock", () => {
  it("names the end on a 24-hour clock in the time zone", () => {
    const at = Date.UTC(2026, 9, 23, 3, 40);
    expect(localClock(at, "UTC")).toBe("03:40");
    expect(localClock(at, "Asia/Tokyo")).toBe("12:40");
    expect(localClock(8.64e15 + 1, "UTC")).toBe("--:--");
  });
});

const PAUSE_MS = PAUSE_LENGTHS["1h"];

describe("createLoginPauses", () => {
  it("pauses every origin of the site for an hour", async () => {
    let now = 1_000_000;
    const { store, box } = memory();
    const pauses = createLoginPauses(store, () => now);
    expect(await pauses.pause("https://login.example.co.jp/signin", false, "1h")).toBe(
      now + PAUSE_MS,
    );
    expect(await pauses.until(["https://www.example.co.jp/"], false)).toBe(now + PAUSE_MS);
    expect(await pauses.until(["https://example.com/"], false)).toBeUndefined();
    expect(box.value).toEqual([
      {
        site: "example.co.jp",
        incognito: false,
        length: "1h",
        until: new Date(now + PAUSE_MS).toISOString(),
      },
    ]);
    // Expiry needs no alarm: the check compares the time.
    now += PAUSE_MS - 1;
    expect(await pauses.until(["https://example.co.jp/"], false)).toBe(1_000_000 + PAUSE_MS);
    now += 1;
    expect(await pauses.until(["https://example.co.jp/"], false)).toBeUndefined();
  });
  it("pauses for the chosen length, and a new pause replaces a running one", async () => {
    let now = 0;
    const { store, box } = memory();
    const pauses = createLoginPauses(store, () => now);
    expect(await pauses.pause("https://example.com/", false, "10m")).toBe(10 * 60_000);
    expect(box.value).toEqual([
      {
        site: "example.com",
        incognito: false,
        length: "10m",
        until: new Date(10 * 60_000).toISOString(),
      },
    ]);
    now = 10 * 60_000 - 1;
    expect(await pauses.until(["https://example.com/"], false)).toBe(10 * 60_000);
    now = 10 * 60_000;
    expect(await pauses.until(["https://example.com/"], false)).toBeUndefined();
    // Pausing again counts from now, also for a shorter length.
    await pauses.pause("https://example.com/", false, "1h");
    now += 60_000;
    expect(await pauses.pause("https://example.com/", false, "10m")).toBe(now + 10 * 60_000);
    expect(box.value).toEqual([expect.objectContaining({ length: "10m" })]);
  });
  it("ignores a stored pause of an unknown length", async () => {
    const stored = [
      { site: "example.com", incognito: false, length: "1d", until: "1970-01-02T00:00:00.000Z" },
    ];
    const pauses = createLoginPauses(memory(stored).store, () => 0);
    expect(await pauses.until(["https://example.com/"], false)).toBeUndefined();
  });
  it("keeps normal and incognito windows apart", async () => {
    const pauses = createLoginPauses(memory().store, () => 0);
    await pauses.pause("https://example.com/", true, "1h");
    expect(await pauses.until(["https://example.com/"], true)).toBe(PAUSE_MS);
    expect(await pauses.until(["https://example.com/"], false)).toBeUndefined();
    expect(await pauses.resume("https://example.com/", false)).toBe(false);
    expect(await pauses.until(["https://example.com/"], true)).toBe(PAUSE_MS);
  });
  it("pauses a frame when the frame's site or its tab's site is paused", async () => {
    const pauses = createLoginPauses(memory().store, () => 0);
    await pauses.pause("https://top.example/", false, "1h");
    expect(await pauses.until(["https://idp.example.net/", "https://top.example/"], false)).toBe(
      PAUSE_MS,
    );
    expect(await pauses.until(["https://idp.example.net/", undefined], false)).toBeUndefined();
  });
  it("is read again by a restarted worker", async () => {
    const { store } = memory();
    await createLoginPauses(store, () => 0).pause("https://example.com/", false, "1h");
    const restarted = createLoginPauses(store, () => 10);
    expect(await restarted.until(["https://example.com/a"], false)).toBe(PAUSE_MS);
  });
  it("ignores damaged storage", async () => {
    const pauses = createLoginPauses(memory([{ site: "example.com" }]).store, () => 0);
    expect(await pauses.until(["https://example.com/"], false)).toBeUndefined();
  });
  it("resumes a running pause and drops ended ones when it writes", async () => {
    let now = 0;
    const { store, box } = memory();
    const pauses = createLoginPauses(store, () => now);
    await pauses.pause("https://old.example/", false, "1h");
    now = PAUSE_MS / 2;
    await pauses.pause("https://example.com/", false, "1h");
    expect(await pauses.resume("https://www.example.com/", false)).toBe(true);
    expect(await pauses.resume("https://example.com/", false)).toBe(false);
    expect(box.value).toEqual([
      {
        site: "old.example",
        incognito: false,
        length: "1h",
        until: new Date(PAUSE_MS).toISOString(),
      },
    ]);
    now = PAUSE_MS;
    // An ended pause has nothing to resume, and the next write drops it.
    expect(await pauses.resume("https://old.example/", false)).toBe(false);
    await pauses.pause("https://example.com/", false, "1h");
    expect(box.value).toEqual([
      {
        site: "example.com",
        incognito: false,
        length: "1h",
        until: new Date(2 * PAUSE_MS).toISOString(),
      },
    ]);
  });
  it("keeps the memory as it was when the write fails", async () => {
    const { store, box } = memory();
    const pauses = createLoginPauses(store, () => 0);
    box.fail = true;
    await expect(pauses.pause("https://example.com/", false, "1h")).rejects.toThrow();
    expect(await pauses.until(["https://example.com/"], false)).toBeUndefined();
    box.fail = false;
    expect(await pauses.pause("https://example.com/", false, "1h")).toBe(PAUSE_MS);
  });
  it("has nothing to pause on a page without a site", async () => {
    const { store, box } = memory();
    const pauses = createLoginPauses(store, () => 0);
    expect(await pauses.pause("chrome://newtab/", false, "1h")).toBeUndefined();
    expect(box.writes).toBe(0);
  });
  it("never drops stored pauses after a failed read", async () => {
    const other = {
      site: "other.example",
      incognito: false,
      length: "1h",
      until: new Date(PAUSE_MS).toISOString(),
    };
    const { store, box } = memory([other]);
    box.unreadable = 2;
    const pauses = createLoginPauses(store, () => 0);
    // The first read and the read again before the write both fail: nothing is written.
    await expect(pauses.pause("https://example.com/", false, "1h")).rejects.toThrow();
    expect(box.value).toEqual([other]);
    // A later read succeeds, and the write keeps the other site's pause.
    await pauses.pause("https://example.com/", false, "1h");
    expect(box.value).toEqual(
      expect.arrayContaining([other, expect.objectContaining({ site: "example.com" })]),
    );
    expect(await pauses.until(["https://other.example/"], false)).toBe(PAUSE_MS);
  });
  it("counts either window kind's pause when the kind is not known", async () => {
    const pauses = createLoginPauses(memory().store, () => 0);
    await pauses.pause("https://example.com/", true, "1h");
    expect(await pauses.until(["https://example.com/"], undefined)).toBe(PAUSE_MS);
    expect(await pauses.resume("https://example.com/", undefined)).toBe(true);
    expect(await pauses.until(["https://example.com/"], true)).toBeUndefined();
  });
  it("refuses to answer while the store cannot be read, so the caller counts it as paused", async () => {
    const { store, box } = memory();
    box.unreadable = 2;
    const pauses = createLoginPauses(store, () => 0);
    await expect(pauses.until(["https://example.com/"], false)).rejects.toThrow(
      "The paused sites could not be read",
    );
    // Read again on the next check.
    expect(await pauses.until(["https://example.com/"], false)).toBeUndefined();
  });
  it("forgets only the incognito pauses once the last incognito window closed", async () => {
    const { store, box } = memory();
    const pauses = createLoginPauses(store, () => 0);
    await pauses.pause("https://example.com/", false, "1h");
    await pauses.pause("https://example.com/", true, "1h");
    await pauses.pause("https://other.example/", true, "10m");
    await pauses.clearIncognito();
    expect(box.value).toEqual([expect.objectContaining({ site: "example.com", incognito: false })]);
    expect(await pauses.until(["https://example.com/"], true)).toBeUndefined();
    expect(await pauses.until(["https://example.com/"], false)).toBe(PAUSE_MS);
    // Nothing left to forget writes nothing.
    const writes = box.writes;
    await pauses.clearIncognito();
    expect(box.writes).toBe(writes);
  });
});
