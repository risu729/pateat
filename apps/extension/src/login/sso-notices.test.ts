import { expect, test, vi } from "vitest";
import { ssoVaultNotices } from "./sso-notices";

test("a vault notice reaches the login runtime only once it is attached", async () => {
  const notices = ssoVaultNotices();
  const vaultStateMayChange = vi.fn(() => Promise.resolve());
  notices.notify();
  notices.attach({ vaultStateMayChange });
  expect(vaultStateMayChange).not.toHaveBeenCalled();
  notices.notify();
  notices.notify();
  expect(vaultStateMayChange).toHaveBeenCalledTimes(2);
});

test("a failed withdrawal never escapes the notice", async () => {
  const notices = ssoVaultNotices();
  const failure = vi.fn(() => Promise.reject(new Error("synthetic failure")));
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    notices.attach({ vaultStateMayChange: failure });
    expect(() => notices.notify()).not.toThrow();
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", unhandled);
  }
});
