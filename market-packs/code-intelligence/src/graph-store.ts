import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

export type GraphKind = "primary-base" | "derived-base" | "branch";
export type GraphState = "fresh" | "building" | "stale" | "failed" | "base-fallback";
export type GraphStaleReason = "parent-advanced" | "worktree-dirty" | "base-rebuilt" | "validation-failed" | "version-changed" | "missing-runtime";

/** Durable, tool-safe description of a published graph snapshot. */
export interface GraphMeta {
	schema: 1;
	component: { name: string; repo: string; relativePath?: string };
	kind: GraphKind;
	anchor: { cwdMode: "component-root-relative"; scanRoots: string[] };
	corpus: { roots: Array<{ path: string; tier: "code" | "docs" }>; trackedOnly: true };
	graphify: { requestedVersion?: string; resolvedVersion: string; resolvedAt: string; requiredCapability: "incremental-delta"; compatibility?: string };
	revisions: { baseRef: string; baseRev: string; headRev: string; parentGoalId?: string; parentHeadRev?: string };
	build: { startedAt: string; completedAt: string; buildMs: number; cloneMs?: number; deltaMs?: number; nodes: number; edges: number; bytes: number; clustered: boolean; tierLatencyMs: { code?: number; codeDocs?: number } };
	state: GraphState;
	staleReason?: GraphStaleReason;
	applied: { changedPaths: string[]; dirtyPaths: string[]; deltaNodeCount: number };
}

export interface GraphComponent {
	name: string;
	repo: string;
	relativePath?: string;
}

/** Server-derived identity for an independently published branch/base graph. */
export interface GraphSlot {
	kind: GraphKind;
	branch?: string;
	goalId?: string;
	worktreeId?: string;
}

export interface GraphCandidate {
	readonly componentKey: string;
	readonly id: string;
	/** Host-only path for Graphify. It must never be returned by a tool response. */
	readonly root: string;
}

export interface GraphSnapshotRef {
	readonly componentKey: string;
	readonly id: string;
	readonly slotKey: string;
}

export interface GraphSnapshot extends GraphSnapshotRef {
	readonly meta: GraphMeta;
}

export interface GraphStoreStatus {
	component: GraphComponent;
	componentKey: string;
	snapshots: GraphSnapshot[];
}

export interface GraphGcResult {
	removedCandidates: number;
	removedSnapshots: number;
}

export class GraphStoreContainmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GraphStoreContainmentError";
	}
}

/** A store-local failure that callers may report as a declared graph status. */
export class GraphStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GraphStoreError";
	}
}

interface SnapshotRecord {
	version: 1;
	componentKey: string;
	slotKey: string;
	id: string;
	parentId?: string;
	publishedAt: number;
}

interface CurrentPointer {
	version: 1;
	id: string;
}

export interface GraphStoreOptions {
	now?: () => number;
	newId?: () => string;
}

/**
 * Host-owned storage for Graphify artifacts.  The only caller-controlled values
 * retained in filenames are cryptographic digests; artifact roots are always
 * derived below `hostRoot/graphs/<project hash>`.
 */
export class GraphStore {
	readonly projectKey: string;
	private readonly hostRoot: string;
	private readonly now: () => number;
	private readonly newId: () => string;
	private rootPromise: Promise<string> | undefined;

	constructor(hostRoot: string, projectId: string, options: GraphStoreOptions = {}) {
		if (!path.isAbsolute(hostRoot)) throw new GraphStoreContainmentError("graph store host root must be absolute");
		if (typeof projectId !== "string" || projectId.length === 0) throw new GraphStoreError("graph store requires a project identity");
		this.hostRoot = path.resolve(hostRoot);
		this.projectKey = keyFor("project", projectId);
		this.now = options.now ?? Date.now;
		this.newId = options.newId ?? randomUUID;
	}

	componentKey(component: GraphComponent): string {
		assertComponent(component);
		return keyFor("component", canonical(component));
	}

	async createCandidate(component: GraphComponent): Promise<GraphCandidate> {
		const componentKey = this.componentKey(component);
		const componentRoot = await this.ensureComponent(componentKey);
		const id = this.nextId();
		const root = path.join(componentRoot, "tmp", id);
		await fs.mkdir(root, { recursive: false });
		await this.assertRealContained(path.join(componentRoot, "tmp"), root, "candidate");
		await writeJsonAtomic(path.join(root, ".candidate.json"), { version: 1, createdAt: this.now() });
		return { componentKey, id, root };
	}

	/** Copies a published graph into a new external candidate, excluding store control files. */
	async cloneSnapshot(ref: GraphSnapshotRef): Promise<GraphCandidate> {
		const source = await this.snapshotRoot(ref);
		await this.assertGraphTree(source, false);
		const candidate = await this.createCandidateForKey(ref.componentKey);
		try {
			for (const name of await safeDirNames(source)) {
				if (isControlFile(name)) continue;
				await fs.cp(path.join(source, name), path.join(candidate.root, name), { recursive: true });
			}
			await this.assertGraphTree(candidate.root, true);
			return candidate;
		} catch (error) {
			await this.discardCandidate(candidate).catch(() => undefined);
			throw error;
		}
	}

	/** Removes a candidate that has not been published. It is safe to call repeatedly. */
	async discardCandidate(candidate: GraphCandidate): Promise<void> {
		const root = await this.candidateRoot(candidate);
		await fs.rm(root, { recursive: true, force: true });
	}

	/**
	 * Publishes a validated candidate.  Graph payloads are first renamed into the
	 * immutable snapshots area; `meta.json` is written only after that rename and
	 * the current pointer is replaced only after metadata exists. A failed publish
	 * therefore leaves the prior current graph readable.
	 */
	async publishCandidate(candidate: GraphCandidate, meta: GraphMeta, options: { slot: GraphSlot; parent?: GraphSnapshotRef } ): Promise<GraphSnapshot> {
		assertGraphMeta(meta);
		if (options.slot.kind !== meta.kind) throw new GraphStoreError("graph slot kind must match graph metadata kind");
		const componentRoot = await this.ensureComponent(candidate.componentKey);
		const candidateRoot = await this.candidateRoot(candidate);
		await this.assertGraphTree(candidateRoot, true);
		if (options.parent && options.parent.componentKey !== candidate.componentKey) throw new GraphStoreError("a graph snapshot parent must belong to the same component");
		if (options.parent) await this.snapshotRoot(options.parent);
		const slotKey = keyFor("slot", canonical(options.slot));
		const destination = path.join(componentRoot, "snapshots", candidate.id);
		await assertPathContained(componentRoot, destination, "snapshot destination");
		try {
			await fs.rename(candidateRoot, destination);
		} catch (error) {
			throw new GraphStoreError(`unable to atomically stage graph snapshot: ${message(error)}`);
		}
		try {
			await this.assertRealContained(path.join(componentRoot, "snapshots"), destination, "published snapshot");
			const record: SnapshotRecord = { version: 1, componentKey: candidate.componentKey, slotKey, id: candidate.id, parentId: options.parent?.id, publishedAt: this.now() };
			await writeJsonAtomic(path.join(destination, ".snapshot.json"), record);
			// Intentionally last in the snapshot: readers treat an absent meta as unpublished.
			await writeJsonAtomic(path.join(destination, "meta.json"), meta);
			await writeJsonAtomic(path.join(componentRoot, "current", `${slotKey}.json`), { version: 1, id: candidate.id } satisfies CurrentPointer);
			return { componentKey: candidate.componentKey, slotKey, id: candidate.id, meta: cloneMeta(meta) };
		} catch (error) {
			// Do not touch the old pointer. The unreferenced staged directory is GC-able.
			throw new GraphStoreError(`unable to publish graph metadata: ${message(error)}`);
		}
	}

	async readCurrent(component: GraphComponent, slot: GraphSlot): Promise<GraphSnapshot | null> {
		const componentKey = this.componentKey(component);
		const componentRoot = await this.ensureComponent(componentKey);
		const slotKey = keyFor("slot", canonical(slot));
		const pointer = await readJson<CurrentPointer>(path.join(componentRoot, "current", `${slotKey}.json`));
		if (!pointer) return null;
		if (pointer.version !== 1 || !validId(pointer.id)) throw new GraphStoreError("invalid graph current pointer");
		return this.readSnapshot({ componentKey, slotKey, id: pointer.id });
	}

	async readSnapshot(ref: GraphSnapshotRef): Promise<GraphSnapshot | null> {
		const root = await this.snapshotRoot(ref, true);
		if (!root) return null;
		const record = await readJson<SnapshotRecord>(path.join(root, ".snapshot.json"));
		if (!record || record.version !== 1 || record.componentKey !== ref.componentKey || record.id !== ref.id || record.slotKey !== ref.slotKey) {
			throw new GraphStoreError("invalid graph snapshot record");
		}
		const meta = await readJson<GraphMeta>(path.join(root, "meta.json"));
		if (!meta) return null; // crash between directory rename and meta-last publication
		assertGraphMeta(meta);
		return { ...ref, meta: cloneMeta(meta) };
	}

	async status(component: GraphComponent): Promise<GraphStoreStatus> {
		const componentKey = this.componentKey(component);
		const componentRoot = await this.ensureComponent(componentKey);
		const names = await safeDirNames(path.join(componentRoot, "current"));
		const snapshots: GraphSnapshot[] = [];
		for (const name of names.sort()) {
			if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
			const slotKey = name.slice(0, -5);
			const pointer = await readJson<CurrentPointer>(path.join(componentRoot, "current", name));
			if (!pointer || pointer.version !== 1 || !validId(pointer.id)) continue;
			const snapshot = await this.readSnapshot({ componentKey, slotKey, id: pointer.id });
			if (snapshot) snapshots.push(snapshot);
		}
		return { component: { ...component }, componentKey, snapshots };
	}

	async markStale(ref: GraphSnapshotRef, reason: GraphStaleReason): Promise<GraphSnapshot> {
		const snapshot = await this.readSnapshot(ref);
		if (!snapshot) throw new GraphStoreError("cannot mark a missing graph snapshot stale");
		const meta: GraphMeta = { ...snapshot.meta, state: "stale", staleReason: reason };
		await writeJsonAtomic(path.join(await this.snapshotRoot(ref), "meta.json"), meta);
		return { ...snapshot, meta };
	}

	/** Marks current descendants of a published parent stale without falling back to another base. */
	async markDescendantsStale(parent: GraphSnapshotRef, reason: GraphStaleReason = "parent-advanced"): Promise<GraphSnapshotRef[]> {
		await this.snapshotRoot(parent);
		const componentRoot = await this.ensureComponent(parent.componentKey);
		const records = await this.snapshotRecords(componentRoot);
		const current = await this.currentIds(componentRoot);
		const stale: GraphSnapshotRef[] = [];
		const visit = async (parentId: string) => {
			for (const record of records) {
				if (record.parentId !== parentId || !current.has(record.id)) continue;
				const ref = { componentKey: parent.componentKey, slotKey: record.slotKey, id: record.id };
				await this.markStale(ref, reason);
				stale.push(ref);
				await visit(record.id);
			}
		};
		await visit(parent.id);
		return stale;
	}

	/** Resolves an artifact only after lexical and physical containment checks. Host-side callers only. */
	async artifactPath(ref: GraphSnapshotRef, relativePath: string): Promise<string> {
		const root = await this.snapshotRoot(ref);
		assertRelativeArtifact(relativePath);
		const target = path.join(root, relativePath);
		await assertPathContained(root, target, "graph artifact");
		await this.assertRealContained(root, target, "graph artifact");
		return target;
	}

	async acquireLease(ref: GraphSnapshotRef, ttlMs: number): Promise<() => Promise<void>> {
		if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new GraphStoreError("graph lease duration must be positive");
		const root = await this.snapshotRoot(ref);
		const id = this.nextId();
		const lease = path.join(root, ".leases", `${id}.json`);
		await fs.mkdir(path.dirname(lease), { recursive: true });
		await writeJsonAtomic(lease, { version: 1, expiresAt: this.now() + ttlMs });
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			await fs.rm(lease, { force: true });
		};
	}

	/** Deletes only expired candidates and unreachable, unleased old snapshots. */
	async gc(maxAgeMs: number): Promise<GraphGcResult> {
		if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new GraphStoreError("graph GC age must be non-negative");
		const root = await this.ensureRoot();
		let removedCandidates = 0;
		let removedSnapshots = 0;
		for (const componentKey of await safeDirNames(root)) {
			if (!/^[a-f0-9]{64}$/.test(componentKey)) continue;
			const componentRoot = path.join(root, componentKey);
			if (!(await isDirectory(componentRoot))) continue;
			const current = await this.currentIds(componentRoot);
			const records = await this.snapshotRecords(componentRoot);
			const retainedParents = new Set(records.filter(record => current.has(record.id) && record.parentId).map(record => record.parentId!));
			for (const id of await safeDirNames(path.join(componentRoot, "tmp"))) {
				if (!validId(id)) continue;
				const candidate = path.join(componentRoot, "tmp", id);
				if (await this.expired(candidate, maxAgeMs)) { await this.removeContained(componentRoot, candidate); removedCandidates += 1; }
			}
			for (const record of records) {
				if (current.has(record.id) || retainedParents.has(record.id)) continue;
				const snapshot = path.join(componentRoot, "snapshots", record.id);
				if (await this.hasActiveLease(snapshot)) continue;
				if (await this.expired(snapshot, maxAgeMs)) { await this.removeContained(componentRoot, snapshot); removedSnapshots += 1; }
			}
		}
		return { removedCandidates, removedSnapshots };
	}

	private async ensureRoot(): Promise<string> {
		this.rootPromise ??= (async () => {
			await fs.mkdir(this.hostRoot, { recursive: true });
			const hostReal = await fs.realpath(this.hostRoot);
			const root = path.join(hostReal, "graphs", this.projectKey);
			await fs.mkdir(root, { recursive: true });
			const rootReal = await fs.realpath(root);
			await assertPathContained(hostReal, rootReal, "graph store root");
			return rootReal;
		})();
		return this.rootPromise;
	}

	private async ensureComponent(componentKey: string): Promise<string> {
		if (!/^[a-f0-9]{64}$/.test(componentKey)) throw new GraphStoreContainmentError("invalid graph component key");
		const root = await this.ensureRoot();
		const componentRoot = path.join(root, componentKey);
		await fs.mkdir(path.join(componentRoot, "tmp"), { recursive: true });
		await fs.mkdir(path.join(componentRoot, "snapshots"), { recursive: true });
		await fs.mkdir(path.join(componentRoot, "current"), { recursive: true });
		await this.assertRealContained(root, componentRoot, "graph component root");
		return componentRoot;
	}

	private async createCandidateForKey(componentKey: string): Promise<GraphCandidate> {
		const componentRoot = await this.ensureComponent(componentKey);
		const id = this.nextId();
		const root = path.join(componentRoot, "tmp", id);
		await fs.mkdir(root, { recursive: false });
		await writeJsonAtomic(path.join(root, ".candidate.json"), { version: 1, createdAt: this.now() });
		return { componentKey, id, root };
	}

	private async candidateRoot(candidate: GraphCandidate): Promise<string> {
		if (!validId(candidate.id) || !/^[a-f0-9]{64}$/.test(candidate.componentKey)) throw new GraphStoreContainmentError("invalid graph candidate identity");
		const componentRoot = await this.ensureComponent(candidate.componentKey);
		const expected = path.join(componentRoot, "tmp", candidate.id);
		if (path.resolve(candidate.root) !== expected) throw new GraphStoreContainmentError("graph candidate root is not store-derived");
		await this.assertRealContained(path.join(componentRoot, "tmp"), expected, "candidate");
		return expected;
	}

	private snapshotRoot(ref: GraphSnapshotRef): Promise<string>;
	private snapshotRoot(ref: GraphSnapshotRef, allowMissing: true): Promise<string | null>;
	private async snapshotRoot(ref: GraphSnapshotRef, allowMissing = false): Promise<string | null> {
		if (!validId(ref.id) || !/^[a-f0-9]{64}$/.test(ref.componentKey) || !/^[a-f0-9]{64}$/.test(ref.slotKey)) throw new GraphStoreContainmentError("invalid graph snapshot identity");
		const componentRoot = await this.ensureComponent(ref.componentKey);
		const root = path.join(componentRoot, "snapshots", ref.id);
		try {
			await this.assertRealContained(path.join(componentRoot, "snapshots"), root, "graph snapshot");
			return root;
		} catch (error) {
			if (allowMissing && isNotFound(error)) return null;
			throw error;
		}
	}

	private async assertRealContained(root: string, target: string, label: string): Promise<void> {
		await assertPathContained(root, target, label);
		let rootReal: string;
		let targetReal: string;
		try {
			[rootReal, targetReal] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
		} catch (error) {
			if (isNotFound(error)) throw error;
			throw new GraphStoreContainmentError(`${label} cannot be resolved safely: ${message(error)}`);
		}
		await assertPathContained(rootReal, targetReal, label);
	}

	private async assertGraphTree(root: string, rejectStoreMetadata: boolean): Promise<void> {
		await this.assertRealContained(root, root, "graph candidate");
		let names: string[];
		try { names = await fs.readdir(root); } catch (error) { if (isNotFound(error)) throw error; throw new GraphStoreError(`cannot inspect graph candidate: ${message(error)}`); }
		for (const name of names) {
			const entry = path.join(root, name);
			const stat = await fs.lstat(entry);
			if (stat.isSymbolicLink()) throw new GraphStoreContainmentError("graph candidate may not contain symbolic links");
			if (rejectStoreMetadata && (name === "meta.json" || name === ".snapshot.json" || name === ".leases")) {
				throw new GraphStoreError("graph candidate must not prewrite store metadata");
			}
			if (stat.isDirectory()) await this.assertGraphTree(entry, rejectStoreMetadata);
		}
	}

	private async snapshotRecords(componentRoot: string): Promise<SnapshotRecord[]> {
		const records: SnapshotRecord[] = [];
		for (const id of await safeDirNames(path.join(componentRoot, "snapshots"))) {
			if (!validId(id)) continue;
			const record = await readJson<SnapshotRecord>(path.join(componentRoot, "snapshots", id, ".snapshot.json"));
			if (!record || record.version !== 1 || record.id !== id || record.componentKey !== path.basename(componentRoot) || !/^[a-f0-9]{64}$/.test(record.slotKey)) continue;
			records.push(record);
		}
		return records;
	}

	private async currentIds(componentRoot: string): Promise<Set<string>> {
		const current = new Set<string>();
		for (const name of await safeDirNames(path.join(componentRoot, "current"))) {
			if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
			const pointer = await readJson<CurrentPointer>(path.join(componentRoot, "current", name));
			if (pointer?.version === 1 && validId(pointer.id)) current.add(pointer.id);
		}
		return current;
	}

	private async hasActiveLease(snapshotRoot: string): Promise<boolean> {
		for (const name of await safeDirNames(path.join(snapshotRoot, ".leases"))) {
			if (!validId(name.replace(/\.json$/, "")) || !name.endsWith(".json")) continue;
			const leasePath = path.join(snapshotRoot, ".leases", name);
			const lease = await readJson<{ version: 1; expiresAt: number }>(leasePath);
			if (lease?.version === 1 && Number.isFinite(lease.expiresAt) && lease.expiresAt > this.now()) return true;
			await fs.rm(leasePath, { force: true });
		}
		return false;
	}

	private async expired(target: string, maxAgeMs: number): Promise<boolean> {
		try { return this.now() - (await fs.stat(target)).mtimeMs >= maxAgeMs; } catch (error) { if (isNotFound(error)) return false; throw error; }
	}

	private async removeContained(root: string, target: string): Promise<void> {
		await this.assertRealContained(root, target, "graph GC target");
		const stat = await fs.lstat(target);
		if (stat.isSymbolicLink()) throw new GraphStoreContainmentError("graph GC refuses symbolic links");
		await fs.rm(target, { recursive: true, force: false });
	}

	private nextId(): string {
		const id = this.newId();
		if (!validId(id)) throw new GraphStoreError("graph store ID generator returned an unsafe identifier");
		return id;
	}
}

function keyFor(namespace: string, value: string): string {
	return createHash("sha256").update(`${namespace}\0${value}`).digest("hex");
}
function canonical(value: unknown): string {
	return JSON.stringify(sortValue(value));
}
function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortValue(child)]));
	return value;
}
function validId(id: string): boolean { return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9-]{7,127}$/.test(id); }
function isControlFile(name: string): boolean { return name === "meta.json" || name === ".snapshot.json" || name === ".candidate.json" || name === ".leases"; }
function assertComponent(component: GraphComponent): void {
	if (!component || typeof component.name !== "string" || !component.name || typeof component.repo !== "string" || !component.repo) throw new GraphStoreError("graph component requires name and repo");
	if (component.relativePath !== undefined) assertRelativeArtifact(component.relativePath);
}
function assertRelativeArtifact(value: string): void {
	if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\0") || /^[A-Za-z]:[\\/]/.test(value)) throw new GraphStoreContainmentError("graph artifact path must be component-relative");
	const normal = value.replace(/\\/g, "/");
	if (normal.split("/").some(part => !part || part === "." || part === "..")) throw new GraphStoreContainmentError("graph artifact path must be component-relative");
}
async function assertPathContained(root: string, target: string, label: string): Promise<void> {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new GraphStoreContainmentError(`${label} escapes graph store containment`);
}
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
	try {
		await fs.writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
		await fs.rename(temp, file);
	} finally {
		await fs.rm(temp, { force: true }).catch(() => undefined);
	}
}
async function readJson<T>(file: string): Promise<T | null> {
	try { return JSON.parse(await fs.readFile(file, "utf8")) as T; } catch (error) { if (isNotFound(error)) return null; throw error; }
}
async function safeDirNames(directory: string): Promise<string[]> {
	try { return (await fs.readdir(directory)).filter(name => !name.startsWith(".")); } catch (error) { if (isNotFound(error)) return []; throw error; }
}
async function isDirectory(file: string): Promise<boolean> { try { return (await fs.lstat(file)).isDirectory(); } catch (error) { if (isNotFound(error)) return false; throw error; } }
function isNotFound(error: unknown): boolean { return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT"; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function cloneMeta(meta: GraphMeta): GraphMeta { return JSON.parse(JSON.stringify(meta)) as GraphMeta; }

function assertGraphMeta(meta: GraphMeta): void {
	if (!meta || meta.schema !== 1) throw new GraphStoreError("graph metadata schema must be 1");
	assertComponent(meta.component);
	if (!(["primary-base", "derived-base", "branch"] as const).includes(meta.kind)) throw new GraphStoreError("invalid graph metadata kind");
	if (meta.anchor?.cwdMode !== "component-root-relative" || !Array.isArray(meta.anchor.scanRoots)) throw new GraphStoreError("invalid graph metadata anchor");
	for (const root of meta.anchor.scanRoots) assertRelativeArtifact(root);
	if (!meta.corpus || meta.corpus.trackedOnly !== true || !Array.isArray(meta.corpus.roots)) throw new GraphStoreError("graph corpus must be tracked-only");
	for (const root of meta.corpus.roots) if (!root || (root.tier !== "code" && root.tier !== "docs")) throw new GraphStoreError("invalid graph corpus tier"); else assertRelativeArtifact(root.path);
	if (!meta.graphify || !meta.graphify.resolvedVersion || !meta.graphify.resolvedAt || meta.graphify.requiredCapability !== "incremental-delta") throw new GraphStoreError("graph metadata requires resolved incremental-delta identity");
	if (!meta.revisions || !meta.revisions.baseRef || !meta.revisions.baseRev || !meta.revisions.headRev) throw new GraphStoreError("graph metadata requires revisions");
	if (!meta.build || !Number.isFinite(meta.build.nodes) || !Number.isFinite(meta.build.edges) || !Number.isFinite(meta.build.bytes) || !Number.isFinite(meta.build.buildMs) || !meta.build.tierLatencyMs) throw new GraphStoreError("invalid graph build metadata");
	if (!(["fresh", "building", "stale", "failed", "base-fallback"] as const).includes(meta.state)) throw new GraphStoreError("invalid graph metadata state");
	if (meta.staleReason && !(["parent-advanced", "worktree-dirty", "base-rebuilt", "validation-failed", "version-changed", "missing-runtime"] as const).includes(meta.staleReason)) throw new GraphStoreError("invalid graph stale reason");
	if (!meta.applied || !Array.isArray(meta.applied.changedPaths) || !Array.isArray(meta.applied.dirtyPaths) || !Number.isFinite(meta.applied.deltaNodeCount)) throw new GraphStoreError("invalid graph applied metadata");
	for (const candidate of [...meta.applied.changedPaths, ...meta.applied.dirtyPaths]) assertRelativeArtifact(candidate);
}
