import { isAbsolute } from "node:path";

/**
 * Graphify's delta surface is isolated here so the Graph Runtime never imports a
 * private Graphify module directly. A future supported public capability wins;
 * the temporary fallback is accepted only for a resolved, explicitly pinned
 * Graphify version whose module and callable signature were feature-probed.
 */
export interface GraphifyDeltaRequest {
	cwd: string;
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
		if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error("GraphifyDeltaAdapter requires an exact resolved version");
		this.version = version;
	}

	async invokeDelta(request: GraphifyDeltaRequest): Promise<GraphRunResult> {
		validateRequest(request);
		const publicCapability = await this.execution.probePublicDelta(this.version);
		if (publicCapability) {
			const output = await this.execution.invokePublicDelta(publicCapability, request);
			return { ...normaliseOutput(output), compatibility: { kind: "public", id: publicCapability.id, resolvedVersion: this.version } };
		}
		const spec = this.compatibility.find(candidate => candidate.version === this.version);
		if (!spec) throw new GraphifyCapabilityError(this.version, "incremental-delta", "no supported public delta capability and no pinned compatibility adapter");
		const observed = await this.execution.probeCompatibility(spec);
		if (observed.modulePath !== spec.modulePath || observed.callable !== spec.callable || !containsAll(observed.signature, spec.requiredSignature)) {
			throw new GraphifyCapabilityError(this.version, "incremental-delta", `compatibility probe expected ${spec.modulePath}.${spec.callable}(${spec.requiredSignature.join(", ")})`);
		}
		const output = await this.execution.invokeCompatibility(spec, request);
		return {
			...normaliseOutput(output),
			compatibility: { kind: "compatibility", id: `${spec.modulePath}.${spec.callable}`, resolvedVersion: this.version, modulePath: observed.modulePath, signature: [...observed.signature].sort() },
		};
	}
}

function validateRequest(request: GraphifyDeltaRequest): void {
	if (!request.noCluster) throw new Error("Graphify deltas must set noCluster=true");
	if (!request.cwd || !isAbsolute(request.cwd)) throw new Error("Graphify delta cwd must be an absolute component root");
	for (const root of request.scanRoots) validateRelative(root, "scan root");
	for (const changed of request.changedPaths) validateRelative(changed, "changed path");
}
function validateRelative(value: string, kind: string): void {
	if (!value || value.startsWith("/") || value.split(/[\\/]/).some(part => part === ".." || part === "")) throw new Error(`${kind} must be a non-empty component-relative path: ${value}`);
}
function normaliseOutput(result: Omit<GraphRunResult, "compatibility">): Omit<GraphRunResult, "compatibility"> {
	return { ...result, sourcePaths: [...new Set(result.sourcePaths)].sort() };
}
function containsAll(observed: readonly string[], required: readonly string[]): boolean { return required.every(name => observed.includes(name)); }

/** Create the sole private compatibility identity Phase 0 permits. The caller
 * receives the resolved version from Graphify resolution; no guessed version is
 * baked into this pack. */
export function rebuildCodeCompatibility(version: string, requiredSignature: readonly string[]): CompatibilitySpec {
	if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error("compatibility adapter requires an exact Graphify version");
	if (requiredSignature.length === 0) throw new Error("compatibility adapter requires a probed _rebuild_code signature");
	return { version, modulePath: "graphify.watch", callable: "_rebuild_code", requiredSignature: [...requiredSignature] };
}
