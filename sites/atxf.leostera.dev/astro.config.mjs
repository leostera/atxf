import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

// Fully prerendered. Cloudflare serves dist/ as Workers Static Assets; no adapter or Worker script.
export default defineConfig({
  site: "https://atxf.leostera.dev",
  output: "static",
  trailingSlash: "always",
  integrations: [react()],
  markdown: {
    // Match Kumo's own code themes so prose code and example code look the same.
    shikiConfig: { themes: { light: "github-light", dark: "vesper" } },
  },
  vite: {
    plugins: [tailwindcss()],
    // The spec, mappings, schema and examples live at the repository root.
    server: { fs: { allow: ["../.."] } },
  },
});
