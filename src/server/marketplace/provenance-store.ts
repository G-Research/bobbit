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
import { hashInstalledEntity } from "./pack-scanner.js";
import type { EntityRef, EntityType, InstallStatus, ProvenanceRecord, ScannedPack, SourceRecord } from "./types.js";

const ENTITY_TYPES: EntityType[] = ["role", "tool", "skill"];

/**
 * Validate + normalise a record loaded from installed.json. A hand-edited or
 * corrupt file must never crash the server or feed malformed records into the
 * install engine, so records failing the shape/type contract are dropped.
 * Missing `installMode` defaults to "pack" (legacy records predate the field).
 */
function coerceRecord(raw: unknown): ProvenanceRecord | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.sourceId !== "string" || typeof r.packId !== "string") return null;
	if (r.scope !== "system" && r.scope !== "project") return null;
	if (!Array.isArray(r.entities)) return null;
	for (const e of r.entities) {
		if (!e || typeof e !== "object" || Array.isArray(e)) return null;
		const ent = e as Record<string, unknown>;
		if (!ENTITY_TYPES.includes(ent.type as EntityType)) return null;
		if (typeof ent.name !== "string") return null;
		if (!Array.isArray(ent.installedPaths) || !ent.installedPaths.every((p) => typeof p === "string")) return null;
	}
	if (r.installMode !== "pack" && r.installMode !== "subset") r.installMode = "pack";
	return r as unknown as ProvenanceRecord;
}

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
			const arr: unknown[] = Array.isArray(parsed?.installs) ? parsed.installs : [];
			this.records = arr.map(coerceRecord).filter((r): r is ProvenanceRecord => r !== null);
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

	/**
	 * Transfer ownership of the given (type, name) entities to the installing pack
	 * by dropping them from every OTHER pack record in this (same-scope) store.
	 *
	 * Called after an `overwrite` install/update rewrites the bytes of an entity
	 * another pack previously installed: the destination path is now the new
	 * pack's, so the prior pack must no longer claim it — otherwise uninstalling
	 * the prior pack would delete an entity it no longer owns (asymmetry). A record
	 * emptied by the removal is dropped entirely so it never lingers as a phantom
	 * "installed" pack. The (keepSourceId, keepPackId) record is never touched
	 * (the caller upserts it separately).
	 */
	supersedeEntities(entities: EntityRef[], keepSourceId: string, keepPackId: string): void {
		if (entities.length === 0) return;
		const keys = new Set(entities.map((e) => `${e.type}/${e.name}`));
		let changed = false;
		const next: ProvenanceRecord[] = [];
		for (const r of this.records) {
			if (r.sourceId === keepSourceId && r.packId === keepPackId) {
				next.push(r);
				continue;
			}
			const filtered = r.entities.filter((e) => !keys.has(`${e.type}/${e.name}`));
			if (filtered.length === r.entities.length) {
				next.push(r);
				continue;
			}
			changed = true;
			if (filtered.length > 0) next.push({ ...r, entities: filtered });
			// else: drop the now-empty record entirely.
		}
		if (changed) {
			this.records = next;
			this.save();
		}
	}
}

/**
 * Compute install status for a scanned pack against its provenance record (§5).
 * - not-installed: no record.
 * - drifted: a recorded installed path is missing OR its bytes were edited
 *   locally (per-entity contentHash mismatch). Records that predate the
 *   contentHash field fall back to existence-only drift detection.
 * - update-available: source commit (git) / content hash (local) differs from recorded.
 * - installed: otherwise.
 */
export function computeInstallStatus(
	source: SourceRecord,
	record: ProvenanceRecord | undefined,
	currentContentHash: string | null,
): InstallStatus {
	// No record — or a record that tracks zero entities (e.g. a stale empty
	// record) — means nothing is installed for this pack.
	if (!record || record.entities.length === 0) return "not-installed";

	for (const entity of record.entities) {
		for (const p of entity.installedPaths) {
			if (!fs.existsSync(p)) return "drifted";
		}
		// Edit drift: recompute the on-disk hash and compare to what install
		// recorded. Skipped for legacy records lacking a contentHash (existence
		// check above is the only signal then).
		if (entity.contentHash && hashInstalledEntity(entity.installedPaths) !== entity.contentHash) {
			return "drifted";
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
