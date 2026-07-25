import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The live provider suites bill a real API and need a credential, so they
    // are excluded from the default run rather than merely skipped inside it:
    // `npm test` must stay hermetic and offline. Run them deliberately with
    // `npm run test:live -w server` — see docs/provider-swap.md.
    exclude: ["node_modules/**", "test/live/**"],
  },
});
