import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Graphify's delta surface is isolated here so the Graph Runtime never imports a
 * private Graphify module directly. A future supported public capability wins;
 * the temporary fallback is accepted only for a resolved, explicitly pinned
 * Graphify version whose module and callable signature were feature-probed.
 *
 * This is an adapter contract, not a Graph runtime or store. Its caller owns the
 * server-derived component and candidate directories; the adapter makes their
 * containment requirements explicit before an executor can receive them.
 */
export interface GraphifyDeltaRequest {
	/** Absolute component checkout root. */
	cwd: string;
	/** Absolute, server-derived candidate directory outside the component checkout. */
	candidateRoot: string;
	scanRoots: string[];
	changedPaths: string[];
	noCluster: boolean;
}
export interface PublicDeltaCapability {
	id: string;
	version: string;
}
export interface CompatibilityIdentity {
	kind: "public" | "compatibility";
	id: string;
	resolvedVersion: string;
	modulePath?: string;
	signature?: string[];
}
export interface GraphRunResult {
	graphPath: string;
	nodes: number;
	edges: number;
	sourcePaths: string[];
	/** Persist this exact value in GraphMeta; it makes private compatibility visible. */
	compatibility: CompatibilityIdentity;
}

/** Process boundary, deliberately injectable for contract tests and host policy. */
export interface GraphifyDeltaExecution {
	probePublicDelta(version: string): Promise<PublicDeltaCapability | null>;
	invokePublicDelta(capability: PublicDeltaCapability, request: GraphifyDeltaRequest): Promise<Omit<GraphRunResult, "compatibility">>;
	probeCompatibility(spec: CompatibilitySpec): Promise<{ modulePath: string; callable: string; signature: string[] }>;
	invokeCompatibility(spec: CompatibilitySpec, request: GraphifyDeltaRequest): Promise<Omit<GraphRunResult, "compatibility">>;
}
export interface CompatibilitySpec {
	/** Resolved package version, never a loose range. */
	version: string;
	modulePath: "graphify.watch";
	callable: "_rebuild_code";
	/** Required argument names; additional optional parameters are allowed. */
	requiredSignature: readonly string[];
}

export class GraphifyCapabilityError extends Error {
	constructor(readonly version: string, readonly capability: "incremental-delta", detail: string) {
		super(`Graphify ${version} cannot provide ${capability}: ${detail}`);
		this.name = "GraphifyCapabilityError";
	}
}

export class GraphifyDeltaAdapter {
	readonly version: string;
	constructor(version: string, private readonly execution: GraphifyDeltaExecution, private readonly compatibility: readonly CompatibilitySpec[]) {
		if (!isExactVersion(version)) throw new Error("GraphifyDeltaAdapter requires an exact resolved version");
		this.version = version;
	}

	async invokeDelta(request: GraphifyDeltaRequest): Promise<GraphRunResult> {
		const normalisedRequest = normaliseRequest(request);
		const publicCapability = await this.execution.probePublicDelta(this.version);
		if (publicCapability) {
			const output = await this.execution.invokePublicDelta(publicCapability, normalisedRequest);
			return { ...normaliseOutput(output, normalisedRequest), compatibility: { kind: "public", id: publicCapability.id, resolvedVersion: this.version } };
		}
		const spec = this.compatibility.find(candidate => candidate.version === this.version);
		if (!spec) throw new GraphifyCapabilityError(this.version, "incremental-delta", "no supported public delta capability and no pinned compatibility adapter");
		const observed = await this.execution.probeCompatibility(spec);
		if (observed.modulePath !== spec.modulePath || observed.callable !== spec.callable || !containsAll(observed.signature, spec.requiredSignature)) {
			throw new GraphifyCapabilityError(this.version, "incremental-delta", `compatibility probe expected ${spec.modulePath}.${spec.callable}(${spec.requiredSignature.join(", ")})`);
		}
		const output = await this.execution.invokeCompatibility(spec, normalisedRequest);
		return {
			...normaliseOutput(output, normalisedRequest),
			compatibility: { kind: "compatibility", id: `${spec.modulePath}.${spec.callable}`, resolvedVersion: this.version, modulePath: observed.modulePath, signature: [...observed.signature].sort() },
		};
	}
}

function normaliseRequest(request: GraphifyDeltaRequest): GraphifyDeltaRequest {
	if (!request.noCluster) throw new Error("Graphify deltas must set noCluster=true");
	if (!isAbsolute(request.cwd)) throw new Error("Graphify delta cwd must be an absolute component root");
	if (!isAbsolute(request.candidateRoot)) throw new Error("Graphify delta candidate root must be an absolute external directory");
	const cwd = physicalPath(request.cwd, "Graphify delta cwd");
	const candidateRoot = physicalPath(request.candidateRoot, "Graphify delta candidate root");
	if (isWithinOrEqual(cwd, candidateRoot) || isWithinOrEqual(candidateRoot, cwd)) {
		throw new Error("Graphify delta candidate root must be outside the component root");
	}
	const scanRoots = uniqueSorted(request.scanRoots.map(root => normaliseRelative(root, "scan root")));
	if (scanRoots.length === 0) throw new Error("Graphify delta requires at least one scan root");
	const physicalScanRoots = scanRoots.map(root => {
		const physicalRoot = physicalPath(join(cwd, root), "Graphify delta scan root");
		if (!isWithinOrEqual(cwd, physicalRoot)) throw new Error(`scan root must be physically contained by the component root: ${root}`);
		return physicalRoot;
	});
	const changedPaths = uniqueSorted(request.changedPaths.map(changed => normaliseRelative(changed, "changed path")));
	for (const changed of changedPaths) {
		if (!isUnderRoots(changed, scanRoots)) throw new Error(`changed path must be under a pinned scan root: ${changed}`);
		const physicalChanged = physicalPath(join(cwd, changed), "Graphify delta changed path");
		if (!isWithinOrEqual(cwd, physicalChanged)) throw new Error(`changed path must be physically contained by the component root: ${changed}`);
		if (!scanRoots.some((root, index) => isUnderRoots(changed, [root]) && isWithinOrEqual(physicalScanRoots[index], physicalChanged))) {
			throw new Error(`changed path must be physically contained by its pinned scan root: ${changed}`);
		}
	}
	return { ...request, cwd, candidateRoot, scanRoots, changedPaths };
}

function normaliseOutput(result: Omit<GraphRunResult, "compatibility">, request: GraphifyDeltaRequest): Omit<GraphRunResult, "compatibility"> {
	if (!result || typeof result !== "object") throw new Error("Graphify delta execution returned no result");
	if (!isAbsolute(result.graphPath)) throw new Error("Graphify delta graph path must be contained by the external candidate root");
	const graphPath = existingPhysicalPath(result.graphPath, "Graphify delta graph path", true);
	if (!isContainedBy(request.candidateRoot, graphPath)) throw new Error("Graphify delta graph path must be contained by the external candidate root");
	if (!Number.isFinite(result.nodes) || result.nodes < 0 || !Number.isFinite(result.edges) || result.edges < 0) {
		throw new Error("Graphify delta graph counters must be non-negative finite numbers");
	}
	if (!Array.isArray(result.sourcePaths)) throw new Error("Graphify delta graph source paths must be an array");
	const sourcePaths = uniqueSorted(result.sourcePaths.map(source => normaliseRelative(source, "graph source path")));
	const physicalScanRoots = request.scanRoots.map(root => {
		const physicalRoot = physicalPath(join(request.cwd, root), "Graphify delta scan root");
		if (!isWithinOrEqual(request.cwd, physicalRoot)) throw new Error(`scan root must be physically contained by the component root: ${root}`);
		return physicalRoot;
	});
	for (const source of sourcePaths) {
		if (!isUnderRoots(source, request.scanRoots)) throw new Error(`graph source path must be under a pinned scan root: ${source}`);
		const physicalSource = existingPhysicalPath(join(request.cwd, source), "Graphify delta graph source path", false);
		if (!isWithinOrEqual(request.cwd, physicalSource)) throw new Error(`graph source path must be physically contained by the component root: ${source}`);
		if (!request.scanRoots.some((root, index) => isUnderRoots(source, [root]) && isWithinOrEqual(physicalScanRoots[index], physicalSource))) {
			throw new Error(`graph source path must be physically contained by a pinned scan root: ${source}`);
		}
	}
	return { ...result, graphPath, sourcePaths };
}

function normaliseRelative(value: string, kind: string): string {
	if (typeof value !== "string" || !value || /[\0-\x1f]/.test(value)) throw new Error(`${kind} must be a non-empty component-relative path: ${String(value)}`);
	if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) throw new Error(`${kind} must be a non-empty component-relative path: ${value}`);
	const normal = value.replace(/\\/g, "/").replace(/^\.\//, "");
	if (!normal || normal.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`${kind} must be a non-empty component-relative path: ${value}`);
	return normal;
}
function uniqueSorted(values: readonly string[]): string[] { return [...new Set(values)].sort(); }
function isUnderRoots(value: string, roots: readonly string[]): boolean { return roots.some(root => value === root || value.startsWith(`${root}/`)); }
function isWithinOrEqual(root: string, target: string): boolean {
	const pathRelative = relative(resolve(root), resolve(target));
	return pathRelative === "" || (pathRelative !== ".." && !pathRelative.startsWith(`..${sep}`) && !isAbsolute(pathRelative));
}
function isContainedBy(root: string, target: string): boolean { return resolve(root) !== resolve(target) && isWithinOrEqual(root, target); }

/** Resolve existing segments through the filesystem while retaining a missing tail.
 * This permits delete/rename-old deltas, but never treats a symlink escape as a
 * component-relative path. */
function physicalPath(value: string, kind: string): string {
	let cursor = resolve(value);
	const missingTail: string[] = [];
	for (;;) {
		try {
			lstatSync(cursor);
		} catch (error: unknown) {
			if (isMissingPath(error)) {
				const parent = dirname(cursor);
				if (parent === cursor) throw new Error(`${kind} cannot resolve a physical path`);
				missingTail.push(basename(cursor));
				cursor = parent;
				continue;
			}
			throw new Error(`${kind} cannot resolve a physical path`);
		}
		try {
			return resolve(realpathSync(cursor), ...missingTail.reverse());
		} catch {
			throw new Error(`${kind} cannot resolve a physical path`);
		}
	}
}

function existingPhysicalPath(value: string, kind: string, regular: boolean): string {
	try {
		const metadata = statSync(value);
		if (regular && !metadata.isFile()) throw new Error("not a file");
	} catch {
		throw new Error(`${kind} must be an existing${regular ? " regular artifact" : " source target"}`);
	}
	return physicalPath(value, kind);
}
function isMissingPath(error: unknown): error is NodeJS.ErrnoException { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
function containsAll(observed: readonly string[], required: readonly string[]): boolean { return required.every(name => observed.includes(name)); }
function isExactVersion(version: string): boolean { return /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version); }

/** Create the sole private compatibility identity Phase 0 permits. The caller
 * receives the resolved version from Graphify resolution; no guessed version is
 * baked into this pack. */
export function rebuildCodeCompatibility(version: string, requiredSignature: readonly string[]): CompatibilitySpec {
	if (!isExactVersion(version)) throw new Error("compatibility adapter requires an exact Graphify version");
	if (requiredSignature.length === 0) throw new Error("compatibility adapter requires a probed _rebuild_code signature");
	return { version, modulePath: "graphify.watch", callable: "_rebuild_code", requiredSignature: [...requiredSignature] };
}
