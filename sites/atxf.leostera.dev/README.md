# atxf.leostera.dev

Static Astro site for the ATXF specification, built with [Kumo](https://www.npmjs.com/package/@cloudflare/kumo) components and deployed as the Cloudflare Worker `atxf-www` on the custom domain **https://atxf.leostera.dev**.

The site has no copy of its own content. At build time it renders the repository's `SPEC.md`, `docs/mappings.md`, `examples/*.atxf.jsonl` and `schema/v0.1/atxf.schema.json`, so editing those files updates the site. The schema is published at `/schema/v0.1/atxf.schema.json`, which is the schema's `$id`.

From the repository root:

```sh
bun install
bun run --cwd sites/atxf.leostera.dev dev     # local dev server
bun run --cwd sites/atxf.leostera.dev check   # Astro/TypeScript checks
bun run --cwd sites/atxf.leostera.dev build   # static site in dist/
```

## Deploy

Deployment is manual, with the [`cf`](https://developers.cloudflare.com/cf/) CLI. [`cloudflare.config.ts`](cloudflare.config.ts) defines the Worker: `workers.dev` and preview URLs are off, and it serves the custom domain `atxf.leostera.dev`. The `leostera.dev` zone must be in the same account. The `@astrojs/cloudflare` adapter writes the Build Output that `cf` deploys. Every page is prerendered, so the Worker serves static assets only and has no other bindings.

`cf` loads `cloudflare.config.ts` under Node, not Bun, so run it with `npx`:

```sh
cd sites/atxf.leostera.dev
npx cf auth login               # with the personal Cloudflare account
npx cf deploy --dry-run         # builds and validates; no upload
npx cf deploy
```
