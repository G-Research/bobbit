/**
 * Marketplace MVP — install pipeline (§6).
 *
 * One engine drives whole-pack and individual-entity install, plus update and
 * uninstall. Conflict detection runs before any copy; copies are transactional
 * with rollback of this install's writes on mid-copy failure. A TrustPolicy
 * gate is invoked before any handler runs — a no-op in the MVP (§8.1) — so the
 * call site exists from day one.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stripTokenFromGitUrl } from "../skills/git.js";
import { ENTITY_HANDLERS, isWithin, reconcileSkillDirRegistration } from "./entity-handlers.js";
import { hashPackPayload } from "./pack-scanner.js";
import { ProvenanceStore } from "./provenance-store.js";
import type {
	ConflictMode,
	EntityRef,
	InstallCtx,
	InstallEntityResult,
	InstallMode,
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

		// reconcile is the authoritative final step: whatever doCopy leaves on
		// disk (full success, conflict abort, or rolled-back failure), the skills
		// registration is settled against on-disk reality afterwards.
		let installed: InstalledEntity[];
		let skipped: EntityRef[];
		try {
			({ installed, skipped } = this.doCopy(ctx, targets, pack.dir, conflict));
		} finally {
			reconcileSkillDirRegistration(ctx);
		}

		const isWholePack = entities === null;
		// Subset install into an already-installed pack MERGES (union by type/name,
		// new install wins) so installing A then B never loses A from provenance.
		// Whole-pack install writes the full record.
		const existing = provenance.find(source.id, pack.packId);
		let recordEntities = installed;
		if (!isWholePack && existing) {
			const byKey = new Map(existing.entities.map((e) => [`${e.type}/${e.name}`, e]));
			for (const e of installed) byKey.set(`${e.type}/${e.name}`, e);
			recordEntities = [...byKey.values()];
		}
		const installMode = this.resolveInstallMode(isWholePack, pack, recordEntities);
		const record = this.buildRecord(scope, projectId, source, pack, recordEntities, installMode);
		provenance.upsert(record);

		const results: InstallEntityResult[] = [
			...installed.map((e): InstallEntityResult => ({ type: e.type, name: e.name, status: "installed", installedPaths: e.installedPaths })),
			...skipped.map((e): InstallEntityResult => ({ type: e.type, name: e.name, status: "skipped" })),
		];
		return { record, results, skipped };
	}

	/** subset install becomes "pack" once its record covers every declared entity. */
	private resolveInstallMode(isWholePack: boolean, pack: ScannedPack, recordEntities: InstalledEntity[]): InstallMode {
		if (isWholePack) return "pack";
		const declared = pack.entities.map((e) => `${e.type}/${e.name}`);
		const have = new Set(recordEntities.map((e) => `${e.type}/${e.name}`));
		const coversAll = declared.length > 0 && declared.every((k) => have.has(k));
		return coversAll ? "pack" : "subset";
	}

	/**
	 * Re-sync-then-refresh, fully transactional across removals AND copies.
	 *
	 * - installMode "pack"   → install everything the updated pack now declares
	 *   (add newly-declared, refresh existing, remove no-longer-declared), so a
	 *   whole-pack update truly reflects upstream.
	 * - installMode "subset" → refresh only tracked entities still declared and
	 *   remove tracked entities no longer declared; never auto-add new ones.
	 *
	 * A mid-update failure restores the system exactly as it was: every removed
	 * and every overwritten entity is backed up first, and on failure newly
	 * copied entities are removed and all backups restored. Provenance is
	 * rewritten only on full success.
	 */
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

		const mode: InstallMode = existing.installMode === "subset" ? "subset" : "pack";
		const declaredNow = new Set(pack.entities.map((e) => `${e.type}/${e.name}`));

		const finalTargets: EntityRef[] = mode === "pack"
			? pack.entities.map((e) => ({ type: e.type, name: e.name }))
			: existing.entities.filter((e) => declaredNow.has(`${e.type}/${e.name}`)).map((e) => ({ type: e.type, name: e.name }));
		const finalKeys = new Set(finalTargets.map((t) => `${t.type}/${t.name}`));
		const toRemove = existing.entities.filter((e) => !finalKeys.has(`${e.type}/${e.name}`));

		let installed: InstalledEntity[];
		try {
			installed = this.applyUpdateTransactional(ctx, pack.dir, finalTargets, toRemove);
		} finally {
			// Authoritative final step: settle the skills registration against
			// on-disk reality regardless of success or rolled-back failure.
			reconcileSkillDirRegistration(ctx);
		}

		const installMode = this.resolveInstallMode(mode === "pack", pack, installed);
		const record = this.buildRecord(scope, projectId, source, pack, installed, installMode);
		provenance.upsert(record);

		const results: InstallEntityResult[] = installed.map((e): InstallEntityResult => ({
			type: e.type, name: e.name, status: "installed", installedPaths: e.installedPaths,
		}));
		return { record, results, skipped: [] };
	}

	/** Entity-type destination root for the resolved scope (for containment + backup). */
	private entityRoot(ctx: InstallCtx, ref: EntityRef): string {
		return path.dirname(ENTITY_HANDLERS[ref.type].destPath(ctx, ref.name));
	}

	/**
	 * Apply an update's removals + copies as one transaction. Every path that
	 * will be removed or overwritten is renamed to a temp backup first; on any
	 * failure newly-copied entities are removed and all backups restored, leaving
	 * the system byte-for-byte as before. On success backups are discarded and
	 * skill custom-dir registrations are dropped only when no skill remains.
	 */
	private applyUpdateTransactional(
		ctx: InstallCtx,
		packDir: string,
		targets: EntityRef[],
		toRemove: InstalledEntity[],
	): InstalledEntity[] {
		const backups: { dest: string; backup: string }[] = [];
		const installed: InstalledEntity[] = [];
		const backup = (dest: string): void => {
			if (!fs.existsSync(dest)) return;
			const bak = `${dest}.mp-bak-${randomUUID().slice(0, 8)}`;
			fs.renameSync(dest, bak);
			backups.push({ dest, backup: bak });
		};
		try {
			// 1. Back up (move aside) every entity that is being removed.
			for (const e of toRemove) {
				const root = this.entityRoot(ctx, e);
				for (const p of e.installedPaths) {
					if (!isWithin(root, p)) continue; // never touch tampered out-of-scope paths
					backup(p);
				}
			}
			// 2. Back up overwrite targets, then copy every target fresh.
			for (const t of targets) {
				backup(ENTITY_HANDLERS[t.type].destPath(ctx, t.name));
				installed.push(ENTITY_HANDLERS[t.type].install(ctx, packDir, t.name));
			}
		} catch (err) {
			for (const e of installed) {
				try { ENTITY_HANDLERS[e.type].uninstall(ctx, e); } catch { /* best-effort */ }
			}
			for (const b of [...backups].reverse()) {
				try {
					if (fs.existsSync(b.dest)) fs.rmSync(b.dest, { recursive: true, force: true });
					fs.renameSync(b.backup, b.dest);
				} catch { /* best-effort */ }
			}
			throw err;
		}
		// Success: discard backups.
		for (const b of backups) {
			try { fs.rmSync(b.backup, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
		// Removed skills: their files are already gone (backups discarded above);
		// the shared config_directories "skills" registration is settled by the
		// authoritative reconcile in update()'s finally — never dropped here, so a
		// surviving sibling skill can't lose its dir registration.
		if (toRemove.some((e) => e.type === "role")) ctx.invalidateRoles?.();
		if (toRemove.some((e) => e.type === "tool")) ctx.invalidateTools?.();
		return installed;
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

		try {
			for (const entity of record.entities) {
				ENTITY_HANDLERS[entity.type].uninstall(ctx, entity);
			}
		} finally {
			// Authoritative final step — keep the skills registration iff any skill
			// (e.g. from a sibling pack) still lives under the shared dir.
			reconcileSkillDirRegistration(ctx);
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
		// Overwrite mode: MOVE each existing destination to a temp backup before
		// copying so a mid-install failure can restore it. Deleting up-front (the
		// old behaviour) made rollback unable to recover a clobbered entity.
		const backups: { dest: string; backup: string }[] = [];
		try {
			for (const t of toInstall) {
				const handler = ENTITY_HANDLERS[t.type];
				if (conflict === "overwrite" && conflictKeys.has(`${t.type}/${t.name}`)) {
					const dest = handler.destPath(ctx, t.name);
					const backup = `${dest}.mp-bak-${randomUUID().slice(0, 8)}`;
					fs.renameSync(dest, backup);
					backups.push({ dest, backup });
				}
				installed.push(handler.install(ctx, packDir, t.name));
			}
		} catch (err) {
			// Roll back this install's writes (best-effort), then restore backups so
			// the system is left exactly as it was before the install began.
			for (const e of installed) {
				try { ENTITY_HANDLERS[e.type].uninstall(ctx, e); } catch { /* best-effort */ }
			}
			for (const b of backups) {
				try {
					if (fs.existsSync(b.dest)) fs.rmSync(b.dest, { recursive: true, force: true });
					fs.renameSync(b.backup, b.dest);
				} catch { /* best-effort */ }
			}
			throw err;
		}
		// Success: discard the backups of overwritten entities.
		for (const b of backups) {
			try { fs.rmSync(b.backup, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
		return { installed, skipped };
	}

	private buildRecord(
		scope: InstallScope,
		projectId: string | null,
		source: SourceRecord,
		pack: ScannedPack,
		installed: InstalledEntity[],
		installMode: InstallMode,
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
			installMode,
			entities: installed,
		};
	}
}
