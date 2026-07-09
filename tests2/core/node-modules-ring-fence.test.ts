import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { healDependencies } from "../../src/server/harness-deps.js";
import { resolveAgentRuntimeModulesDir } from "../../src/server/agent/runtime-ringfence.js";

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

function packageManifestPath(modulesDir: string, packageName: string): string {
	return path.join(modulesDir, packageName, "package.json");
}

function writePackage(modulesDir: string, packageName: string): void {
	const manifest = packageManifestPath(modulesDir, packageName);
	fs.mkdirSync(path.dirname(manifest), { recursive: true });
	fs.writeFileSync(manifest, JSON.stringify({ name: packageName, version: "0.0.0" }), "utf-8");
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("node_modules repair + agent runtime ring-fence reproducing invariant", () => {
	it("fails loud on repair regression and resolves an intact runtime snapshot over a gutted working tree", () => {
		const root = makeTempDir("bobbit-nm-ring-fence-");
		const projectRoot = path.join(root, "project");
		const projectModules = path.join(projectRoot, "node_modules");
		fs.mkdirSync(projectModules, { recursive: true });
		fs.writeFileSync(
			path.join(projectRoot, "package.json"),
			JSON.stringify({
				dependencies: {
					"healthy-pkg": "1.0.0",
					"lightningcss-win32-x64-msvc": "1.0.0",
				},
			}),
			"utf-8",
		);
		writePackage(projectModules, "healthy-pkg");
		writePackage(projectModules, "lightningcss-win32-x64-msvc");

		const lockedPath = path.join(
			projectModules,
			"lightningcss-win32-x64-msvc",
			"lightningcss.win32-x64-msvc.node",
		);
		fs.writeFileSync(lockedPath, "native-addon-sentinel", "utf-8");

		let thrown: unknown;
		try {
			healDependencies(projectRoot, {
				exec: () => {
					// Simulate a destructive/interrupted reify: a package that was
					// healthy before repair is removed, then npm reports the locked
					// native file that aborted the rewrite.
					fs.rmSync(packageManifestPath(projectModules, "healthy-pkg"), { force: true });
					throw Object.assign(new Error("npm error code EBUSY"), {
						code: "EBUSY",
						syscall: "rename",
						path: lockedPath,
						errno: -4082,
					});
				},
			});
		} catch (err) {
			thrown = err;
		}

		const thrownMessage = thrown instanceof Error ? thrown.message : "";
		expect.soft(
			thrown,
			"NODE_MODULES_RING_FENCE_REPAIR_INVARIANT: healDependencies must throw when repair removes healthy-pkg and must surface the locked native file path",
		).toBeInstanceOf(Error);
		expect.soft(
			thrownMessage,
			"NODE_MODULES_RING_FENCE_REPAIR_INVARIANT: loud repair error must name the regressed dependency healthy-pkg",
		).toContain("healthy-pkg");
		expect.soft(
			thrownMessage,
			"NODE_MODULES_RING_FENCE_REPAIR_INVARIANT: loud repair error must name npm's exact locked native file path",
		).toContain(lockedPath);

		const workingModulesDir = path.join(root, "working-node_modules");
		const snapshotModulesDir = path.join(root, "snapshot-node_modules");
		fs.mkdirSync(path.dirname(packageManifestPath(workingModulesDir, "@earendil-works/pi-coding-agent")), { recursive: true });
		writePackage(snapshotModulesDir, "@earendil-works/pi-coding-agent");

		const resolved = resolveAgentRuntimeModulesDir({ workingModulesDir, snapshotModulesDir });
		expect.soft(
			resolved,
			"NODE_MODULES_RING_FENCE_RUNTIME_INVARIANT: resolver must prefer the intact snapshot when the working runtime package is half-wiped",
		).toBe(snapshotModulesDir);
		expect(
			fs.existsSync(packageManifestPath(resolved, "@earendil-works/pi-coding-agent")),
			"NODE_MODULES_RING_FENCE_RUNTIME_INVARIANT: resolved runtime modules dir must still contain @earendil-works/pi-coding-agent/package.json",
		).toBe(true);
	});
});
