import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        // The wrangler/runtime bundled in vitest-pool-workers lags the deployed
        // wrangler (4.60+). Pin the test runtime to a date it actually supports
        // so it stops falling back and logging a warning on every run — this is
        // test-only and does NOT change the production compatibility_date.
        miniflare: { compatibilityDate: "2024-12-30" },
      },
    },
  },
});
