import { defineConfig } from "@leostera/feynman/config";

// Depth 10 explores every interleaving of reconcile.ts completely.
export default defineConfig({ specs: ["specs/*.ts"], check: { depth: 10, maxStates: 5_000_000 } });
