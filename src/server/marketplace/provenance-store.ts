/**
 * Marketplace MVP — provenance store (§7).
 *
 * Provenance is committed alongside the entities it tracks, per scope, so
 * update/uninstall is symmetric on any machine that has the entities:
 *   - system scope  → <server-root>/.bobbit/config/marketplace/installed.json
 *   - project scope → <project-root>/.bobbit/config/marketplace/installed.json
 *
 * Record key is (scope, projectId, sourceId, packId). Atomic write mirrors
 * ProjectRegistry.
 */

import fs from "node:fs";
import path from "node:path";
import type { InstallStatus, ProvenanceRecord, ScannedPack, SourceRecord } from "./types.js";

export class ProvenanceStore {
	private records: ProvenanceRecord[] = [];
	private readonly storePath: string;

	/** @param configDir scope config root (provenance lives at <configDir>/marketplace/installed.json). */
	constructor(configDir: string) {
		this.storePath = path.join(configDir, "marketplace", "installed.json");
		this.load();
	}

	load(): void {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.storePath, "utf-8"));
			this.records = Array.isArray(parsed?.installs) ? parsed.installs : [];
		} catch {
			this.records = [];
		}
	}

	private save(): void {
		const dir = path.dirname(this.storePath);
		fs.mkdirSync(dir, { recursive: true });
		const tmp = this.storePath + ".tmp";
		fs.writeFileSync(tmp, JSON.stringify({ version: 1, installs: this.records }, null, 2), "utf-8");
		fs.renameSync(tmp, this.storePath);
	}

	list(): ProvenanceRecord[] {
		return [...this.records];
	}

	find(sourceId: string, packId: string): ProvenanceRecord | undefined {
		return this.records.find((r) => r.sourceId === sourceId && r.packId === packId);
	}

	/** Insert or replace the record for (sourceId, packId). */
	upsert(record: ProvenanceRecord): void {
		const idx = this.records.findIndex((r) => r.sourceId === record.sourceId && r.packId === record.packId);
		if (idx >= 0) this.records[idx] = record;
		else this.records.push(record);
		this.save();
	}

	remove(sourceId: string, packId: string): void {
		const before = this.records.length;
		this.records = this.records.filter((r) => !(r.sourceId === sourceId && r.packId === packId));
		if (this.records.length !== before) this.save();
	}
}

/**
 * Compute install status for a scanned pack against its provenance record (§5).
 * - not-installed: no record.
 * - drifted: a recorded installed path is missing on disk (best-effort).
 * - update-available: source commit (git) / content hash (local) differs from recorded.
 * - installed: otherwise.
 */
export function computeInstallStatus(
	source: SourceRecord,
	record: ProvenanceRecord | undefined,
	currentContentHash: string | null,
): InstallStatus {
	if (!record) return "not-installed";

	for (const entity of record.entities) {
		for (const p of entity.installedPaths) {
			if (!fs.existsSync(p)) return "drifted";
		}
	}

	if (source.kind === "git") {
		if (record.sourceCommit && source.lastSyncCommit && record.sourceCommit !== source.lastSyncCommit) {
			return "update-available";
		}
	} else if (currentContentHash && record.sourceContentHash && currentContentHash !== record.sourceContentHash) {
		return "update-available";
	}

	return "installed";
}

/** Convenience for tests/diagnostics: presence check ignoring drift/freshness. */
export function isInstalled(record: ProvenanceRecord | undefined, pack: ScannedPack): boolean {
	return !!record && record.packId === pack.packId;
}
