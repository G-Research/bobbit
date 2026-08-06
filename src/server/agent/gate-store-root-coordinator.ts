import { createProjectPathIdentity } from "./project-registry.js";

export interface GateStoreRootReferenceSnapshot {
	immutable: Iterable<string>;
	partitions: Iterable<[string, Iterable<string>]>;
}

type RootReferenceState = {
	immutableRefs: Set<string>;
	partitionRefs: Map<string, Set<string>>;
};

type RootState = {
	owners: Map<symbol, RootReferenceState>;
	/** Newest loaded GateStore generation; older live instances are stale readers. */
	canonicalOwner?: symbol;
	tail: Promise<void>;
	pendingOperations: number;
	referencesInitialized: boolean;
	/** Latest atomically published durable reference set for this root. */
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
		owners: new Map(),
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

function referenceState(snapshot: GateStoreRootReferenceSnapshot): RootReferenceState {
	return {
		immutableRefs: new Set(snapshot.immutable),
		partitionRefs: new Map(
			Array.from(snapshot.partitions, ([owner, refs]) => [owner, new Set(refs)]),
		),
	};
}

function replaceReferences(state: RootState, snapshot: GateStoreRootReferenceSnapshot): void {
	const next = referenceState(snapshot);
	state.immutableRefs = next.immutableRefs;
	state.partitionRefs = next.partitionRefs;
	state.referencesInitialized = true;
}

function referenceStateContains(state: RootReferenceState, hash: string): boolean {
	if (state.immutableRefs.has(hash)) return true;
	for (const refs of state.partitionRefs.values()) if (refs.has(hash)) return true;
	return false;
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
	state.owners.set(owner, { immutableRefs: new Set(), partitionRefs: new Map() });
	state.canonicalOwner = owner;
	let released = false;
	const ownerReferences = (): RootReferenceState => {
		const references = state.owners.get(owner);
		if (!references) throw new Error("gate store root lease is released");
		return references;
	};
	return {
		canonicalRoot: root,
		runExclusive: operation => runExclusive(root, state, operation),
		seedReferences(snapshot) {
			const ownerSnapshot = referenceState(snapshot);
			state.owners.set(owner, ownerSnapshot);
			// The first live owner seeds the durable view. A later generation may
			// have loaded a newer snapshot while an older GateStore is still winding
			// down, so retain its own complete claims without letting construction
			// overwrite the publication ledger.
			if (!state.referencesInitialized) replaceReferences(state, snapshot);
			else for (const hash of ownerSnapshot.immutableRefs) state.immutableRefs.add(hash);
		},
		replacePartition(partitionOwner, refs) {
			const next = new Set(refs);
			const owned = ownerReferences().partitionRefs;
			if (next.size > 0) {
				owned.set(partitionOwner, next);
				state.partitionRefs.set(partitionOwner, new Set(next));
			} else {
				owned.delete(partitionOwner);
				state.partitionRefs.delete(partitionOwner);
			}
			state.referencesInitialized = true;
		},
		addImmutable(refs) {
			const owned = ownerReferences().immutableRefs;
			for (const hash of refs) {
				owned.add(hash);
				state.immutableRefs.add(hash);
			}
			state.referencesInitialized = true;
		},
		isReferenced(hash) {
			if (state.immutableRefs.has(hash)) return true;
			for (const refs of state.partitionRefs.values()) if (refs.has(hash)) return true;
			// A reloaded canonical owner is a real reference holder even before it
			// next republishes a partition. This closes the stale-generation window
			// where the prior instance removes a shared durable ledger entry and
			// reclaims a body the replacement is about to republish. Only the newest
			// generation participates: an older in-process restart fixture (or leaked
			// stale instance) must not keep genuinely deleted payloads forever.
			const canonical = state.canonicalOwner && state.owners.get(state.canonicalOwner);
			return canonical ? referenceStateContains(canonical, hash) : false;
		},
		release() {
			if (released) return;
			released = true;
			state.owners.delete(owner);
			if (state.canonicalOwner === owner) state.canonicalOwner = undefined;
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
