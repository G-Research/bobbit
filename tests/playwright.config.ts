import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "**/*.spec.ts",
	testIgnore: ["e2e/**", "fullstack/**"],
	timeout: 15_000,
});
