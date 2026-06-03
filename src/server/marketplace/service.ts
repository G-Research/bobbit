/**
 * Marketplace MVP — service facade.
 *
 * Wires the source registry, sync service, scanner, provenance, and install
 * engine behind high-level methods the REST routes call. Resolution of a
 * (scope, projectId) pair into concrete config dirs + invalidation callbacks
 * lives here so routes stay thin and the engine stays testable.
 */

import os from "node:os";
import path from "node:path";
import { ConflictError, InstallService, type InstallArgs } from "./install-service.js";
import { hashPackPayload, scanSource } from "./pack-scanner.js";
import { ProvenanceStore, computeInstallStatus } from "./provenance-store.js";
import { SourceRegistry, type AddSourceInput } from "./source-registry.js";
import { MarketplaceSyncService } from "./sync-service.js";
import type { ProjectConfigWriter } from "../agent/config-directories.js";
import type {
	ConflictMode,
	EntityRef,
	InstallCtx,
	InstallOutcome,
	InstallScope,
	InstallStatus,
	ScannedPack,
	SourceRecord,
} from "./types.js";

/** Per-project resolution result the host supplies. */
export interface ResolvedProject {
	configDir: string;
	projectConfigStore: ProjectConfigWriter;
	invalidateTools?: () => void;
	invalidateRoles?: () => void;
}

export interface MarketplaceServiceDeps {
	/** Server-global state dir (sources.json + sync cache live under here). */
	stateDir: string;
	/** System-scope config dir (= bobbitConfigDir()). */
	systemConfigDir: string;
	/** System-scope skills dir (always scanned by discoverSlashSkills). Default ~/.bobbit/skills. */
	systemSkillsDir?: string;
	/** Resolve a projectId to its config dir + writer + invalidators, or null. */
	resolveProject: (projectId: string) => ResolvedProject | null;
	invalidateSystemTools?: () => void;
	invalidateSystemRoles?: () => void;
}

export interface PackSummary {
	sourceId: string;
	packId: string;
	name: string;
	description: string;
	version: string;
	sourceLabel: string | null;
	entities: EntityRef[];
	hasTools: boolean;
	valid: boolean;
	error?: string;
	installStatus: InstallStatus;
	installedVersion: string | null;
	installedCommit: string | null;
}

export class MarketplaceService {
	readonly registry: SourceRegistry;
	readonly sync: MarketplaceSyncService;
	private readonly install: InstallService;
	private readonly deps: MarketplaceServiceDeps;
	private readonly systemSkillsDir: string;

	constructor(deps: MarketplaceServiceDeps) {
		this.deps = deps;
		this.systemSkillsDir = deps.systemSkillsDir ?? path.join(os.homedir(), ".bobbit", "skills");
		this.registry = new SourceRegistry(deps.stateDir);
		this.sync = new MarketplaceSyncService(path.join(deps.stateDir, "marketplace"));
		this.install = new InstallService({
			resolveCtx: (scope, projectId) => this.resolveCtx(scope, projectId),
			resolveProvenance: (scope, projectId) => this.resolveProvenance(scope, projectId),
		});
	}

	// ── Sources ────────────────────────────────────────────────

	listSources(): SourceRecord[] {
		return this.registry.list();
	}

	addSource(input: AddSourceInput): SourceRecord {
		return this.registry.add(input);
	}

	/** Sync a source (clone/pull git; validate local) and persist sync status. */
	async syncSource(id: string): Promise<SourceRecord> {
		const source = this.registry.get(id);
		if (!source) throw new Error(`source not found: ${id}`);
		const result = await this.sync.sync(source);
		return this.registry.update(id, {
			lastSyncedAt: Date.now(),
			lastSyncCommit: result.commit,
			lastSyncError: result.error,
		});
	}

	removeSource(id: string): void {
		this.registry.remove(id);
		this.sync.removeCache(id);
	}

	// ── Browse ─────────────────────────────────────────────────

	/** List all packs across all sources, annotated with install status for the scope. */
	listPacks(scope: InstallScope, projectId: string | null): PackSummary[] {
		const provenance = this.resolveProvenance(scope, projectId);
		const out: PackSummary[] = [];
		for (const source of this.registry.list()) {
			const root = this.sync.syncRoot(source);
			for (const pack of scanSource(source.id, root)) {
				out.push(this.summarize(source, pack, provenance));
			}
		}
		return out;
	}

	/** Drill-down: the scanned pack + install status for the scope. */
	getPack(sourceId: string, packId: string, scope: InstallScope, projectId: string | null): {
		summary: PackSummary;
		pack: ScannedPack;
		installedEntities: EntityRef[];
	} | null {
		const found = this.findPack(sourceId, packId);
		if (!found) return null;
		const { source, pack } = found;
		const provenance = this.resolveProvenance(scope, projectId);
		const record = provenance?.find(sourceId, packId);
		const installedEntities = record ? record.entities.map((e) => ({ type: e.type, name: e.name })) : [];
		return { summary: this.summarize(source, pack, provenance), pack, installedEntities };
	}

	// ── Install / update / uninstall ───────────────────────────

	installPack(opts: {
		sourceId: string;
		packId: string;
		scope: InstallScope;
		projectId: string | null;
		entities: EntityRef[] | null;
		conflict: ConflictMode;
	}): InstallOutcome {
		const found = this.requirePack(opts.sourceId, opts.packId);
		const args: InstallArgs = {
			scope: opts.scope,
			projectId: opts.projectId,
			source: found.source,
			pack: found.pack,
			entities: opts.entities,
			conflict: opts.conflict,
		};
		return this.install.install(args);
	}

	async updatePack(opts: { sourceId: string; packId: string; scope: InstallScope; projectId: string | null }): Promise<InstallOutcome> {
		// Re-sync first so the re-copy reflects upstream changes.
		await this.syncSource(opts.sourceId);
		const found = this.requirePack(opts.sourceId, opts.packId);
		return this.install.update({ scope: opts.scope, projectId: opts.projectId, source: found.source, pack: found.pack });
	}

	uninstallPack(opts: { sourceId: string; packId: string; scope: InstallScope; projectId: string | null }): { removed: EntityRef[] } {
		const res = this.install.uninstall({ scope: opts.scope, projectId: opts.projectId, sourceId: opts.sourceId, packId: opts.packId });
		return { removed: res.removed.map((e) => ({ type: e.type, name: e.name })) };
	}

	// ── internals ──────────────────────────────────────────────

	private findPack(sourceId: string, packId: string): { source: SourceRecord; pack: ScannedPack } | null {
		const source = this.registry.get(sourceId);
		if (!source) return null;
		const root = this.sync.syncRoot(source);
		const pack = scanSource(sourceId, root).find((p) => p.packId === packId);
		if (!pack) return null;
		return { source, pack };
	}

	private requirePack(sourceId: string, packId: string): { source: SourceRecord; pack: ScannedPack } {
		const found = this.findPack(sourceId, packId);
		if (!found) throw new Error(`pack not found: ${sourceId}/${packId}`);
		return found;
	}

	private summarize(source: SourceRecord, pack: ScannedPack, provenance: ProvenanceStore | null): PackSummary {
		const record = provenance?.find(source.id, pack.packId);
		const contentHash = source.kind === "local" && pack.valid ? hashPackPayload(pack) : null;
		const installStatus = computeInstallStatus(source, record, contentHash);
		return {
			sourceId: source.id,
			packId: pack.packId,
			name: pack.manifest?.name ?? pack.packId,
			description: pack.manifest?.description ?? "",
			version: pack.manifest?.version ?? "",
			sourceLabel: source.label,
			entities: pack.entities.map((e) => ({ type: e.type, name: e.name })),
			hasTools: pack.hasTools,
			valid: pack.valid,
			error: pack.error,
			installStatus,
			installedVersion: record?.packVersion ?? null,
			installedCommit: record?.sourceCommit ?? null,
		};
	}

	private resolveCtx(scope: InstallScope, projectId: string | null): InstallCtx | null {
		if (scope === "system") {
			return {
				scope,
				projectId: null,
				configDir: this.deps.systemConfigDir,
				skillInstallDir: this.systemSkillsDir,
				invalidateTools: this.deps.invalidateSystemTools,
				invalidateRoles: this.deps.invalidateSystemRoles,
			};
		}
		if (!projectId) return null;
		const proj = this.deps.resolveProject(projectId);
		if (!proj) return null;
		return {
			scope,
			projectId,
			configDir: proj.configDir,
			skillInstallDir: path.join(proj.configDir, "skills"),
			projectConfigStore: proj.projectConfigStore,
			invalidateTools: proj.invalidateTools,
			invalidateRoles: proj.invalidateRoles,
		};
	}

	private resolveProvenance(scope: InstallScope, projectId: string | null): ProvenanceStore | null {
		if (scope === "system") return new ProvenanceStore(this.deps.systemConfigDir);
		if (!projectId) return null;
		const proj = this.deps.resolveProject(projectId);
		if (!proj) return null;
		return new ProvenanceStore(proj.configDir);
	}
}

export { ConflictError };
