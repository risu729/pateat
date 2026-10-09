import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("health-only Worker", () => {
  it("identifies the build without caching or opening cross-origin access", async () => {
    const response = await exports.default.fetch("https://example.test/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "pateat-api",
      revision: "test-revision",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("supports a bodyless HEAD probe", async () => {
    const response = await exports.default.fetch("https://example.test/health", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it.each(["/", "/health/", "/auth", "/vault", "/recipes", "/inference"])(
    "does not expose %s",
    async (path) => {
      const response = await exports.default.fetch(`https://example.test${path}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "rejects %s without processing a body",
    async (method) => {
      const response = await exports.default.fetch("https://example.test/health", {
        method,
        body: "synthetic-unused-body",
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, HEAD");
      expect(await response.json()).toEqual({ error: "method_not_allowed" });
    },
  );
});
