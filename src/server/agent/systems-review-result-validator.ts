import { createHash } from "node:crypto";
import { changedPathForSystemsReview, isGapFreeReceiptCoverage } from "./systems-review-reader.js";
import type {
	SystemsReviewActionBehavior,
	SystemsReviewBehavior,
	SystemsReviewCheckpointSubmission,
	SystemsReviewCoverageItem,
	SystemsReviewCoverageMapping,
	SystemsReviewEvidenceLocation,
	SystemsReviewFinalReport,
	SystemsReviewFinding,
	SystemsReviewMixedStateCase,
	SystemsReviewReceiptClaims,
	SystemsReviewSnapshot,
	SystemsReviewStoredCheckpoint,
	SystemsReviewTestInvariant,
	SystemsReviewTraceLayer,
} from "./systems-review-types.js";

const STATE_LAYERS = ["producer", "aggregation", "transport", "persistence", "consumer"] as const;
const ACTION_LAYERS = ["control", "payload", "handler", "target-resolver", "final-side-effect"] as const;
const MIXED_STATES = ["empty", "complete", "partial", "failed", "stale", "mixed-success"] as const;
const BLOCKING_MEDIUM_CATEGORIES = new Set([
	"wrong-target",
	"hidden-or-misstated-work",
	"incomplete-authoritative",
	"untested-destructive-aggregate-target",
]);

export class SystemsReviewResultError extends Error {
	readonly code: string;
	readonly details?: Record<string, unknown>;

	constructor(code: string, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "SystemsReviewResultError";
		this.code = code;
		this.details = details;
	}
}

export interface SystemsReviewAccumulatedResult {
	behaviors: SystemsReviewBehavior[];
	coverageMappings: SystemsReviewCoverageMapping[];
	findings: SystemsReviewFinding[];
	unresolvedLinks: string[];
	receipts: SystemsReviewReceiptClaims[];
}

export interface ValidateCheckpointContext {
	snapshot: SystemsReviewSnapshot;
	contractDigest: string;
	executionId: string;
	checkpoints: readonly SystemsReviewStoredCheckpoint[];
	accumulated: SystemsReviewAccumulatedResult;
	verifyReceipt: (token: string) => SystemsReviewReceiptClaims;
	now?: () => number;
}

export interface FinalizeSystemsReviewContext {
	snapshot: SystemsReviewSnapshot;
	checkpoints: readonly SystemsReviewStoredCheckpoint[];
	accumulated: SystemsReviewAccumulatedResult;
	resolvedLinks: readonly string[];
	finalCheckpointDigest: string;
	validateExactTargetAssertion?: (args: { assertionId: string; behavior: SystemsReviewActionBehavior; coverageItem: SystemsReviewCoverageItem }) => boolean;
	now?: () => number;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function assertIdentifier(value: string, label: string): void {
	if (typeof value !== "string" || value.length < 1 || value.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9:._/-]*$/.test(value)) {
		throw new SystemsReviewResultError("INVALID_IDENTIFIER", `${label} must be a non-empty stable identifier containing at most 200 safe characters.`, { value });
	}
}

function assertNonEmptyText(value: string, label: string, max = 20_000): void {
	if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > max) {
		throw new SystemsReviewResultError("INVALID_TEXT", `${label} must contain bounded non-empty text.`);
	}
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && [...new Set(left)].sort().join("\0") === [...new Set(right)].sort().join("\0");
}

function locationKey(location: SystemsReviewEvidenceLocation): string {
	return stableJson(location);
}

function mergeLocations(existing: readonly SystemsReviewEvidenceLocation[], incoming: readonly SystemsReviewEvidenceLocation[]): SystemsReviewEvidenceLocation[] {
	const result = [...existing];
	const seen = new Set(result.map(locationKey));
	for (const location of incoming) {
		const key = locationKey(location);
		if (!seen.has(key)) {
			seen.add(key);
			result.push(location);
		}
	}
	return result;
}

function mergeLayer(existing: SystemsReviewTraceLayer, incoming: SystemsReviewTraceLayer): SystemsReviewTraceLayer {
	if (existing.layer !== incoming.layer || existing.description !== incoming.description) throw new SystemsReviewResultError("CONFLICTING_BEHAVIOR", `Trace layer "${existing.layer}" was rewritten by a later checkpoint.`);
	return { ...existing, locations: mergeLocations(existing.locations, incoming.locations) };
}

function mergeTests(existing: readonly SystemsReviewTestInvariant[], incoming: readonly SystemsReviewTestInvariant[]): SystemsReviewTestInvariant[] {
	const result = existing.map(test => ({ ...test, locations: [...test.locations] }));
	for (const test of incoming) {
		const found = result.find(candidate => candidate.invariant === test.invariant);
		if (!found) {
			result.push({ ...test, locations: [...test.locations] });
			continue;
		}
		if (found.failureLayer !== test.failureLayer || found.exactTargetAssertionId !== test.exactTargetAssertionId) throw new SystemsReviewResultError("CONFLICTING_BEHAVIOR", `Test invariant "${test.invariant}" was rewritten by a later checkpoint.`);
		found.locations = mergeLocations(found.locations, test.locations);
	}
	return result;
}

function mergeLayers(existing: readonly SystemsReviewTraceLayer[], incoming: readonly SystemsReviewTraceLayer[]): SystemsReviewTraceLayer[] {
	const result = existing.map(layer => ({ ...layer, locations: [...layer.locations] }));
	for (const layer of incoming) {
		const index = result.findIndex(candidate => candidate.layer === layer.layer);
		if (index < 0) result.push({ ...layer, locations: [...layer.locations] });
		else result[index] = mergeLayer(result[index], layer);
	}
	return result;
}

function mergeMatrix(existing: readonly SystemsReviewMixedStateCase[], incoming: readonly SystemsReviewMixedStateCase[]): SystemsReviewMixedStateCase[] {
	const result = existing.map(item => ({ ...item, locations: [...item.locations] }));
	for (const item of incoming) {
		const found = result.find(candidate => candidate.state === item.state);
		if (!found) {
			result.push({ ...item, locations: [...item.locations] });
			continue;
		}
		if (found.expected !== item.expected || found.observed !== item.observed) throw new SystemsReviewResultError("CONFLICTING_BEHAVIOR", `Mixed-state case "${item.state}" was rewritten by a later checkpoint.`);
		found.locations = mergeLocations(found.locations, item.locations);
	}
	return result;
}

function mergeBehavior(existing: SystemsReviewBehavior, incoming: SystemsReviewBehavior): SystemsReviewBehavior {
	if (existing.kind !== incoming.kind || existing.title !== incoming.title) throw new SystemsReviewResultError("CONFLICTING_BEHAVIOR", `Behavior "${existing.id}" was rewritten by a later checkpoint.`);
	const common = {
		...existing,
		coverageItemIds: [...new Set([...existing.coverageItemIds, ...incoming.coverageItemIds])],
		layers: mergeLayers(existing.layers, incoming.layers),
		tests: mergeTests(existing.tests, incoming.tests),
	};
	if (existing.kind === "state" && incoming.kind === "state") {
		if (existing.conservativeAggregateInvariant !== incoming.conservativeAggregateInvariant) throw new SystemsReviewResultError("CONFLICTING_BEHAVIOR", `State behavior "${existing.id}" changed its conservative aggregate invariant.`);
		return { ...common, kind: "state", conservativeAggregateInvariant: existing.conservativeAggregateInvariant, mixedStateMatrix: mergeMatrix(existing.mixedStateMatrix, incoming.mixedStateMatrix) };
	}
	if (existing.kind === "action" && incoming.kind === "action") {
		if (existing.change !== incoming.change || existing.mutation !== incoming.mutation || existing.aggregate !== incoming.aggregate || existing.targetInvariant !== incoming.targetInvariant) throw new SystemsReviewResultError("CONFLICTING_BEHAVIOR", `Action behavior "${existing.id}" changed immutable action semantics.`);
		return { ...common, kind: "action", change: existing.change, mutation: existing.mutation, aggregate: existing.aggregate, targetInvariant: existing.targetInvariant };
	}
	throw new SystemsReviewResultError("CONFLICTING_BEHAVIOR", `Behavior "${existing.id}" changed kind.`);
}

function mergeFinding(existing: SystemsReviewFinding, incoming: SystemsReviewFinding): SystemsReviewFinding {
	for (const key of ["severity", "category", "title", "trigger", "consequence", "violatedInvariant"] as const) {
		if (existing[key] !== incoming[key]) throw new SystemsReviewResultError("CONFLICTING_FINDING", `Finding "${existing.id}" rewrote ${key}.`);
	}
	return {
		...existing,
		behaviorIds: [...new Set([...existing.behaviorIds, ...incoming.behaviorIds])],
		locations: mergeLocations(existing.locations, incoming.locations),
	};
}

export function accumulateSystemsReviewResults(checkpoints: readonly SystemsReviewStoredCheckpoint[]): SystemsReviewAccumulatedResult {
	const behaviors = new Map<string, SystemsReviewBehavior>();
	const mappings = new Map<string, SystemsReviewCoverageMapping>();
	const findings = new Map<string, SystemsReviewFinding>();
	const unresolved = new Set<string>();
	const receipts: SystemsReviewReceiptClaims[] = [];
	for (const checkpoint of checkpoints) {
		for (const behavior of checkpoint.behaviors) {
			const found = behaviors.get(behavior.id);
			behaviors.set(behavior.id, found ? mergeBehavior(found, behavior) : structuredClone(behavior));
		}
		for (const mapping of checkpoint.coverageMappings) {
			const found = mappings.get(mapping.coverageItemId);
			if (!found) mappings.set(mapping.coverageItemId, structuredClone(mapping));
			else {
				if (found.nonBehavioralReason !== mapping.nonBehavioralReason) throw new SystemsReviewResultError("CONFLICTING_MAPPING", `Coverage mapping "${mapping.coverageItemId}" changed its nonbehavioral reason.`);
				found.behaviorIds = [...new Set([...found.behaviorIds, ...mapping.behaviorIds])];
			}
		}
		for (const finding of checkpoint.findings) {
			const found = findings.get(finding.id);
			findings.set(finding.id, found ? mergeFinding(found, finding) : structuredClone(finding));
		}
		for (const link of checkpoint.unresolvedLinks) unresolved.add(link);
		// Receipt claims are injected by validateSystemsReviewCheckpoint as a non-persisted
		// symbol-like field before the checkpoint reaches this helper after restart.
		const checkpointReceipts = (checkpoint as SystemsReviewStoredCheckpoint & { receiptClaims?: SystemsReviewReceiptClaims[] }).receiptClaims;
		if (checkpointReceipts) receipts.push(...checkpointReceipts);
	}
	return { behaviors: [...behaviors.values()], coverageMappings: [...mappings.values()], findings: [...findings.values()], unresolvedLinks: [...unresolved], receipts };
}

function validateLocation(location: SystemsReviewEvidenceLocation, availableReceipts: Map<string, SystemsReviewReceiptClaims>, snapshot: SystemsReviewSnapshot): void {
	assertSystemsReviewReadableLocationPath(location.path);
	if (!snapshot.repos.some(repo => repo.id === location.repoId)) throw new SystemsReviewResultError("UNKNOWN_LOCATION_REPO", `Evidence location references unknown repository "${location.repoId}".`);
	if (location.lineStart !== undefined && (!Number.isSafeInteger(location.lineStart) || location.lineStart < 1)) throw new SystemsReviewResultError("INVALID_LOCATION", "Evidence lineStart must be a positive integer.");
	if (location.lineEnd !== undefined && (!Number.isSafeInteger(location.lineEnd) || location.lineEnd < (location.lineStart ?? 1))) throw new SystemsReviewResultError("INVALID_LOCATION", "Evidence lineEnd must not precede lineStart.");
	if (!Array.isArray(location.receipts) || location.receipts.length === 0) throw new SystemsReviewResultError("UNBOUND_LOCATION", `Evidence location ${location.repoId}:${location.path} has no receipt.`);
	for (const token of location.receipts) {
		const claims = availableReceipts.get(token);
		if (!claims) throw new SystemsReviewResultError("UNDECLARED_RECEIPT", `Evidence location cites a receipt absent from receiptTokens.`);
		if (claims.repoId !== location.repoId || claims.path !== location.path) throw new SystemsReviewResultError("RECEIPT_LOCATION_MISMATCH", `Evidence receipt does not bind ${location.repoId}:${location.path}.`);
		if (location.kind === "changed" && claims.operation !== "patch") throw new SystemsReviewResultError("RECEIPT_KIND_MISMATCH", "Changed evidence must cite patch receipts.");
		if (location.kind === "unchanged" && claims.operation !== "file") throw new SystemsReviewResultError("RECEIPT_KIND_MISMATCH", "Unchanged context must cite bound-tree file receipts.");
	}
}

function assertSystemsReviewReadableLocationPath(candidate: string): void {
	if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0") || candidate.startsWith("/") || candidate.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(candidate) || candidate.replace(/\\/g, "/").split("/").some(part => part === ".." || part === "")) {
		throw new SystemsReviewResultError("INVALID_LOCATION", `Unsafe evidence location path "${candidate}".`);
	}
}

function validateBehavior(behavior: SystemsReviewBehavior, receipts: Map<string, SystemsReviewReceiptClaims>, snapshot: SystemsReviewSnapshot): void {
	assertIdentifier(behavior.id, "behavior.id");
	assertNonEmptyText(behavior.title, "behavior.title", 2_000);
	if (!Array.isArray(behavior.coverageItemIds) || behavior.coverageItemIds.length === 0) throw new SystemsReviewResultError("UNMAPPED_BEHAVIOR", `Behavior "${behavior.id}" has no coverage items.`);
	for (const coverageId of behavior.coverageItemIds) if (!snapshot.coverage.some(item => item.id === coverageId)) throw new SystemsReviewResultError("UNKNOWN_COVERAGE_ITEM", `Behavior "${behavior.id}" references unknown coverage item "${coverageId}".`);
	for (const layer of behavior.layers) {
		assertNonEmptyText(layer.description, `behavior.${behavior.id}.layer.description`);
		for (const location of layer.locations) validateLocation(location, receipts, snapshot);
	}
	for (const test of behavior.tests) {
		assertNonEmptyText(test.invariant, `behavior.${behavior.id}.test.invariant`);
		assertNonEmptyText(test.failureLayer, `behavior.${behavior.id}.test.failureLayer`, 2_000);
		if (test.exactTargetAssertionId) assertIdentifier(test.exactTargetAssertionId, "test.exactTargetAssertionId");
		for (const location of test.locations) validateLocation(location, receipts, snapshot);
	}
	if (behavior.kind === "state") {
		assertNonEmptyText(behavior.conservativeAggregateInvariant, `behavior.${behavior.id}.conservativeAggregateInvariant`);
		for (const state of behavior.mixedStateMatrix) {
			assertNonEmptyText(state.expected, `behavior.${behavior.id}.mixedState.expected`);
			assertNonEmptyText(state.observed, `behavior.${behavior.id}.mixedState.observed`);
			for (const location of state.locations) validateLocation(location, receipts, snapshot);
		}
	} else {
		assertNonEmptyText(behavior.targetInvariant, `behavior.${behavior.id}.targetInvariant`);
	}
}

function validateFinding(finding: SystemsReviewFinding, receipts: Map<string, SystemsReviewReceiptClaims>, snapshot: SystemsReviewSnapshot): void {
	assertIdentifier(finding.id, "finding.id");
	assertNonEmptyText(finding.title, `finding.${finding.id}.title`, 2_000);
	assertNonEmptyText(finding.trigger, `finding.${finding.id}.trigger`);
	assertNonEmptyText(finding.consequence, `finding.${finding.id}.consequence`);
	assertNonEmptyText(finding.violatedInvariant, `finding.${finding.id}.violatedInvariant`);
	if (finding.behaviorIds.length === 0) throw new SystemsReviewResultError("UNBOUND_FINDING", `Finding "${finding.id}" has no behavior.`);
	if (finding.locations.length === 0) throw new SystemsReviewResultError("UNBOUND_FINDING", `Finding "${finding.id}" has no evidence location.`);
	for (const location of finding.locations) validateLocation(location, receipts, snapshot);
}

function isRangeCovered(receipts: readonly SystemsReviewReceiptClaims[], objectId: string, start: number, end: number): boolean {
	if (start === end) return receipts.some(claim => claim.operation === "patch" && claim.objectId === objectId && claim.start === 0 && claim.end === 0 && claim.complete);
	const ranges = receipts.filter(claim => claim.operation === "patch" && claim.objectId === objectId && claim.end > start && claim.start < end).sort((a, b) => a.start - b.start || b.end - a.end);
	let cursor = start;
	for (const range of ranges) {
		if (range.start > cursor) return false;
		cursor = Math.max(cursor, Math.min(range.end, end));
		if (cursor >= end) return true;
	}
	return false;
}

function compatibleNonBehavioralReason(item: SystemsReviewCoverageItem, reason: SystemsReviewCoverageMapping["nonBehavioralReason"], snapshot: SystemsReviewSnapshot): boolean {
	if (!reason) return false;
	if (reason === "test-only") return item.pathClass === "test";
	if (reason === "docs-only") return item.pathClass === "docs";
	const change = snapshot.changes.find(candidate => candidate.id === item.changeId);
	if (reason === "passive-asset") return item.pathClass === "asset" && change?.binaryExempt === true;
	if (reason === "dependency-lockfile") return change?.bodyExempt === true && change.binary === false;
	return false;
}

export function validateSystemsReviewCheckpoint(submission: SystemsReviewCheckpointSubmission, context: ValidateCheckpointContext): SystemsReviewStoredCheckpoint & { receiptClaims: SystemsReviewReceiptClaims[] } {
	if (submission.executionId !== context.executionId || submission.snapshotDigest !== context.snapshot.digest || submission.contractDigest !== context.contractDigest) throw new SystemsReviewResultError("SUBMISSION_SCOPE_MISMATCH", "Systems review checkpoint belongs to a different execution, snapshot, or contract.");
	const index = context.checkpoints.length;
	const chunk = context.snapshot.chunks[index];
	if (!chunk) throw new SystemsReviewResultError("EXTRA_CHECKPOINT", "All immutable evidence chunks are already checkpointed.");
	if (submission.chunkId !== chunk.id) throw new SystemsReviewResultError("CHUNK_ORDER_MISMATCH", `Expected evidence chunk "${chunk.id}" at checkpoint ${index}.`, { expectedChunkId: chunk.id, actualChunkId: submission.chunkId });
	const expectedPrevious = context.checkpoints.at(-1)?.digest;
	if (submission.previousCheckpointDigest !== expectedPrevious) throw new SystemsReviewResultError("CHECKPOINT_CHAIN_MISMATCH", "Systems review checkpoint does not extend the accepted immutable chain.", { expectedPrevious });
	if (!sameStringSet(submission.processedChangeIds, chunk.changeIds)) throw new SystemsReviewResultError("CHANGE_COVERAGE_MISMATCH", `Checkpoint ${index} must declare exactly the changes in its immutable evidence chunk.`);
	if (new Set(submission.receiptTokens).size !== submission.receiptTokens.length) throw new SystemsReviewResultError("DUPLICATE_RECEIPT", "Systems review checkpoint repeats a receipt token.");
	const receiptMap = new Map<string, SystemsReviewReceiptClaims>();
	for (const token of submission.receiptTokens) receiptMap.set(token, context.verifyReceipt(token));
	const coverageCursorClaims = context.verifyReceipt(submission.coverageCursor);
	if (coverageCursorClaims.operation !== "coverage") throw new SystemsReviewResultError("INVALID_COVERAGE_CURSOR", "coverageCursor must be the signed receipt for a coverage page.");
	if (!receiptMap.has(submission.coverageCursor)) receiptMap.set(submission.coverageCursor, coverageCursorClaims);
	const receiptClaims = [...receiptMap.values()];
	for (const part of chunk.parts) {
		const change = context.snapshot.changes.find(candidate => candidate.id === part.changeId);
		if (!change) throw new SystemsReviewResultError("UNKNOWN_CHANGE", `Evidence chunk references missing change "${part.changeId}".`);
		const objectId = `patch:${change.id}:${change.patchSha256}`;
		if (!isRangeCovered(receiptClaims, objectId, part.patchStart, part.patchEnd)) throw new SystemsReviewResultError("PATCH_GAP", `Checkpoint ${index} lacks gap-free patch receipts for ${change.id} bytes ${part.patchStart}-${part.patchEnd}.`);
	}
	for (const behavior of submission.behaviors) validateBehavior(behavior, receiptMap, context.snapshot);
	for (const finding of submission.findings) validateFinding(finding, receiptMap, context.snapshot);
	for (const link of submission.unresolvedLinks) assertIdentifier(link, "unresolvedLink");
	if (new Set(submission.unresolvedLinks).size !== submission.unresolvedLinks.length) throw new SystemsReviewResultError("DUPLICATE_LINK", "Checkpoint repeats an unresolved cross-chunk link.");
	const currentCoverageIds = new Set(chunk.changeIds.map(changeId => context.snapshot.coverage.find(item => item.changeId === changeId)?.id).filter((value): value is string => !!value));
	const submittedMappings = new Map(submission.coverageMappings.map(mapping => [mapping.coverageItemId, mapping]));
	for (const coverageId of currentCoverageIds) if (!submittedMappings.has(coverageId) && !context.accumulated.coverageMappings.some(mapping => mapping.coverageItemId === coverageId)) throw new SystemsReviewResultError("UNMAPPED_COVERAGE", `Checkpoint ${index} omitted coverage mapping "${coverageId}".`);
	for (const mapping of submission.coverageMappings) {
		const item = context.snapshot.coverage.find(candidate => candidate.id === mapping.coverageItemId);
		if (!item) throw new SystemsReviewResultError("UNKNOWN_COVERAGE_ITEM", `Unknown coverage mapping "${mapping.coverageItemId}".`);
		if (mapping.nonBehavioralReason && mapping.behaviorIds.length > 0) throw new SystemsReviewResultError("AMBIGUOUS_MAPPING", `Coverage mapping "${mapping.coverageItemId}" cannot combine behaviors with a nonbehavioral reason.`);
		if (mapping.behaviorIds.length === 0 && !compatibleNonBehavioralReason(item, mapping.nonBehavioralReason, context.snapshot)) throw new SystemsReviewResultError("INVALID_NONBEHAVIORAL_MAPPING", `Coverage item "${mapping.coverageItemId}" requires a compatible receipt-backed behavior.`);
	}
	const knownBehaviorIds = new Set([...context.accumulated.behaviors, ...submission.behaviors].map(behavior => behavior.id));
	for (const mapping of submission.coverageMappings) for (const behaviorId of mapping.behaviorIds) if (!knownBehaviorIds.has(behaviorId)) throw new SystemsReviewResultError("UNKNOWN_BEHAVIOR", `Coverage mapping references unknown behavior "${behaviorId}".`);
	const digest = sha256(stableJson({ index, previousCheckpointDigest: expectedPrevious ?? null, submission }));
	return {
		...submission,
		index,
		digest,
		createdAt: context.now?.() ?? Date.now(),
		receiptClaims,
	};
}

function assertCompleteLayers(behaviorId: string, layers: readonly SystemsReviewTraceLayer[], required: readonly string[]): void {
	const names = layers.map(layer => layer.layer);
	for (const name of required) {
		const layer = layers.find(candidate => candidate.layer === name);
		if (!layer || layer.locations.length === 0) throw new SystemsReviewResultError("INCOMPLETE_TRACE", `Behavior "${behaviorId}" lacks receipt-bound ${name} evidence.`);
	}
	if (new Set(names).size !== names.length) throw new SystemsReviewResultError("DUPLICATE_TRACE_LAYER", `Behavior "${behaviorId}" repeats a trace layer.`);
}

function validateCompleteBehavior(behavior: SystemsReviewBehavior): void {
	if (behavior.tests.length === 0) throw new SystemsReviewResultError("INCOMPLETE_TEST_TRACE", `Behavior "${behavior.id}" has no material invariant tests.`);
	if (behavior.kind === "state") {
		assertCompleteLayers(behavior.id, behavior.layers, STATE_LAYERS);
		if (!sameStringSet(behavior.mixedStateMatrix.map(item => item.state), MIXED_STATES)) throw new SystemsReviewResultError("INCOMPLETE_MIXED_STATE_MATRIX", `State behavior "${behavior.id}" must cover empty, complete, partial, failed, stale, and mixed-success inputs exactly once.`);
	} else {
		assertCompleteLayers(behavior.id, behavior.layers, ACTION_LAYERS);
	}
}

function derivedUntestedTargetFinding(behavior: SystemsReviewActionBehavior, item: SystemsReviewCoverageItem): SystemsReviewFinding {
	const location = behavior.layers.find(layer => layer.layer === "final-side-effect")?.locations[0]
		?? behavior.layers.flatMap(layer => layer.locations)[0];
	if (!location) throw new SystemsReviewResultError("INCOMPLETE_ACTION_TRACE", `Action behavior "${behavior.id}" has no final-side-effect evidence.`);
	return {
		id: `derived:untested-target:${sha256(`${behavior.id}\0${item.id}`).slice(0, 24)}`,
		severity: "medium",
		category: "untested-destructive-aggregate-target",
		title: `Aggregate mutation target lacks trusted final-mutator coverage: ${behavior.title}`,
		trigger: `Invoke the introduced or modified aggregate ${behavior.mutation} action represented by ${behavior.id}.`,
		consequence: "A mutation can reach an unintended repository, branch, resource, or scope without an integration/browser assertion observing the final production adapter.",
		violatedInvariant: behavior.targetInvariant,
		behaviorIds: [behavior.id],
		locations: [location],
	};
}

function reportLocation(finding: SystemsReviewFinding): string {
	const location = finding.locations[0];
	if (!location) return "unknown";
	return `${location.path}${location.lineStart ? `:${location.lineStart}` : ""}`;
}

function renderReport(findings: readonly SystemsReviewFinding[], snapshot: SystemsReviewSnapshot, checkpointDigest: string): { report: string; blockingFindingIds: string[] } {
	const blockingFindingIds = findings.filter(finding => finding.severity === "critical" || finding.severity === "high" || (finding.severity === "medium" && BLOCKING_MEDIUM_CATEGORIES.has(finding.category))).map(finding => finding.id);
	const lines = [
		"# Systems Interaction Review",
		"",
		`Snapshot: \`${snapshot.digest}\``,
		`Checkpoint chain: \`${checkpointDigest}\``,
		`Repositories: ${snapshot.repos.length}; changes: ${snapshot.changes.length}; coverage items: ${snapshot.coverage.length}.`,
		"",
	];
	if (findings.length === 0) lines.push("No reproducible medium-or-higher cross-layer correctness defects found.");
	for (const finding of findings) {
		lines.push(`## [${finding.severity}] ${finding.title}`, "", `- Category: \`${finding.category}\``, `- Location: \`${reportLocation(finding)}\``, `- Trigger: ${finding.trigger}`, `- Consequence: ${finding.consequence}`, `- Violated invariant: ${finding.violatedInvariant}`, "");
	}
	lines.push(`Verdict: **${blockingFindingIds.length > 0 ? "FAIL" : "PASS"}**.`);
	return { report: lines.join("\n"), blockingFindingIds };
}

export function finalizeSystemsReviewResult(context: FinalizeSystemsReviewContext): SystemsReviewFinalReport {
	if (context.checkpoints.length !== context.snapshot.chunks.length) throw new SystemsReviewResultError("INCOMPLETE_CHECKPOINT_CHAIN", `Systems review has ${context.checkpoints.length}/${context.snapshot.chunks.length} immutable evidence checkpoints.`);
	const lastDigest = context.checkpoints.at(-1)?.digest;
	if (!lastDigest || lastDigest !== context.finalCheckpointDigest) throw new SystemsReviewResultError("FINAL_CHECKPOINT_MISMATCH", "Final synthesis does not name the accepted checkpoint-chain head.");
	for (let index = 0; index < context.checkpoints.length; index++) {
		if (context.checkpoints[index].index !== index || context.checkpoints[index].chunkId !== context.snapshot.chunks[index]?.id) throw new SystemsReviewResultError("CHECKPOINT_GAP", `Checkpoint chain is not gap-free at index ${index}.`);
		const previous = index === 0 ? undefined : context.checkpoints[index - 1].digest;
		if (context.checkpoints[index].previousCheckpointDigest !== previous) throw new SystemsReviewResultError("CHECKPOINT_CHAIN_MISMATCH", `Checkpoint ${index} does not bind its predecessor.`);
	}
	const unresolved = new Set(context.accumulated.unresolvedLinks);
	for (const link of context.resolvedLinks) {
		if (!unresolved.delete(link)) throw new SystemsReviewResultError("UNKNOWN_RESOLVED_LINK", `Final synthesis resolved unknown link "${link}".`);
	}
	if (unresolved.size > 0) throw new SystemsReviewResultError("UNRESOLVED_CROSS_CHUNK_LINK", `Final synthesis left ${unresolved.size} cross-chunk link(s) unresolved.`, { unresolved: [...unresolved] });
	const behaviorMap = new Map(context.accumulated.behaviors.map(behavior => [behavior.id, behavior]));
	for (const behavior of behaviorMap.values()) validateCompleteBehavior(behavior);
	const mappingMap = new Map(context.accumulated.coverageMappings.map(mapping => [mapping.coverageItemId, mapping]));
	const findings = context.accumulated.findings.map(finding => structuredClone(finding));
	for (const item of context.snapshot.coverage) {
		const mapping = mappingMap.get(item.id);
		if (!mapping) throw new SystemsReviewResultError("UNMAPPED_COVERAGE", `Final synthesis omitted coverage item "${item.id}".`);
		if (mapping.nonBehavioralReason) {
			if (!compatibleNonBehavioralReason(item, mapping.nonBehavioralReason, context.snapshot)) throw new SystemsReviewResultError("INVALID_NONBEHAVIORAL_MAPPING", `Final synthesis improperly dismissed coverage item "${item.id}".`);
			continue;
		}
		if (mapping.behaviorIds.length === 0) throw new SystemsReviewResultError("UNMAPPED_COVERAGE", `Coverage item "${item.id}" has no behavior.`);
		const mappedBehaviors = mapping.behaviorIds.map(id => behaviorMap.get(id));
		if (mappedBehaviors.some(behavior => !behavior)) throw new SystemsReviewResultError("UNKNOWN_BEHAVIOR", `Coverage item "${item.id}" maps to an unknown behavior.`);
		if (item.requiresStateTrace && !mappedBehaviors.some(behavior => behavior?.kind === "state")) throw new SystemsReviewResultError("MISSING_STATE_TRACE", `Coverage item "${item.id}" requires a state trace.`);
		if (item.requiresActionTrace && !mappedBehaviors.some(behavior => behavior?.kind === "action")) throw new SystemsReviewResultError("MISSING_ACTION_TRACE", `Coverage item "${item.id}" requires an action trace.`);
		for (const behavior of mappedBehaviors) {
			if (behavior?.kind !== "action") continue;
			const reviewerConfirmedQualifyingAction = behavior.change !== "unchanged"
				&& (behavior.mutation === "destructive" || behavior.mutation === "remote")
				&& behavior.aggregate;
			if (!item.requiresExactTargetEvidence && !reviewerConfirmedQualifyingAction) continue;
			// Server-derived coverage risk cannot be downgraded by reviewer fields;
			// conversely, a reviewer-confirmed introduced/modified destructive or
			// remote aggregate action cannot evade proof because a keyword heuristic
			// missed it. Either source independently forces trusted final evidence.
			const assertionIds = behavior.tests.map(test => test.exactTargetAssertionId).filter((value): value is string => !!value);
			const trusted = assertionIds.some(assertionId => context.validateExactTargetAssertion?.({ assertionId, behavior, coverageItem: item }) === true);
			if (!trusted) findings.push(derivedUntestedTargetFinding(behavior, item));
		}
	}
	for (const change of context.snapshot.changes) {
		const objectId = `patch:${change.id}:${change.patchSha256}`;
		if (!isGapFreeReceiptCoverage(context.accumulated.receipts, "patch", objectId, change.bodyExempt ? 0 : change.patchBytes)) throw new SystemsReviewResultError("PATCH_COVERAGE_GAP", `Final synthesis lacks gap-free immutable patch receipts for "${change.id}" (${changedPathForSystemsReview(change)}).`);
	}
	for (const finding of findings) {
		for (const behaviorId of finding.behaviorIds) if (!behaviorMap.has(behaviorId)) throw new SystemsReviewResultError("UNKNOWN_FINDING_BEHAVIOR", `Finding "${finding.id}" references unknown behavior "${behaviorId}".`);
	}
	const dedupedFindings = [...new Map(findings.map(finding => [finding.id, finding])).values()];
	const rendered = renderReport(dedupedFindings, context.snapshot, context.finalCheckpointDigest);
	return {
		verdict: rendered.blockingFindingIds.length > 0 ? "fail" : "pass",
		report: rendered.report,
		blockingFindingIds: rendered.blockingFindingIds,
		checkpointDigest: context.finalCheckpointDigest,
		completedAt: context.now?.() ?? Date.now(),
	};
}
