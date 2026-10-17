import { describe, expect, it } from "vitest";
import { observedPath, redactsPath } from "./path";

describe("observedPath (ADR 0039)", () => {
  it("replaces each whole token-like segment and leaves others", () => {
    expect(observedPath("/123e4567-e89b-12d3-a456-426614174000/oauth2/authorize")).toBe(
      "/[id]/oauth2/authorize",
    );
    expect(observedPath("/oauth2/aus1a2b3c4d5e6f7g8h9/v1/authorize")).toBe(
      "/oauth2/[id]/v1/authorize",
    );
    expect(observedPath("/app/login;jsessionid=Synthetic0Session1")).toBe("/app/[id]");
    expect(observedPath("/user/12345/login")).toBe("/user/12345/login");
    expect(observedPath("/")).toBe("/");
    expect(redactsPath("/oauth2/aus1a2b3c4d5e6f7g8h9/v1/authorize")).toBe(true);
    expect(redactsPath("/oauth2/default/v1/authorize")).toBe(false);
  });

  it("replaces a segment that holds an email address, percent-encoded or not", () => {
    expect(observedPath("/u/taro.yamada@example.com/signin")).toBe("/u/[id]/signin");
    expect(observedPath("/reset/taro%40example.com")).toBe("/reset/[id]");
  });

  it("is unchanged when redacted again, so either side of a comparison may be redacted", () => {
    for (const path of ["/[id]/oauth2/authorize", "/s/[id]/login", "/app/[id]"])
      expect(observedPath(path)).toBe(path);
  });
});
