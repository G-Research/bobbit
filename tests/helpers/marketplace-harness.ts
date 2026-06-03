/**
 * Shared helpers for marketplace install/conflict/provenance unit tests.
 * Builds an InstallService against temp config dirs and an in-memory
 * project-config writer so file operations are exercised hermetically.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { InstallService } from "../../src/server/marketplace/install-service.ts";
import { ProvenanceStore } from "../../src/server/marketplace/provenance-store.ts";
import { scanPackDir } from "../../src/server/marketplace/pack-scanner.ts";
import type { ProjectConfigWriter } from "../../src/server/agent/config-directories.ts";
import type { InstallScope, ScannedPack, SourceRecord } from "../../src/server/marketplace/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE_A = path.join(__dirname, "..", "fixtures", "marketplace", "source-a");

export function tmpDir(label = "bobbit-market-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), label));
}

/** Minimal in-memory ProjectConfigWriter (key→string), no typed accessors. */
export class MemConfigStore implements ProjectConfigWriter {
	private map = new Map<string, string>();
	get(key: string): string | undefined { return this.map.get(key); }
	set(key: string, value: string): void { this.map.set(key, value); }
	remove(key: string): void { this.map.delete(key); }
}

export interface Harness {
	service: InstallService;
	systemConfigDir: string;
	systemSkillsDir: string;
	projectConfigDir: string;
	projectConfigStore: MemConfigStore;
	systemProvenance: () => ProvenanceStore;
	projectProvenance: () => ProvenanceStore;
}

export function makeHarness(): Harness {
	const systemConfigDir = tmpDir("bobbit-market-sys-");
	const systemSkillsDir = tmpDir("bobbit-market-sysskills-");
	const projectConfigDir = tmpDir("bobbit-market-proj-");
	const projectConfigStore = new MemConfigStore();

	const service = new InstallService({
		resolveCtx: (scope: InstallScope, projectId) => {
			if (scope === "system") {
				return { scope, projectId: null, configDir: systemConfigDir, skillInstallDir: systemSkillsDir };
			}
			return {
				scope: "project",
				projectId,
				configDir: projectConfigDir,
				skillInstallDir: path.join(projectConfigDir, "skills"),
				projectConfigStore,
			};
		},
		resolveProvenance: (scope: InstallScope) =>
			new ProvenanceStore(scope === "system" ? systemConfigDir : projectConfigDir),
	});

	return {
		service,
		systemConfigDir,
		systemSkillsDir,
		projectConfigDir,
		projectConfigStore,
		systemProvenance: () => new ProvenanceStore(systemConfigDir),
		projectProvenance: () => new ProvenanceStore(projectConfigDir),
	};
}

export function localSource(): SourceRecord {
	return {
		id: "src-a",
		kind: "local",
		url: null,
		ref: null,
		path: SOURCE_A,
		label: "Source A",
		addedAt: 0,
		lastSyncedAt: 0,
		lastSyncCommit: null,
		lastSyncError: null,
	};
}

export function pack(packId: string): ScannedPack {
	return scanPackDir("src-a", path.join(SOURCE_A, packId));
}
