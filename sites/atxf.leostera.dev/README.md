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

Deployment is manual. [`wrangler.jsonc`](wrangler.jsonc) serves `dist/` through Workers Static Assets, with no Worker script, `workers_dev` off and the custom domain `atxf.leostera.dev`. The `leostera.dev` zone must be in the same account.

```sh
cd sites/atxf.leostera.dev
bunx wrangler login             # with the personal Cloudflare account
bunx wrangler whoami            # verify the account before deploying
bun run build
bunx wrangler deploy --dry-run
bunx wrangler deploy
```
