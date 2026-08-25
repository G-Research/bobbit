import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import {
	MAX_RAPID_RESTARTS,
	RAPID_FAILURE_WINDOW_MS,
	VITE_ENTRY,
	restartPlan,
} from "../../../scripts/dev-vite.mjs";

describe("development Vite supervisor", () => {
	it("restarts an unexpected Vite failure with bounded backoff", () => {
		assert.deepEqual(restartPlan({ code: 1, signal: null, stopping: false, runtimeMs: 1_000, rapidFailures: 0 }), {
			restart: true,
			rapidFailures: 1,
			delayMs: 500,
			reason: "code 1",
		});
		assert.equal(
			restartPlan({ code: 1, signal: null, stopping: false, runtimeMs: 1_000, rapidFailures: 3 }).delayMs,
			4_000,
		);
	});

	it("does not loop after clean shutdown or repeated rapid failures", () => {
		assert.equal(restartPlan({ code: 0, signal: null, stopping: false, runtimeMs: 1_000, rapidFailures: 0 }).restart, false);
		assert.equal(restartPlan({ code: 1, signal: null, stopping: true, runtimeMs: 1_000, rapidFailures: 0 }).restart, false);
		assert.equal(
			restartPlan({ code: 1, signal: null, stopping: false, runtimeMs: 1_000, rapidFailures: MAX_RAPID_RESTARTS }).restart,
			false,
		);
		assert.equal(
			restartPlan({ code: 1, signal: null, stopping: false, runtimeMs: RAPID_FAILURE_WINDOW_MS, rapidFailures: 4 }).rapidFailures,
			1,
		);
	});

	it("routes every development command through the supervisor", () => {
		assert.match(VITE_ENTRY.replaceAll("\\", "/"), /node_modules\/vite\/bin\/vite\.js$/);
		const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
		for (const name of ["dev", "dev:harness", "dev:watchdog"]) {
			assert.match(pkg.scripts[name], /node scripts\/dev-vite\.mjs/);
			assert.doesNotMatch(pkg.scripts[name], /(?:^|[" ])vite(?:[" ]|$)/);
		}
		const nord = readFileSync(new URL("../../../scripts/dev-nord.mjs", import.meta.url), "utf8");
		assert.match(nord, /node scripts\/dev-vite\.mjs/);
		assert.doesNotMatch(nord, /"vite"/);
	});
});
