/**
 * Real-model and external-service manual test config.
 *
 * Manual tests are never included in `npm test` or an automated lane.
 * Run explicitly with `npm run test:manual`.
 */
import { defineConfig } from "@playwright/test";

const WANT_VIDEO = process.env.RECORDVIDEO === "1";

export default defineConfig({
	testDir: "./tests/manual",
	testMatch: ["**/*.manual.spec.ts"],
	timeout: 300_000,
	retries: 0,
	workers: 1,
	use: {
		headless: true,
		screenshot: "off",
		video: WANT_VIDEO ? { mode: "on", size: { width: 1280, height: 720 } } : "off",
		trace: WANT_VIDEO ? "on" : "off",
	},
	projects: [
		{
			name: "manual",
		},
	],
});
