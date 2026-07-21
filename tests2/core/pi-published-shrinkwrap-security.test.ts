import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "vitest";

interface LockPackage {
	name?: string;
	version?: string;
	resolved?: string;
}

interface Lockfile {
	packages: Record<string, LockPackage>;
}

interface AdvisoryFloor {
	package: string;
	advisory: string;
	minimumVersion: string;
}

interface LockSource {
	label: string;
	lock: Lockfile;
}

const FIXTURE_ROOT = fileURLToPath(
	new URL("./fixtures/pi-published-shrinkwrap-security/", import.meta.url),
);

function readJson<T>(relativePath: string): T {
	return JSON.parse(readFileSync(path.join(FIXTURE_ROOT, relativePath), "utf8")) as T;
}

function packageNameFromLockPath(lockPath: string, entry: LockPackage): string | undefined {
	if (entry.name) return entry.name;
	const marker = "node_modules/";
	const index = lockPath.lastIndexOf(marker);
	if (index < 0) return undefined;
	const remainder = lockPath.slice(index + marker.length);
	if (!remainder.startsWith("@")) return remainder.split("/")[0];
	return remainder.split("/").slice(0, 2).join("/");
}

function compareStableVersions(left: string, right: string): number {
	const parse = (value: string): [number, number, number] => {
		const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
		assert.ok(match, `fixture security floors require a stable x.y.z version, got ${value}`);
		return [Number(match[1]), Number(match[2]), Number(match[3])];
	};
	const a = parse(left);
	const b = parse(right);
	for (let index = 0; index < a.length; index++) {
		if (a[index] !== b[index]) return a[index]! - b[index]!;
	}
	return 0;
}

/**
 * Audit the actual lock sources shipped to a consumer, not just the wrapper's
 * checkout lock. A published dependency's npm-shrinkwrap.json is authoritative
 * when npm installs that dependency, while a dependency package's `overrides`
 * field is ignored outside its own root checkout.
 */
function enforcePublishedDependencyFloor(
	sources: LockSource[],
	floor: AdvisoryFloor,
): void {
	const violations: string[] = [];
	for (const source of sources) {
		for (const [lockPath, entry] of Object.entries(source.lock.packages)) {
			if (packageNameFromLockPath(lockPath, entry) !== floor.package || !entry.version) continue;
			if (compareStableVersions(entry.version, floor.minimumVersion) < 0) {
				violations.push(`${source.label}:${lockPath} resolved ${floor.package}@${entry.version}`);
			}
		}
	}
	if (violations.length > 0) {
		throw new Error(
			`PUBLISHED_SHRINKWRAP_SECURITY ${floor.advisory}: ${violations.join(", ")} below secure floor ${floor.minimumVersion}`,
		);
	}
}

function resolvedVersions(lock: Lockfile, packageName: string): string[] {
	return Object.entries(lock.packages)
		.filter(([lockPath, entry]) => packageNameFromLockPath(lockPath, entry) === packageName)
		.map(([, entry]) => entry.version)
		.filter((version): version is string => typeof version === "string");
}

function assertLocalResolutionFixture(lock: Lockfile): void {
	for (const entry of Object.values(lock.packages)) {
		if (entry.resolved) assert.match(entry.resolved, /^file:/, "fixture resolution must remain network-free");
	}
}

describe("published dependency shrinkwrap security", () => {
	it("rejects a dependency-owned vulnerable pin hidden by the wrapper checkout override", () => {
		const floor = readJson<AdvisoryFloor>("advisory-floor.json");
		const wrapperManifest = readJson<{ overrides: Record<string, string> }>("wrapper/package.json");
		const consumerManifest = readJson<{ overrides?: Record<string, string> }>("consumer/package.json");
		const vulnerablePackage = readJson<{ name: string; version: string }>(
			"packages/protobufjs-vulnerable/package.json",
		);
		const fixedPackage = readJson<{ name: string; version: string }>(
			"packages/protobufjs-fixed/package.json",
		);
		const publishedManifest = readJson<{ dependencies: Record<string, string> }>(
			"packages/published-agent/package.json",
		);
		const checkoutLock = readJson<Lockfile>("wrapper/package-lock.json");
		const publishedShrinkwrap = readJson<Lockfile>(
			"packages/published-agent/npm-shrinkwrap.json",
		);
		const consumerLock = readJson<Lockfile>("consumer/package-lock.json");

		assert.deepEqual(vulnerablePackage, { name: floor.package, version: "7.6.4" });
		assert.deepEqual(fixedPackage, { name: floor.package, version: floor.minimumVersion });
		assert.equal(publishedManifest.dependencies[floor.package], "^7.6.4");
		assertLocalResolutionFixture(checkoutLock);
		assertLocalResolutionFixture(publishedShrinkwrap);
		assertLocalResolutionFixture(consumerLock);
		assert.equal(wrapperManifest.overrides[floor.package], "file:../packages/protobufjs-fixed");
		assert.equal(consumerManifest.overrides, undefined, "dependency overrides must not become consumer overrides");
		assert.deepEqual(resolvedVersions(checkoutLock, floor.package), ["7.6.5"]);
		assert.doesNotThrow(() =>
			enforcePublishedDependencyFloor([{ label: "wrapper checkout", lock: checkoutLock }], floor),
			"a root-only audit sees the secure override and cannot expose the published pin",
		);

		assert.deepEqual(resolvedVersions(publishedShrinkwrap, floor.package), ["7.6.4"]);
		assert.throws(
			() => enforcePublishedDependencyFloor(
				[{ label: "published-agent/npm-shrinkwrap.json", lock: publishedShrinkwrap }],
				floor,
			),
			(error: unknown) => error instanceof Error
				&& error.message === "PUBLISHED_SHRINKWRAP_SECURITY GHSA-j3f2-48v5-ccww: published-agent/npm-shrinkwrap.json:node_modules/protobufjs resolved protobufjs@7.6.4 below secure floor 7.6.5",
		);

		assert.deepEqual(resolvedVersions(consumerLock, floor.package), ["7.6.4"]);
		assert.throws(
			() => enforcePublishedDependencyFloor([{ label: "packed consumer", lock: consumerLock }], floor),
			/PUBLISHED_SHRINKWRAP_SECURITY GHSA-j3f2-48v5-ccww: packed consumer:node_modules\/@bobbit-fixture\/published-agent\/node_modules\/protobufjs resolved protobufjs@7\.6\.4 below secure floor 7\.6\.5/,
		);
	});
});
