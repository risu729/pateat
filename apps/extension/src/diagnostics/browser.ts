import type { BrowserInfo } from "./report";

type BrandVersion = { brand: string; version: string };
export type UserAgentData = {
  getHighEntropyValues(hints: string[]): Promise<{ fullVersionList?: BrandVersion[] }>;
};

/** The Chrome or Chromium entry of the full version list; GREASE brands are skipped. */
export function pickBrowser(list: readonly BrandVersion[] | undefined): {
  name: string;
  version: string;
} {
  for (const brand of ["Google Chrome", "Chromium"]) {
    const found = list?.find((entry) => entry.brand === brand);
    if (found)
      return { name: brand === "Google Chrome" ? "Chrome" : "Chromium", version: found.version };
  }
  return { name: "Unknown browser", version: "" };
}

/** Read on the page: the browser version and how this extension was installed. */
export async function readBrowserInfo(deps: {
  userAgentData?: UserAgentData | undefined;
  getSelf(): Promise<{ installType: string }>;
}): Promise<BrowserInfo> {
  const [values, self] = await Promise.all([
    deps.userAgentData?.getHighEntropyValues(["fullVersionList"]).catch(() => undefined),
    // A missing API throws synchronously; either failure only hides the install type.
    Promise.resolve()
      .then(() => deps.getSelf())
      .catch(() => ({ installType: "unknown" })),
  ]);
  return { ...pickBrowser(values?.fullVersionList), installType: self.installType };
}
