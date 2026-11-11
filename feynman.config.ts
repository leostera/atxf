import { defineConfig } from "@leostera/feynman/config";

// reconcile.ts explores every world (2.8M states) in about 25 s, just past the default 20 s time limit.
export default defineConfig({ specs: ["specs/*.ts"], check: { maxStates: 5_000_000, timeLimit: 120_000 } });
