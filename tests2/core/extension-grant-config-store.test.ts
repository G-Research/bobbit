import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import yaml from "yaml";
import { ProjectConfigStore, type ExtensionGrant } from "../../src/server/agent/project-config-store.js";
import { makeTmpDir } from "../../tests/helpers/tmp.ts";
import { createMemFs, type MemFs } from "../harness/mem-fs.js";

let tmpDir: string;
const grantedAt = "2025-02-03T04:05:06.000Z";

function grant(overrides: Partial<ExtensionGrant> = {}): ExtensionGrant {
	return {
		packId: "pack-a",
		hookId: "hook-a",
		capability: "decide",
		grantedAt,
		grantedBy: "admin",
		...overrides,
	};
}

beforeEach(() => {
	tmpDir = makeTmpDir("extension-grant-config-");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ProjectConfigStore extension_grants", () => {
	it("writes native YAML, de-duplicates exact tuples, and survives reload", () => {
		const store = new ProjectConfigStore(tmpDir);
		store.setExtensionGrants([
			grant({ grantedBy: "first" }),
			grant({ grantedBy: "last" }),
			grant({ hookId: "hook-b", capability: "store" }),
		]);

		const onDisk = yaml.parse(fs.readFileSync(path.join(tmpDir, "project.yaml"), "utf-8")) as Record<string, unknown>;
		expect(onDisk.extension_grants).toEqual([
			grant({ grantedBy: "last" }),
			grant({ hookId: "hook-b", capability: "store" }),
		]);
		expect(new ProjectConfigStore(tmpDir).getExtensionGrants()).toEqual(onDisk.extension_grants);
	});

	it("drops malformed native rows without allowing them to become grants", () => {
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), yaml.stringify({
			extension_grants: [
			grant(),
			{ ...grant(), hookId: "../../wildcard" },
			{ ...grant(), capability: "anything" },
			{ ...grant(), grantedAt: "2025-02-03T04:05:06Z" },
			{ ...grant(), grantedBy: "actor with spaces" },
			"not-an-object",
		],
		}), "utf-8");

		const store = new ProjectConfigStore(tmpDir);
		expect(store.getExtensionGrants()).toEqual([grant()]);
	});

	it("returns defensive grant snapshots and clears the native field for an empty replacement", () => {
		const store = new ProjectConfigStore(tmpDir);
		store.setExtensionGrants([grant()]);
		const snapshot = store.getExtensionGrants();
		snapshot[0].grantedBy = "mutated";
		snapshot.push(grant({ hookId: "injected" }));
		expect(store.getExtensionGrants()).toEqual([grant()]);

		store.setExtensionGrants([]);
		const onDisk = yaml.parse(fs.readFileSync(path.join(tmpDir, "project.yaml"), "utf-8")) as Record<string, unknown>;
		expect(onDisk.extension_grants).toBeUndefined();
	});

	it("keeps the existing grant snapshot when atomic publication fails", () => {
		const memfs = createMemFs();
		const configDir = path.resolve("/memfs/extension-grant-config");
		const configFile = path.join(configDir, "project.yaml");
		memfs.mkdirSync(configDir, { recursive: true });
		memfs.writeFileSync(configFile, yaml.stringify({ extension_grants: [grant()] }), "utf-8");
		const store = new ProjectConfigStore(configDir, memfs);
		const originalBytes = String(memfs.readFileSync(configFile, "utf-8"));
		const originalRename = memfs.renameSync.bind(memfs);
		(memfs as MemFs & { renameSync: typeof memfs.renameSync }).renameSync = ((from, to) => {
			if (String(to) === configFile) throw new Error("injected publication failure");
			return originalRename(from, to);
		}) as typeof memfs.renameSync;

		expect(() => store.setExtensionGrants([grant({ grantedBy: "replacement" })])).toThrow(/project config|persist/i);
		expect(store.getExtensionGrants()).toEqual([grant()]);
		expect(String(memfs.readFileSync(configFile, "utf-8"))).toBe(originalBytes);
	});
});
