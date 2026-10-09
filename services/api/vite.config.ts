import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare()],
  define: {
    PATEAT_BUILD_REVISION: JSON.stringify(process.env["PATEAT_REVISION"] ?? "development"),
  },
});
