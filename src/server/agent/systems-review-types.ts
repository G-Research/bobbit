export const SYSTEMS_REVIEW_READER_VERSION = 1 as const;
export const SYSTEMS_REVIEW_COVERAGE_VERSION = 1 as const;

export type SystemsReviewPathClass =
	| "production-executable"
	| "test"
	| "docs"
	| "config-schema"
	| "asset"
	| "unknown";

export type SystemsReviewRiskSignal =
	| "control"
	| "route"
	| "mutation"
	| "target"
	| "aggregation"
	| "transport"
	| "persistence"
	| "state";

export type SystemsReviewChangeKind = "add" | "modify" | "delete" | "rename" | "copy" | "type-change";
export type SystemsReviewTreeSide = "base" | "head";

/**
 * Closed final-effect vocabulary used to bind target proof to the changed
 * action. A registered Git merge adapter cannot satisfy a filesystem, queue,
 * persistence, or remote-request coverage item.
 */
export type SystemsReviewTargetEffectKind =
	| "git-merge"
	| "git-push"
	| "filesystem-delete"
	| "persistence-write"
	| "queue-effect"
	| "remote-request"
	| "unknown";

export interface SystemsReviewEligibleTargetAssertion {
	assertionId: string;
	actionId: string;
	commandId: string;
	testId: string;
	testKind: "integration" | "browser";
	baseOid: string;
	headOid: string;
	expectedTarget: string;
	expectedScope: string;
	effectOutcome: "succeeded";
	adapterIds: readonly string[];
	effectKinds: readonly SystemsReviewTargetEffectKind[];
}

export interface SystemsReviewRepoBinding {
	id: string;
	root: string;
	components: string[];
	baseRef: string;
	baseOid: string;
	mergeBaseOid: string;
	mergeBaseTreeOid: string;
	headOid: string;
	headTreeOid: string;
}

export interface SystemsReviewChange {
	id: string;
	repoId: string;
	kind: SystemsReviewChangeKind;
	oldPath?: string;
	newPath?: string;
	oldMode: string;
	newMode: string;
	oldBlobOid?: string;
	newBlobOid?: string;
	patchSha256: string;
	patchBytes: number;
	binary: boolean;
	binaryExempt: boolean;
	bodyExempt: boolean;
	components: string[];
	pathClass: SystemsReviewPathClass;
	riskSignals: SystemsReviewRiskSignal[];
	/** Adapter identities inferred from the immutable semantic patch. */
	targetAdapterIds?: string[];
	/** Final-effect kinds inferred from the immutable semantic patch. */
	targetEffectKinds?: SystemsReviewTargetEffectKind[];
}

export interface SystemsReviewCoverageItem {
	id: string;
	version: typeof SYSTEMS_REVIEW_COVERAGE_VERSION;
	changeId: string;
	repoId: string;
	path: string;
	pathClass: SystemsReviewPathClass;
	riskSignals: SystemsReviewRiskSignal[];
	requiresStateTrace: boolean;
	requiresActionTrace: boolean;
	requiresExactTargetEvidence: boolean;
	/** Empty means no registered final adapter can prove this item (fail closed). */
	requiredTargetAdapterIds?: string[];
	requiredTargetEffectKinds?: SystemsReviewTargetEffectKind[];
}

/** Reader-only projection. Assertions are server-attested and append-only. */
export interface SystemsReviewCoverageReadRecord extends SystemsReviewCoverageItem {
	eligibleTargetAssertions: SystemsReviewEligibleTargetAssertion[];
}

export interface SystemsReviewChunkPart {
	changeId: string;
	patchStart: number;
	patchEnd: number;
}

export interface SystemsReviewEvidenceChunk {
	id: string;
	index: number;
	parts: SystemsReviewChunkPart[];
	semanticPatchBytes: number;
	changeIds: string[];
}

export interface SystemsReviewSnapshot {
	version: typeof SYSTEMS_REVIEW_READER_VERSION;
	sessionId: string;
	signalId: string;
	createdAt: number;
	projectRoot: string;
	branchContainer: string;
	digest: string;
	derivationSha256: string;
	repos: SystemsReviewRepoBinding[];
	changes: SystemsReviewChange[];
	coverage: SystemsReviewCoverageItem[];
	chunks: SystemsReviewEvidenceChunk[];
}

export interface SystemsReviewReceiptClaims {
	version: typeof SYSTEMS_REVIEW_READER_VERSION;
	sessionId: string;
	signalId: string;
	snapshotDigest: string;
	operation: SystemsReviewReadOperation;
	objectId: string;
	repoId?: string;
	path?: string;
	side?: SystemsReviewTreeSide;
	start: number;
	end: number;
	complete: boolean;
	contentSha256: string;
}

export interface SystemsReviewReadPage<T = unknown> {
	version: typeof SYSTEMS_REVIEW_READER_VERSION;
	sessionId: string;
	signalId: string;
	snapshotDigest: string;
	operation: SystemsReviewReadOperation;
	objectId: string;
	range: { start: number; end: number; complete: boolean };
	data: T;
	receipt: string;
	receiptClaims: SystemsReviewReceiptClaims;
	nextCursor?: string;
}

export type SystemsReviewReadOperation = "repos" | "manifest" | "patch" | "file" | "list" | "search" | "coverage";

export type SystemsReviewReadRequest =
	| { operation: "repos" | "manifest" | "coverage"; cursor?: string; limit?: number }
	| { operation: "patch"; changeId: string; cursor?: string; limit?: number }
	| { operation: "file"; repoId: string; side: SystemsReviewTreeSide; path: string; cursor?: string; limit?: number }
	| { operation: "list"; repoId: string; side: SystemsReviewTreeSide; path?: string; cursor?: string; limit?: number }
	| { operation: "search"; repoId: string; side: SystemsReviewTreeSide; paths: string[]; query: string; cursor?: string; limit?: number };

export interface SystemsReviewEvidenceLocation {
	repoId: string;
	path: string;
	lineStart?: number;
	lineEnd?: number;
	kind: "changed" | "unchanged";
	receipts: string[];
}

export type SystemsReviewTraceLayerName =
	| "producer"
	| "aggregation"
	| "transport"
	| "persistence"
	| "consumer"
	| "control"
	| "payload"
	| "handler"
	| "target-resolver"
	| "final-side-effect";

export interface SystemsReviewTraceLayer {
	layer: SystemsReviewTraceLayerName;
	description: string;
	locations: SystemsReviewEvidenceLocation[];
}

export interface SystemsReviewTestInvariant {
	invariant: string;
	failureLayer: string;
	locations: SystemsReviewEvidenceLocation[];
	exactTargetAssertionId?: string;
}

export interface SystemsReviewMixedStateCase {
	state: "empty" | "complete" | "partial" | "failed" | "stale" | "mixed-success";
	expected: string;
	observed: string;
	locations: SystemsReviewEvidenceLocation[];
}

export interface SystemsReviewStateBehavior {
	kind: "state";
	id: string;
	title: string;
	coverageItemIds: string[];
	layers: SystemsReviewTraceLayer[];
	mixedStateMatrix: SystemsReviewMixedStateCase[];
	conservativeAggregateInvariant: string;
	tests: SystemsReviewTestInvariant[];
}

export interface SystemsReviewActionBehavior {
	kind: "action";
	id: string;
	title: string;
	coverageItemIds: string[];
	layers: SystemsReviewTraceLayer[];
	change: "introduced" | "modified" | "unchanged";
	mutation: "none" | "local" | "destructive" | "remote";
	aggregate: boolean;
	targetInvariant: string;
	tests: SystemsReviewTestInvariant[];
}

export type SystemsReviewBehavior = SystemsReviewStateBehavior | SystemsReviewActionBehavior;
export type SystemsReviewFindingSeverity = "critical" | "high" | "medium";
export type SystemsReviewFindingCategory =
	| "wrong-target"
	| "hidden-or-misstated-work"
	| "incomplete-authoritative"
	| "untested-destructive-aggregate-target"
	| "other";

export interface SystemsReviewFinding {
	id: string;
	severity: SystemsReviewFindingSeverity;
	category: SystemsReviewFindingCategory;
	title: string;
	trigger: string;
	consequence: string;
	violatedInvariant: string;
	behaviorIds: string[];
	locations: SystemsReviewEvidenceLocation[];
}

export interface SystemsReviewCoverageMapping {
	coverageItemId: string;
	behaviorIds: string[];
	nonBehavioralReason?: "test-only" | "docs-only" | "passive-asset" | "dependency-lockfile";
}

export interface SystemsReviewCheckpointSubmission {
	operation: "checkpoint";
	executionId: string;
	snapshotDigest: string;
	contractDigest: string;
	previousCheckpointDigest?: string;
	chunkId: string;
	coverageCursor: string;
	processedChangeIds: string[];
	receiptTokens: string[];
	behaviors: SystemsReviewBehavior[];
	coverageMappings: SystemsReviewCoverageMapping[];
	findings: SystemsReviewFinding[];
	unresolvedLinks: string[];
}

export interface SystemsReviewFinalSubmission {
	operation: "final";
	executionId: string;
	snapshotDigest: string;
	contractDigest: string;
	finalCheckpointDigest: string;
	resolvedLinks: string[];
}

export type SystemsReviewResultSubmission = SystemsReviewCheckpointSubmission | SystemsReviewFinalSubmission;

export interface SystemsReviewStoredCheckpoint extends Omit<SystemsReviewCheckpointSubmission, "operation"> {
	index: number;
	digest: string;
	createdAt: number;
}

export interface SystemsReviewFinalReport {
	verdict: "pass" | "fail";
	report: string;
	blockingFindingIds: string[];
	checkpointDigest: string;
	completedAt: number;
}
