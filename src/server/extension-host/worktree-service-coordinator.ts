// src/server/extension-host/worktree-service-coordinator.ts
//
// Gateway-owned boundary between persisted session coordinates and the
// core-owned managed-service lifecycle. Packs never select a worktree, host
// path, process, or endpoint through this module.

import { createHash } from "node:crypto";
import path from "node:path";
import type { ServiceInstancePublicRef, ServiceInstanceRef, ServiceStatus } from "./service-extension-contract.js";
import { isServicePlatformIdentifier } from "./service-platform-identifier.js";
import type { ServiceExtensionRuntime } from "./service-extension-runtime.js";
import {
	ServiceToolAdapterRegistry,
	ServiceToolOperationScheduler,
	ServiceToolRpcError,
	validateServiceToolPayload,
	validateServiceToolRequest,
	validateServiceToolResult,
	type ServiceExtensionToolRpc,
	type ServiceToolRequest,
	type ServiceToolResponse,
} from "./service-extension-tool-rpc.js";

export type { ServiceInstancePublicRef, ServiceInstanceRef } from "./service-extension-contract.js";

const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_DISCRIMINATOR = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_DISCRIMINATOR_BYTES = 32;

export interface WorktreeServiceSession {
	id: string;
	projectId?: string;
	cwd?: string;
	worktreePath?: string;
	repoWorktrees?: Readonly<Record<string, string>> | readonly { repo: string; worktreePath: string }[];
	archived?: boolean;
}

export interface WorktreeServiceComponent {
	name: string;
	repo: string;
}

export interface WorktreeServiceDeclaration {
	packId: string;
	spec: { id: string; dataDir?: string };
}

/** Backward-compatible coordinator names alias the canonical broker contracts. */
export type WorktreeServiceRequest = ServiceToolRequest;
export type WorktreeServiceResponse = ServiceToolResponse;

/** The lifecycle manager deliberately remains unaware of sessions and Git. */
export interface WorktreeServiceRuntime extends Pick<ServiceExtensionRuntime, "reconcile" | "stop"> {
	status: (ref: ServiceInstancePublicRef) => Pick<ServiceStatus, "state"> | undefined;
}

/** A core-registered executor. It is never passed to extension code. */
export interface WorktreeServiceAdapter {
	request(input: { ref: ServiceInstanceRef; operation: string; payload?: unknown; signal: AbortSignal }): Promise<unknown>;
}

export interface WorktreeServiceCoordinatorDeps {
	sessions: {
		get(sessionId: string): WorktreeServiceSession | undefined;
		list(projectId: string): readonly WorktreeServiceSession[];
	};
	components(projectId: string): readonly WorktreeServiceComponent[];
	stateDir(projectId: string): string | undefined;
	git: { topLevel(cwd: string): Promise<string> };
	filesystem: {
		realpath(target: string): Promise<string>;
		isDirectory(target: string): Promise<boolean>;
		removeDirectory(target: string): Promise<void>;
	};
	listActive(projectId: string): Promise<readonly WorktreeServiceDeclaration[]> | readonly WorktreeServiceDeclaration[];
	authorize(projectId: string, principal: { kind: "pack"; packId: string }, capability: "service.manage"): { allowed: boolean };
	/** A fresh unreadable-settings result is treated exactly like an inactive service. */
	settingsReadable?(ref: ServiceInstanceRef): Promise<boolean> | boolean;
	runtime: WorktreeServiceRuntime;
	/** Closed schemas, owned by core and injected by the gateway. */
	operations: ServiceToolAdapterRegistry;
	/** Bounded, abortable execution queue, owned by the gateway. */
	scheduler: ServiceToolOperationScheduler;
	adapter?(packId: string, serviceId: string, discriminator: string): WorktreeServiceAdapter | undefined;
	schedule?(run: () => void): void;
}

export class WorktreeServiceCoordinatorError extends Error {
	constructor(readonly code: "SERVICE_UNAVAILABLE" | "SERVICE_NOT_READY" | "SERVICE_OPERATION_INVALID") {
		super(code === "SERVICE_OPERATION_INVALID" ? "Managed service operation is invalid" : "Managed service is unavailable");
		this.name = "WorktreeServiceCoordinatorError";
	}
}

interface Scope {
	projectId: string;
	component: string;
	canonicalWorktreeRoot: string;
	worktreeKey: string;
}

interface ReconcileState {
	dirty: boolean;
	scheduled: boolean;
	running?: Promise<void>;
}

function safeIdentifier(value: unknown): value is string {
	return typeof value === "string" && SAFE_ID.test(value);
}

function safePlatformIdentifier(value: unknown): value is string {
	return isServicePlatformIdentifier(value);
}

function normalizeDiscriminator(value: string | undefined): string | undefined {
	const normalized = value ?? "default";
	return Buffer.byteLength(normalized, "utf8") <= MAX_DISCRIMINATOR_BYTES && SAFE_DISCRIMINATOR.test(normalized)
		? normalized
		: undefined;
}

function worktreeKey(root: string): string {
	return createHash("sha256").update(root).digest("base64url").toLowerCase().slice(0, 22);
}

function instanceKey(ref: ServiceInstanceRef): string {
	return [ref.projectId, ref.component, ref.canonicalWorktreeRoot, ref.packId, ref.serviceId, ref.discriminator].join("\0");
}

function scopeKey(scope: Scope): string {
	return [scope.projectId, scope.component, scope.canonicalWorktreeRoot].join("\0");
}

function contains(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function asRepoWorktrees(session: WorktreeServiceSession): Readonly<Record<string, string>> {
	const entries = session.repoWorktrees;
	if (Array.isArray(entries)) return Object.fromEntries(entries.map(entry => [entry.repo, entry.worktreePath]));
	return (entries ?? {}) as Readonly<Record<string, string>>;
}

function isRelativeDataDir(value: string): boolean {
	return value.length > 0 && value.length <= 240 && !value.includes("\0") && !value.includes("\\") && !path.isAbsolute(value)
		&& value.split("/").every(segment => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment));
}

/**
 * Resolves all service identity fields from server-owned session coordinates.
 * Calls are intentionally exact: a request can never select a sibling pack,
 * component, or linked worktree by supplying a path.
 */
export class WorktreeServiceCoordinator implements ServiceExtensionToolRpc {
	private readonly instances = new Map<string, ServiceInstanceRef>();
	/** Retained after a non-destructive stop so final worktree cleanup knows its exact owned directory. */
	private readonly knownInstances = new Map<string, ServiceInstanceRef>();
	/** Cleanup coordinates survive archive until a confirmed worktree removal. */
	private readonly sessionRoots = new Map<string, Map<string, Set<string>>>();
	/** Active owners keep an instance running; archived owners intentionally do not. */
	private readonly activeSessionRoots = new Map<string, Map<string, Set<string>>>();
	/** Candidate paths bind a trusted cleanup completion to the captured canonical root. */
	private readonly sessionRootPaths = new Map<string, Map<string, Map<string, Set<string>>>>();
	private readonly reconcileStates = new Map<string, ReconcileState>();
	/** Stop operations advance this fence so an older resolver cannot revive a root. */
	private readonly projectGenerations = new Map<string, number>();
	private closed = false;

	constructor(private readonly deps: WorktreeServiceCoordinatorDeps) {}

	async reconcileProject(projectId: string): Promise<void> {
		if (this.closed || !safePlatformIdentifier(projectId)) return;
		let state = this.reconcileStates.get(projectId);
		if (!state) {
			state = { dirty: false, scheduled: false };
			this.reconcileStates.set(projectId, state);
		}
		state.dirty = true;
		if (!state.running) {
			state.running = new Promise<void>(resolve => {
				const run = () => void this.runProject(projectId, state!, resolve);
				state!.scheduled = true;
				(this.deps.schedule ?? queueMicrotask)(run);
			});
		}
		await state.running;
	}

	async reconcileSession(sessionId: string): Promise<void> {
		const session = this.deps.sessions.get(sessionId);
		if (!session?.projectId || session.archived || this.closed) return;
		await this.reconcileProject(session.projectId);
	}

	/** Closure-bound broker entry point used by ServerHostApi. */
	async request(input: { sessionId: string; packId: string; request: WorktreeServiceRequest }): Promise<WorktreeServiceResponse> {
		if (this.closed || !safePlatformIdentifier(input.packId)) throw new WorktreeServiceCoordinatorError("SERVICE_OPERATION_INVALID");
		let request: ServiceToolRequest;
		try { request = validateServiceToolRequest(input.request); } catch { throw new WorktreeServiceCoordinatorError("SERVICE_OPERATION_INVALID"); }
		let resolved;
		try { resolved = this.deps.operations.resolve(input.packId, request); } catch (error) {
			if (error instanceof ServiceToolRpcError) throw error;
			throw new WorktreeServiceCoordinatorError("SERVICE_OPERATION_INVALID");
		}
		let payload: unknown;
		try { payload = validateServiceToolPayload(resolved.operation, resolved.request.payload); } catch (error) {
			if (error instanceof ServiceToolRpcError) throw error;
			throw new WorktreeServiceCoordinatorError("SERVICE_OPERATION_INVALID");
		}
		const session = this.deps.sessions.get(input.sessionId);
		if (!session?.projectId || session.archived) throw new WorktreeServiceCoordinatorError("SERVICE_UNAVAILABLE");
		const projectGeneration = this.projectGeneration(session.projectId);
		const scope = await this.resolveScope(session, resolved.request.component);
		if (!scope) throw new WorktreeServiceCoordinatorError("SERVICE_UNAVAILABLE");
		const ref = await this.resolveActiveRef(scope, input.packId, resolved.request.serviceId, resolved.request.discriminator ?? "default");
		if (!ref || !this.isCurrent(projectGeneration, ref.projectId)) throw new WorktreeServiceCoordinatorError("SERVICE_UNAVAILABLE");

		await this.deps.runtime.reconcile(ref);
		if (!await this.isReadyAndCurrent(projectGeneration, ref)) throw new WorktreeServiceCoordinatorError("SERVICE_UNAVAILABLE");
		const adapter = this.deps.adapter?.(ref.packId, ref.serviceId, ref.discriminator);
		if (!adapter) throw new WorktreeServiceCoordinatorError("SERVICE_UNAVAILABLE");
		try {
			const value = await this.deps.scheduler.run(instanceKey(ref), async signal => {
				if (!await this.isReadyAndCurrent(projectGeneration, ref)) throw new WorktreeServiceCoordinatorError("SERVICE_UNAVAILABLE");
				const result = await adapter.request({ ref, operation: resolved.request.operation, signal, ...(payload === undefined ? {} : { payload }) });
				if (!await this.isReadyAndCurrent(projectGeneration, ref)) throw new WorktreeServiceCoordinatorError("SERVICE_UNAVAILABLE");
				return validateServiceToolResult(resolved.operation, result);
			});
			return { state: "ready", ...(value === undefined ? {} : { value }) };
		} catch (error) {
			if (error instanceof ServiceToolRpcError || error instanceof WorktreeServiceCoordinatorError) throw error;
			throw new WorktreeServiceCoordinatorError("SERVICE_UNAVAILABLE");
		}
	}

	/** Called only when the owning worktree was authoritatively removed. */
	async stopWorktree(projectId: string, canonicalWorktreeRoot: string): Promise<void> {
		if (!safePlatformIdentifier(projectId) || !path.isAbsolute(canonicalWorktreeRoot)) return;
		this.advanceProjectGeneration(projectId);
		const targets = this.refsFor(projectId, canonicalWorktreeRoot);
		await Promise.all(targets.map(ref => this.stopInstance(ref, true)));
	}

	/** Archive releases a live owner and fences its final instance, but preserves data ownership for later cleanup. */
	async releaseSession(projectId: string, sessionId: string): Promise<void> {
		if (!safePlatformIdentifier(projectId)) return;
		const roots = this.activeSessionRoots.get(sessionId)?.get(projectId);
		this.deleteActiveSessionRoots(sessionId, projectId);
		if (!roots) return;
		for (const root of roots) {
			if (!this.hasOtherRootOwner(this.activeSessionRoots, projectId, root)) {
				await Promise.all(this.refsFor(projectId, root).map(ref => this.stopInstance(ref, false)));
			}
		}
	}

	/** Destructive cleanup is allowed only after the owning worktree removal succeeded. */
	async cleanupRemovedSessionWorktrees(projectId: string, sessionId: string, worktreePaths: readonly string[]): Promise<void> {
		if (!safePlatformIdentifier(projectId) || worktreePaths.length === 0) return;
		const roots = this.sessionRoots.get(sessionId)?.get(projectId);
		const paths = this.sessionRootPaths.get(sessionId)?.get(projectId);
		if (!roots || !paths) return;
		const removed = new Set(worktreePaths.map(candidate => path.resolve(candidate)));
		for (const [root, candidates] of [...paths]) {
			if (![...candidates].some(candidate => removed.has(path.resolve(candidate)))) continue;
			paths.delete(root);
			roots.delete(root);
			if (!this.hasOtherRootOwner(this.sessionRoots, projectId, root)) await this.stopWorktree(projectId, root);
		}
		this.deleteEmptySessionRootMaps(sessionId, projectId);
	}

	/** Called only for authoritative project deletion or root replacement. */
	async stopProject(projectId: string): Promise<void> {
		if (!safePlatformIdentifier(projectId)) return;
		this.advanceProjectGeneration(projectId);
		const targets = this.refsFor(projectId);
		await Promise.all(targets.map(ref => this.stopInstance(ref, true)));
		for (const owners of [this.sessionRoots, this.activeSessionRoots]) {
			for (const [sessionId, projects] of owners) {
				projects.delete(projectId);
				if (projects.size === 0) owners.delete(sessionId);
			}
		}
		for (const [sessionId, projects] of this.sessionRootPaths) {
			projects.delete(projectId);
			if (projects.size === 0) this.sessionRootPaths.delete(sessionId);
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.deps.scheduler.close();
		const targets = [...this.instances.values()];
		this.instances.clear();
		await Promise.all(targets.map(async ref => {
			try { await this.deps.runtime.stop(ref); } catch { /* best effort */ }
		}));
	}

	/** Runtime dependency seam: only a coordinator-discovered ref gets a data path. */
	resolveDataDir(ref: ServiceInstanceRef, declaredPath: string): string {
		if (this.knownInstances.get(instanceKey(ref))?.canonicalWorktreeRoot !== ref.canonicalWorktreeRoot || !isRelativeDataDir(declaredPath)) {
			throw new Error("Managed service data directory is unavailable");
		}
		const base = this.dataBase(ref);
		const resolved = path.resolve(base, declaredPath);
		if (!contains(base, resolved)) throw new Error("Managed service data directory is unavailable");
		return resolved;
	}

	private async runProject(projectId: string, state: ReconcileState, resolve: () => void): Promise<void> {
		try {
			do {
				state.dirty = false;
				await this.reconcileProjectPass(projectId);
			} while (state.dirty && !this.closed);
		} catch {
			// Dependency failures fence and stop, but never erase persistent service data.
			this.advanceProjectGeneration(projectId);
			await Promise.all(this.refsFor(projectId).map(ref => this.stopInstance(ref, false)));
		} finally {
			state.running = undefined;
			state.scheduled = false;
			resolve();
		}
	}

	private async reconcileProjectPass(projectId: string): Promise<void> {
		const generation = this.projectGeneration(projectId);
		let declarations: readonly WorktreeServiceDeclaration[];
		try { declarations = await this.deps.listActive(projectId); } catch { await this.stopNonDestructiveProject(projectId); return; }
		if (!this.isCurrent(generation, projectId)) return;
		const active = this.uniqueActive(declarations);
		const scopes = new Map<string, Scope>();
		// Empty declarations are common today. Stop stale instances below, but do not
		// spawn git/realpath work for every session on an invalidation that cannot start one.
		if (active.length > 0) {
			const components = this.eligibleComponents(projectId);
			for (const session of this.deps.sessions.list(projectId)) {
				if (session.archived || session.projectId !== projectId) continue;
				for (const component of components) {
					const scope = await this.resolveScope(session, component);
					if (scope) scopes.set(scopeKey(scope), scope);
				}
			}
		}
		const wanted = new Map<string, ServiceInstanceRef>();
		for (const scope of scopes.values()) {
			for (const declaration of active) {
				const discriminators = new Set(["default"]);
				for (const existing of this.instances.values()) {
					if (scopeKey(existing) === scopeKey(scope) && existing.packId === declaration.packId && existing.serviceId === declaration.spec.id) discriminators.add(existing.discriminator);
				}
				for (const discriminator of discriminators) {
					const ref = this.makeRef(scope, declaration.packId, declaration.spec.id, discriminator);
					if (this.isAuthorized(ref) && await this.isSettingsReadable(ref)) wanted.set(instanceKey(ref), ref);
				}
			}
		}
		if (!this.isCurrent(generation, projectId)) return;
		for (const [key, ref] of wanted) {
			if (!this.isCurrent(generation, projectId)) return;
			this.instances.set(key, ref);
			this.knownInstances.set(key, ref);
			try { await this.deps.runtime.reconcile(ref); } catch { /* runtime fails closed internally */ }
			if (!this.isCurrent(generation, projectId)) return;
		}
		for (const [key, ref] of [...this.instances]) {
			if (ref.projectId === projectId && !wanted.has(key)) await this.stopInstance(ref, false);
		}
	}

	private async resolveScope(session: WorktreeServiceSession, requestedComponent: string): Promise<Scope | undefined> {
		if (!session.projectId || !safePlatformIdentifier(session.projectId) || !this.eligibleComponents(session.projectId).includes(requestedComponent)) return undefined;
		const components = this.deps.components(session.projectId);
		const multiRepo = components.some(component => component.repo !== ".");
		const candidate = this.candidate(session, requestedComponent, multiRepo, components);
		if (!candidate || !path.isAbsolute(candidate)) return undefined;
		const cwdFallback = !multiRepo && !session.worktreePath && Object.keys(asRepoWorktrees(session)).length === 0 && candidate === session.cwd;
		try {
			const topLevel = await this.deps.git.topLevel(candidate);
			if (!path.isAbsolute(topLevel)) return undefined;
			const [canonicalCandidate, canonicalTopLevel, isDirectory] = await Promise.all([
				this.deps.filesystem.realpath(candidate), this.deps.filesystem.realpath(topLevel), this.deps.filesystem.isDirectory(topLevel),
			]);
			if (!isDirectory || !(cwdFallback ? contains(canonicalTopLevel, canonicalCandidate) : contains(canonicalCandidate, canonicalTopLevel))) return undefined;
			this.recordSessionRoot(session.id, session.projectId, canonicalTopLevel, candidate, topLevel);
			return { projectId: session.projectId, component: requestedComponent, canonicalWorktreeRoot: canonicalTopLevel, worktreeKey: worktreeKey(canonicalTopLevel) };
		} catch {
			return undefined;
		}
	}

	private candidate(session: WorktreeServiceSession, component: string, multiRepo: boolean, components: readonly WorktreeServiceComponent[]): string | undefined {
		const worktrees = asRepoWorktrees(session);
		if (multiRepo) {
			const configured = components.find(item => item.name === component);
			return configured ? worktrees[configured.repo] : undefined;
		}
		if (component !== ".") return undefined;
		return session.worktreePath ?? (session.cwd && Object.keys(worktrees).length === 0 ? session.cwd : undefined) ?? worktrees["."];
	}

	private eligibleComponents(projectId: string): string[] {
		const configured = this.deps.components(projectId);
		return configured.some(component => component.repo !== ".")
			? configured.filter(component => safePlatformIdentifier(component.name) && typeof component.repo === "string").map(component => component.name)
			: ["."];
	}

	private async resolveActiveRef(scope: Scope, packId: string, serviceId: string, discriminator: string): Promise<ServiceInstanceRef | undefined> {
		let declarations: readonly WorktreeServiceDeclaration[];
		try { declarations = await this.deps.listActive(scope.projectId); } catch { return undefined; }
		const matches = declarations.filter(item => item.packId === packId && item.spec.id === serviceId);
		if (matches.length !== 1 || !safePlatformIdentifier(packId) || !safeIdentifier(serviceId) || !normalizeDiscriminator(discriminator)) return undefined;
		const ref = this.makeRef(scope, packId, serviceId, discriminator);
		if (!this.isAuthorized(ref) || !await this.isSettingsReadable(ref)) return undefined;
		this.instances.set(instanceKey(ref), ref);
		this.knownInstances.set(instanceKey(ref), ref);
		return ref;
	}

	private uniqueActive(declarations: readonly WorktreeServiceDeclaration[]): WorktreeServiceDeclaration[] {
		const counts = new Map<string, number>();
		for (const item of declarations) {
			if (safePlatformIdentifier(item.packId) && safeIdentifier(item.spec.id)) {
				const key = `${item.packId}\0${item.spec.id}`;
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
		}
		return declarations.filter(item => safePlatformIdentifier(item.packId) && safeIdentifier(item.spec.id) && counts.get(`${item.packId}\0${item.spec.id}`) === 1);
	}

	private makeRef(scope: Scope, packId: string, serviceId: string, discriminator: string): ServiceInstanceRef {
		return { ...scope, packId, serviceId, discriminator };
	}

	private publicRef(ref: ServiceInstanceRef): ServiceInstancePublicRef {
		const { canonicalWorktreeRoot: _internal, ...safe } = ref;
		return safe;
	}

	private projectGeneration(projectId: string): number {
		return this.projectGenerations.get(projectId) ?? 0;
	}

	private advanceProjectGeneration(projectId: string): void {
		this.projectGenerations.set(projectId, this.projectGeneration(projectId) + 1);
	}

	private isCurrent(generation: number, projectId: string): boolean {
		return !this.closed && generation === this.projectGeneration(projectId);
	}

	private isAuthorized(ref: ServiceInstanceRef): boolean {
		try { return this.deps.authorize(ref.projectId, { kind: "pack", packId: ref.packId }, "service.manage").allowed === true; } catch { return false; }
	}

	private async isSettingsReadable(ref: ServiceInstanceRef): Promise<boolean> {
		try { return await (this.deps.settingsReadable?.(ref) ?? true); } catch { return false; }
	}

	private async isReadyAndCurrent(generation: number, ref: ServiceInstanceRef): Promise<boolean> {
		if (!this.isCurrent(generation, ref.projectId) || !this.instances.has(instanceKey(ref))) return false;
		let declarations: readonly WorktreeServiceDeclaration[];
		try { declarations = await this.deps.listActive(ref.projectId); } catch { return false; }
		return declarations.filter(item => item.packId === ref.packId && item.spec.id === ref.serviceId).length === 1
			&& this.isAuthorized(ref)
			&& await this.isSettingsReadable(ref)
			&& this.deps.runtime.status(this.publicRef(ref))?.state === "ready";
	}

	private async stopNonDestructiveProject(projectId: string): Promise<void> {
		this.advanceProjectGeneration(projectId);
		await Promise.all(this.refsFor(projectId).map(ref => this.stopInstance(ref, false)));
	}

	private refsFor(projectId: string, canonicalWorktreeRoot?: string): ServiceInstanceRef[] {
		const refs = new Map(this.knownInstances);
		for (const [key, ref] of this.instances) refs.set(key, ref);
		return [...refs.values()].filter(ref => ref.projectId === projectId && (canonicalWorktreeRoot === undefined || ref.canonicalWorktreeRoot === canonicalWorktreeRoot));
	}

	private async stopInstance(ref: ServiceInstanceRef, removeData: boolean): Promise<void> {
		const key = instanceKey(ref);
		this.deps.scheduler.invalidate(key);
		const wasRunning = this.instances.delete(key);
		if (wasRunning) {
			try { await this.deps.runtime.stop(ref); } catch { /* cleanup is best effort */ }
		}
		if (removeData) {
			this.knownInstances.delete(key);
			await this.removeDataDir(ref);
		}
	}

	private recordSessionRoot(sessionId: string, projectId: string, root: string, candidate: string, topLevel: string): void {
		for (const owners of [this.sessionRoots, this.activeSessionRoots]) {
			const projects = owners.get(sessionId) ?? new Map<string, Set<string>>();
			const roots = projects.get(projectId) ?? new Set<string>();
			roots.add(root);
			projects.set(projectId, roots);
			owners.set(sessionId, projects);
		}
		const projects = this.sessionRootPaths.get(sessionId) ?? new Map<string, Map<string, Set<string>>>();
		const roots = projects.get(projectId) ?? new Map<string, Set<string>>();
		const candidates = roots.get(root) ?? new Set<string>();
		candidates.add(candidate);
		candidates.add(topLevel);
		roots.set(root, candidates);
		projects.set(projectId, roots);
		this.sessionRootPaths.set(sessionId, projects);
	}

	private deleteActiveSessionRoots(sessionId: string, projectId: string): void {
		const projects = this.activeSessionRoots.get(sessionId);
		if (!projects) return;
		projects.delete(projectId);
		if (projects.size === 0) this.activeSessionRoots.delete(sessionId);
	}

	private deleteEmptySessionRootMaps(sessionId: string, projectId: string): void {
		const roots = this.sessionRoots.get(sessionId);
		if (roots?.get(projectId)?.size === 0) roots.delete(projectId);
		if (roots?.size === 0) this.sessionRoots.delete(sessionId);
		const paths = this.sessionRootPaths.get(sessionId);
		if (paths?.get(projectId)?.size === 0) paths.delete(projectId);
		if (paths?.size === 0) this.sessionRootPaths.delete(sessionId);
	}

	private hasOtherRootOwner(owners: ReadonlyMap<string, Map<string, Set<string>>>, projectId: string, root: string): boolean {
		for (const projects of owners.values()) if (projects.get(projectId)?.has(root)) return true;
		return false;
	}

	private dataBase(ref: ServiceInstanceRef): string {
		const stateDir = this.deps.stateDir(ref.projectId);
		if (!stateDir) throw new Error("Managed service state directory is unavailable");
		return path.join(stateDir, "managed-services", "v1", ref.component, ref.worktreeKey, ref.packId, ref.serviceId, ref.discriminator);
	}

	private async removeDataDir(ref: ServiceInstanceRef): Promise<void> {
		try { await this.deps.filesystem.removeDirectory(this.dataBase(ref)); } catch { /* removal remains retriable on the next cleanup */ }
	}
}
