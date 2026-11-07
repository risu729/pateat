import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// Package the rendered VitePress pages as an assets-only Worker, as biwa does.
export default defineConfig({
  plugins: [cloudflare()],
  publicDir: ".vitepress/dist",
});
