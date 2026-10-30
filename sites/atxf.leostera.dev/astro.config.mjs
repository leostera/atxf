import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

// Fully prerendered and served as Workers Static Assets; the Worker is configured in cloudflare.config.ts.
export default defineConfig({
  site: "https://atxf.leostera.dev",
  output: "static",
  trailingSlash: "always",
  // Prerender in Node: pages read the spec, schema and examples from the repository at build time.
  // No sessions or image transforms, so the adapter adds no KV or Images bindings.
  adapter: cloudflare({ prerenderEnvironment: "node", imageService: "passthrough" }),
  session: false,
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
