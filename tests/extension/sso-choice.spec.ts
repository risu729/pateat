import { expect, test } from "@playwright/test";
import { withLoginExtension } from "./login-fixture";
import { sendToBackground as send } from "./background-message";

test("the packaged SSO chooser accepts only its exact popup and restores no executable offer", async () => {
  await withLoginExtension(async (context, _worker, extensionId) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.locator("#root")).not.toBeEmpty();
    expect(await send(popup, { version: 1, type: "login.sso.get", tabId: 7 })).toEqual({
      ok: true,
    });
    expect(
      await send(popup, {
        version: 1,
        type: "login.sso.choose",
        tabId: 7,
        offerId: "stale-offer",
        selection: { kind: "native", route: "password" },
      }),
    ).toEqual({ ok: false, reason: "offer-gone" });
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    expect(await send(options, { version: 1, type: "login.sso.get", tabId: 7 })).toBeUndefined();
    expect(
      await send(options, {
        version: 1,
        type: "login.sso.choose",
        tabId: 7,
        offerId: "stale-offer",
        selection: { kind: "native", route: "password" },
      }),
    ).toBeUndefined();
    await popup.reload();
    expect(await send(popup, { version: 1, type: "login.sso.get", tabId: 7 })).toEqual({
      ok: true,
    });
    await expect(popup.getByRole("heading", { name: "Sign-in method", exact: true })).toHaveCount(
      0,
    );
  });
});
