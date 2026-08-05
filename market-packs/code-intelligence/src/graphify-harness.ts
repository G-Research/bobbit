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
	const sorted = [...files].map(file => {
		if (file.tracked !== true) throw new Error(`corpus file must be tracked: ${file.path}`);
		return { ...file, path: normalisePath(file.path), tracked: true as const };
	}).sort((a, b) => a.path.localeCompare(b.path));
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
	/** Exact source contribution counts removed by this delta, keyed by pruned path. */
	prunedNodeCounts?: Record<string, number>;
	/** Test-only allowance for known non-delta shrink; defaults to zero. */
	maxUnaccountedNodeLoss?: number;
}): HarnessValidation {
	const failures: HarnessFailure[] = [];
	if (digest(input.expectedAnchor) !== digest(input.observedAnchor)) failures.push("ANCHOR_MISMATCH");
	if (input.expectedCorpus.digest !== input.observedCorpus.digest) failures.push("CORPUS_DRIFT");
	const allowed = (source: string) => input.expectedAnchor.scanRoots.some(root => source === root || source.startsWith(`${root}/`));
	const normaliseForValidation = (value: string): string | null => {
		try { return normalisePath(value); } catch { failures.push("OUTSIDE_PINNED_ROOT"); return null; }
	};
	const sources = new Set<string>();
	for (const source of input.graph.sourcePaths) {
		const normal = normaliseForValidation(source);
		if (normal && allowed(normal)) sources.add(normal);
		else if (normal) failures.push("OUTSIDE_PINNED_ROOT");
	}
	const changed = input.changedPaths?.map(normaliseForValidation) ?? [];
	const pruned = input.prunedPaths?.map(normaliseForValidation) ?? [];
	const deltaPathsArePinned = [...changed, ...pruned].every((path): path is string => Boolean(path) && allowed(path));
	if (!deltaPathsArePinned) failures.push("OUTSIDE_PINNED_ROOT");
	if (deltaPathsArePinned && input.changedPaths) {
		const prunedSet = new Set(pruned);
		if (changed.some(source => !sources.has(source) && !prunedSet.has(source)) || pruned.some(source => sources.has(source))) {
			failures.push("DELTA_CLOSURE_FAILURE");
		}
	}
	if (input.previous && input.graph.nodes < input.previous.nodes) {
		const expectedRemovedNodes = countPrunedNodes(input.prunedPaths ?? [], input.prunedNodeCounts, failures);
		const loss = input.previous.nodes - input.graph.nodes;
		const limit = input.maxUnaccountedNodeLoss ?? 0;
		if (loss - expectedRemovedNodes > limit) failures.push("UNEXPLAINED_SHRINK");
	}
	return { ok: failures.length === 0, failures: [...new Set(failures)] };
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
	/** Marks a changed parent head and every descendant stale. Passing the same head is a no-op. */
	advanceParent(parentId: string, newHead?: string): string[] {
		const parent = this.require(parentId);
		if (newHead === parent.head) return [];
		if (newHead) parent.head = newHead;
		const stale: string[] = [];
		const markStale = (snapshot: HarnessSnapshot) => {
			if (snapshot.state === "fresh") {
				snapshot.state = "stale";
				snapshot.staleReason = "parent-advanced";
				stale.push(snapshot.id);
			}
		};
		markStale(parent);
		const visit = (ancestor: string) => {
			for (const snapshot of this.snapshots.values()) if (snapshot.parentId === ancestor) {
				markStale(snapshot);
				visit(snapshot.id);
			}
		};
		visit(parentId);
		return stale;
	}
	current(id: string): HarnessSnapshot | null { const snapshot = this.require(id); return snapshot.state === "fresh" ? cloneSnapshot(snapshot) : null; }
	private put(snapshot: HarnessSnapshot): HarnessSnapshot { if (this.snapshots.has(snapshot.id)) throw new Error(`duplicate harness snapshot: ${snapshot.id}`); this.snapshots.set(snapshot.id, cloneSnapshot(snapshot)); return cloneSnapshot(this.require(snapshot.id)); }
	private require(id: string): HarnessSnapshot { const snapshot = this.snapshots.get(id); if (!snapshot) throw new Error(`unknown harness snapshot: ${id}`); return snapshot; }
	private requireFresh(id: string): HarnessSnapshot { const snapshot = this.require(id); if (snapshot.state !== "fresh") throw new Error(`cannot derive from stale snapshot: ${id}`); return snapshot; }
}

/**
 * Fixture-only candidate/publish model. It proves validation failure cannot
 * replace a current snapshot without creating a filesystem store or runtime.
 */
export class GraphifyPublicationHarness {
	private readonly candidates = new Map<string, HarnessSnapshot>();
	private currentSnapshot: HarnessSnapshot | null = null;

	stage(snapshot: HarnessSnapshot): void {
		if (this.candidates.has(snapshot.id)) throw new Error(`duplicate harness candidate: ${snapshot.id}`);
		this.candidates.set(snapshot.id, cloneSnapshot(snapshot));
	}
	cloneCurrent(id: string, head: string): HarnessSnapshot {
		if (!this.currentSnapshot) throw new Error("cannot clone without a current harness snapshot");
		const clone = cloneSnapshot({ ...this.currentSnapshot, id, head, state: "fresh" });
		this.stage(clone);
		return cloneSnapshot(clone);
	}
	promote(id: string, validation: HarnessValidation): boolean {
		const candidate = this.candidates.get(id);
		if (!candidate) throw new Error(`unknown harness candidate: ${id}`);
		this.candidates.delete(id);
		if (!validation.ok) return false;
		this.currentSnapshot = cloneSnapshot(candidate);
		return true;
	}
	current(): HarnessSnapshot | null { return this.currentSnapshot ? cloneSnapshot(this.currentSnapshot) : null; }
	hasCandidate(id: string): boolean { return this.candidates.has(id); }
}

function countPrunedNodes(paths: readonly string[], counts: Record<string, number> | undefined, failures: HarnessFailure[]): number {
	if (!counts) return 0;
	let total = 0;
	for (const path of paths) {
		const normal = tryNormalisePath(path);
		if (!normal) continue;
		const count = counts[normal];
		if (count === undefined) continue;
		if (!Number.isSafeInteger(count) || count < 0) {
			failures.push("DELTA_CLOSURE_FAILURE");
			continue;
		}
		total += count;
	}
	return total;
}
function tryNormalisePath(value: string): string | null { try { return normalisePath(value); } catch { return null; } }
function normalisePath(value: string): string {
	if (typeof value !== "string" || !value || /[\0-\x1f]/.test(value) || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) throw new Error(`invalid component-relative path: ${String(value)}`);
	const normal = value.replace(/\\/g, "/").replace(/^\.\//, "");
	if (!normal || normal.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`invalid component-relative path: ${value}`);
	return normal;
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])); return value; }
function cloneGraph(graph: HarnessGraph): HarnessGraph { return { ...graph, sourcePaths: [...graph.sourcePaths] }; }
function cloneSnapshot(snapshot: HarnessSnapshot): HarnessSnapshot { return { ...snapshot, graph: cloneGraph(snapshot.graph) }; }
