import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import yaml from "yaml";
import {
	ProjectConfigStore,
	isExtensionCapability,
	type ExtensionGrant,
	type ExtensionHookGrant,
	type ExtensionPackGrant,
} from "../../src/server/agent/project-config-store.js";
import { makeTmpDir } from "../../tests/helpers/tmp.ts";
import { createMemFs, type MemFs } from "../harness/mem-fs.js";

let tmpDir: string;
const grantedAt = "2025-02-03T04:05:06.000Z";
const packCapabilities = [
	"service.manage", "memory.read", "memory.write", "memory.reflect",
	"memory.invalidate", "memory.read.all", "sandbox:build",
] as const;

function hookGrant(overrides: Partial<ExtensionHookGrant> = {}): ExtensionHookGrant {
	return {
		packId: "pack-a",
		hookId: "hook-a",
		capability: "decide",
		grantedAt,
		grantedBy: "admin",
		...overrides,
	};
}

function packGrant(overrides: Partial<ExtensionPackGrant> = {}): ExtensionPackGrant {
	return {
		packId: "pack-a",
		principal: "pack",
		capability: "memory.read",
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
	it("writes native YAML, de-duplicates full authority tuples, and survives reload", () => {
		const store = new ProjectConfigStore(tmpDir);
		store.setExtensionGrants([
			hookGrant({ grantedBy: "first" }),
			hookGrant({ grantedBy: "last" }),
			hookGrant({ hookId: "hook-b", capability: "store" }),
			packGrant({ grantedBy: "first" }),
			packGrant({ grantedBy: "last" }),
			packGrant({ packId: "pack-b" }),
		]);

		const expected: ExtensionGrant[] = [
			hookGrant({ grantedBy: "last" }),
			hookGrant({ hookId: "hook-b", capability: "store" }),
			packGrant({ grantedBy: "last" }),
			packGrant({ packId: "pack-b" }),
		];
		const onDisk = yaml.parse(fs.readFileSync(path.join(tmpDir, "project.yaml"), "utf-8")) as Record<string, unknown>;
		expect(onDisk.extension_grants).toEqual(expected);
		expect(new ProjectConfigStore(tmpDir).getExtensionGrants()).toEqual(expected);
	});

	it("keeps legacy hook rows discriminator-free and strips unknown legacy keys through load and serialization", () => {
		const legacy = hookGrant();
		const legacyWithExtraKey = { ...legacy, retiredMetadata: true };
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), yaml.stringify({ extension_grants: [legacyWithExtraKey] }), "utf-8");

		const store = new ProjectConfigStore(tmpDir);
		expect(store.getExtensionGrants()).toEqual([legacy]);
		store.setExtensionGrants(store.getExtensionGrants());

		const onDisk = yaml.parse(fs.readFileSync(path.join(tmpDir, "project.yaml"), "utf-8")) as { extension_grants: Array<Record<string, unknown>> };
		expect(onDisk.extension_grants).toEqual([legacy]);
		expect(Object.hasOwn(onDisk.extension_grants[0], "principal")).toBe(false);
		expect(Object.hasOwn(onDisk.extension_grants[0], "retiredMetadata")).toBe(false);
	});

	it("accepts exactly the seven platform-owned pack capabilities and keeps them pack-scoped", () => {
		const store = new ProjectConfigStore(tmpDir);
		store.setExtensionGrants(packCapabilities.map((capability, index) =>
			packGrant({ packId: `pack-${index}`, capability }),
		));

		expect(packCapabilities.every(isExtensionCapability)).toBe(true);
		expect(store.getExtensionGrants()).toEqual(packCapabilities.map((capability, index) =>
			packGrant({ packId: `pack-${index}`, capability }),
		));
		expect(store.getExtensionGrants().every(grant => grant.principal === "pack")).toBe(true);
	});

	it("drops malformed, unknown, mixed-principal, and ineligible rows independently", () => {
		const validHook = hookGrant();
		const validPack = packGrant();
		fs.writeFileSync(path.join(tmpDir, "project.yaml"), yaml.stringify({
			extension_grants: [
				validHook,
				validPack,
				{ ...hookGrant(), hookId: "../../wildcard" },
				{ ...hookGrant(), principal: "hook" },
				{ ...packGrant(), hookId: "hook-a" },
				{ ...packGrant(), principal: "other" },
				{ ...hookGrant(), capability: "memory.read" },
				{ ...packGrant(), capability: "decide" },
				{ ...packGrant(), capability: "anything" },
				{ ...packGrant(), grantedAt: "2025-02-03T04:05:06Z" },
				{ ...packGrant(), grantedBy: "actor with spaces" },
				{ ...packGrant(), extra: true },
				"not-an-object",
			],
		}), "utf-8");

		expect(new ProjectConfigStore(tmpDir).getExtensionGrants()).toEqual([validHook, validPack]);
	});

	it("returns defensive grant snapshots and clears the native field for an empty replacement", () => {
		const store = new ProjectConfigStore(tmpDir);
		store.setExtensionGrants([hookGrant(), packGrant()]);
		const snapshot = store.getExtensionGrants();
		snapshot[0].grantedBy = "mutated";
		snapshot.push(hookGrant({ hookId: "injected" }));
		expect(store.getExtensionGrants()).toEqual([hookGrant(), packGrant()]);

		store.setExtensionGrants([]);
		const onDisk = yaml.parse(fs.readFileSync(path.join(tmpDir, "project.yaml"), "utf-8")) as Record<string, unknown>;
		expect(onDisk.extension_grants).toBeUndefined();
	});

	it("keeps the existing grant snapshot when atomic publication fails", () => {
		const memfs = createMemFs();
		const configDir = path.resolve("/memfs/extension-grant-config");
		const configFile = path.join(configDir, "project.yaml");
		memfs.mkdirSync(configDir, { recursive: true });
		memfs.writeFileSync(configFile, yaml.stringify({ extension_grants: [hookGrant()] }), "utf-8");
		const store = new ProjectConfigStore(configDir, memfs);
		const originalBytes = String(memfs.readFileSync(configFile, "utf-8"));
		const originalRename = memfs.renameSync.bind(memfs);
		(memfs as MemFs & { renameSync: typeof memfs.renameSync }).renameSync = ((from, to) => {
			if (String(to) === configFile) throw new Error("injected publication failure");
			return originalRename(from, to);
		}) as typeof memfs.renameSync;

		expect(() => store.setExtensionGrants([packGrant({ grantedBy: "replacement" })])).toThrow(/project config|persist/i);
		expect(store.getExtensionGrants()).toEqual([hookGrant()]);
		expect(String(memfs.readFileSync(configFile, "utf-8"))).toBe(originalBytes);
	});
});
