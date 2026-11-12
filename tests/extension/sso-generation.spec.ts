import { expect, test } from "@playwright/test";
import { sendToBackground as send } from "./background-message";
import { settingsRequest } from "./connection-fixture";
import {
  chooseExample,
  configureSso,
  confirmationProofs,
  idpRecipeId,
  items,
  openSsoPopup,
  origins,
  ssoStatus,
  unchangedIdpDefault,
} from "./sso-fixture";
import { startSyncService } from "./sync-service";
import { withVaultProfile } from "./vault-fixture";
import type { RecipeDocument } from "../../packages/contracts/src/index";

type Prompt = {
  task: string;
  labels?: string[];
  slots?: unknown[];
  observation: {
    origin: string;
    path: string;
    candidates: { id: string; target: { by: string; value: string } }[];
  };
};
async function generatedSso(markerReturn: boolean, missingMarker = false) {
  test.setTimeout(60_000);
  const prompts: Prompt[] = [];
  const service = await startSyncService({
    claude: (path, payload) => {
      if (path === "/v1/oauth/token")
        return { access_token: "synthetic-access-token", token_type: "Bearer", expires_in: 600 };
      if (path !== "/v1/messages") throw new Error("Unexpected synthetic inference path");
      const body = JSON.parse(payload) as { messages: { content: string | { text?: string }[] }[] };
      const prompt = body.messages
        .flatMap((message) =>
          typeof message.content === "string"
            ? [message.content]
            : message.content.flatMap((part) => (part.text ? [part.text] : [])),
        )
        .map((text) => {
          try {
            return JSON.parse(text) as Prompt;
          } catch {
            return undefined;
          }
        })
        .find((value) => value?.task);
      if (!prompt || !["sso", "judge-sign-in"].includes(prompt.task))
        throw new Error("Unexpected synthetic inference role");
      prompts.push(prompt);
      const entry = prompt.observation.candidates.find(
        (candidate) =>
          candidate.target.by === "id" &&
          candidate.target.value === (prompt.task === "sso" ? "sso" : "rp-dashboard"),
      );
      if (!entry && prompt.task === "sso")
        throw new Error("Synthetic observed provider entry missing");
      const result =
        prompt.task === "sso"
          ? {
              decision: "plan",
              page: "sign-in",
              entries: [{ label: "Example", candidate: entry!.id }],
            }
          : entry
            ? { decision: "signed-in", marker: entry.id }
            : { decision: "unclear" };
      return {
        id: "msg_synthetic_sso",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              result,
            }),
          },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3000, output_tokens: 900 },
      };
    },
  });
  try {
    await withVaultProfile(
      async (open) => {
        const browser = await open();
        let showMarker = true;
        const { options, evidence, recipes } = await configureSso(
          browser,
          markerReturn ? "rp-marker" : "return",
          { rpMarkerPresent: () => showMarker },
        );
        const native = recipes.find((recipe) => recipe.id === idpRecipeId);
        if (!native) throw new Error("Synthetic provider recipe missing");
        expect(
          (
            await service.request("/v1/recipes/" + native.id, {
              method: "PUT",
              body: { version: 1, expectedRevision: 0, state: "active", recipe: native },
            })
          ).status,
        ).toBe(200);
        await browser.background.evaluate(
          async (record) => {
            const chrome = (
              globalThis as unknown as {
                chrome: { storage: { local: { set(value: unknown): Promise<void> } } };
              }
            ).chrome;
            await chrome.storage.local.set({
              "pateat.device-recipes.v1": { version: 1, recipes: [] },
              "pateat.sync-service.v1": record,
            });
          },
          {
            version: 1,
            kind: "connected",
            origin: service.origin,
            label: "Synthetic SSO device",
            deviceId: service.deviceId,
            credential: service.credential,
          },
        );
        expect(await send(options, { version: 1, type: "service.get" })).toMatchObject({
          ok: true,
          state: { kind: "connected" },
        });
        const saved = await settingsRequest(options);
        await settingsRequest(options, {
          version: 1,
          type: "settings.save",
          expectedRevision: saved.snapshot.revision,
          settings: saved.snapshot.settings,
        });
        await expect
          .poll(async () => (await settingsRequest(options)).catalog.settingsSyncPending)
          .toBeUndefined();
        const page = await browser.context.newPage();
        await page.goto(origins.rp + "/login");
        await chooseExample(await openSsoPopup(browser, options, page));
        try {
          await expect(page.locator("#authenticated")).toBeVisible({ timeout: 15_000 });
        } catch (error) {
          throw new Error(
            "Synthetic generated SSO flow failed: " +
              JSON.stringify({ url: page.url(), evidence, status: await ssoStatus(options) }),
            { cause: error },
          );
        }
        await expect
          .poll(
            async () =>
              (await ssoStatus(options)).attempts.find((attempt) => attempt.route === "sso")?.state,
          )
          .toBe("authenticated");
        expect(prompts).toHaveLength(markerReturn ? 2 : 1);
        expect(prompts[0]).toMatchObject({
          task: "sso",
          labels: ["Example"],
          observation: { origin: origins.rp, path: "/login" },
        });
        if (markerReturn)
          expect(prompts[1]).toMatchObject({
            task: "judge-sign-in",
            slots: [],
            observation: { origin: origins.rp, path: "/complete" },
          });
        const serialized = JSON.stringify(prompts);
        for (const absent of [
          origins.idp,
          "test_username",
          "test_password",
          "rp_user",
          items.rp,
          items.idp,
          "sourceEvidence",
          "usernameProof",
          "connectionId",
        ])
          expect(serialized).not.toContain(absent);
        const cache = await browser.background.evaluate(async () => {
          const chrome = (
            globalThis as unknown as {
              chrome: {
                storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
              };
            }
          ).chrome;
          return (await chrome.storage.local.get("pateat.sync-recipes.v1"))[
            "pateat.sync-recipes.v1"
          ] as { recipes: RecipeDocument[] };
        });
        expect(cache.recipes.find((recipe) => recipe.origin === origins.rp)).toMatchObject({
          sso: {
            path: "/login",
            layouts: [{ entries: [{ label: "Example", target: { by: "id", value: "sso" } }] }],
          },
        });
        expect(cache.recipes.some((recipe) => recipe.id === idpRecipeId)).toBe(true);
        if (markerReturn) {
          expect(cache.recipes.find((recipe) => recipe.origin === origins.rp)).toMatchObject({
            revision: 2,
            sso: { layouts: [{ completion: [{ target: { by: "id", value: "rp-dashboard" } }] }] },
          });
          const stored = (await (await service.request("/v1/recipes")).json()) as {
            changes: { recipe?: RecipeDocument }[];
          };
          expect(
            stored.changes.some(
              (change) =>
                change.recipe?.origin === origins.rp &&
                change.recipe.revision === 2 &&
                change.recipe.sso?.layouts[0]?.completion?.[0]?.target.value === "rp-dashboard",
            ),
          ).toBe(true);
        }
        if (missingMarker) showMarker = false;
        const again = await browser.context.newPage();
        await again.goto(origins.rp + "/login");
        if (missingMarker) {
          await expect(again.locator("#returned")).toBeVisible({ timeout: 15_000 });
          await expect
            .poll(
              async () =>
                (await ssoStatus(options)).attempts
                  .filter((attempt) => attempt.route === "sso")
                  .at(-1)?.state,
              { timeout: 15_000 },
            )
            .toBe("blocked");
          const parent = (await ssoStatus(options)).attempts
            .filter((attempt) => attempt.route === "sso")
            .at(-1)!;
          expect(
            (await confirmationProofs(browser))?.proofs?.some(
              (proof) => proof.tabId === parent.document.tabId,
            ) ?? false,
          ).toBe(false);
          expect(evidence).toMatchObject({ entries: 2, posts: 2, matched: true, returns: 2 });
          expect(prompts.filter((prompt) => prompt.task === "sso")).toHaveLength(1);
          await unchangedIdpDefault(options);
          return;
        }
        try {
          await expect(again.locator("#authenticated")).toBeVisible({ timeout: 15_000 });
        } catch (error) {
          throw new Error(
            "Synthetic SSO cache reuse failed: " +
              JSON.stringify({
                url: again.url(),
                evidence,
                status: await ssoStatus(options),
                prompts: prompts.length,
              }),
            { cause: error },
          );
        }
        await expect.poll(() => evidence.posts).toBe(2);
        expect(evidence).toMatchObject({ entries: 2, posts: 2, matched: true, returns: 2 });
        expect(prompts).toHaveLength(markerReturn ? 2 : 1);
        await unchangedIdpDefault(options);
      },
      { args: ["--ignore-certificate-errors"] },
    );
  } finally {
    await service.close();
  }
}

test("synthetic service generation stores scoped SSO entries and the packaged coordinator reuses the cache", async () =>
  generatedSso(false));
test("the SSO return judge learns a D1 marker and cached completion still requires that marker on the fresh RP document", async () =>
  generatedSso(true));

test("a cached signed-in SSO verdict grants no completion when the fresh RP document lacks its learned marker", async () =>
  generatedSso(true, true));
