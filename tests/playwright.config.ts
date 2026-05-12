import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "**/*.spec.ts",
	testIgnore: ["e2e/**", "fullstack/**", "manual-integration/**", "compaction.spec.ts"],
	timeout: 15_000,
	fullyParallel: true,
	workers: process.env.CI ? 2 : "50%",
});
