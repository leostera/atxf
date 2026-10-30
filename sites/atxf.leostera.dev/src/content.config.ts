import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

// The site renders the repository's own documents, so the spec has one source of truth.
const docs = defineCollection({
  loader: glob({ pattern: ["SPEC.md", "docs/mappings.md"], base: "../.." }),
});

export const collections = { docs };
