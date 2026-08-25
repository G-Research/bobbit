import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";
import {
	ProjectConfigPersistenceError,
	ProjectConfigStore,
} from "../../../src/server/agent/project-config-store.js";
import { createMemFs } from "../../support/harnesses/mem-fs.js";

describe("ProjectConfigStore durable publication", () => {
	it("surfaces a publication failure without changing existing project.yaml bytes", () => {
		const memfs = createMemFs();
		const configDir = path.resolve("/memfs/project-config-durability");
		const configFile = path.join(configDir, "project.yaml");
		const originalBytes = "build_command: npm run previous-build\n";
		memfs.mkdirSync(configDir, { recursive: true });
		memfs.writeFileSync(configFile, originalBytes, "utf-8");

		const store = new ProjectConfigStore(configDir, memfs);
		const originalWrite = memfs.writeFileSync.bind(memfs);
		let publicationWrites = 0;
		(memfs as any).writeFileSync = (candidate: string, ...args: unknown[]) => {
			if (path.dirname(String(candidate)) === configDir) {
				publicationWrites++;
				throw new Error("injected project config publication failure");
			}
			return originalWrite(candidate, ...(args as [any]));
		};

		let saveError: unknown;
		try {
			store.set("build_command", "npm run replacement-build");
		} catch (error) {
			saveError = error;
		}

		assert.equal(publicationWrites, 1, "mutation must attempt one project config publication");
		assert.equal(
			memfs.readFileSync(configFile, "utf-8"),
			originalBytes,
			"failed publication must preserve exact existing project.yaml bytes",
		);
		assert.ok(
			saveError,
			"PROJECT_CONFIG_DURABILITY_BUG: failed publication must surface from the public setter",
		);
		assert.ok(
			saveError instanceof ProjectConfigPersistenceError,
			"publication failures must be exposed as a redacted ProjectConfigPersistenceError",
		);
		assert.equal(saveError.code, "PROJECT_CONFIG_PERSIST_FAILED");
		assert.equal(
			saveError.message,
			"Project config could not be published. Verify the config directory is writable and retry.",
		);
		assert.doesNotMatch(String(saveError), /injected project config publication failure/);
	});
});
