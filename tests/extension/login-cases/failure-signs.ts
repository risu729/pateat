import type { LoginCaseContext } from "./context";

export function registerFailureSigns({
  test,
  expect,
  logs,
  withLoginExtension,
  startLoginFixture,
  send,
  configure,
  stateLogs,
  clicks,
  codeEvidence,
}: Pick<
  LoginCaseContext,
  | "test"
  | "expect"
  | "logs"
  | "withLoginExtension"
  | "startLoginFixture"
  | "send"
  | "configure"
  | "stateLogs"
  | "clicks"
  | "codeEvidence"
>): void {
  /**
   * Characterize the local failure signs before changing ADR 0029. These recipes have no
   * learned rejection marker, so a fixture's plain error cannot bypass the local reading.
   * The competing and reopened tab checks run once per path: a rejected and a silent
   * released result, and a watched password and identifier result.
   */
  for (const variant of [
    {
      name: "an alert in the submitted document",
      path: "/credential-failure?error=alert",
      rejected: true,
      competing: true,
    },
    {
      name: "an alert in the first new document",
      path: "/credential-failure?error=alert&new-document",
      rejected: true,
    },
    {
      name: "plain text in the submitted document",
      path: "/credential-failure?error=plain",
      rejected: false,
      competing: true,
    },
    {
      name: "plain text in the first new document",
      path: "/credential-failure?error=plain&new-document",
      rejected: false,
    },
    {
      name: "a silent form in the first new document",
      path: "/credential-failure?new-document",
      rejected: false,
      competing: true,
    },
    {
      name: "an unknown identifier with plain text after advance",
      path: "/identifier-failure?error=plain",
      rejected: false,
      competing: true,
    },
    {
      name: "an unknown identifier without text after advance",
      path: "/identifier-failure",
      rejected: false,
    },
  ]) {
    test(`current failure handling: ${variant.name}`, async () => {
      const fixture = await startLoginFixture();
      try {
        await withLoginExtension(async (context, worker, id) => {
          const options = await context.newPage();
          await configure(options, id, fixture.origin);
          const page = await context.newPage();
          await page.goto(`${fixture.origin}${variant.path}`);
          await expect(page.locator("#response-state")).toHaveText("Answer received");
          const outcome = variant.rejected ? "credential-rejected" : "unknown-submit";
          await expect
            .poll(() => logs(worker, "login.attempt"), { timeout: 20_000 })
            .toContainEqual(expect.objectContaining({ outcome }));
          // The diagnostic log omits false flags.
          const readings = async () =>
            (await stateLogs(worker)).map((entry) => ({ ...entry, f2: entry["f2"] === true }));
          await expect.poll(readings).toContainEqual(
            expect.objectContaining({
              decision: variant.rejected ? "rejected" : "unknown",
              s1: true,
              f2: variant.rejected,
              ...(variant.path.includes("identifier") ? { reshownMiss: "not-submit" } : {}),
            }),
          );
          const status = () => send(options, { version: 1, type: "login.probe.status" });
          const released = variant.rejected || variant.path.includes("new-document");
          if (released)
            await expect.poll(status).toMatchObject({ attempts: [], asks: ["rejected"] });
          else
            await expect.poll(status).toMatchObject({
              attempts: [
                {
                  state: "reconciling",
                  outcome: "unknown-submit",
                  submissions: 1,
                  watch: expect.any(Object),
                },
              ],
            });
          // The popup's stored login result retains the distinction even after a brief
          // unknown badge expires. The choice badge may take priority after a rejection.
          const presentation = () =>
            worker.evaluate(async (url) => {
              const chrome = (
                globalThis as unknown as {
                  chrome: {
                    tabs: { query: (query: object) => Promise<{ id?: number; url?: string }[]> };
                    storage: {
                      session: { get: (key: string) => Promise<Record<string, unknown>> };
                    };
                  };
                }
              ).chrome;
              const tab = (await chrome.tabs.query({})).find((entry) => entry.url === url);
              const stored = (await chrome.storage.session.get("pateat.login-badge.v1"))[
                "pateat.login-badge.v1"
              ] as {
                statuses: [number, { login?: { outcome?: string } }][];
                results: [number, { kind: string; reason: string }][];
              };
              return {
                login: stored.statuses.find(([tabId]) => tabId === tab?.id)?.[1].login,
                result: stored.results.find(([tabId]) => tabId === tab?.id)?.[1],
              };
            }, page.url());
          await expect.poll(presentation).toMatchObject({
            login: { outcome },
            result: { kind: variant.rejected ? "failed" : "unsettled", reason: outcome },
          });
          const count = () =>
            page.evaluate(() => ({
              identity: Number(sessionStorage.getItem("identityClicks") || 0),
              password: Number(sessionStorage.getItem("submitClicks") || 0),
            }));
          const expected = variant.path.includes("identifier")
            ? { identity: 1, password: 0 }
            : { identity: 0, password: 1 };
          expect(await count()).toEqual(expected);
          if (!variant.competing) return;
          const tabs = () =>
            worker.evaluate(async () => {
              const chrome = (
                globalThis as unknown as {
                  chrome: {
                    tabs: { query: (query: object) => Promise<{ id?: number; url?: string }[]> };
                  };
                }
              ).chrome;
              return chrome.tabs.query({});
            });
          const originalTabs = await tabs();
          const tabId = originalTabs.find((tab) => tab.url === page.url())?.id;
          expect(tabId).toBeDefined();
          const documents = async () =>
            (
              (await status()) as {
                documents: { tabId: number; documentId: string; state?: string; reason?: string }[];
              }
            ).documents;
          const originalDocument = (await documents()).find(
            (entry) => entry.tabId === tabId,
          )?.documentId;
          expect(originalDocument).toBeDefined();
          // Admit a competing tab while the original result is held. Wait for that tab's
          // own refusal, not an earlier account ask belonging to the submitted page. A DOM
          // change first wakes the submitted page's content script, as a page that keeps
          // rendering would.
          await page.evaluate(() => document.body.append(document.createElement("p")));
          const other = await context.newPage();
          await other.goto(`${fixture.origin}${variant.path}`);
          const otherTabId = (await tabs()).find(
            (tab) => !originalTabs.some((old) => old.id === tab.id),
          )?.id;
          expect(otherTabId).toBeDefined();
          await expect.poll(documents).toContainEqual(
            expect.objectContaining({
              tabId: otherTabId,
              state: "denied",
              reason: expect.stringMatching(/origin-busy|account-asked|site-wait|other-tab/u),
            }),
          );
          // The probe intentionally runs a full login where production only fills while
          // asking. Record its one extra press after release; a watched result still holds,
          // which the click counts below show.
          if (released)
            await expect(other.locator("#response-state")).toHaveText("Answer received");
          expect(
            await other.evaluate(() => Number(sessionStorage.getItem("submitClicks") || 0)),
          ).toBe(released ? 1 : 0);
          expect(
            await other.evaluate(() => Number(sessionStorage.getItem("identityClicks") || 0)),
          ).toBe(0);
          expect(await count()).toEqual(expected);
          if (released) {
            // Reopen the start page, with its response flag cleared, in the original tab.
            // The probe's fill-only exception permits one press; its own denial bounds it.
            await page.goto(`${fixture.origin}${variant.path}`);
            await expect
              .poll(async () =>
                (await documents()).find(
                  (entry) => entry.tabId === tabId && entry.documentId !== originalDocument,
                ),
              )
              .toMatchObject({ state: "denied" });
            expect(await count()).toEqual({ identity: 0, password: 2 });
          } else {
            await expect.poll(status).toMatchObject({
              attempts: [
                {
                  state: "reconciling",
                  outcome: "unknown-submit",
                  submissions: 1,
                  watch: expect.any(Object),
                },
              ],
            });
            expect(await count()).toEqual(expected);
          }
        });
      } finally {
        await fixture.close();
      }
    });
  }

  test("Enter form validation reports a form-wide fill rejection without submitting", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, worker, id) => {
        // Reuse the buttonless form; its additional required checkbox is not a filled field.
        await context.route(
          (url) => url.origin === fixture.origin && url.pathname === "/enter-submit",
          async (route) => {
            const response = await route.fetch();
            const body = (await response.text()).replace(
              "</form>",
              '<label>Required agreement<input id="agreement" type="checkbox" required></label></form>',
            );
            await route.fulfill({ response, body });
          },
        );
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const diagnostics = await context.newPage();
        await diagnostics.goto(`chrome-extension://${id}/diagnostics.html`);
        expect(
          await send(diagnostics, { version: 1, type: "diagnostics.logs.debug", enabled: true }),
        ).toMatchObject({ ok: true });
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/enter-submit`);
        const rejected = async () =>
          (await logs(worker, "login.attempt")).find(
            (entry) =>
              entry["outcome"] === "structural-mismatch" && entry["cause"] === "form-invalid",
          );
        await expect.poll(rejected).toMatchObject({
          state: "reconciling",
          outcome: "structural-mismatch",
          cause: "form-invalid",
        });
        expect(await rejected()).not.toHaveProperty("fieldIndex");
        await expect(page.locator("#password")).not.toHaveValue("");
        await expect(page.locator("#agreement")).not.toBeChecked();
        expect(await clicks(page)).toBe(0);
        await expect(page.locator("#authenticated")).toHaveCount(0);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a page-wide alert after a split code reports no invented field index", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, worker, id) => {
        await context.route(
          (url) => url.origin === fixture.origin && url.pathname === "/totp-code",
          async (route) => {
            const response = await route.fetch();
            const body = (await response.text()).replace(
              "</body>",
              `<script>
              const feedback = document.createElement('p');
              feedback.id = 'code-rejection';
              feedback.setAttribute('role', 'alert');
              document.body.append(feedback);
              const form = document.getElementById('code-form');
              form.addEventListener('input', () => {
                if ([...form.querySelectorAll('input')].every((input) => input.value.length === 1))
                  feedback.textContent = 'Synthetic code was not accepted';
              });
            </script></body>`,
            );
            await route.fulfill({ response, body });
          },
        );
        const options = await context.newPage();
        await configure(options, id, fixture.origin, true, undefined, true);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/totp?split`);
        const rejected = async () =>
          (await logs(worker, "login.attempt")).find(
            (entry) => entry["outcome"] === "fill-rejected" && entry["cause"] === "alert-shown",
          );
        await expect.poll(rejected).toMatchObject({
          state: "blocked",
          outcome: "fill-rejected",
          cause: "alert-shown",
        });
        expect(await rejected()).not.toHaveProperty("fieldIndex");
        await expect(page.locator("#code-rejection")).toHaveText("Synthetic code was not accepted");
        expect(await codeEvidence(page)).toEqual({
          codeInputs: 6,
          verifyClicks: 0,
          autoSubmits: 0,
          codeMatched: null,
        });
        expect(JSON.stringify(await logs(worker, "login.attempt"))).not.toContain("012345");
        await expect(page.locator("#authenticated")).toHaveCount(0);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a cleared required password takes precedence over concurrent failure feedback", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, worker, id) => {
        await context.route(
          (url) =>
            url.origin === fixture.origin &&
            url.pathname === "/single" &&
            url.searchParams.get("reject-fill") === "switch-form",
          async (route) => {
            const response = await route.fetch();
            const body = (await response.text()).replace(
              "</body>",
              `<script>
              document.getElementById('password').addEventListener('change', (event) => {
                event.target.setAttribute('aria-invalid', 'true');
                document.body.insertAdjacentHTML(
                  'beforeend',
                  '<p role="alert">Synthetic replacement form needs another value</p>',
                );
              });
            </script></body>`,
            );
            await route.fulfill({ response, body });
          },
        );
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const diagnostics = await context.newPage();
        await diagnostics.goto(`chrome-extension://${id}/diagnostics.html`);
        expect(
          await send(diagnostics, { version: 1, type: "diagnostics.logs.debug", enabled: true }),
        ).toMatchObject({ ok: true });
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/single?reject-fill=switch-form`);
        await expect
          .poll(() => logs(worker, "login.attempt"))
          .toContainEqual(
            expect.objectContaining({
              state: "reconciling",
              outcome: "structural-mismatch",
              cause: "form-changed",
            }),
          );
        await expect(page.locator("#password")).toHaveValue("");
        await expect(page.locator("#password")).toHaveAttribute("aria-invalid", "true");
        expect(
          await page
            .locator("#password")
            .evaluate((input: HTMLInputElement) => input.validity.valueMissing),
        ).toBe(true);
        await expect(page.locator("#security")).toBeVisible();
        expect(await clicks(page)).toBe(0);
        await expect(page.locator("#authenticated")).toHaveCount(0);
      });
    } finally {
      await fixture.close();
    }
  });

  for (const [name, query, account] of [
    ["spaces", "space", "0000 1234"],
    ["hyphens", "hyphen", "0000-1234"],
  ] as const) {
    test("keeps account grouping with " + name + " and completes every login field", async () => {
      const fixture = await startLoginFixture();
      try {
        await withLoginExtension(async (context, worker, id) => {
          const options = await context.newPage();
          await configure(options, id, fixture.origin);
          const page = await context.newPage();
          await page.goto(fixture.origin + "/identity?group-account=" + query);
          await expect(page.locator("#authenticated")).toBeVisible({ timeout: 15_000 });
          expect(
            await page.evaluate(() => ({
              identity: JSON.parse(sessionStorage.getItem("identity") || "null") as unknown,
              identityClicks: Number(sessionStorage.getItem("identityClicks") || 0),
              submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
              identityMatched: sessionStorage.getItem("identityMatched"),
              passwordMatched: sessionStorage.getItem("passwordMatched"),
            })),
          ).toEqual({
            identity: ["007", account],
            identityClicks: 1,
            submitClicks: 1,
            identityMatched: "true",
            passwordMatched: "true",
          });
          await expect
            .poll(() => logs(worker, "login.attempt"))
            .toContainEqual(expect.objectContaining({ outcome: "authenticated" }));
        });
      } finally {
        await fixture.close();
      }
    });
  }
}
