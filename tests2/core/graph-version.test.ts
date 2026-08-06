import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	GRAPHIFY_DELTA_CAPABILITY,
	GraphifyVersionError,
	resolveGraphifyVersion,
	type GraphifyPackageMetadata,
} from "../../market-packs/code-intelligence/src/graph-version.ts";

const now = () => new Date("2026-04-06T12:00:00.000Z");
const release = (version: string, capability = true) => ({
	version,
	capabilities: capability ? [GRAPHIFY_DELTA_CAPABILITY] : [],
});
const metadata = (versions: ReturnType<typeof release>[], installedVersion?: string): GraphifyPackageMetadata => ({
	versions,
	...(installedVersion ? { installedVersion } : {}),
});

describe("resolveGraphifyVersion", () => {
	it("chooses and records the newest capability-proven release in the supported range", () => {
		const result = resolveGraphifyVersion({
			supportedRange: ">=1.2.0 <2.0.0",
			packageMetadata: metadata([
				release("1.2.0"),
				release("1.9.0", false),
				release("1.8.4"),
				release("2.0.0"),
			]),
			now,
		});

		assert.equal(result.resolvedVersion, "1.8.4");
		assert.deepEqual(result.record, { resolvedVersion: "1.8.4", resolvedAt: "2026-04-06T12:00:00.000Z" });
		assert.equal(result.minimumVersion, "1.2.0");
		assert.equal(result.requiredCapability, "incremental-delta");
		assert.equal(result.stale, false);
		assert.deepEqual(result.warnings, []);
	});

	it("honors an explicit exact pin rather than choosing a newer supported release", () => {
		const result = resolveGraphifyVersion({
			requestedVersion: "1.3.0",
			supportedRange: "^1.2.0",
			packageMetadata: metadata([release("1.2.0"), release("1.3.0"), release("1.9.0")]),
			now,
		});

		assert.equal(result.requestedVersion, "1.3.0");
		assert.equal(result.resolvedVersion, "1.3.0");
		assert.throws(
			() => resolveGraphifyVersion({ requestedVersion: "^1.3.0", supportedRange: "^1.2.0", packageMetadata: metadata([release("1.3.0")]) }),
			/exact version, not a range/,
		);
	});

	it("warns and marks current bases stale when installed or recorded identities drift", () => {
		const result = resolveGraphifyVersion({
			supportedRange: ">=1.2.0 <2.0.0",
			packageMetadata: metadata([release("1.2.0"), release("1.4.0"), release("1.8.0")], "1.4.0"),
			recorded: { resolvedVersion: "1.2.0", resolvedAt: "2026-04-05T12:00:00.000Z" },
			now,
		});

		assert.equal(result.resolvedVersion, "1.8.0");
		assert.equal(result.stale, true);
		assert.deepEqual(result.warnings, [
			"Installed Graphify 1.4.0 differs from resolved 1.8.0; existing graph bases are stale.",
			"Recorded Graphify 1.2.0 differs from resolved 1.8.0; existing graph bases are stale.",
		]);
	});

	it("reports the installed version, minimum version, and incremental-delta capability for old runtimes", () => {
		assert.throws(
			() => resolveGraphifyVersion({
				supportedRange: ">=1.2.0 <2.0.0",
				packageMetadata: metadata([release("1.0.0"), release("1.8.0")], "1.0.0"),
			}),
			(error: unknown) => error instanceof GraphifyVersionError
				&& error.installedVersion === "1.0.0"
				&& error.minimumVersion === "1.2.0"
				&& error.requiredCapability === "incremental-delta"
				&& /minimum version 1\.2\.0/.test(error.message)
				&& /required capability incremental-delta/.test(error.message),
		);
	});

	it("fails specifically when a version lacks the feature-probed delta capability", () => {
		assert.throws(
			() => resolveGraphifyVersion({
				requestedVersion: "1.3.0",
				supportedRange: ">=1.2.0 <2.0.0",
				packageMetadata: metadata([release("1.3.0", false)]),
			}),
			(error: unknown) => error instanceof GraphifyVersionError
				&& error.installedVersion === "1.3.0"
				&& error.minimumVersion === "1.2.0"
				&& error.requiredCapability === "incremental-delta"
				&& /feature probe/.test(error.message),
		);
	});

	it("uses semver precedence, including prereleases, instead of lexical ordering", () => {
		const result = resolveGraphifyVersion({
			supportedRange: ">=1.0.0 <2.0.0",
			packageMetadata: metadata([release("1.9.0"), release("1.10.0-rc.10"), release("1.10.0-rc.2"), release("1.10.0")]),
			now,
		});
		assert.equal(result.resolvedVersion, "1.10.0");
	});
});
