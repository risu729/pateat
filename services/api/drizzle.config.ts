import { defineConfig } from "drizzle-kit";

// Generation only: migrations are applied by D1 tooling, never with remote credentials here.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
