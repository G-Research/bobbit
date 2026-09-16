import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
	BINARY_PACKAGES,
	BINARY_PLATFORMS,
	relockBinaries,
	registryFetchMeta,
} from "../../../scripts/release/relock-binaries.mjs";

/** Minimal package.json / lockfile fixtures with the five binary packages plus one unrelated dep. */
function fixtures() {
	const optional = Object.fromEntries(BINARY_PACKAGES.map((name: string) => [name, "0.9.0"]));
	const packageJson = {
		name: "@gresearch/bobbit",
		optionalDependencies: { ...optional },
		dependencies: { "some-dep": "1.2.3" },
	};
	const lockPackages: Record<string, any> = {
		"": { name: "@gresearch/bobbit", optionalDependencies: { ...optional } },
		"node_modules/some-dep": { version: "1.2.3", resolved: "https://example/some-dep", integrity: "sha512-KEEP" },
	};
	for (const name of BINARY_PACKAGES) {
		lockPackages[`node_modules/${name}`] = {
			version: "0.9.0",
			resolved: `https://registry.npmjs.org/${name}/-/old-0.9.0.tgz`,
			integrity: "sha512-OLD",
			cpu: ["x64"],
			license: "MIT",
			optional: true,
			os: ["linux"],
		};
	}
	return { packageJson, lockfile: { lockfileVersion: 3, packages: lockPackages } };
}

/** Deterministic stub registry: returns predictable tarball/integrity per name@version. */
const stubFetchMeta = async (name: string, version: string) => ({
	tarball: `https://registry.npmjs.org/${name}/-/new-${version}.tgz`,
	integrity: `sha512-NEW-${name}-${version}`,
});

describe("BINARY_PACKAGES", () => {
	it("pins the five supported @gresearch/bobbit-binaries names", () => {
		assert.deepEqual(BINARY_PLATFORMS, ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"]);
		assert.deepEqual(BINARY_PACKAGES, [
			"@gresearch/bobbit-binaries-darwin-arm64",
			"@gresearch/bobbit-binaries-darwin-x64",
			"@gresearch/bobbit-binaries-linux-x64",
			"@gresearch/bobbit-binaries-linux-arm64",
			"@gresearch/bobbit-binaries-win32-x64",
		]);
	});
});

describe("relockBinaries", () => {
	it("updates version, resolved, integrity, and both pin mirrors for every binary package", async () => {
		const { packageJson, lockfile } = fixtures();
		const { results } = await relockBinaries({ packageJson, lockfile, version: "0.9.1", fetchMeta: stubFetchMeta });

		assert.equal(results.length, 5);
		for (const name of BINARY_PACKAGES) {
			assert.equal(packageJson.optionalDependencies[name], "0.9.1");
			assert.equal(lockfile.packages[""].optionalDependencies[name], "0.9.1");
			const entry = lockfile.packages[`node_modules/${name}`];
			assert.equal(entry.version, "0.9.1");
			assert.equal(entry.resolved, `https://registry.npmjs.org/${name}/-/new-0.9.1.tgz`);
			assert.equal(entry.integrity, `sha512-NEW-${name}-0.9.1`);
			// preserved structural fields
			assert.deepEqual(entry.cpu, ["x64"]);
			assert.equal(entry.optional, true);
		}
	});

	it("leaves unrelated dependencies untouched", async () => {
		const { packageJson, lockfile } = fixtures();
		await relockBinaries({ packageJson, lockfile, version: "0.9.1", fetchMeta: stubFetchMeta });
		assert.equal(packageJson.dependencies["some-dep"], "1.2.3");
		assert.equal(lockfile.packages["node_modules/some-dep"].integrity, "sha512-KEEP");
	});

	it("rejects a non-exact version before any I/O", async () => {
		const { packageJson, lockfile } = fixtures();
		await assert.rejects(
			() => relockBinaries({ packageJson, lockfile, version: "^0.9.1", fetchMeta: stubFetchMeta }),
			/invalid version/,
		);
	});

	it("throws when a package is missing from the lockfile", async () => {
		const { packageJson, lockfile } = fixtures();
		delete lockfile.packages["node_modules/@gresearch/bobbit-binaries-win32-x64"];
		await assert.rejects(
			() => relockBinaries({ packageJson, lockfile, version: "0.9.1", fetchMeta: stubFetchMeta }),
			/is missing from package-lock\.json/,
		);
	});

	it("throws when registry metadata lacks integrity", async () => {
		const { packageJson, lockfile } = fixtures();
		const bad = async () => ({ tarball: "https://x/t.tgz" }) as { tarball: string; integrity?: string };
		await assert.rejects(
			() => relockBinaries({ packageJson, lockfile, version: "0.9.1", fetchMeta: bad }),
			/missing tarball or integrity/,
		);
	});
});

describe("registryFetchMeta", () => {
	it("returns dist.tarball and dist.integrity on success", async () => {
		const fetchImpl = async () => new Response(JSON.stringify({ dist: { tarball: "https://x/t.tgz", integrity: "sha512-Z" } }), { status: 200 });
		const meta = await registryFetchMeta({ fetchImpl: fetchImpl as unknown as typeof fetch })("@gresearch/bobbit-binaries-linux-x64", "0.9.1");
		assert.deepEqual(meta, { tarball: "https://x/t.tgz", integrity: "sha512-Z" });
	});

	it("throws a publish-first error on 404", async () => {
		const fetchImpl = async () => new Response("not found", { status: 404 });
		await assert.rejects(
			() => registryFetchMeta({ fetchImpl: fetchImpl as unknown as typeof fetch })("@gresearch/bobbit-binaries-linux-x64", "9.9.9"),
			/is not published \(404\)/,
		);
	});

	it("throws on other non-ok status", async () => {
		const fetchImpl = async () => new Response("boom", { status: 503 });
		await assert.rejects(
			() => registryFetchMeta({ fetchImpl: fetchImpl as unknown as typeof fetch })("@gresearch/bobbit-binaries-linux-x64", "0.9.1"),
			/returned 503/,
		);
	});
});
