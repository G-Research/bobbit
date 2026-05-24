import assert from "node:assert/strict";
import test from "node:test";
import config from "../vite.config.ts";

test("Vite dev watcher ignores Bobbit-generated state and output directories", () => {
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
