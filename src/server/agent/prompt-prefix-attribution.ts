import { createHash } from "node:crypto";

/** The four Bobbit-owned inputs that can affect a provider prompt prefix. */
export const PREFIX_COMPONENTS = ["system", "tools", "dynamic-context", "skills"] as const;
export type PrefixComponent = (typeof PREFIX_COMPONENTS)[number];
export type PrefixBoundary = "dispatch" | "before-prompt";
export type ProviderCacheTelemetry = "hit" | "miss" | "unknown";

export interface PrefixComponentFingerprint {
	kind: PrefixComponent;
	/** Full SHA-256 digest. This is deliberately never a prompt fragment. */
	sha256: string;
	/** UTF-8 length of the canonical, domain-separated input. */
	bytes: number;
}

export interface PromptPrefixModel {
	provider: string;
	id: string;
}

export interface PromptPrefixSnapshot {
	schemaVersion: 1;
	ts: number;
	sessionId: string;
	sequence: number;
	boundary: PrefixBoundary;
	model?: PromptPrefixModel;
	compactionEpoch: number;
	components: PrefixComponentFingerprint[];
	aggregateSha256: string;
	providerCacheTelemetry: ProviderCacheTelemetry;
}

export interface PrefixAttribution extends PromptPrefixSnapshot {
	comparison: "first" | "stable" | "changed" | "boundary";
	culprit?: PrefixComponent | "multiple" | "unattributable";
	changed?: PrefixComponent[];
	comparableTo?: number;
}

export type PrefixComponentInputs = Record<PrefixComponent, unknown>;

export interface CreateSnapshotInput {
	ts: number;
	sessionId: string;
	sequence: number;
	boundary: PrefixBoundary;
	model?: PromptPrefixModel;
	compactionEpoch: number;
	components: PrefixComponentInputs;
	providerCacheTelemetry?: ProviderCacheTelemetry | null;
}

/**
 * Canonical JSON for fingerprints. Object keys are sorted recursively while
 * array order remains meaningful. `undefined` deliberately has a stable
 * representation rather than disappearing as it would in JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
	if (value === undefined || typeof value === "function" || typeof value === "symbol") return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "bigint") return value.toString();
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(canonicalValue);
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		result[key] = canonicalValue((value as Record<string, unknown>)[key]);
	}
	return result;
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Fingerprint one input with an explicit version and component domain. */
export function fingerprintPrefixComponent(kind: PrefixComponent, input: unknown): PrefixComponentFingerprint {
	const canonical = canonicalJson({ domain: "bobbit.prompt-prefix.component", schemaVersion: 1, kind, input });
	return { kind, sha256: sha256(canonical), bytes: Buffer.byteLength(canonical, "utf8") };
}

/** Build a complete hash-only snapshot. The inputs never leave this function. */
export function createPromptPrefixSnapshot(input: CreateSnapshotInput): PromptPrefixSnapshot {
	const components = PREFIX_COMPONENTS.map((kind) => fingerprintPrefixComponent(kind, input.components[kind]));
	const model = validModel(input.model) ? { provider: input.model.provider, id: input.model.id } : undefined;
	const compactionEpoch = validNonNegativeInteger(input.compactionEpoch) ? input.compactionEpoch : 0;
	const aggregate = canonicalJson({
		domain: "bobbit.prompt-prefix.aggregate",
		schemaVersion: 1,
		model: model ?? null,
		compactionEpoch,
		components: components.map(({ kind, sha256: digest }) => ({ kind, sha256: digest })),
	});
	return {
		schemaVersion: 1,
		ts: input.ts,
		sessionId: input.sessionId,
		sequence: input.sequence,
		boundary: input.boundary,
		...(model ? { model } : {}),
		compactionEpoch,
		components,
		aggregateSha256: sha256(aggregate),
		providerCacheTelemetry: normalizeProviderCacheTelemetry(input.providerCacheTelemetry),
	};
}

/**
 * Attribute a snapshot relative to the immediately preceding request. A model
 * or compaction transition intentionally forms a comparison boundary instead
 * of blaming one of the four components.
 */
export function comparePromptPrefixSnapshots(
	snapshot: PromptPrefixSnapshot,
	previous?: PromptPrefixSnapshot,
): PrefixAttribution {
	if (!previous) return { ...snapshot, comparison: "first" };
	if (!sameModel(snapshot.model, previous.model) || snapshot.compactionEpoch !== previous.compactionEpoch) {
		return { ...snapshot, comparison: "boundary", comparableTo: previous.sequence };
	}

	const changed = PREFIX_COMPONENTS.filter((kind) => componentDigest(snapshot, kind) !== componentDigest(previous, kind));
	if (changed.length === 0 && snapshot.aggregateSha256 === previous.aggregateSha256) {
		return { ...snapshot, comparison: "stable", comparableTo: previous.sequence };
	}
	if (changed.length === 0) {
		return { ...snapshot, comparison: "changed", culprit: "unattributable", changed: [], comparableTo: previous.sequence };
	}
	return {
		...snapshot,
		comparison: "changed",
		culprit: changed.length === 1 ? changed[0] : "multiple",
		changed,
		comparableTo: previous.sequence,
	};
}

function componentDigest(snapshot: PromptPrefixSnapshot, kind: PrefixComponent): string | undefined {
	return snapshot.components.find((component) => component.kind === kind)?.sha256;
}

function sameModel(a: PromptPrefixModel | undefined, b: PromptPrefixModel | undefined): boolean {
	return a?.provider === b?.provider && a?.id === b?.id;
}

/** Missing, malformed, and zero-valued telemetry is explicitly unknown. */
export function normalizeProviderCacheTelemetry(value: ProviderCacheTelemetry | null | undefined): ProviderCacheTelemetry {
	return value === "hit" || value === "miss" ? value : "unknown";
}

/** Convert explicit per-request provider counters, never cumulative totals. */
export function providerCacheTelemetryFromCounters(counters?: { hit?: number; miss?: number } | null): ProviderCacheTelemetry {
	const hasHit = typeof counters?.hit === "number" && Number.isFinite(counters.hit) && counters.hit > 0;
	const hasMiss = typeof counters?.miss === "number" && Number.isFinite(counters.miss) && counters.miss > 0;
	if (hasHit === hasMiss) return "unknown"; // Both (or neither) is ambiguous.
	return hasHit ? "hit" : "miss";
}

export interface PrefixSeedInput {
	system: unknown;
	tools: unknown;
	skills: unknown;
	sessionSetupDynamicContext?: unknown;
}

/**
 * Immutable hash input assembled once per session. Dynamic context is retained
 * only in canonical in-memory form so later callers cannot mutate the seed.
 */
export interface PrefixSeed {
	readonly system: unknown;
	readonly tools: unknown;
	readonly skills: unknown;
	readonly sessionSetupDynamicContext: unknown;
}

export function createPrefixSeed(input: PrefixSeedInput): PrefixSeed {
	return Object.freeze({
		system: immutableCanonicalValue(input.system),
		tools: immutableCanonicalValue(input.tools),
		skills: immutableCanonicalValue(input.skills),
		sessionSetupDynamicContext: immutableCanonicalValue(input.sessionSetupDynamicContext),
	});
}

function immutableCanonicalValue(value: unknown): unknown {
	return deepFreeze(JSON.parse(canonicalJson(value)));
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}

export interface SnapshotFromSeedInput extends Omit<CreateSnapshotInput, "components"> {
	seed: PrefixSeed;
	beforePromptDynamicContext?: unknown;
}

/** Build a request snapshot from an immutable assembly seed and final hook blocks. */
export function createSnapshotFromSeed(input: SnapshotFromSeedInput): PromptPrefixSnapshot {
	return createPromptPrefixSnapshot({
		...input,
		components: {
			system: input.seed.system,
			tools: input.seed.tools,
			skills: input.seed.skills,
			"dynamic-context": {
				sessionSetup: input.seed.sessionSetupDynamicContext,
				beforePrompt: input.beforePromptDynamicContext ?? [],
			},
		},
	});
}

export interface PrefixAttributionStore {
	appendPrefixAttribution(sessionId: string, entry: PrefixAttribution): void;
	readPrefixAttribution(sessionId: string, limit?: number): PrefixAttribution[];
}

export interface BeginPrefixDispatchInput {
	ts?: number;
	model?: PromptPrefixModel;
	compactionEpoch: number;
	providerCacheTelemetry?: ProviderCacheTelemetry | null;
}

export interface FinalizePrefixDispatchInput {
	ts?: number;
	beforePromptDynamicContext?: unknown;
	providerCacheTelemetry?: ProviderCacheTelemetry | null;
}

/**
 * Per-session sequence guard. A bridge callback must present the sequence it
 * received from beginDispatch; callbacks for replaced/retried requests are
 * ignored and cannot overwrite the current pending request.
 */
export class PrefixAttributionRecorder {
	private nextSequence: number;
	private pending?: { snapshot: PromptPrefixSnapshot; seed: PrefixSeed };

	constructor(
		private readonly sessionId: string,
		private readonly store: PrefixAttributionStore,
	) {
		this.nextSequence = Math.max(0, ...store.readPrefixAttribution(sessionId).map((entry) => entry.sequence + 1));
	}

	beginDispatch(seed: PrefixSeed, input: BeginPrefixDispatchInput): PromptPrefixSnapshot {
		this.flushPending();
		const snapshot = createSnapshotFromSeed({
			seed,
			ts: input.ts ?? Date.now(),
			sessionId: this.sessionId,
			sequence: this.nextSequence++,
			boundary: "dispatch",
			model: input.model,
			compactionEpoch: input.compactionEpoch,
			providerCacheTelemetry: input.providerCacheTelemetry,
		});
		this.pending = { snapshot, seed };
		return snapshot;
	}

	finalizeBeforePrompt(sequence: number, input: FinalizePrefixDispatchInput = {}): PrefixAttribution | undefined {
		if (!this.pending || this.pending.snapshot.sequence !== sequence) return undefined;
		const { snapshot, seed } = this.pending;
		this.pending = undefined;
		return this.persist(createSnapshotFromSeed({
			seed,
			ts: input.ts ?? Date.now(),
			sessionId: this.sessionId,
			sequence,
			boundary: "before-prompt",
			model: snapshot.model,
			compactionEpoch: snapshot.compactionEpoch,
			beforePromptDynamicContext: input.beforePromptDynamicContext,
			providerCacheTelemetry: input.providerCacheTelemetry ?? snapshot.providerCacheTelemetry,
		}));
	}

	/** Persist the dispatch fallback for sessions without a provider bridge. */
	flushPending(): PrefixAttribution | undefined {
		if (!this.pending) return undefined;
		const { snapshot } = this.pending;
		this.pending = undefined;
		return this.persist(snapshot);
	}

	private persist(snapshot: PromptPrefixSnapshot): PrefixAttribution {
		const previous = this.store.readPrefixAttribution(this.sessionId, 1).at(-1);
		const attribution = comparePromptPrefixSnapshots(snapshot, previous);
		this.store.appendPrefixAttribution(this.sessionId, attribution);
		return attribution;
	}
}

function validModel(value: PromptPrefixModel | undefined): value is PromptPrefixModel {
	return Boolean(value && typeof value.provider === "string" && value.provider && typeof value.id === "string" && value.id);
}

function validNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
