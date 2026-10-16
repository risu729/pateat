import { describe, expect, it } from "vitest";
import { senderDocumentOrigin } from "./sender";

describe("a sender's document origin", () => {
  it("is the browser-reported origin when it is the URL's", () => {
    expect(
      senderDocumentOrigin({
        origin: "https://login.example",
        url: "https://login.example/signin?next=%2F#form",
      }),
    ).toBe("https://login.example");
    // A default port is not part of either origin.
    expect(
      senderDocumentOrigin({ origin: "https://login.example", url: "https://login.example:443/" }),
    ).toBe("https://login.example");
  });

  it.each<[string, { origin?: unknown; url?: unknown }]>([
    // A page served with a CSP `sandbox` header, or a sandboxed frame, on the site's URL.
    ["an opaque origin on the site's URL", { origin: "null", url: "https://login.example/signin" }],
    ["an opaque origin on an opaque URL", { origin: "null", url: "data:text/html,<p>" }],
    ["no origin", { url: "https://login.example/signin" }],
    ["an undefined origin", { origin: undefined, url: "https://login.example/signin" }],
    ["another site's origin", { origin: "https://other.example", url: "https://login.example/" }],
    [
      "another port's origin",
      { origin: "https://login.example:8443", url: "https://login.example/" },
    ],
    ["another scheme's origin", { origin: "http://login.example", url: "https://login.example/" }],
    ["an unparsable URL", { origin: "https://login.example", url: "not a URL" }],
    ["no URL", { origin: "https://login.example" }],
    [
      "a non-string origin",
      { origin: { toString: () => "https://login.example" }, url: "https://login.example/" },
    ],
    [
      "a non-string URL",
      { origin: "https://login.example", url: new URL("https://login.example/") },
    ],
  ])("is none for %s", (_name, sender) => {
    expect(senderDocumentOrigin(sender as never)).toBeUndefined();
  });
});
