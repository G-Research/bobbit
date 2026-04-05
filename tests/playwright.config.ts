import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "**/*.spec.ts",
	testIgnore: ["e2e/**", "fullstack/**", "manual-integration/**"],
	timeout: 15_000,
});
