/**
 * Marketplace MVP — install pipeline (§6).
 *
 * One engine drives whole-pack and individual-entity install, plus update and
 * uninstall. Conflict detection runs before any copy; copies are transactional
 * with rollback of this install's writes on mid-copy failure. A TrustPolicy
 * gate is invoked before any handler runs — a no-op in the MVP (§8.1) — so the
 * call site exists from day one.
 */

import fs from "node:fs";
import { stripTokenFromGitUrl } from "../skills/git.js";
import { ENTITY_HANDLERS } from "./entity-handlers.js";
import { hashPackPayload } from "./pack-scanner.js";
import { ProvenanceStore } from "./provenance-store.js";
import type {
	ConflictMode,
	EntityRef,
	InstallCtx,
	InstallEntityResult,
	InstallOutcome,
	InstallScope,
	InstalledEntity,
	ProvenanceRecord,
	ScannedPack,
	SourceRecord,
} from "./types.js";

/** Thrown when conflict mode is `fail` and ≥1 destination already exists. */
export class ConflictError extends Error {
	constructor(public readonly conflicts: EntityRef[]) {
		super(`install conflict: ${conflicts.map((c) => `${c.type}/${c.name}`).join(", ")}`);
		this.name = "ConflictError";
	}
}

/** MVP no-op trust gate (§8.1). A future phase consults signatures/allowlists. */
export interface TrustPolicy {
	check(source: SourceRecord, pack: ScannedPack): void;
}
const NOOP_TRUST: TrustPolicy = { check: () => { /* no-op in MVP */ } };

export interface InstallServiceDeps {
	resolveCtx: (scope: InstallScope, projectId: string | null) => InstallCtx | null;
	resolveProvenance: (scope: InstallScope, projectId: string | null) => ProvenanceStore | null;
	trustPolicy?: TrustPolicy;
}

export interface InstallArgs {
	scope: InstallScope;
	projectId: string | null;
	source: SourceRecord;
	pack: ScannedPack;
	/** null ⇒ whole pack (all declared); else a subset. */
	entities: EntityRef[] | null;
	conflict: ConflictMode;
}

export interface UpdateArgs {
	scope: InstallScope;
	projectId: string | null;
	source: SourceRecord;
	pack: ScannedPack;
}

export class InstallService {
	private readonly deps: InstallServiceDeps;
	private readonly trust: TrustPolicy;

	constructor(deps: InstallServiceDeps) {
		this.deps = deps;
		this.trust = deps.trustPolicy ?? NOOP_TRUST;
	}

	/** Install a whole pack or a declared subset. */
	install(args: InstallArgs): InstallOutcome {
		const { scope, projectId, source, pack, entities, conflict } = args;
		if (!pack.valid) throw new Error(`pack ${pack.packId} is invalid and cannot be installed: ${pack.error ?? ""}`);

		const ctx = this.deps.resolveCtx(scope, projectId);
		if (!ctx) throw new Error(`could not resolve install context for scope=${scope} projectId=${projectId ?? ""}`);
		const provenance = this.deps.resolveProvenance(scope, projectId);
		if (!provenance) throw new Error(`could not resolve provenance store for scope=${scope}`);

		this.trust.check(source, pack);

		const targets = this.resolveTargets(pack, entities);
		if (targets.length === 0) throw new Error("no installable entities matched the request");

		const { installed, skipped } = this.doCopy(ctx, targets, pack.dir, conflict);

		const record = this.buildRecord(scope, projectId, source, pack, installed);
		provenance.upsert(record);

		const results: InstallEntityResult[] = [
			...installed.map((e): InstallEntityResult => ({ type: e.type, name: e.name, status: "installed", installedPaths: e.installedPaths })),
			...skipped.map((e): InstallEntityResult => ({ type: e.type, name: e.name, status: "skipped" })),
		];
		return { record, results, skipped };
	}

	/** Re-sync-then-refresh: re-copy recorded entities still declared; drop orphans. */
	update(args: UpdateArgs): InstallOutcome {
		const { scope, projectId, source, pack } = args;
		const provenance = this.deps.resolveProvenance(scope, projectId);
		if (!provenance) throw new Error(`could not resolve provenance store for scope=${scope}`);
		const existing = provenance.find(source.id, pack.packId);
		if (!existing) throw new Error(`pack ${pack.packId} is not installed at scope=${scope}`);
		if (!pack.valid) throw new Error(`pack ${pack.packId} is invalid and cannot be updated: ${pack.error ?? ""}`);

		const ctx = this.deps.resolveCtx(scope, projectId);
		if (!ctx) throw new Error(`could not resolve install context for scope=${scope}`);
		this.trust.check(source, pack);

		const declaredNow = new Set(pack.entities.map((e) => `${e.type}/${e.name}`));
		const toRefresh = existing.entities.filter((e) => declaredNow.has(`${e.type}/${e.name}`));
		const toRemove = existing.entities.filter((e) => !declaredNow.has(`${e.type}/${e.name}`));

		// Drop entities the new version no longer declares (no orphans).
		for (const entity of toRemove) {
			ENTITY_HANDLERS[entity.type].uninstall(ctx, entity);
		}

		// Re-copy the still-declared entities (overwrite).
		const targets: EntityRef[] = toRefresh.map((e) => ({ type: e.type, name: e.name }));
		const { installed, skipped } = this.doCopy(ctx, targets, pack.dir, "overwrite");

		const record = this.buildRecord(scope, projectId, source, pack, installed);
		provenance.upsert(record);

		const results: InstallEntityResult[] = installed.map((e): InstallEntityResult => ({
			type: e.type, name: e.name, status: "installed", installedPaths: e.installedPaths,
		}));
		return { record, results, skipped };
	}

	/** Remove exactly the paths the provenance record tracks, then drop the record. */
	uninstall(args: { scope: InstallScope; projectId: string | null; sourceId: string; packId: string }): { removed: InstalledEntity[] } {
		const { scope, projectId, sourceId, packId } = args;
		const provenance = this.deps.resolveProvenance(scope, projectId);
		if (!provenance) throw new Error(`could not resolve provenance store for scope=${scope}`);
		const record = provenance.find(sourceId, packId);
		if (!record) return { removed: [] };

		const ctx = this.deps.resolveCtx(scope, projectId);
		if (!ctx) throw new Error(`could not resolve install context for scope=${scope}`);

		for (const entity of record.entities) {
			ENTITY_HANDLERS[entity.type].uninstall(ctx, entity);
		}
		provenance.remove(sourceId, packId);
		return { removed: record.entities };
	}

	// ── internals ──────────────────────────────────────────────

	private resolveTargets(pack: ScannedPack, entities: EntityRef[] | null): EntityRef[] {
		if (!entities) return pack.entities.map((e) => ({ type: e.type, name: e.name }));
		const declared = new Set(pack.entities.map((e) => `${e.type}/${e.name}`));
		return entities.filter((e) => declared.has(`${e.type}/${e.name}`));
	}

	private doCopy(
		ctx: InstallCtx,
		targets: EntityRef[],
		packDir: string,
		conflict: ConflictMode,
	): { installed: InstalledEntity[]; skipped: EntityRef[] } {
		// Conflict detection up front (against the same scope only).
		const conflicting: EntityRef[] = [];
		for (const t of targets) {
			const dest = ENTITY_HANDLERS[t.type].destPath(ctx, t.name);
			if (fs.existsSync(dest)) conflicting.push(t);
		}
		const conflictKeys = new Set(conflicting.map((c) => `${c.type}/${c.name}`));

		if (conflict === "fail" && conflicting.length > 0) {
			throw new ConflictError(conflicting);
		}

		const toInstall = conflict === "skip"
			? targets.filter((t) => !conflictKeys.has(`${t.type}/${t.name}`))
			: targets;
		const skipped = conflict === "skip" ? conflicting : [];

		const installed: InstalledEntity[] = [];
		try {
			for (const t of toInstall) {
				const handler = ENTITY_HANDLERS[t.type];
				// Overwrite: remove the existing destination first so a dir copy
				// can't leave stale files behind from a previous version.
				if (conflict === "overwrite" && conflictKeys.has(`${t.type}/${t.name}`)) {
					const dest = handler.destPath(ctx, t.name);
					try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* best-effort */ }
				}
				installed.push(handler.install(ctx, packDir, t.name));
			}
		} catch (err) {
			// Roll back this install's writes (best-effort).
			for (const e of installed) {
				try { ENTITY_HANDLERS[e.type].uninstall(ctx, e); } catch { /* best-effort */ }
			}
			throw err;
		}
		return { installed, skipped };
	}

	private buildRecord(
		scope: InstallScope,
		projectId: string | null,
		source: SourceRecord,
		pack: ScannedPack,
		installed: InstalledEntity[],
	): ProvenanceRecord {
		return {
			scope,
			projectId: scope === "project" ? projectId : null,
			sourceId: source.id,
			packId: pack.packId,
			packName: pack.manifest?.name ?? pack.packId,
			packVersion: pack.manifest?.version ?? "",
			sourceKind: source.kind,
			sourceUrl: source.url ? stripTokenFromGitUrl(source.url) : null,
			sourceCommit: source.lastSyncCommit ?? null,
			sourceContentHash: source.kind === "local" ? hashPackPayload(pack) : null,
			installedAt: Date.now(),
			entities: installed,
		};
	}
}
