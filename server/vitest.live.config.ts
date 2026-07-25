import { defineConfig } from "vitest/config";

/**
 * The live provider suites: real HTTP against whatever ANTHROPIC_BASE_URL
 * points at. Separate from vitest.config.ts so the default `npm test` cannot
 * accidentally bill an API, and so these can have a timeout measured in
 * minutes — a full agentic loop with thinking enabled is nowhere near the
 * default 5s, and DeepSeek's reasoning floor makes that worse.
 *
 * Sequential on purpose: these assert on token accounting and prompt-cache
 * behaviour, and concurrent turns against the same account make both noisy.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/live/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    retry: 0,
  },
});
