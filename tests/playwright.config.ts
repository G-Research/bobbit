import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "**/*.spec.ts",
	// Unit browser-fixture project: top-level `tests/*.spec.ts` only. Subtrees
	// that run in other phases are excluded: `e2e/**` (e2e gate) and
	// `manual-integration/**` (real-LLM/Docker, gate-exempt). This exclusion
	// set is mirrored by the phase-invariant guard in test-phase-invariant.test.ts.
	testIgnore: ["e2e/**", "manual-integration/**"],
	timeout: 15_000,
	fullyParallel: true,
	workers: process.env.CI ? 2 : "50%",
});
