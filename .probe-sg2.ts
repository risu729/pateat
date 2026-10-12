import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
const bundle = readFileSync("/tmp/claude-0/-home-user-pateat/f261b567-a851-55a3-8b8d-4ee7481af6ac/scratchpad/probe-sg/bundle.js", "utf8");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-AU" });
await page.goto("https://ibanking.stgeorge.com.au/ibank/loginPage.action", { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(4000);
await page.addScriptTag({ content: bundle });
const out = await page.evaluate(async () => {
  const w = window as any; const $ = w.jQuery;
  $.ajax = () => undefined; // never reach the bank's server
  // The page's own simplified-logon branch (logonSimple.js), as with a remembered access number.
  w.isSimplifiedLogon = true;
  $('.fullLogon').hide(); $('.simplifiedLogon').show();
  $("#access-number").val("12345678").on("keydown change", () => w.showFullLogon());
  const vis = (id: string) => { const e = document.getElementById(id)!; return e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== "none"; };
  const before = w.probe().result;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const fill = (id: string, value: string) => { const i = document.getElementById(id) as HTMLInputElement; setter.call(i, value); i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); };
  fill("access-number", "87654321");
  fill("internet-password", "synthetic");
  await new Promise((r) => setTimeout(r, 500));
  return { before, after: { access: (document.getElementById("access-number") as HTMLInputElement).value, password: (document.getElementById("internet-password") as HTMLInputElement).value.length, security: (document.getElementById("securityNumber") as HTMLInputElement).value, securityShown: vis("securityNumber") } };
});
writeFileSync("/tmp/claude-0/-home-user-pateat/f261b567-a851-55a3-8b8d-4ee7481af6ac/scratchpad/probe-sg/out2.json", JSON.stringify(out, null, 1));
await browser.close();
