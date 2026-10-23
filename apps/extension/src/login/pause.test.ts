import { describe, expect, it } from "vitest";
import { localClock } from "../time";
import { createLoginPauses, PAUSE_MS, pauseSite } from "./pause";

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

describe("localClock", () => {
  it("names the end on a 24-hour clock in the time zone", () => {
    const at = Date.UTC(2026, 9, 23, 3, 40);
    expect(localClock(at, "UTC")).toBe("03:40");
    expect(localClock(at, "Asia/Tokyo")).toBe("12:40");
    expect(localClock(8.64e15 + 1, "UTC")).toBe("--:--");
  });
});

describe("createLoginPauses", () => {
  it("pauses every origin of the site for an hour", async () => {
    let now = 1_000_000;
    const { store, box } = memory();
    const pauses = createLoginPauses(store, () => now);
    expect(await pauses.pause("https://login.example.co.jp/signin", false)).toBe(now + PAUSE_MS);
    expect(await pauses.until(["https://www.example.co.jp/"], false)).toBe(now + PAUSE_MS);
    expect(await pauses.until(["https://example.com/"], false)).toBeUndefined();
    expect(box.value).toEqual([
      { site: "example.co.jp", incognito: false, until: new Date(now + PAUSE_MS).toISOString() },
    ]);
    // Expiry needs no alarm: the check compares the time.
    now += PAUSE_MS - 1;
    expect(await pauses.until(["https://example.co.jp/"], false)).toBe(1_000_000 + PAUSE_MS);
    now += 1;
    expect(await pauses.until(["https://example.co.jp/"], false)).toBeUndefined();
  });
  it("keeps normal and incognito windows apart", async () => {
    const pauses = createLoginPauses(memory().store, () => 0);
    await pauses.pause("https://example.com/", true);
    expect(await pauses.until(["https://example.com/"], true)).toBe(PAUSE_MS);
    expect(await pauses.until(["https://example.com/"], false)).toBeUndefined();
    expect(await pauses.resume("https://example.com/", false)).toBe(false);
    expect(await pauses.until(["https://example.com/"], true)).toBe(PAUSE_MS);
  });
  it("pauses a frame when the frame's site or its tab's site is paused", async () => {
    const pauses = createLoginPauses(memory().store, () => 0);
    await pauses.pause("https://top.example/", false);
    expect(await pauses.until(["https://idp.example.net/", "https://top.example/"], false)).toBe(
      PAUSE_MS,
    );
    expect(await pauses.until(["https://idp.example.net/", undefined], false)).toBeUndefined();
  });
  it("is read again by a restarted worker", async () => {
    const { store } = memory();
    await createLoginPauses(store, () => 0).pause("https://example.com/", false);
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
    await pauses.pause("https://old.example/", false);
    now = PAUSE_MS / 2;
    await pauses.pause("https://example.com/", false);
    expect(await pauses.resume("https://www.example.com/", false)).toBe(true);
    expect(await pauses.resume("https://example.com/", false)).toBe(false);
    expect(box.value).toEqual([
      { site: "old.example", incognito: false, until: new Date(PAUSE_MS).toISOString() },
    ]);
    now = PAUSE_MS;
    // An ended pause has nothing to resume, and the next write drops it.
    expect(await pauses.resume("https://old.example/", false)).toBe(false);
    await pauses.pause("https://example.com/", false);
    expect(box.value).toEqual([
      { site: "example.com", incognito: false, until: new Date(2 * PAUSE_MS).toISOString() },
    ]);
  });
  it("keeps the memory as it was when the write fails", async () => {
    const { store, box } = memory();
    const pauses = createLoginPauses(store, () => 0);
    box.fail = true;
    await expect(pauses.pause("https://example.com/", false)).rejects.toThrow();
    expect(await pauses.until(["https://example.com/"], false)).toBeUndefined();
    box.fail = false;
    expect(await pauses.pause("https://example.com/", false)).toBe(PAUSE_MS);
  });
  it("has nothing to pause on a page without a site", async () => {
    const { store, box } = memory();
    const pauses = createLoginPauses(store, () => 0);
    expect(await pauses.pause("chrome://newtab/", false)).toBeUndefined();
    expect(box.writes).toBe(0);
  });
  it("never drops stored pauses after a failed read", async () => {
    const other = {
      site: "other.example",
      incognito: false,
      until: new Date(PAUSE_MS).toISOString(),
    };
    const { store, box } = memory([other]);
    box.unreadable = 2;
    const pauses = createLoginPauses(store, () => 0);
    // The first read and the read again before the write both fail: nothing is written.
    await expect(pauses.pause("https://example.com/", false)).rejects.toThrow();
    expect(box.value).toEqual([other]);
    // A later read succeeds, and the write keeps the other site's pause.
    await pauses.pause("https://example.com/", false);
    expect(box.value).toEqual(
      expect.arrayContaining([other, expect.objectContaining({ site: "example.com" })]),
    );
    expect(await pauses.until(["https://other.example/"], false)).toBe(PAUSE_MS);
  });
  it("counts either window kind's pause when the kind is not known", async () => {
    const pauses = createLoginPauses(memory().store, () => 0);
    await pauses.pause("https://example.com/", true);
    expect(await pauses.until(["https://example.com/"], undefined)).toBe(PAUSE_MS);
    expect(await pauses.resume("https://example.com/", undefined)).toBe(true);
    expect(await pauses.until(["https://example.com/"], true)).toBeUndefined();
  });
});
