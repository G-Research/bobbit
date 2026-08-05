import { createHash } from "node:crypto";

/**
 * Test-only correctness model. It has no filesystem, process, hook, tool, or
 * runtime registration responsibility; Graph Extension Runtime owns those
 * later. Fixtures use it to pin the adapter's invocation/corpus/lineage rules.
 */
export interface HarnessAnchor { cwdMode: "component-root-relative"; scanRoots: string[] }
export interface HarnessCorpusFile { path: string; sha256: string; tracked: true }
export interface HarnessCorpus { files: HarnessCorpusFile[]; digest: string }
export interface HarnessGraph { sourcePaths: string[]; nodes: number; edges: number }
export type HarnessFailure = "ANCHOR_MISMATCH" | "CORPUS_DRIFT" | "OUTSIDE_PINNED_ROOT" | "UNEXPLAINED_SHRINK" | "DELTA_CLOSURE_FAILURE";
export interface HarnessValidation { ok: boolean; failures: HarnessFailure[] }

export function createHarnessAnchor(scanRoots: readonly string[]): HarnessAnchor {
	const roots = [...new Set(scanRoots.map(normalisePath))].sort();
	return { cwdMode: "component-root-relative", scanRoots: roots };
}
export function createHarnessCorpus(files: readonly HarnessCorpusFile[]): HarnessCorpus {
	const sorted = [...files].map(file => ({ ...file, path: normalisePath(file.path), tracked: true as const })).sort((a, b) => a.path.localeCompare(b.path));
	return { files: sorted, digest: digest(sorted) };
}

export function validateHarnessCandidate(input: {
	expectedAnchor: HarnessAnchor;
	observedAnchor: HarnessAnchor;
	expectedCorpus: HarnessCorpus;
	observedCorpus: HarnessCorpus;
	graph: HarnessGraph;
	previous?: HarnessGraph;
	changedPaths?: string[];
	prunedPaths?: string[];
	maxUnaccountedNodeLoss?: number;
}): HarnessValidation {
	const failures: HarnessFailure[] = [];
	if (digest(input.expectedAnchor) !== digest(input.observedAnchor)) failures.push("ANCHOR_MISMATCH");
	if (input.expectedCorpus.digest !== input.observedCorpus.digest) failures.push("CORPUS_DRIFT");
	const allowed = (source: string) => input.expectedAnchor.scanRoots.some(root => source === root || source.startsWith(`${root}/`));
	if (input.graph.sourcePaths.some(source => !allowed(normalisePath(source)))) failures.push("OUTSIDE_PINNED_ROOT");
	if (input.changedPaths) {
		const sources = new Set(input.graph.sourcePaths.map(normalisePath));
		const pruned = new Set((input.prunedPaths ?? []).map(normalisePath));
		const changed = input.changedPaths.map(normalisePath);
		if (changed.some(source => !sources.has(source) && !pruned.has(source))) failures.push("DELTA_CLOSURE_FAILURE");
	}
	if (input.previous && input.graph.nodes < input.previous.nodes) {
		const accounted = Math.max(0, (input.prunedPaths ?? []).length);
		const loss = input.previous.nodes - input.graph.nodes;
		const limit = input.maxUnaccountedNodeLoss ?? 0;
		if (loss - accounted > limit) failures.push("UNEXPLAINED_SHRINK");
	}
	return { ok: failures.length === 0, failures };
}

export interface HarnessSnapshot { id: string; kind: "base" | "derived-base" | "branch"; head: string; parentId?: string; graph: HarnessGraph; state: "fresh" | "stale"; staleReason?: "parent-advanced" }

/** In-memory chain fixture: primary → parent-derived → child; no graph store. */
export class GraphifyChainHarness {
	private readonly snapshots = new Map<string, HarnessSnapshot>();
	addBase(id: string, head: string, graph: HarnessGraph): HarnessSnapshot { return this.put({ id, kind: "base", head, graph, state: "fresh" }); }
	derive(id: string, kind: "derived-base" | "branch", parentId: string, head: string, graph: HarnessGraph): HarnessSnapshot {
		const parent = this.requireFresh(parentId);
		return this.put({ id, kind, head, parentId: parent.id, graph, state: "fresh" });
	}
	advanceParent(parentId: string): string[] {
		const parent = this.require(parentId); const stale: string[] = [];
		if (parent.kind === "derived-base" && parent.state === "fresh") { parent.state = "stale"; parent.staleReason = "parent-advanced"; stale.push(parent.id); }
		const visit = (ancestor: string) => {
			for (const snapshot of this.snapshots.values()) if (snapshot.parentId === ancestor && snapshot.state === "fresh") {
				snapshot.state = "stale"; snapshot.staleReason = "parent-advanced"; stale.push(snapshot.id); visit(snapshot.id);
			}
		};
		visit(parentId); return stale;
	}
	current(id: string): HarnessSnapshot | null { const snapshot = this.require(id); return snapshot.state === "fresh" ? cloneSnapshot(snapshot) : null; }
	private put(snapshot: HarnessSnapshot): HarnessSnapshot { if (this.snapshots.has(snapshot.id)) throw new Error(`duplicate harness snapshot: ${snapshot.id}`); this.snapshots.set(snapshot.id, cloneSnapshot(snapshot)); return cloneSnapshot(this.require(snapshot.id)); }
	private require(id: string): HarnessSnapshot { const snapshot = this.snapshots.get(id); if (!snapshot) throw new Error(`unknown harness snapshot: ${id}`); return snapshot; }
	private requireFresh(id: string): HarnessSnapshot { const snapshot = this.require(id); if (snapshot.state !== "fresh") throw new Error(`cannot derive from stale snapshot: ${id}`); return snapshot; }
}

function normalisePath(value: string): string {
	const normal = value.replace(/\\/g, "/").replace(/^\.\//, "");
	if (!normal || normal.startsWith("/") || normal.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`invalid component-relative path: ${value}`);
	return normal;
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])); return value; }
function cloneGraph(graph: HarnessGraph): HarnessGraph { return { ...graph, sourcePaths: [...graph.sourcePaths] }; }
function cloneSnapshot(snapshot: HarnessSnapshot): HarnessSnapshot { return { ...snapshot, graph: cloneGraph(snapshot.graph) }; }
