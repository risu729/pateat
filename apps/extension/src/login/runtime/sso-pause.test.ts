import { describe, expect, it } from "vitest";
import { createSsoPauseIntents } from "./sso-pause";
const rp = "https://rp.example.test";
const idp = "https://idp.other.test";
describe("local SSO pause intents", () => {
  it("covers the registrable site and leaves other sites available", () => {
    const guards = createSsoPauseIntents();
    const pending = guards.begin(rp + "/settings", false);
    expect(guards.blocked("https://login.example.test/signin", false)).toBe(true);
    expect(guards.blocked(idp, false)).toBe(false);
    pending.success();
    expect(guards.blocked(rp, false)).toBe(false);
  });
  it("keeps known cookie partitions separate and treats unknown partition as either", () => {
    const guards = createSsoPauseIntents();
    guards.begin(rp, true).failure();
    expect(guards.blocked(rp, false)).toBe(false);
    expect(guards.blocked(rp, true)).toBe(true);
    expect(guards.blocked(rp, undefined)).toBe(true);
    guards.resumed(rp, false);
    expect(guards.blocked(rp, true)).toBe(true);
    guards.resumed(rp, true);
    expect(guards.blocked(rp, undefined)).toBe(false);
  });
  it("cannot release overlapping pending writes with one successful or duplicated acknowledgement", () => {
    const guards = createSsoPauseIntents();
    const first = guards.begin(rp, false);
    const second = guards.begin(rp, false);
    first.success();
    first.success();
    first.failure();
    expect(guards.blocked(rp, false)).toBe(true);
    second.success();
    expect(guards.blocked(rp, false)).toBe(false);
  });
  it("retains a failed pause until an explicit resume and cannot clear an outstanding write", () => {
    const guards = createSsoPauseIntents();
    guards.begin(rp, false).failure();
    expect(guards.blocked(rp, false)).toBe(true);
    const pending = guards.begin(rp, false);
    guards.resumed(rp, false);
    expect(guards.blocked(rp, false)).toBe(true);
    pending.failure();
    expect(guards.blocked(rp, false)).toBe(true);
    guards.resumed(rp, false);
    expect(guards.blocked(rp, false)).toBe(false);
  });
  it("allows a successful explicit retry to replace a failed persistence hold", () => {
    const guards = createSsoPauseIntents();
    guards.begin(rp, false).failure();
    guards.begin(rp, false).success();
    expect(guards.blocked(rp, false)).toBe(false);
  });
  it("clears ended private holds without changing normal or outstanding private writes", () => {
    const guards = createSsoPauseIntents();
    guards.begin(rp, false).failure();
    guards.begin(rp, true).failure();
    const pending = guards.begin(idp, true);
    guards.clearPrivate();
    expect(guards.blocked(rp, false)).toBe(true);
    expect(guards.blocked(rp, true)).toBe(false);
    expect(guards.blocked(idp, true)).toBe(true);
    pending.success();
    expect(guards.blocked(idp, true)).toBe(false);
  });
  it("fails closed when distinct-site hold capacity is exceeded for this worker lifetime", () => {
    const guards = createSsoPauseIntents();
    for (let n = 0; n < 256; n++) guards.begin(`https://host.pause-${n}.test`, false).failure();
    expect(guards.blocked(idp, false)).toBe(false);
    guards.begin("https://overflow.extra.test", false).failure();
    expect(guards.blocked(idp, false)).toBe(true);
    guards.resumed("https://overflow.extra.test", false);
    guards.clearPrivate();
    expect(guards.blocked(idp, false)).toBe(true);
  });
  it("bounds overlapping pending writes even on one site and does not count invalid sites", () => {
    const guards = createSsoPauseIntents();
    for (let n = 0; n < 300; n++) guards.begin("about:blank", false).failure();
    expect(guards.blocked(idp, false)).toBe(false);
    for (let n = 0; n < 256; n++) guards.begin(rp, false);
    expect(guards.blocked(idp, false)).toBe(false);
    guards.begin(rp, false);
    expect(guards.blocked(idp, false)).toBe(true);
  });
});
