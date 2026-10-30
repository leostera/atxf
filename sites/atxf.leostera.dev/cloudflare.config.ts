import { defineConfig } from "cf/config";

export default defineConfig({
  accountId: "0f436d2aabf1f872be90b8dd9d5715e6",
  worker: {
    name: "atxf-www",
    compatibilityDate: "2026-10-29",
    workersDev: false,
    previewUrls: false,
    observability: {
      enabled: true,
    },
    assets: {
      notFoundHandling: "404-page",
    },
    domains: [
      "atxf.leostera.dev",
    ],
  },
});
