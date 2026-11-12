import { expect, type Page } from "@playwright/test";
import {
  newLayoutKey,
  toLoginLayout,
  type LoginRecipe,
  type RecipeDocument,
} from "../../packages/contracts/src/index";
import {
  syntheticSsoItemIds as items,
  syntheticSsoOrigins as origins,
} from "../../packages/bitwarden/src/__fixtures__/sso-account";
import { sendToBackground as send } from "./background-message";
import {
  beginInput,
  catalogAccount,
  settingsRequest,
  setupProbe,
  setupRequest,
  useOnly,
} from "./connection-fixture";
import type { VaultBrowser } from "./vault-fixture";
import { passkeyPageHtml } from "./passkey-server";

export { items, origins };
export const idpRecipeId = "synthetic-idp-native";
export type SsoScenario =
  | "return"
  | "idp-complete"
  | "consent"
  | "signup"
  | "sharing"
  | "nested"
  | "fedcm"
  | "new-origin"
  | "new-window"
  | "target-changed"
  | "exact-destination"
  | "wrong-rp"
  | "rp-unknown"
  | "rp-signup"
  | "passkey"
  | "selected-origin"
  | "rp-marker"
  | "intermediate";
export type SsoEvidence = {
  entries: number;
  posts: number;
  matched: boolean;
  returns: number;
  unsafeClicks: number;
};
const html = (body: string) =>
  "<!doctype html><html lang=en><meta charset=utf-8><title>Synthetic sign in</title>" +
  body +
  "</html>";

/** Synthetic sites only. Browser requests traverse the normal extension content/runtime path. */
export async function configureSso(
  browser: VaultBrowser,
  scenario: SsoScenario = "return",
  controls: { holdIdp?: boolean; rpMarkerPresent?: () => boolean } = {},
) {
  let releaseIdp!: () => void;
  const idpReady = new Promise<void>((resolve) => {
    releaseIdp = resolve;
  });
  if (!controls.holdIdp) releaseIdp();
  const passkeyResults: Record<string, unknown>[] = [];
  const idpEvents: string[] = [];
  const evidence: SsoEvidence = {
    entries: 0,
    posts: 0,
    matched: true,
    returns: 0,
    unsafeClicks: 0,
  };
  const destination =
    scenario === "new-origin"
      ? "https://unselected.synthetic.example.test/login"
      : origins.idp + "/login";
  await browser.context.route("https://**.synthetic.example.test/**", async (route) => {
    const url = new URL(route.request().url());
    const respond = (body: string) => route.fulfill({ contentType: "text/html", body: html(body) });
    if (url.origin === origins.rp && url.pathname === "/login") {
      const heading = "<h1>Sign in</h1>";
      const target = scenario === "new-window" ? " target=_blank" : "";
      const changed =
        scenario === "target-changed"
          ? "<script>document.querySelector('#sso').addEventListener('pointerdown',()=>document.querySelector('#sso').setAttribute('href','https://unselected.synthetic.example.test/login'))</script>"
          : "";
      return respond(
        heading +
          '<a id="sso" href="' +
          destination +
          '"' +
          target +
          ">Continue with Example</a>" +
          changed,
      );
    }
    if (url.origin === origins.idp && ["/login", "/password"].includes(url.pathname)) {
      if (url.pathname === "/login") evidence.entries++;
      await idpReady;
      if (scenario === "intermediate" && url.pathname === "/login")
        return respond(
          '<h1>Choose an account</h1><button id=choose-exact>test_username</button><button id=choose-wrong>attacker</button><script>document.querySelector("#choose-exact").onclick=()=>fetch("/choice-exact",{method:"POST"}).then(()=>location.replace("/password"));document.querySelector("#choose-wrong").onclick=()=>fetch("/choice-wrong",{method:"POST"});</script>',
        );
      if (scenario === "passkey") {
        const completion =
          '<script>window.nextSpec={challenge:"00".repeat(32)};const original=window.request; window.request=spec=>original(spec).then(async result=>{if(!result.error){const response=await fetch("/passkey-session",{method:"POST",body:JSON.stringify(result)});if(response.ok)location.replace(' +
          JSON.stringify(origins.rp + "/complete") +
          ");}return result;});</script>";
        return route.fulfill({ contentType: "text/html", body: passkeyPageHtml + completion });
      }
      const unsafe = {
        consent:
          "<h1>Consent to requested permissions</h1><p>test_username</p><button id=unsafe>Continue</button>",
        signup: "<h1>Create account</h1><p>test_username</p><button id=unsafe>Continue</button>",
        sharing:
          "<h1>Choose an account</h1><p>Your account details will be shared with this application.</p><button id=unsafe>test_username</button>",
        nested:
          '<h1>Sign in</h1><a id=unsafe href="https://third.synthetic.example.test/login">Continue with another provider</a>',
        fedcm:
          "<h1>Sign in with browser identity</h1><button id=unsafe>Use browser identity</button>",
      }[scenario as "consent" | "signup" | "sharing" | "nested" | "fedcm"];
      if (unsafe)
        return respond(
          unsafe +
            "<script>document.querySelector('#unsafe').onclick=()=>fetch('/unsafe-effect',{method:'POST'})</script>",
        );
      const action =
        scenario === "exact-destination"
          ? "https://submit.idp.synthetic.example.test/not-saved"
          : scenario === "selected-origin"
            ? "https://submit.idp.synthetic.example.test/session"
            : "/session";
      return respond(
        '<h1>Sign in to Example</h1><form method=POST action="' +
          action +
          '"><label>Username<input id=username name=username autocomplete=username></label><label>Password<input id=password name=password type=password autocomplete=current-password></label><button id=login>Log in</button></form>',
      );
    }
    if (
      url.origin === origins.idp &&
      ["/choice-exact", "/choice-wrong", "/continue-effect", "/stay-yes", "/stay-no"].includes(
        url.pathname,
      )
    ) {
      idpEvents.push(url.pathname);
      return route.fulfill({ status: 204, body: "" });
    }
    if (url.origin === origins.idp && url.pathname === "/stay") {
      return respond(
        '<title>Stay signed in?</title><h1>Stay signed in?</h1><p>test_username</p><button id=stay-yes>Yes</button><button id=stay-no>No</button><script>document.querySelector("#stay-yes").onclick=()=>fetch("/stay-yes",{method:"POST"}).then(()=>location.replace(' +
          JSON.stringify(origins.rp + "/complete") +
          '));document.querySelector("#stay-no").onclick=()=>fetch("/stay-no",{method:"POST"});</script>',
      );
    }
    if (url.origin === origins.idp && url.pathname === "/passkey-session") {
      evidence.posts++;
      const result = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      passkeyResults.push(result);
      evidence.matched &&=
        typeof result["signature"] === "string" && result["type"] === "public-key";
      return route.fulfill({ status: 204, body: "" });
    }
    if (
      (url.origin === origins.idp || url.origin === "https://submit.idp.synthetic.example.test") &&
      ["/session", "/not-saved"].includes(url.pathname)
    ) {
      evidence.posts++;
      const values = new URLSearchParams(route.request().postData() ?? "");
      evidence.matched &&=
        values.get("username") === "test_username" && values.get("password") === "test_password";
      if (scenario === "intermediate")
        return respond(
          '<header><span>test_username</span><a href=/logout>Sign out</a></header><h1 id=idp-authenticated>Provider authenticated</h1><button id=continue>Continue</button><script>document.querySelector("#continue").onclick=()=>fetch("/continue-effect",{method:"POST"}).then(()=>location.replace("/stay"));</script>',
        );
      if (scenario === "idp-complete")
        return respond(
          '<header><span>test_username</span><a href=/logout>Sign out</a></header><h1 id=idp-authenticated>Provider authenticated</h1><a id=return href="' +
            origins.rp +
            '/complete">Return to relying party</a>',
        );
      // Playwright routes do not intercept the remainder of a fulfilled redirect chain.
      // A new same-tab navigation keeps both synthetic origins under interception.
      return respond(
        "<script>location.replace(" + JSON.stringify(origins.rp + "/complete") + ")</script>",
      );
    }
    if (url.origin === origins.idp && url.pathname === "/unsafe-effect") {
      evidence.unsafeClicks++;
      return route.fulfill({ status: 204, body: "" });
    }
    if (url.origin === origins.rp && url.pathname === "/complete") {
      evidence.returns++;
      if (scenario === "rp-marker")
        return respond(
          controls.rpMarkerPresent?.() === false
            ? "<h1 id=returned>Returned to relying party</h1>"
            : "<h1 id=authenticated>Account dashboard</h1><nav><a id=rp-dashboard href=/dashboard>Open your account dashboard</a></nav>",
        );
      if (scenario === "wrong-rp")
        return respond(
          "<header><span>attacker_user</span><a href=/logout>Sign out</a></header><h1>Another account</h1>",
        );
      if (scenario === "rp-unknown")
        return respond("<h1>Returned to relying party</h1><p>No account has been identified.</p>");
      if (scenario === "rp-signup")
        return respond(
          "<header><span>rp_user</span></header><h1>Create account</h1><button>Complete registration</button>",
        );
      return respond(
        "<header><span>rp_user</span><a href=/logout>Sign out</a></header><h1 id=authenticated>Authenticated relying party</h1>",
      );
    }
    return respond("<h1>Unexpected destination</h1>");
  });
  expect(
    await setupProbe(browser.page, {
      action: "configure",
      variant:
        scenario === "exact-destination"
          ? "sso-exact-uri"
          : scenario === "passkey"
            ? "sso-passkey"
            : scenario === "selected-origin"
              ? "sso-sibling-uri"
              : "sso",
    }),
  ).toMatchObject({ ok: true });
  const options = await browser.context.newPage();
  await options.goto("chrome-extension://" + browser.extensionId + "/options.html");
  const accepted = await setupRequest(options, { type: "connection.begin", input: beginInput() });
  if (!accepted.ok || accepted.kind !== "ready")
    throw new Error("Synthetic encrypted SSO setup failed");
  const initial = await settingsRequest(options);
  const connection = initial.catalog.connections.find(
    (entry) => entry.id === accepted.connectionId,
  );
  if (!connection || connection.items.length !== 3)
    throw new Error("Synthetic SSO catalog missing");
  const identity = catalogAccount(initial.catalog, connection.id);
  const settings = useOnly(initial.snapshot.settings, initial.catalog, connection.id);
  settings.siteDefaults = [
    { origin: origins.rp, ...identity, itemId: items.rp },
    { origin: origins.idp, ...identity, itemId: items.decoy },
  ];
  settings.bindings = [
    {
      origin: origins.idp,
      recipeId: idpRecipeId,
      ...identity,
      itemId: items.idp,
      itemName: "Example",
      slots: [
        { slot: "username", field: "username" },
        { slot: "password", field: "password" },
      ],
    },
  ];
  await settingsRequest(options, {
    version: 1,
    type: "settings.save",
    expectedRevision: initial.snapshot.revision,
    settings,
  });
  const native: LoginRecipe = {
    version: 1,
    id: idpRecipeId,
    revision: 1,
    origin: origins.idp,
    pageKind: "sign-in",
    slots: ["username", "password"],
    steps: [
      {
        kind: "fill",
        effect: "prepare",
        path: scenario === "intermediate" ? "/password" : "/login",
        fields: [
          { slot: "username", target: { by: "id", value: "username" } },
          { slot: "password", target: { by: "id", value: "password" } },
        ],
      },
      {
        kind: "click",
        path: scenario === "intermediate" ? "/password" : "/login",
        target: { by: "id", value: "login" },
        purpose: "submit",
      },
    ],
    completion: [{ target: { by: "id", value: "idp-authenticated" } }],
    ...(scenario === "passkey"
      ? { passkey: { path: "/login", target: { by: "id" as const, value: "sign-in" } } }
      : {}),
    maxSubmissions: 1,
  };
  const createdAt = Date.now();
  const recipes: RecipeDocument[] = [
    {
      version: 1,
      id: "synthetic-rp-sso",
      revision: 1,
      origin: origins.rp,
      sso: {
        path: "/login",
        layouts: [
          {
            key: newLayoutKey(createdAt, []),
            createdAt,
            entries: [{ label: "Example", target: { by: "id", value: "sso" } }],
          },
        ],
      },
    },
    {
      version: 1,
      id: idpRecipeId,
      revision: 1,
      origin: origins.idp,
      layouts: [toLoginLayout(native, { key: newLayoutKey(createdAt + 1, []), createdAt })],
    },
  ];
  // The normal device recipe cache is the only recipe input. No runtime authority is injected.
  await browser.background.evaluate(
    async (value) => {
      const chrome = (
        globalThis as unknown as {
          chrome: { storage: { local: { set(value: unknown): Promise<void> } } };
        }
      ).chrome;
      await chrome.storage.local.set({ "pateat.device-recipes.v1": value });
    },
    { version: 1, recipes },
  );
  return {
    options,
    evidence,
    connectionId: connection.id,
    releaseIdp,
    recipes,
    passkeyResults,
    idpEvents,
  };
}

export type AttemptStatus = {
  id: string;
  state: string;
  route: string;
  ssoChild?: { parentId: string; attemptId: string };
  outcome?: string;
  account: { origin: string; itemId: string };
  document: { tabId: number };
};
export async function ssoStatus(options: Page) {
  return (await send(options, { version: 1, type: "login.probe.status" })) as {
    attempts: AttemptStatus[];
    documents: { reason?: string; state?: string }[];
  };
}
export async function openSsoPopup(browser: VaultBrowser, options: Page, site: Page) {
  await site.bringToFront();
  const opened = browser.context.waitForEvent("page");
  await options.evaluate(
    async (url) => {
      const chrome = (
        globalThis as unknown as {
          chrome: { tabs: { create(value: { url: string; active: boolean }): Promise<unknown> } };
        }
      ).chrome;
      await chrome.tabs.create({ url, active: false });
    },
    "chrome-extension://" + browser.extensionId + "/popup.html",
  );
  const popup = await opened;
  try {
    await expect(popup.getByRole("region", { name: "Sign-in method", exact: true })).toBeVisible();
  } catch (error) {
    const metadata = (await settingsRequest(options)).catalog.connections.map((connection) => ({
      provider: connection.provider,
      items: connection.items.map((item) => ({
        id: item.id,
        fields: item.fields.map((field) => ({ name: field.name, empty: field.empty })),
      })),
    }));
    throw new Error(
      "Synthetic SSO offer unavailable: " +
        JSON.stringify({ status: await ssoStatus(options), metadata }),
      { cause: error },
    );
  }
  return popup;
}
export async function chooseExample(popup: Page) {
  const methods = popup.getByRole("region", { name: "Sign-in method", exact: true });
  await methods
    .getByRole("combobox", { name: "Method for this sign-in", exact: true })
    .selectOption("1");
  const provider = methods.getByRole("combobox", {
    name: "Saved account and sign-in origin",
    exact: true,
  });
  // Only the exact native username and its own URI is eligible; the saved default is absent.
  const choices = await provider.locator("option").allTextContents();
  expect(choices.some((value) => value.includes(items.idp))).toBe(true);
  expect(choices.some((value) => value.includes(items.decoy))).toBe(false);
  const value = await provider
    .locator("option")
    .filter({ hasText: items.idp })
    .filter({ hasText: origins.idp })
    .getAttribute("value");
  if (!value) throw new Error("Exact synthetic provider account was not offered");
  await provider.selectOption(value);
  await methods.getByRole("button", { name: "Save provider mapping", exact: true }).click();
  await expect(
    methods.getByRole("button", { name: "Remove provider mapping", exact: true }),
  ).toBeVisible();
  await methods.getByRole("button", { name: "Continue", exact: true }).click();
}
export async function unchangedIdpDefault(options: Page) {
  const saved = await settingsRequest(options);
  expect(
    saved.snapshot.settings.siteDefaults.find((entry) => entry.origin === origins.idp)?.itemId,
  ).toBe(items.decoy);
}
export async function confirmationProofs(browser: VaultBrowser) {
  return await browser.background.evaluate(async () => {
    const chrome = (
      globalThis as unknown as {
        chrome: { storage: { session: { get(key: string): Promise<Record<string, unknown>> } } };
      }
    ).chrome;
    return (await chrome.storage.session.get("pateat.confirm-fills.v1"))[
      "pateat.confirm-fills.v1"
    ] as { proofs?: { origin: string; itemId: string; tabId: number }[] } | undefined;
  });
}
