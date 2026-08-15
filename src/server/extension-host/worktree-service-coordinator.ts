// src/server/extension-host/worktree-service-coordinator.ts
//
// Gateway-owned boundary between persisted session coordinates and the
// core-owned managed-service lifecycle. Packs never select a worktree, host
// path, process, or endpoint through this module.

import { createHash } from "node:crypto";
import path from "node:path";
import type { ServiceInstancePublicRef, ServiceInstanceRef, ServiceStatus } from "./service-extension-contract.js";
import type { ServiceExtensionRuntime } from "./service-extension-runtime.js";
import type { ServiceExtensionToolRpc, ServiceToolRequest, ServiceToolResponse } from "./service-extension-tool-rpc.js";

export type { ServiceInstancePublicRef, ServiceInstanceRef } from "./service-extension-contract.js";

const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_DISCRIMINATOR = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_DISCRIMINATOR_BYTES = 32;
const MAX_OPERATION_BYTES = 64;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_VALUE_DEPTH = 16;

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

/** A core-registered adapter. It is never passed to extension code. */
export interface WorktreeServiceAdapter {
	request(input: { ref: ServiceInstanceRef; operation: string; payload?: unknown }): Promise<unknown>;
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

function safeIdentifier(value: string): boolean {
	return SAFE_ID.test(value);
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

function cloneBounded(value: unknown, depth = 0): unknown | undefined {
	if (depth > MAX_VALUE_DEPTH || value === null || typeof value === "string" || typeof value === "boolean") return depth > MAX_VALUE_DEPTH ? undefined : value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (Array.isArray(value)) {
		const output: unknown[] = [];
		for (const item of value) {
			const cloned = cloneBounded(item, depth + 1);
			if (cloned === undefined && item !== undefined) return undefined;
			output.push(cloned);
		}
		return output;
	}
	if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
	const output: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		const cloned = cloneBounded(item, depth + 1);
		if (cloned === undefined && item !== undefined) return undefined;
		output[key] = cloned;
	}
	return output;
}

function isBoundedJson(value: unknown): boolean {
	const cloned = cloneBounded(value);
	if (cloned === undefined && value !== undefined) return false;
	try { return Buffer.byteLength(JSON.stringify(cloned), "utf8") <= MAX_VALUE_BYTES; } catch { return false; }
}

/**
 * Resolves all service identity fields from server-owned session coordinates.
 * Calls are intentionally exact: a request can never select a sibling pack,
 * component, or linked worktree by supplying a path.
 */
export class WorktreeServiceCoordinator implements ServiceExtensionToolRpc {
	private readonly instances = new Map<string, ServiceInstanceRef>();
	private readonly reconcileStates = new Map<string, ReconcileState>();
	/** Stop operations advance this fence so an older resolver cannot revive a root. */
	private readonly projectGenerations = new Map<string, number>();
	private closed = false;

	constructor(private readonly deps: WorktreeServiceCoordinatorDeps) {}

	async reconcileProject(projectId: string): Promise<void> {
		if (this.closed || !safeIdentifier(projectId)) return;
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
		if (this.closed || !safeIdentifier(input.packId) || !this.validRequest(input.request)) throw new WorktreeServiceCoordinatorError("SERVICE_OPERATION_INVALID");
		const session = this.deps.sessions.get(input.sessionId);
		if (!session?.projectId || session.archived) throw new WorktreeServiceCoordinatorError("SERVICE_UNAVAILABLE");
		const projectGeneration = this.projectGeneration(session.projectId);
		const scope = await this.resolveScope(session, input.request.component);
		if (!scope) throw new WorktreeServiceCoordinatorError("SERVICE_UNAVAILABLE");
		const discriminator = normalizeDiscriminator(input.request.discriminator);
		if (!discriminator) throw new WorktreeServiceCoordinatorError("SERVICE_OPERATION_INVALID");
		const ref = await this.resolveActiveRef(scope, input.packId, input.request.serviceId, discriminator);
		if (!ref || !this.isCurrent(projectGeneration, ref.projectId)) throw new WorktreeServiceCoordinatorError("SERVICE_UNAVAILABLE");

		// Reconciliation is deliberately repeated immediately before readiness so a
		// committed revoke/settings change cannot rely on an earlier positive read.
		await this.deps.runtime.reconcile(ref);
		if (!this.isCurrent(projectGeneration, ref.projectId) || this.instances.get(instanceKey(ref)) !== ref || !this.isAuthorized(ref) || !await this.isSettingsReadable(ref)) throw new WorktreeServiceCoordinatorError("SERVICE_UNAVAILABLE");
		if (this.deps.runtime.status(this.publicRef(ref))?.state !== "ready") throw new WorktreeServiceCoordinatorError("SERVICE_NOT_READY");
		const adapter = this.deps.adapter?.(ref.packId, ref.serviceId, ref.discriminator);
		if (!adapter) throw new WorktreeServiceCoordinatorError("SERVICE_UNAVAILABLE");
		try {
			const value = await adapter.request({ ref, operation: input.request.operation, ...(input.request.payload === undefined ? {} : { payload: cloneBounded(input.request.payload) }) });
			if (!isBoundedJson(value)) throw new WorktreeServiceCoordinatorError("SERVICE_OPERATION_INVALID");
			return { state: "ready", ...(value === undefined ? {} : { value: cloneBounded(value) }) };
		} catch (error) {
			if (error instanceof WorktreeServiceCoordinatorError) throw error;
			throw new WorktreeServiceCoordinatorError("SERVICE_UNAVAILABLE");
		}
	}

	/** Called with a captured canonical root before or after worktree removal. */
	async stopWorktree(projectId: string, canonicalWorktreeRoot: string): Promise<void> {
		if (!safeIdentifier(projectId) || !path.isAbsolute(canonicalWorktreeRoot)) return;
		this.advanceProjectGeneration(projectId);
		const targets = [...this.instances.values()].filter(ref => ref.projectId === projectId && ref.canonicalWorktreeRoot === canonicalWorktreeRoot);
		await Promise.all(targets.map(ref => this.stopInstance(ref)));
	}

	async stopProject(projectId: string): Promise<void> {
		if (!safeIdentifier(projectId)) return;
		this.advanceProjectGeneration(projectId);
		const targets = [...this.instances.values()].filter(ref => ref.projectId === projectId);
		await Promise.all(targets.map(ref => this.stopInstance(ref)));
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const targets = [...this.instances.values()];
		this.instances.clear();
		await Promise.all(targets.map(async ref => {
			try { await this.deps.runtime.stop(ref); } catch { /* cleanup is best effort */ }
			await this.removeDataDir(ref);
		}));
	}

	/** Runtime dependency seam: only a coordinator-discovered ref gets a data path. */
	resolveDataDir(ref: ServiceInstanceRef, declaredPath: string): string {
		if (this.instances.get(instanceKey(ref))?.canonicalWorktreeRoot !== ref.canonicalWorktreeRoot || !isRelativeDataDir(declaredPath)) {
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
			// A coordinator dependency failure must not retain a process whose scope
			// can no longer be proven. This also keeps scheduled invalidations safe.
			await this.stopProject(projectId);
		} finally {
			state.running = undefined;
			state.scheduled = false;
			resolve();
		}
	}

	private async reconcileProjectPass(projectId: string): Promise<void> {
		const generation = this.projectGeneration(projectId);
		let declarations: readonly WorktreeServiceDeclaration[];
		try { declarations = await this.deps.listActive(projectId); } catch { await this.stopProject(projectId); return; }
		if (!this.isCurrent(generation, projectId)) return;
		const scopes = new Map<string, Scope>();
		for (const session of this.deps.sessions.list(projectId)) {
			if (session.archived || session.projectId !== projectId) continue;
			for (const component of this.eligibleComponents(projectId)) {
				const scope = await this.resolveScope(session, component);
				if (scope) scopes.set(scopeKey(scope), scope);
			}
		}
		const wanted = new Map<string, ServiceInstanceRef>();
		for (const scope of scopes.values()) {
			for (const declaration of this.uniqueActive(declarations)) {
				const ref = this.makeRef(scope, declaration.packId, declaration.spec.id, "default");
				if (this.isAuthorized(ref) && await this.isSettingsReadable(ref)) wanted.set(instanceKey(ref), ref);
			}
		}
		if (!this.isCurrent(generation, projectId)) return;
		for (const [key, ref] of wanted) {
			if (!this.isCurrent(generation, projectId)) return;
			this.instances.set(key, ref);
			try { await this.deps.runtime.reconcile(ref); } catch { /* runtime fails closed internally */ }
			if (!this.isCurrent(generation, projectId)) return;
		}
		for (const [key, ref] of [...this.instances]) {
			if (ref.projectId === projectId && !wanted.has(key)) await this.stopInstance(ref);
		}
	}

	private async resolveScope(session: WorktreeServiceSession, requestedComponent: string): Promise<Scope | undefined> {
		if (!session.projectId || !safeIdentifier(session.projectId) || !this.eligibleComponents(session.projectId).includes(requestedComponent)) return undefined;
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
			? configured.filter(component => safeIdentifier(component.name) && typeof component.repo === "string").map(component => component.name)
			: ["."];
	}

	private async resolveActiveRef(scope: Scope, packId: string, serviceId: string, discriminator: string): Promise<ServiceInstanceRef | undefined> {
		let declarations: readonly WorktreeServiceDeclaration[];
		try { declarations = await this.deps.listActive(scope.projectId); } catch { return undefined; }
		const matches = declarations.filter(item => item.packId === packId && item.spec.id === serviceId);
		if (matches.length !== 1 || !safeIdentifier(serviceId)) return undefined;
		const ref = this.makeRef(scope, packId, serviceId, discriminator);
		if (!this.isAuthorized(ref) || !await this.isSettingsReadable(ref)) return undefined;
		this.instances.set(instanceKey(ref), ref);
		return ref;
	}

	private uniqueActive(declarations: readonly WorktreeServiceDeclaration[]): WorktreeServiceDeclaration[] {
		const counts = new Map<string, number>();
		for (const item of declarations) {
			if (safeIdentifier(item.packId) && safeIdentifier(item.spec.id)) {
				const key = `${item.packId}\0${item.spec.id}`;
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
		}
		return declarations.filter(item => safeIdentifier(item.packId) && safeIdentifier(item.spec.id) && counts.get(`${item.packId}\0${item.spec.id}`) === 1);
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

	private validRequest(request: WorktreeServiceRequest): boolean {
		return safeIdentifier(request.component) || request.component === "."
			? safeIdentifier(request.serviceId) && typeof request.operation === "string" && request.operation.length <= MAX_OPERATION_BYTES && SAFE_ID.test(request.operation)
				&& (request.payload === undefined || isBoundedJson(request.payload))
			: false;
	}

	private async stopInstance(ref: ServiceInstanceRef): Promise<void> {
		this.instances.delete(instanceKey(ref));
		try { await this.deps.runtime.stop(ref); } catch { /* cleanup is best effort */ }
		await this.removeDataDir(ref);
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
