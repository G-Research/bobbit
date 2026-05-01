import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "**/*.spec.ts",
	testIgnore: ["e2e/**", "fullstack/**", "manual-integration/**"],
	// 15s was tight for browser-fixture page setup under heavy parallel
	// load (gate verification runs unit + e2e + reviews concurrently on
	// the same machine). 30s gives a comfortable headroom for the
	// Chromium launch + first paint without masking real test bugs.
	timeout: 30_000,
	fullyParallel: true,
	workers: process.env.CI ? 2 : "50%",
});
