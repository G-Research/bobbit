import { createProjectPathIdentity } from "./project-registry.js";

export interface GateStoreRootReferenceSnapshot {
	immutable: Iterable<string>;
	partitions: Iterable<[string, Iterable<string>]>;
}

type RootState = {
	owners: Set<symbol>;
	tail: Promise<void>;
	pendingOperations: number;
	referencesInitialized: boolean;
	immutableRefs: Set<string>;
	partitionRefs: Map<string, Set<string>>;
};

const roots = new Map<string, RootState>();

// Gate coordination deliberately shares the established project-path identity
// contract: physical aliases coalesce, while casing folds only with bounded
// filesystem evidence. One identity instance also shares that evidence cache
// across coordinator, migration, preload-claim, and test-fault keys.
const gateStoreRootIdentity = createProjectPathIdentity();

/** Physical identity for every gate persistence owner of a project state root. */
export function canonicalGateStoreStateRoot(stateDir: string): string {
	return gateStoreRootIdentity(stateDir);
}

function stateFor(root: string): RootState {
	let state = roots.get(root);
	if (state) return state;
	state = {
		owners: new Set(),
		tail: Promise.resolve(),
		pendingOperations: 0,
		referencesInitialized: false,
		immutableRefs: new Set(),
		partitionRefs: new Map(),
	};
	roots.set(root, state);
	return state;
}

function maybeForget(root: string, state: RootState): void {
	if (state.owners.size > 0 || state.pendingOperations > 0) return;
	if (roots.get(root) === state) roots.delete(root);
}

async function runExclusive<T>(root: string, state: RootState, operation: () => Promise<T>): Promise<T> {
	state.pendingOperations++;
	const prior = state.tail;
	let release!: () => void;
	const turn = new Promise<void>(resolve => { release = resolve; });
	state.tail = prior.catch(() => undefined).then(() => turn);
	await prior.catch(() => undefined);
	try {
		return await operation();
	} finally {
		release();
		state.pendingOperations--;
		maybeForget(root, state);
	}
}

function replaceReferences(state: RootState, snapshot: GateStoreRootReferenceSnapshot): void {
	state.immutableRefs = new Set(snapshot.immutable);
	state.partitionRefs = new Map(
		Array.from(snapshot.partitions, ([owner, refs]) => [owner, new Set(refs)]),
	);
	state.referencesInitialized = true;
}

export interface GateStoreRootLease {
	readonly canonicalRoot: string;
	runExclusive<T>(operation: () => Promise<T>): Promise<T>;
	seedReferences(snapshot: GateStoreRootReferenceSnapshot): void;
	replacePartition(owner: string, refs: Iterable<string>): void;
	addImmutable(refs: Iterable<string>): void;
	isReferenced(hash: string): boolean;
	release(): void;
}

/** Register one live GateStore against its canonical physical state root. */
export function acquireGateStoreRootLease(stateDir: string): GateStoreRootLease {
	const root = canonicalGateStoreStateRoot(stateDir);
	const state = stateFor(root);
	const owner = Symbol(root);
	state.owners.add(owner);
	let released = false;
	return {
		canonicalRoot: root,
		runExclusive: operation => runExclusive(root, state, operation),
		seedReferences(snapshot) {
			if (!state.referencesInitialized) replaceReferences(state, snapshot);
			else for (const hash of snapshot.immutable) state.immutableRefs.add(hash);
		},
		replacePartition(partitionOwner, refs) {
			const next = new Set(refs);
			if (next.size > 0) state.partitionRefs.set(partitionOwner, next);
			else state.partitionRefs.delete(partitionOwner);
			state.referencesInitialized = true;
		},
		addImmutable(refs) {
			for (const hash of refs) state.immutableRefs.add(hash);
			state.referencesInitialized = true;
		},
		isReferenced(hash) {
			if (state.immutableRefs.has(hash)) return true;
			for (const refs of state.partitionRefs.values()) if (refs.has(hash)) return true;
			return false;
		},
		release() {
			if (released) return;
			released = true;
			state.owners.delete(owner);
			maybeForget(root, state);
		},
	};
}

/**
 * Serialize worker inventory/reclaim with every live payload publication and
 * reset the shared durable-reference ledger from the worker's validated view.
 */
export function coordinateGateStoreRootPreparation<T>(
	stateDir: string,
	operation: () => Promise<T>,
	references: (result: T) => GateStoreRootReferenceSnapshot,
): Promise<T> {
	const root = canonicalGateStoreStateRoot(stateDir);
	const state = stateFor(root);
	return runExclusive(root, state, async () => {
		const result = await operation();
		replaceReferences(state, references(result));
		return result;
	});
}
