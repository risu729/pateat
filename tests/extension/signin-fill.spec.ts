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
async function counts(page: Page) {
  return page.evaluate(() => ({
    next: Number(sessionStorage.getItem("identityClicks") || 0),
    submit: Number(sessionStorage.getItem("submitClicks") || 0),
  }));
}

test("profile autofill crosses documents only after the person presses Next and leaves submission to them", async () => {
  const fixture = await startLoginFixture();
  try {
    await withLoginExtension(async (context, _worker, id) => {
      const options = await context.newPage();
      await configure(options, id, fixture.origin);
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
      await waiting(options, 5);
      expect(await counts(page)).toEqual({ next: 1, submit: 0 });
      await page.getByRole("button", { name: "Log in", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Authenticated synthetic account", exact: true }),
      ).toBeVisible();
      expect(await counts(page)).toEqual({ next: 1, submit: 1 });
    });
  } finally {
    await fixture.close();
  }
});

test("profile autofill follows the person's same-document Next without pressing a button", async () => {
  const fixture = await startLoginFixture();
  try {
    await withLoginExtension(async (context, _worker, id) => {
      const options = await context.newPage();
      await configure(options, id, fixture.origin);
      const page = await context.newPage();
      await page.goto(`${fixture.origin}/identifier-first`);
      await expect(page.locator("#account")).toHaveValue("00001234");
      await waiting(options, 1);
      expect(await counts(page)).toEqual({ next: 0, submit: 0 });
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(page.locator("#password")).toHaveValue("Pateat-synthetic-only!");
      await waiting(options, 3);
      expect(await counts(page)).toEqual({ next: 1, submit: 0 });
      await expect(page).toHaveURL(`${fixture.origin}/identifier-first`);
    });
  } finally {
    await fixture.close();
  }
});

test("an effectful fill is left empty without a POST or fallback click under profile autofill", async () => {
  const fixture = await startLoginFixture();
  try {
    await withLoginExtension(async (context, _worker, id) => {
      const options = await context.newPage();
      await configure(options, id, fixture.origin);
      const runId = fixture.createRun();
      const page = await context.newPage();
      await page.goto(`${fixture.origin}/input-submit?runId=${runId}`);
      await waiting(options, 0);
      await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
      expect(fixture.evidence(runId)).toEqual({
        posts: 0,
        inputPosts: 0,
        clickPosts: 0,
        allMatched: true,
      });
      await expect(page.locator("#effect-status")).toHaveText("No POST observed");
      expect(await counts(page)).toEqual({ next: 0, submit: 0 });
    });
  } finally {
    await fixture.close();
  }
});

test("a person typing before value delivery keeps their password with the real document-start recorder", async () => {
  const fixture = await startLoginFixture();
  try {
    await withLoginExtension(async (context, _worker, id) => {
      const options = await context.newPage();
      await configure(options, id, fixture.origin);
      expect(
        await send(options, {
          version: 1,
          type: "login.probe.control",
          action: "arm",
          checkpoint: "before-delivery",
        }),
      ).toMatchObject({ ok: true });
      const page = await context.newPage();
      await page.goto(`${fixture.origin}/single`);
      await expect
        .poll(() => send(options, { version: 1, type: "login.probe.status" }))
        .toMatchObject({
          checkpoint: "before-delivery",
          attempts: [{ signInFill: true, operationKind: "fill", submissions: 0 }],
        });
      const password = page.getByLabel("Password", { exact: true });
      await password.pressSequentially("Person-chosen-synthetic!");
      expect(
        await send(options, { version: 1, type: "login.probe.control", action: "release" }),
      ).toMatchObject({ ok: true });
      await waiting(options, 1);
      await expect(password).toHaveValue("Person-chosen-synthetic!");
      expect(await counts(page)).toEqual({ next: 0, submit: 0 });
    });
  } finally {
    await fixture.close();
  }
});
