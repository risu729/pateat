import { expect, test, type Page } from "@playwright/test";
import type { SettingsResponse } from "../../packages/contracts/src/index";
import { sendToBackground as send } from "./background-message";
import { withLoginExtension } from "./login-fixture";
import { startLoginFixture } from "./login-server";

async function configure(options: Page, extensionId: string, origin: string) {
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.locator("#settings-status")).toContainText("Saved settings loaded");
  expect(await send(options, { version: 1, type: "login.probe.configure", origin })).toMatchObject({
    ok: true,
  });
  const read = (await send(options, { version: 1, type: "settings.get" })) as SettingsResponse;
  if (!read.ok) throw new Error("Synthetic settings unavailable");
  const settings = read.snapshot.settings;
  settings.pagePermissionDefaults = {
    "sign-in": "fill",
    confirm: "fill",
    "personal-details": "fill",
  };
  settings.siteDefaults = [
    {
      origin,
      provider: "dummy",
      server: "cloud-us",
      userId: "demo-personal-account",
      itemId: "primary",
    },
  ];
  expect(
    await send(options, {
      version: 1,
      type: "settings.save",
      expectedRevision: read.snapshot.revision,
      settings,
    }),
  ).toMatchObject({ ok: true });
}
async function waiting(options: Page, stepIndex: number) {
  await expect
    .poll(() => send(options, { version: 1, type: "login.probe.status" }))
    .toMatchObject({
      attempts: [{ signInFill: true, state: "ready", stepIndex, submissions: 0 }],
    });
}
/** The fill filled what it could and ended, leaving the rest of the steps to the person. */
async function done(options: Page, stepIndex: number) {
  await expect
    .poll(() => send(options, { version: 1, type: "login.probe.status" }))
    .toMatchObject({
      attempts: [{ signInFill: true, state: "blocked", fillDone: true, stepIndex, submissions: 0 }],
    });
}
/** A closed tab forgets its fill, so the next scenario's tab is the only one listed. */
async function closed(options: Page, page: Page) {
  await page.close();
  await expect
    .poll(() => send(options, { version: 1, type: "login.probe.status" }))
    .toMatchObject({ attempts: [] });
}
async function counts(page: Page) {
  return page.evaluate(() => ({
    next: Number(sessionStorage.getItem("identityClicks") || 0),
    submit: Number(sessionStorage.getItem("submitClicks") || 0),
  }));
}

test("profile autofill follows the person's Next across and within documents and leaves submission to them", async () => {
  const fixture = await startLoginFixture();
  try {
    await withLoginExtension(async (context, _worker, id) => {
      const options = await context.newPage();
      await configure(options, id, fixture.origin);
      // A new document after the person's Next.
      const page = await context.newPage();
      await page.goto(`${fixture.origin}/identity`);
      await expect(page.getByLabel("Branch", { exact: true })).toHaveValue("007");
      await expect(page.getByLabel("Account", { exact: true })).toHaveValue("00001234");
      await waiting(options, 2);
      expect(await counts(page)).toEqual({ next: 0, submit: 0 });
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(page).toHaveURL(`${fixture.origin}/password`);
      await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
        "Pateat-synthetic-only!",
      );
      await done(options, 5);
      expect(await counts(page)).toEqual({ next: 1, submit: 0 });
      await page.getByRole("button", { name: "Log in", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Authenticated synthetic account", exact: true }),
      ).toBeVisible();
      expect(await counts(page)).toEqual({ next: 1, submit: 1 });
      await closed(options, page);
      // The same document after the person's Next.
      const inPlace = await context.newPage();
      await inPlace.goto(`${fixture.origin}/identifier-first`);
      await expect(inPlace.locator("#account")).toHaveValue("00001234");
      await waiting(options, 1);
      expect(await counts(inPlace)).toEqual({ next: 0, submit: 0 });
      await inPlace.getByRole("button", { name: "Next", exact: true }).click();
      await expect(inPlace.locator("#password")).toHaveValue("Pateat-synthetic-only!");
      await done(options, 3);
      expect(await counts(inPlace)).toEqual({ next: 1, submit: 0 });
      await expect(inPlace).toHaveURL(`${fixture.origin}/identifier-first`);
    });
  } finally {
    await fixture.close();
  }
});

test("profile autofill leaves an effectful fill and a password the person typed alone", async () => {
  const fixture = await startLoginFixture();
  try {
    await withLoginExtension(async (context, _worker, id) => {
      const options = await context.newPage();
      await configure(options, id, fixture.origin);
      // An effectful fill is left empty, without a POST or a fallback click.
      const runId = fixture.createRun();
      const page = await context.newPage();
      await page.goto(`${fixture.origin}/input-submit?runId=${runId}`);
      await done(options, 0);
      await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
      expect(fixture.evidence(runId)).toEqual({
        posts: 0,
        inputPosts: 0,
        clickPosts: 0,
        allMatched: true,
      });
      await expect(page.locator("#effect-status")).toHaveText("No POST observed");
      expect(await counts(page)).toEqual({ next: 0, submit: 0 });
      await closed(options, page);
      // A person typing before value delivery keeps their password, with the real
      // document-start recorder.
      expect(
        await send(options, {
          version: 1,
          type: "login.probe.control",
          action: "arm",
          checkpoint: "before-delivery",
        }),
      ).toMatchObject({ ok: true });
      const typed = await context.newPage();
      await typed.goto(`${fixture.origin}/single`);
      await expect
        .poll(() => send(options, { version: 1, type: "login.probe.status" }))
        .toMatchObject({
          checkpoint: "before-delivery",
          attempts: [{ signInFill: true, operationKind: "fill", submissions: 0 }],
        });
      const password = typed.getByLabel("Password", { exact: true });
      await password.pressSequentially("Person-chosen-synthetic!");
      expect(
        await send(options, { version: 1, type: "login.probe.control", action: "release" }),
      ).toMatchObject({ ok: true });
      await done(options, 1);
      await expect(password).toHaveValue("Person-chosen-synthetic!");
      expect(await counts(typed)).toEqual({ next: 0, submit: 0 });
    });
  } finally {
    await fixture.close();
  }
});
