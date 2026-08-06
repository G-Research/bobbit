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
	/** Newest fully loaded GateStore generation; older live instances are stale readers. */
	canonicalOwner?: symbol;
	tail: Promise<void>;
	pendingOperations: number;
	referencesInitialized: boolean;
	/** Latest atomically published durable reference set for this root. */
	immutableRefs: Set<string>;
	partitionRefs: Map<string, Set<string>>;
};

export interface GateStoreRootPreparationClaim {
	readonly canonicalRoot: string;
}

type PreparationClaimState = {
	root: string;
	state: RootState;
	owner: symbol;
	status: "prepared" | "handed-off" | "released";
};

const roots = new Map<string, RootState>();
const preparationClaims = new WeakMap<GateStoreRootPreparationClaim, PreparationClaimState>();
const abandonedPreparationClaims = new FinalizationRegistry<PreparationClaimState>((claim) => {
	if (claim.status !== "prepared") return;
	// GC is only a fallback for a caller that abandoned an unconsumed result.
	// Queue its release behind any publication already using the same root.
	void runExclusive(claim.root, claim.state, async () => {
		if (claim.status !== "prepared") return;
		claim.status = "released";
		claim.state.owners.delete(claim.owner);
		if (claim.state.canonicalOwner === claim.owner) claim.state.canonicalOwner = undefined;
	});
});

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

function createLease(
	root: string,
	state: RootState,
	owner: symbol,
	promoteWhenSeeded: boolean,
): GateStoreRootLease {
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
			ownerReferences();
			const ownerSnapshot = referenceState(snapshot);
			state.owners.set(owner, ownerSnapshot);
			// A synchronous first-open becomes canonical only after its full loaded
			// snapshot exists. A prepared owner was already made canonical atomically
			// with worker completion; a superseded prepared result must not promote
			// itself merely because its constructor ran late.
			if (promoteWhenSeeded) state.canonicalOwner = owner;
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
			// Only the newest fully loaded generation supplements the global durable
			// ledger. This covers both a live GateStore and the worker-to-constructor
			// handoff without letting stale instances retain deleted bodies forever.
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

/** Register one live GateStore against its canonical physical state root. */
export function acquireGateStoreRootLease(
	stateDir: string,
	preparationClaim?: GateStoreRootPreparationClaim,
): GateStoreRootLease {
	const root = canonicalGateStoreStateRoot(stateDir);
	if (preparationClaim) {
		const prepared = preparationClaims.get(preparationClaim);
		if (!prepared || prepared.status !== "prepared") throw new Error("gate store root preparation claim is not available");
		if (prepared.root !== root || preparationClaim.canonicalRoot !== root) {
			throw new Error("gate store root preparation claim belongs to a different physical state root");
		}
		prepared.status = "handed-off";
		abandonedPreparationClaims.unregister(preparationClaim);
		// The owner symbol and complete snapshot stay installed throughout this
		// synchronous handoff. If another preparation superseded it, construction
		// may read the snapshot but cannot make that older generation canonical.
		return createLease(root, prepared.state, prepared.owner, prepared.state.canonicalOwner === prepared.owner);
	}
	const state = stateFor(root);
	const owner = Symbol(root);
	state.owners.set(owner, { immutableRefs: new Set(), partitionRefs: new Map() });
	return createLease(root, state, owner, true);
}

/** Abandon a prepared snapshot that will not be handed to a constructor. */
export function releaseGateStoreRootPreparationClaim(claim: GateStoreRootPreparationClaim): void {
	const prepared = preparationClaims.get(claim);
	if (!prepared || prepared.status !== "prepared") return;
	prepared.status = "released";
	abandonedPreparationClaims.unregister(claim);
	prepared.state.owners.delete(prepared.owner);
	if (prepared.state.canonicalOwner === prepared.owner) prepared.state.canonicalOwner = undefined;
	maybeForget(prepared.root, prepared.state);
}

export interface CoordinatedGateStoreRootPreparation<T> {
	result: T;
	claim: GateStoreRootPreparationClaim;
}

/**
 * Serialize worker inventory/reclaim with every live payload publication, then
 * atomically install the validated loaded snapshot as the newest owner before
 * returning it to a GateStore constructor.
 */
export function coordinateGateStoreRootPreparation<T>(
	stateDir: string,
	operation: () => Promise<T>,
	references: (result: T) => GateStoreRootReferenceSnapshot,
): Promise<CoordinatedGateStoreRootPreparation<T>> {
	const root = canonicalGateStoreStateRoot(stateDir);
	const state = stateFor(root);
	return runExclusive(root, state, async () => {
		const result = await operation();
		const snapshot = references(result);
		replaceReferences(state, snapshot);
		const owner = Symbol(root);
		state.owners.set(owner, referenceState(snapshot));
		state.canonicalOwner = owner;
		const claim = Object.freeze({ canonicalRoot: root });
		const prepared: PreparationClaimState = { root, state, owner, status: "prepared" };
		preparationClaims.set(claim, prepared);
		abandonedPreparationClaims.register(claim, prepared, claim);
		return { result, claim };
	});
}
