import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { handlerRoute, unhandledError } from "../src/error-log";

class StoreError extends Error {}

class NamedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NamedError";
  }
}

const frameLines = (error: Error) => error.stack?.split("\n").slice(1) ?? [];

describe("unhandledError", () => {
  it("keeps the class name and frames, never the message", () => {
    const thrown = new StoreError(
      "Failed query: select 1\nparams: secret-value\n    at secret-frame (index.js:1:1)",
    );
    const logged = unhandledError(thrown);
    expect(logged.name).toBe("StoreError");
    expect(logged.message).toBe("Unhandled API error");
    expect(logged.stack?.split("\n")[0]).toBe("StoreError: Unhandled API error");
    expect(frameLines(logged).length).toBeGreaterThan(0);
    expect(frameLines(logged).every((line) => /^\s+at .*:\d+:\d+\)?$/u.test(line))).toBe(true);
    expect(logged.stack).not.toContain("secret");
  });

  it("keeps the frames of a class that sets its name in its constructor", () => {
    const logged = unhandledError(new NamedError("value"));
    expect(logged.stack?.split("\n")[0]).toBe("NamedError: Unhandled API error");
    expect(frameLines(logged).length).toBeGreaterThan(0);
    expect(logged.stack).not.toContain("value");
  });

  it("drops every frame of a stack that does not start with its own header", () => {
    const changed = new Error("value");
    changed.stack = "Error: other value\n    at somewhere (index.js:1:1)";
    expect(unhandledError(changed).stack).toBe("Error: Unhandled API error");

    const renamed = new Error("value");
    void renamed.stack;
    renamed.name = "Renamed";
    expect(unhandledError(renamed).stack).toBe("Error: Unhandled API error");

    const unnamed = new Error("value");
    void unnamed.stack;
    unnamed.name = "";
    expect(unhandledError(unnamed).stack).toBe("Error: Unhandled API error");
  });

  it("keeps only lines with a source position and drops the property a call went through", () => {
    const thrown = new Error("value");
    thrown.stack = [
      "Error: value",
      "    at Object.handle [as secret-key] (index.js:10:5)",
      "    at async Promise.all (index 0)",
      "    at index.js:20:7",
      "    not a frame",
    ].join("\n");
    expect(unhandledError(thrown).stack).toBe(
      "Error: Unhandled API error\n    at Object.handle (index.js:10:5)\n    at index.js:20:7",
    );
  });

  it("names a thrown value that is not an error as unknown", () => {
    expect(unhandledError("secret").stack).toBe("unknown: Unhandled API error");
  });
});

describe("handlerRoute", () => {
  const routeOf = async (method: string, path: string) => {
    let route: string | undefined;
    const app = new Hono()
      .use("/v1/*", async (_, next) => next())
      .post("/v1/recipes/generate", () => {
        throw new Error("value");
      })
      .put("/v1/recipes/:recipeId", () => {
        throw new Error("value");
      })
      .all("/v1/recipes/:recipeId", () => {
        throw new Error("value");
      })
      .onError((_, c) => {
        route = handlerRoute(c);
        return c.text("", 500);
      });
    await app.request(path, { method });
    return route;
  };

  it("names the handler's route, not a catch-all registered after it", async () => {
    expect(await routeOf("POST", "/v1/recipes/generate")).toBe("/v1/recipes/generate");
    expect(await routeOf("PUT", "/v1/recipes/recipe-1")).toBe("/v1/recipes/:recipeId");
    expect(await routeOf("DELETE", "/v1/recipes/recipe-1")).toBe("/v1/recipes/:recipeId");
  });
});
