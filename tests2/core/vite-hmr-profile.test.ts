import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { parseArgs, percentile, usage, validateReport } from "../../scripts/profile-vite-hmr.mjs";

const profilerPath = fileURLToPath(new URL("../../scripts/profile-vite-hmr.mjs", import.meta.url));

describe("Vite HMR profiler", () => {
	it("parses bounded repeatable profile options", () => {
		const options = parseArgs(["--iterations=7", "--clients=4", "--exercise-lazy", "--port", "5180", "--max-p95-ms=2500"]);
		assert.equal(options.iterations, 7);
		assert.equal(options.clients, 4);
		assert.equal(options.exerciseLazy, true);
		assert.equal(options.port, 5180);
		assert.equal(options.maxP95Ms, 2500);
		assert.throws(() => parseArgs(["--iterations=0"]), /iterations/);
		assert.throws(() => parseArgs(["--port=70000"]), /port/);
		assert.throws(() => parseArgs(["--clients=21"]), /clients/);
	});

	it("uses nearest-rank percentiles", () => {
		assert.equal(percentile([400, 100, 500, 200, 300], 0.5), 300);
		assert.equal(percentile([400, 100, 500, 200, 300], 0.95), 500);
		assert.equal(percentile([], 0.95), 0);
	});

	it("fails on dropped overlapping edits and optional latency budgets", () => {
		const passing = {
			overlappingTwoFileEdit: { delivered: true },
			singleFileP95Ms: 800,
		};
		assert.doesNotThrow(() => validateReport(passing, null));
		assert.doesNotThrow(() => validateReport(passing, 1000));
		assert.throws(
			() => validateReport({ ...passing, overlappingTwoFileEdit: { delivered: false } }, null),
			/not delivered/,
		);
		assert.throws(() => validateReport(passing, 700), /exceeded/);
	});

	it("keeps profiling isolated from the working tree and live Vite server", () => {
		const source = readFileSync(profilerPath, "utf8");
		assert.match(source, /\.bobbit-qa["'], "vite-hmr-profile/);
		assert.match(source, /copyFixture\(options\.fixtureRoot\)/);
		assert.doesNotMatch(source, /appendProbe\(path\.join\(REPO_ROOT, "src"/);
		const validationIndex = source.indexOf("validateReport(report, options.maxP95Ms);");
		const latestWriteIndex = source.indexOf('fs.writeFileSync(path.join(options.resultsRoot, "latest.json")');
		assert.ok(validationIndex >= 0 && validationIndex < latestWriteIndex, "rejected runs must not replace latest.json");

		const help = usage();
		assert.match(help, /working tree are not modified/);
		assert.match(help, /--max-p95-ms/);
		assert.match(help, /--clients/);
		assert.match(help, /--exercise-lazy/);
	});
});
