import assert from "node:assert/strict";
import test from "node:test";
import viteConfig from "../vite.config.ts";

test("Vite dev watcher ignores Bobbit-generated state and output directories", async () => {
	// vite.config.ts uses `defineConfig(({ mode }) => ({...}))`, so the
	// default export is a function that returns the config (possibly async).
	const raw = typeof viteConfig === "function"
		? (viteConfig as (env: { mode: string; command: "build" | "serve" }) => unknown)({ mode: "development", command: "serve" })
		: viteConfig;
	const config: any = await Promise.resolve(raw);
	assert.equal(typeof config, "object");
	const ignored = config.server?.watch?.ignored;
	assert.ok(Array.isArray(ignored), "server.watch.ignored should be an array");

	for (const pattern of [
		"**/.bobbit/**",
		"**/.bobbit-*/**",
		"**/bobbit-wt/**",
		"**/*-wt/**",
		"**/dist/**",
		"**/coverage/**",
		"**/playwright-report/**",
		"**/test-results/**",
	]) {
		assert.ok(ignored.includes(pattern), `missing Vite watch ignore: ${pattern}`);
	}
});
