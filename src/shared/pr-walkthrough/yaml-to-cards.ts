// PURE PR-walkthrough YAML → cards synthesis. Extracted from the server-side
// walkthrough-yaml-schema.ts so BOTH the agent toolchain AND the first-party
// pr-walkthrough pack (bundled to lib/yaml-to-cards.mjs) run the SAME synthesis —
// one source of truth (design built-in-first-party-packs.md §8.4). This module
// imports ONLY from sibling shared modules + the `yaml` package: no node:/server
// deps, so it bundles cleanly into the pack's confined worker.
import { parseAllDocuments } from "yaml";

import { changesetIdForGithub } from "./ids.js";
import { deriveNavLabel, navLabelError } from "./nav-label.js";
import type {
	PrWalkthroughCard,
	PrWalkthroughCardCoverageSummary,
	PrWalkthroughCardSection,
	PrWalkthroughChangesetRef,
	PrWalkthroughCoverageSummary,
	PrWalkthroughDiffBlock,
	PrWalkthroughDiffBreakdownItem,
	PrWalkthroughDiffLine,
	PrWalkthroughHunk,
	PrWalkthroughHunkPlacement,
	PrWalkthroughNarrativeBlock,
	PrWalkthroughReadReceipt,
	PrWalkthroughOrientationConcern,
	PrWalkthroughOrientationFileRole,
	PrWalkthroughPhaseId,
	PrWalkthroughSuggestedComment,
	WalkthroughExportCapability,
	WalkthroughLimits,
	WalkthroughWarning,
} from "./types.js";

/** Permissive limits/export shapes (mirror the prior server payload: a structural
 *  shared type intersected with an open record, so callers may carry extra keys
 *  like `previewOnly` without an excess-property error). */
export type WalkthroughSynthesisLimits = WalkthroughLimits & Record<string, unknown>;
export type WalkthroughSynthesisExport = WalkthroughExportCapability & Record<string, unknown>;

/** The structural result of YAML → cards synthesis. The server maps this onto its
 *  own `WalkthroughStorePayload` type (structurally identical); the pack consumes
 *  the `cards` array directly. */
export interface WalkthroughSynthesisResult {
	changesetId: string;
	changeset: PrWalkthroughChangesetRef;
	cards: PrWalkthroughCard[];
	warnings: WalkthroughWarning[];
	coverage?: PrWalkthroughCoverageSummary;
	limits?: WalkthroughSynthesisLimits;
	export?: WalkthroughSynthesisExport;
}

export interface PrWalkthroughValidationError {
	path: string;
	message: string;
}

export interface PrWalkthroughValidationSummary {
	code: "YAML_SCHEMA_INVALID";
	message: string;
	errors: PrWalkthroughValidationError[];
	retryable: true;
}

export type PrWalkthroughSynthesisErrorCode =
	| "PRW_HUNK_REF_UNRESOLVED"
	| "PRW_DUPLICATE_PRIMARY_HUNK"
	| "PRW_SECONDARY_WITHOUT_PRIMARY"
	| "PRW_SKIP_REASON_REQUIRED"
	| "PRW_MAJOR_REMAINING_HUNKS"
	| "PRW_HUNK_PLACEMENT_CONFLICT";

export interface PrWalkthroughSynthesisError extends Error {
	code: PrWalkthroughSynthesisErrorCode;
	retryable: true;
	details?: Record<string, unknown>;
}

export type PrWalkthroughYamlValidationResult =
	| { ok: true; document: PrWalkthroughYamlDocument }
	| { ok: false; summary: PrWalkthroughValidationSummary };

export interface PrWalkthroughYamlLaunchTarget {
	provider?: "github" | "local" | string;
	owner?: string;
	repo?: string;
	number?: number | string;
	prUrl?: string;
	url?: string;
	baseSha?: string;
	headSha?: string;
	changesetId?: string;
}

export interface PrWalkthroughYamlValidationOptions {
	target?: PrWalkthroughYamlLaunchTarget;
	maxYamlBytes?: number;
	maxStringLength?: number;
	maxArrayItems?: number;
}

export interface PrWalkthroughYamlDocument {
	schema_version: 1;
	pr: PrWalkthroughYamlPr;
	walkthrough: PrWalkthroughYamlWalkthrough;
}

export interface PrWalkthroughYamlPr {
	provider: "github";
	owner: string;
	repo: string;
	number: number;
	title: string;
	url: string;
	base_sha: string;
	head_sha: string;
	original_description: {
		body: string;
		source: "gh_api" | "gh_cli" | "unknown";
		fetched_at: string;
	};
	stats: {
		files_changed: number;
		additions: number;
		deletions: number;
	};
}

export interface PrWalkthroughYamlWalkthrough {
	context: {
		why_created: string;
		problem_solved: string;
		why_worth_merging: string;
		merge_concerns: string;
		author_intent: string;
		reviewer_map: string;
		diff_breakdown?: PrWalkthroughYamlDiffBreakdown;
	};
	merge_assessment: {
		recommendation: "approve" | "comment" | "request_changes" | "unknown";
		confidence: "low" | "medium" | "high";
		summary: string;
		blocking_concerns: string[];
		non_blocking_concerns: string[];
	};
	design_decisions: PrWalkthroughYamlDesignDecision[];
	review_chunks: PrWalkthroughYamlReviewChunk[];
	omissions_and_followups: PrWalkthroughYamlOmission[];
	audit: {
		remaining_changed_areas: string[];
		low_signal_or_mechanical_changes: string[];
		generated_or_binary_files: string[];
		reviewer_checklist: string[];
	};
	display: {
		phase_order: PrWalkthroughPhaseId[];
		chunk_order: string[];
	};
}

export type PrWalkthroughYamlHunkPlacement = "primary" | "secondary" | "skip";
export type PrWalkthroughYamlSkipReason = "generated" | "binary" | "mechanical" | "unread" | "superseded" | "other";

export interface PrWalkthroughYamlHunkReference {
	hunk_id?: string;
	file?: string;
	hunk_index?: number;
	hunk_header?: string;
	old_start?: number;
	old_lines?: number;
	new_start?: number;
	new_lines?: number;
	line_range?: string;
	placement?: PrWalkthroughYamlHunkPlacement;
	why_relevant?: string;
	primary_card_id?: string;
	skip_reason?: PrWalkthroughYamlSkipReason | string;
}

export interface PrWalkthroughYamlRelevantHunk extends PrWalkthroughYamlHunkReference {
	why_relevant: string;
}

export type PrWalkthroughYamlNarrativeEntry =
	| { id: string; type: "text"; body: string }
	| { id: string; type: "diff"; hunks: PrWalkthroughYamlHunkReference[] }
	| { id: string; type: "note"; body: string; anchor?: PrWalkthroughYamlAnchor }
	| { id: string; type: "suggested_comment"; severity: "blocking" | "non_blocking" | "question" | "nit"; intent: "inline" | "summary"; body: string; anchor?: PrWalkthroughYamlAnchor }
	| { id: string; type: "checklist"; items: string[] };

export interface PrWalkthroughYamlDesignDecision {
	id: string;
	title: string;
	nav_label?: string;
	explanation: string;
	chosen_approach: string;
	alternatives_considered: Array<{ option: string; pros: string[]; cons: string[] }>;
	tradeoffs: string[];
	suggested_reviewer_concerns: string[];
	relevant_hunks: PrWalkthroughYamlRelevantHunk[];
}

export interface PrWalkthroughYamlReviewChunk {
	id: string;
	phase: "significant" | "other" | "audit";
	title: string;
	nav_label?: string;
	reviewer_goal: string;
	explanation: string;
	files: string[];
	relevant_hunks: PrWalkthroughYamlRelevantHunk[];
	narrative?: PrWalkthroughYamlNarrativeEntry[];
	suggested_concerns: Array<{
		severity: "blocking" | "non_blocking" | "question" | "nit";
		concern: string;
		suggested_comment: string;
		anchors: PrWalkthroughYamlAnchor[];
	}>;
	positive_notes: string[];
}

export interface PrWalkthroughYamlAnchor extends PrWalkthroughYamlHunkReference {
	line?: number;
}

export interface PrWalkthroughYamlOmission {
	category: "tests" | "docs" | "migration" | "telemetry" | "security" | "performance" | "compatibility" | "cleanup" | "other";
	expected_artifact: string;
	evidence_checked: string;
	concern: string;
	suggested_comment: string;
	severity: "blocking" | "non_blocking" | "question";
}

export interface PrWalkthroughYamlDiffBreakdownCounts {
	files?: number;
	additions?: number;
	deletions?: number;
	note?: string;
}

export interface PrWalkthroughYamlDiffBreakdown {
	prod_executable_code: PrWalkthroughYamlDiffBreakdownCounts;
	test_code: PrWalkthroughYamlDiffBreakdownCounts;
	code_and_comments: PrWalkthroughYamlDiffBreakdownCounts;
	docs_only: PrWalkthroughYamlDiffBreakdownCounts;
}

export interface MapYamlToWalkthroughPayloadOptions {
	changesetId?: string;
	target?: PrWalkthroughYamlLaunchTarget;
	warnings?: WalkthroughWarning[];
	limits?: WalkthroughSynthesisLimits;
	export?: WalkthroughSynthesisExport;
	readReceipts?: PrWalkthroughReadReceipt[];
}

export interface WalkthroughParsedDiffForYamlMapping {
	changeset?: Partial<PrWalkthroughChangesetRef>;
	files?: unknown[];
	diffBlocks?: PrWalkthroughDiffBlock[];
	warnings?: WalkthroughWarning[];
	limits?: WalkthroughSynthesisLimits;
	export?: WalkthroughSynthesisExport;
}

const DEFAULT_MAX_YAML_BYTES = 256_000;
const DEFAULT_MAX_STRING_LENGTH = 20_000;
const DEFAULT_MAX_ARRAY_ITEMS = 200;

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const STABLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

const PROVIDERS = new Set(["github"]);
const DESCRIPTION_SOURCES = new Set(["gh_api", "gh_cli", "unknown"]);
const RECOMMENDATIONS = new Set(["approve", "comment", "request_changes", "unknown"]);
const CONFIDENCES = new Set(["low", "medium", "high"]);
const REVIEW_PHASES = new Set(["significant", "other", "audit"]);
const PHASES = new Set(["orientation", "design", "significant", "other", "audit"]);
const CONCERN_SEVERITIES = new Set(["blocking", "non_blocking", "question", "nit"]);
const OMISSION_SEVERITIES = new Set(["blocking", "non_blocking", "question"]);
const OMISSION_CATEGORIES = new Set(["tests", "docs", "migration", "telemetry", "security", "performance", "compatibility", "cleanup", "other"]);
const HUNK_PLACEMENTS = new Set(["primary", "secondary", "skip"]);
const HUNK_SKIP_REASONS = new Set(["generated", "binary", "mechanical", "unread", "superseded", "other"]);
const NARRATIVE_TYPES = new Set(["text", "diff", "note", "suggested_comment", "checklist"]);
const COMMENT_INTENTS = new Set(["inline", "summary"]);
export function validatePrWalkthroughYaml(yamlText: string, options: PrWalkthroughYamlValidationOptions = {}): PrWalkthroughYamlValidationResult {
	const errors: PrWalkthroughValidationError[] = [];
	const maxYamlBytes = options.maxYamlBytes ?? DEFAULT_MAX_YAML_BYTES;
	const bytes = Buffer.byteLength(yamlText, "utf-8");
	if (bytes === 0 || yamlText.trim().length === 0) {
		return invalid([{ path: "$", message: "YAML content is empty." }]);
	}
	if (bytes > maxYamlBytes) {
		return invalid([{ path: "$", message: `YAML is ${bytes} bytes; limit is ${maxYamlBytes} bytes. Prioritize the most important review chunks and retry.` }]);
	}

	let root: unknown;
	try {
		const documents = parseAllDocuments(yamlText, { uniqueKeys: true });
		if (documents.length !== 1) {
			return invalid([{ path: "$", message: `Expected exactly one YAML document, received ${documents.length}.` }]);
		}
		const [document] = documents;
		if (!document) return invalid([{ path: "$", message: "YAML content is empty." }]);
		if (document.errors.length > 0) {
			return invalid(document.errors.map((error, index) => ({ path: "$", message: `YAML syntax error${document.errors.length > 1 ? ` ${index + 1}` : ""}: ${error.message}` })));
		}
		root = document.toJSON();
	} catch (error) {
		return invalid([{ path: "$", message: `YAML syntax error: ${error instanceof Error ? error.message : String(error)}` }]);
	}

	if (!isRecord(root) || Array.isArray(root)) {
		return invalid([{ path: "$", message: "Root value must be an object with schema_version, pr, and walkthrough." }]);
	}

	checkLimits(root, "$", errors, options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH, options.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS);
	const document = parseDocument(root, errors);
	if (document) validateCrossFieldRules(document, options.target, errors);
	return errors.length > 0 || !document ? invalid(errors) : { ok: true, document };
}

export function mapYamlToWalkthroughPayload(
	document: PrWalkthroughYamlDocument,
	parsedDiff: WalkthroughParsedDiffForYamlMapping = {},
	options: MapYamlToWalkthroughPayloadOptions = {},
): WalkthroughSynthesisResult {
	const diffBlocks = flattenDiffBlocks(parsedDiff);
	const mapper = new DiffReferenceMapper(diffBlocks);
	const warnings: WalkthroughWarning[] = [...(options.warnings ?? []), ...(parsedDiff.warnings ?? [])];
	const cards: PrWalkthroughCard[] = [];
	const allocatedCards: PrWalkthroughCard[] = [];
	const cardPlans: HunkCardPlan[] = [];
	const changesetId = options.changesetId ?? options.target?.changesetId ?? changesetIdForGithub(document.pr.owner, document.pr.repo, document.pr.number, document.pr.head_sha);

	const allocateCardId = (seed: string): string => {
		const id = uniqueCardId(seed, allocatedCards);
		allocatedCards.push({ id, phaseId: "other", title: id, summary: "", diffBlocks: [] });
		return id;
	};

	const orientation = buildOrientationCard(document);
	cards.push(orientation);
	allocatedCards.push(orientation);

	for (const decision of document.walkthrough.design_decisions) {
		const cardId = allocateCardId(`design-${decision.id}`);
		const refs = mergeCardReferences(collectHunkReferences(decision.relevant_hunks, mapper, {
			cardId,
			cardTitle: decision.title,
			phaseId: "design",
			path: `walkthrough.design_decisions[id=${decision.id}].relevant_hunks`,
		}));
		cardPlans.push({ kind: "design", cardId, title: decision.title, phaseId: "design", refs, decision });
	}

	const chunkById = new Map(document.walkthrough.review_chunks.map(chunk => [chunk.id, chunk]));
	const orderedChunks = [
		...document.walkthrough.display.chunk_order.map(id => chunkById.get(id)).filter((chunk): chunk is PrWalkthroughYamlReviewChunk => Boolean(chunk)),
		...document.walkthrough.review_chunks.filter(chunk => !document.walkthrough.display.chunk_order.includes(chunk.id)),
	];
	for (const chunk of orderedChunks) {
		const cardId = allocateCardId(`${chunk.phase}-${chunk.id}`);
		const refs = mergeCardReferences([
			...collectHunkReferences(chunk.relevant_hunks, mapper, {
				cardId,
				cardTitle: chunk.title,
				phaseId: chunk.phase,
				path: `walkthrough.review_chunks[id=${chunk.id}].relevant_hunks`,
			}),
			...collectNarrativeDiffReferences(chunk, mapper, {
				cardId,
				cardTitle: chunk.title,
				phaseId: chunk.phase,
				path: `walkthrough.review_chunks[id=${chunk.id}].narrative`,
			}),
		]);
		cardPlans.push({ kind: "review", cardId, title: chunk.title, phaseId: chunk.phase, refs, chunk });
	}

	const placement = validateHunkCoverage(mapper.allHunks(), cardPlans.flatMap(plan => plan.refs), options.readReceipts ?? []);
	if (placement.majorRemaining.length > 0) {
		throw synthesisError("PRW_MAJOR_REMAINING_HUNKS", "One or more major hunks would first appear in the completion sweep.", {
			major_remaining: placement.majorRemaining,
			suggestedFix: "Create a logical review card for each major remaining hunk, or mark it placement: skip with a reason if it is genuinely mechanical.",
		});
	}

	for (const plan of cardPlans) {
		if (plan.kind === "design") {
			cards.push(buildDesignDecisionCard(plan, placement));
		} else {
			cards.push(buildReviewChunkCard(plan, mapper, placement, warnings));
		}
	}

	const omissionsCard = buildOmissionsCard(document.walkthrough.omissions_and_followups, cards);
	if (omissionsCard) cards.push(omissionsCard);

	cards.push(buildAuditCard(document, placement, mapper, cards));

	return {
		changesetId,
		changeset: {
			...(parsedDiff.changeset ?? {}),
			baseSha: parsedDiff.changeset?.baseSha ?? document.pr.base_sha,
			headSha: parsedDiff.changeset?.headSha ?? document.pr.head_sha,
			provider: document.pr.provider,
			externalUrl: document.pr.url,
			prUrl: document.pr.url,
			prNumber: document.pr.number,
			prTitle: document.pr.title,
			title: document.pr.title,
			prBody: document.pr.original_description.body,
			filesChanged: document.pr.stats.files_changed,
			additions: document.pr.stats.additions,
			deletions: document.pr.stats.deletions,
		},
		cards: orderCards(cards, document.walkthrough.display.phase_order),
		warnings: dedupeWarnings(warnings),
		coverage: placement.summary,
		limits: options.limits ?? parsedDiff.limits,
		export: options.export ?? parsedDiff.export,
	};
}

interface HunkReferenceContext {
	cardId: string;
	cardTitle: string;
	phaseId: PrWalkthroughPhaseId;
	path: string;
	narrativeEntryId?: string;
}

interface IndexedHunk {
	hunkId: string;
	blockId: string;
	block: PrWalkthroughDiffBlock;
	hunk: PrWalkthroughHunk;
	filePath: string;
	oldPath?: string;
	hunkIndex: number;
	hunkHeader: string;
	coordinates?: HunkCoordinates;
	changedLines: number;
	additions: number;
	deletions: number;
	generated: boolean;
	binary: boolean;
	truncated: boolean;
	sourceTruncated: boolean;
	fileCategory: string;
}

interface ResolvedHunkReference {
	cardId: string;
	cardTitle: string;
	phaseId: PrWalkthroughPhaseId;
	path: string;
	narrativeEntryId?: string;
	hunk: IndexedHunk;
	placement: "primary" | "secondary" | "skip";
	whyRelevant?: string;
	primaryCardId?: string;
	skipReason?: string;
}

interface HunkCardPlan {
	kind: "design" | "review";
	cardId: string;
	title: string;
	phaseId: PrWalkthroughPhaseId;
	refs: ResolvedHunkReference[];
	decision?: PrWalkthroughYamlDesignDecision;
	chunk?: PrWalkthroughYamlReviewChunk;
}

interface HunkCoverageComputation {
	placementsByCard: Map<string, PrWalkthroughHunkPlacement[]>;
	completionSweepPlacements: PrWalkthroughHunkPlacement[];
	records: Map<string, NonNullable<PrWalkthroughCoverageSummary["records"]>[number]>;
	summary: PrWalkthroughCoverageSummary;
	majorRemaining: NonNullable<PrWalkthroughCoverageSummary["majorRemaining"]>;
}

function collectHunkReferences(hunks: PrWalkthroughYamlHunkReference[], mapper: DiffReferenceMapper, context: HunkReferenceContext): ResolvedHunkReference[] {
	return hunks.map((hunk, index) => resolveReference(mapper, hunk, { ...context, path: `${context.path}[${index}]` }));
}

function collectNarrativeDiffReferences(chunk: PrWalkthroughYamlReviewChunk, mapper: DiffReferenceMapper, context: HunkReferenceContext): ResolvedHunkReference[] {
	const out: ResolvedHunkReference[] = [];
	for (const [entryIndex, entry] of (chunk.narrative ?? []).entries()) {
		if (entry.type !== "diff") continue;
		for (const [hunkIndex, hunk] of entry.hunks.entries()) {
			out.push(resolveReference(mapper, hunk, { ...context, narrativeEntryId: entry.id, path: `${context.path}[${entryIndex}].hunks[${hunkIndex}]` }));
		}
	}
	return out;
}

function mergeCardReferences(refs: ResolvedHunkReference[]): ResolvedHunkReference[] {
	const byHunk = new Map<string, ResolvedHunkReference>();
	for (const ref of refs) {
		const existing = byHunk.get(ref.hunk.hunkId);
		if (!existing) {
			byHunk.set(ref.hunk.hunkId, ref);
			continue;
		}
		if (existing.placement !== ref.placement || (existing.primaryCardId ?? "") !== (ref.primaryCardId ?? "") || (existing.skipReason ?? "") !== (ref.skipReason ?? "")) {
			throw synthesisError("PRW_HUNK_PLACEMENT_CONFLICT", "A hunk is referenced more than once in the same card with conflicting placement metadata.", {
				hunkId: ref.hunk.hunkId,
				cardId: ref.cardId,
				firstPath: existing.path,
				conflictingPath: ref.path,
			});
		}
		if ((!existing.whyRelevant && ref.whyRelevant) || (!existing.narrativeEntryId && ref.narrativeEntryId)) {
			byHunk.set(ref.hunk.hunkId, {
				...existing,
				...(existing.whyRelevant ? {} : ref.whyRelevant ? { whyRelevant: ref.whyRelevant } : {}),
				...(existing.narrativeEntryId ? {} : ref.narrativeEntryId ? { narrativeEntryId: ref.narrativeEntryId } : {}),
			});
		}
	}
	return [...byHunk.values()];
}

function resolveReference(mapper: DiffReferenceMapper, ref: PrWalkthroughYamlHunkReference, context: HunkReferenceContext): ResolvedHunkReference {
	const hunk = mapper.resolveHunk(ref, context.path, context.cardId);
	const placement = ref.placement ?? "primary";
	if (placement === "skip" && !ref.skip_reason) {
		throw synthesisError("PRW_SKIP_REASON_REQUIRED", "Skipped hunk references require skip_reason.", {
			cardId: context.cardId,
			path: context.path,
			hunkId: hunk.hunkId,
			suggestedFix: "Add skip_reason: generated, binary, mechanical, unread, superseded, or other.",
		});
	}
	return {
		cardId: context.cardId,
		cardTitle: context.cardTitle,
		phaseId: context.phaseId,
		path: context.path,
		...(context.narrativeEntryId ? { narrativeEntryId: context.narrativeEntryId } : {}),
		hunk,
		placement,
		...(ref.why_relevant ? { whyRelevant: ref.why_relevant } : {}),
		...(ref.primary_card_id ? { primaryCardId: ref.primary_card_id } : {}),
		...(ref.skip_reason ? { skipReason: ref.skip_reason } : {}),
	};
}

function validateHunkCoverage(allHunks: IndexedHunk[], refs: ResolvedHunkReference[], receipts: PrWalkthroughReadReceipt[]): HunkCoverageComputation {
	const primaryByHunk = new Map<string, ResolvedHunkReference[]>();
	const secondaryByHunk = new Map<string, ResolvedHunkReference[]>();
	const skipByHunk = new Map<string, ResolvedHunkReference[]>();
	for (const ref of refs) {
		const target = ref.placement === "primary" ? primaryByHunk : ref.placement === "secondary" ? secondaryByHunk : skipByHunk;
		target.set(ref.hunk.hunkId, [...(target.get(ref.hunk.hunkId) ?? []), ref]);
	}

	const duplicateConflicts = [...primaryByHunk.entries()]
		.map(([hunkId, hunkRefs]) => ({ hunkId, primaryCards: uniqueCardRefs(hunkRefs), hunk: hunkRefs[0]?.hunk }))
		.filter(item => item.primaryCards.length > 1);
	if (duplicateConflicts.length > 0) {
		throw synthesisError("PRW_DUPLICATE_PRIMARY_HUNK", "One or more hunks have multiple primary placements.", {
			conflicts: duplicateConflicts.map(conflict => ({
				hunkId: conflict.hunkId,
				file: conflict.hunk?.filePath,
				hunkHeader: conflict.hunk?.hunkHeader,
				primaryCards: conflict.primaryCards,
			})),
			suggestedFix: "Keep one primary placement and mark later mentions placement: secondary.",
		});
	}

	for (const [hunkId, hunkRefs] of secondaryByHunk) {
		const primary = primaryByHunk.get(hunkId)?.[0];
		if (!primary) {
			throw synthesisError("PRW_SECONDARY_WITHOUT_PRIMARY", "A secondary hunk reference has no primary owner.", {
				hunkId,
				secondaryCards: uniqueCardRefs(hunkRefs),
				suggestedFix: "Make this reference primary, or add a primary placement in the card that first explains the hunk.",
			});
		}
		for (const ref of hunkRefs) {
			if (ref.primaryCardId && ref.primaryCardId !== primary.cardId) {
				throw synthesisError("PRW_HUNK_PLACEMENT_CONFLICT", "A secondary hunk reference points at a different primary card than the resolved owner.", {
					hunkId,
					path: ref.path,
					primaryCardId: primary.cardId,
					suppliedPrimaryCardId: ref.primaryCardId,
				});
			}
		}
	}

	for (const [hunkId, hunkRefs] of skipByHunk) {
		if ((primaryByHunk.get(hunkId)?.length ?? 0) > 0) {
			throw synthesisError("PRW_HUNK_PLACEMENT_CONFLICT", "A hunk cannot be both skipped and primary-reviewed.", {
				hunkId,
				skipCards: uniqueCardRefs(hunkRefs),
				primaryCards: uniqueCardRefs(primaryByHunk.get(hunkId) ?? []),
			});
		}
	}

	const receiptsByHunk = indexReadReceipts(receipts);
	const records = new Map<string, NonNullable<PrWalkthroughCoverageSummary["records"]>[number]>();
	const placementsByCard = new Map<string, PrWalkthroughHunkPlacement[]>();
	const completionSweepPlacements: PrWalkthroughHunkPlacement[] = [];
	const majorRemaining: NonNullable<PrWalkthroughCoverageSummary["majorRemaining"]> = [];

	for (const hunk of allHunks) {
		const primary = primaryByHunk.get(hunk.hunkId)?.[0];
		const secondaryRefs = secondaryByHunk.get(hunk.hunkId) ?? [];
		const skip = skipByHunk.get(hunk.hunkId)?.[0];
		const readReceiptIds = receiptsByHunk.get(hunk.hunkId) ?? [];
		const primaryState = primary ? (readReceiptIds.length > 0 ? "primary-reviewed" : "unread") : skip ? "skipped" : "completion-sweep-remaining";
		const record: NonNullable<PrWalkthroughCoverageSummary["records"]>[number] = {
			hunkId: hunk.hunkId,
			filePath: hunk.filePath,
			hunkHeader: hunk.hunkHeader,
			primaryState,
			state: primaryState,
			...(primary ? { primaryCardId: primary.cardId } : {}),
			secondaryCardIds: uniqueStrings(secondaryRefs.map(ref => ref.cardId)),
			repeatedReferenceCount: secondaryRefs.length,
			...(skip?.skipReason ? { skippedReason: skip.skipReason } : {}),
			readReceiptIds,
			generated: hunk.generated,
			binary: hunk.binary,
			truncated: hunk.truncated,
			changedLines: hunk.changedLines,
			fileCategory: hunk.fileCategory,
		};
		records.set(hunk.hunkId, record);
		if (!primary && !skip && isMajorRemaining(hunk)) {
			majorRemaining.push({ hunkId: hunk.hunkId, filePath: hunk.filePath, hunkHeader: hunk.hunkHeader, changedLines: hunk.changedLines, fileCategory: hunk.fileCategory });
		}
	}

	for (const ref of refs) {
		const primary = primaryByHunk.get(ref.hunk.hunkId)?.[0];
		const record = records.get(ref.hunk.hunkId);
		const placement = placementForReference(ref, primary, record?.readReceiptIds ?? []);
		placementsByCard.set(ref.cardId, [...(placementsByCard.get(ref.cardId) ?? []), placement]);
	}

	for (const hunk of allHunks) {
		const record = records.get(hunk.hunkId);
		if (record?.primaryState !== "completion-sweep-remaining") continue;
		completionSweepPlacements.push({
			hunkId: hunk.hunkId,
			blockId: hunk.blockId,
			filePath: hunk.filePath,
			hunkHeader: hunk.hunkHeader,
			placement: "completion_sweep",
			defaultExpanded: false,
			readReceiptIds: record.readReceiptIds,
		});
	}

	const recordList = [...records.values()];
	const summary: PrWalkthroughCoverageSummary = {
		totalHunks: recordList.length,
		primaryReviewed: recordList.filter(record => record.primaryState === "primary-reviewed").length,
		unread: recordList.filter(record => record.primaryState === "unread").length,
		skipped: recordList.filter(record => record.primaryState === "skipped").length,
		completionSweepRemaining: recordList.filter(record => record.primaryState === "completion-sweep-remaining").length,
		repeatedSecondaryReferences: recordList.reduce((sum, record) => sum + record.repeatedReferenceCount, 0),
		uniqueSecondaryHunks: recordList.filter(record => record.secondaryCardIds.length > 0).length,
		records: recordList,
		majorRemaining,
	};

	return { placementsByCard, completionSweepPlacements, records, summary, majorRemaining };
}

function placementForReference(ref: ResolvedHunkReference, primary: ResolvedHunkReference | undefined, readReceiptIds: string[]): PrWalkthroughHunkPlacement {
	return {
		hunkId: ref.hunk.hunkId,
		blockId: ref.hunk.blockId,
		filePath: ref.hunk.filePath,
		hunkHeader: ref.hunk.hunkHeader,
		placement: ref.placement,
		defaultExpanded: ref.placement === "primary",
		...(primary && ref.placement === "secondary" ? { primaryCardId: primary.cardId, primaryCardTitle: primary.cardTitle } : {}),
		...(ref.whyRelevant ? { whyRelevant: ref.whyRelevant } : {}),
		...(ref.skipReason ? { skipReason: ref.skipReason } : {}),
		readReceiptIds,
	};
}

function buildDesignDecisionCard(plan: HunkCardPlan, placement: HunkCoverageComputation): PrWalkthroughCard {
	const decision = plan.decision;
	if (!decision) throw new Error("Missing design decision plan data.");
	const hunkPlacements = placement.placementsByCard.get(plan.cardId) ?? [];
	return {
		id: plan.cardId,
		phaseId: "design",
		title: decision.title,
		navLabel: decision.nav_label ?? deriveNavLabel(decision.title),
		summary: decision.explanation,
		rationale: compactJoin([
			`Chosen approach: ${decision.chosen_approach}`,
			formatAlternatives(decision.alternatives_considered),
			formatList("Trade-offs", decision.tradeoffs),
		]),
		diffBlocks: hunkSlicedDiffBlocks(hunkPlacements.filter(item => item.placement !== "skip"), plan.refs),
		hunkPlacements,
		coverage: cardCoverageSummary(hunkPlacements, placement.records),
		cardSuggestions: compactArray([...decision.suggested_reviewer_concerns, ...plan.refs.map(ref => ref.whyRelevant)]),
	};
}

function buildReviewChunkCard(plan: HunkCardPlan, mapper: DiffReferenceMapper, placement: HunkCoverageComputation, warnings: WalkthroughWarning[]): PrWalkthroughCard {
	const chunk = plan.chunk;
	if (!chunk) throw new Error("Missing review chunk plan data.");
	const hunkPlacements = placement.placementsByCard.get(plan.cardId) ?? [];
	const commentMapping = mapSuggestedConcerns(chunk, plan.cardId, mapper, warnings);
	const narrative = chunk.narrative
		? mapAuthoredNarrative(chunk, plan, mapper)
		: synthesizeLegacyNarrative(chunk, plan.refs.filter(ref => ref.placement !== "skip").map(ref => ref.hunk.hunkId), commentMapping.notes);
	return {
		id: plan.cardId,
		phaseId: chunk.phase,
		title: chunk.title,
		navLabel: chunk.nav_label ?? deriveNavLabel(chunk.title),
		summary: chunk.explanation,
		rationale: compactJoin([`Reviewer goal: ${chunk.reviewer_goal}`, formatList("Positive notes", chunk.positive_notes)]),
		diffBlocks: hunkSlicedDiffBlocks(hunkPlacements.filter(item => item.placement !== "skip"), plan.refs),
		...(commentMapping.comments.length > 0 ? { suggestedComments: commentMapping.comments } : {}),
		cardSuggestions: compactArray([...plan.refs.map(ref => ref.whyRelevant), ...commentMapping.notes]),
		narrative,
		hunkPlacements,
		coverage: cardCoverageSummary(hunkPlacements, placement.records),
	};
}

function mapAuthoredNarrative(chunk: PrWalkthroughYamlReviewChunk, plan: HunkCardPlan, mapper: DiffReferenceMapper): PrWalkthroughNarrativeBlock[] {
	const blocks: PrWalkthroughNarrativeBlock[] = [];
	for (const [index, entry] of (chunk.narrative ?? []).entries()) {
		const path = `walkthrough.review_chunks[id=${chunk.id}].narrative[${index}]`;
		switch (entry.type) {
			case "text":
				blocks.push({ type: "text", id: entry.id, body: entry.body });
				break;
			case "diff": {
				const hunkIds = plan.refs.filter(ref => ref.narrativeEntryId === entry.id && ref.placement !== "skip").map(ref => ref.hunk.hunkId);
				blocks.push({ type: "diff", id: entry.id, hunkIds: uniqueStrings(hunkIds) });
				break;
			}
			case "note": {
				const anchor = entry.anchor ? resolveNarrativeAnchor(mapper, entry.anchor, `${path}.anchor`, plan.cardId) : undefined;
				blocks.push({ type: "note", id: entry.id, body: entry.body, ...(anchor ? { anchor } : {}) });
				break;
			}
			case "suggested_comment": {
				const anchor = entry.anchor ? resolveNarrativeAnchor(mapper, entry.anchor, `${path}.anchor`, plan.cardId) : undefined;
				if (entry.intent === "inline" && !anchor) {
					throw synthesisError("PRW_HUNK_REF_UNRESOLVED", "Inline narrative suggested comment could not resolve its anchor.", { cardId: plan.cardId, path: `${path}.anchor` });
				}
				blocks.push({ type: "suggested_comment", id: entry.id, severity: entry.severity, intent: anchor ? entry.intent : "summary", body: entry.body, ...(anchor ? { anchor } : {}) });
				break;
			}
			case "checklist":
				blocks.push({ type: "checklist", id: entry.id, items: entry.items });
				break;
		}
	}
	// Top-level relevant_hunks refs that the author did not also place in a
	// narrative[].diff entry are still counted in coverage and appear in the flat
	// diffBlocks. Append a deterministic diff entry so narrative-first rendering does
	// not silently hide them.
	const narrativeHunkIds = new Set(blocks.flatMap(block => (block.type === "diff" ? block.hunkIds : [])));
	const orphanHunkIds = uniqueStrings(
		plan.refs
			.filter(ref => ref.placement !== "skip" && !narrativeHunkIds.has(ref.hunk.hunkId))
			.map(ref => ref.hunk.hunkId),
	);
	if (orphanHunkIds.length > 0) {
		const existingIds = new Set(blocks.map(block => block.id));
		let entryId = "additional-referenced-hunks";
		for (let suffix = 2; existingIds.has(entryId); suffix += 1) entryId = `additional-referenced-hunks-${suffix}`;
		blocks.push({ type: "diff", id: entryId, hunkIds: orphanHunkIds });
	}
	return blocks;
}

function synthesizeLegacyNarrative(chunk: PrWalkthroughYamlReviewChunk, hunkIds: string[], notes: string[]): PrWalkthroughNarrativeBlock[] {
	const narrative: PrWalkthroughNarrativeBlock[] = [
		{ type: "text", id: "summary", body: chunk.explanation },
		{ type: "text", id: "reviewer-goal", body: `Reviewer goal: ${chunk.reviewer_goal}` },
	];
	if (hunkIds.length > 0) narrative.push({ type: "diff", id: "referenced-hunks", hunkIds: uniqueStrings(hunkIds) });
	for (const [index, note] of notes.entries()) narrative.push({ type: "suggested_comment", id: `legacy-suggestion-${index + 1}`, severity: "question", intent: "summary", body: note });
	if (chunk.positive_notes.length > 0) narrative.push({ type: "checklist", id: "positive-notes", items: chunk.positive_notes });
	return narrative;
}

function resolveNarrativeAnchor(mapper: DiffReferenceMapper, anchor: PrWalkthroughYamlAnchor, path: string, cardId: string): { hunkId?: string; lineId?: string } {
	const hunk = mapper.resolveHunk(anchor, path, cardId);
	const line = selectLine(hunk.hunk, anchor);
	return { hunkId: hunk.hunkId, ...(line ? { lineId: line.id } : {}) };
}

function hunkSlicedDiffBlocks(placements: PrWalkthroughHunkPlacement[], refs: ResolvedHunkReference[]): PrWalkthroughDiffBlock[] {
	const refByHunk = new Map(refs.map(ref => [ref.hunk.hunkId, ref]));
	const byBlock = new Map<string, { source: PrWalkthroughDiffBlock; placements: PrWalkthroughHunkPlacement[] }>();
	for (const placement of placements) {
		const ref = refByHunk.get(placement.hunkId);
		if (!ref || placement.placement === "skip") continue;
		const entry = byBlock.get(ref.hunk.blockId) ?? { source: ref.hunk.block, placements: [] };
		entry.placements.push(placement);
		byBlock.set(ref.hunk.blockId, entry);
	}
	return [...byBlock.values()].map(({ source, placements: blockPlacements }) => ({
		...source,
		hunks: blockPlacements.map(placement => {
			const ref = refByHunk.get(placement.hunkId);
			const hunk = ref?.hunk.hunk;
			return {
				...(hunk ?? { id: placement.hunkId, header: placement.hunkHeader, lines: [] }),
				id: placement.hunkId,
				placement: placement.placement,
				defaultExpanded: placement.defaultExpanded,
				...(placement.primaryCardId ? { primaryCardId: placement.primaryCardId } : {}),
				...(placement.primaryCardTitle ? { primaryCardTitle: placement.primaryCardTitle } : {}),
				...(placement.whyRelevant ? { whyRelevant: placement.whyRelevant } : {}),
				...(placement.skipReason ? { skipReason: placement.skipReason } : {}),
				readReceiptIds: placement.readReceiptIds,
			};
		}),
		hunkPlacements: blockPlacements,
	}));
}

function hunkSlicedDiffBlocksFromPlacements(placements: PrWalkthroughHunkPlacement[], mapper: DiffReferenceMapper): PrWalkthroughDiffBlock[] {
	const refs: ResolvedHunkReference[] = [];
	for (const placement of placements) {
		const hunk = mapper.hunkById(placement.hunkId);
		if (!hunk) continue;
		refs.push({ cardId: "audit-checklist", cardTitle: "Audit and review checklist", phaseId: "audit", path: "completion_sweep", hunk, placement: "primary" });
	}
	return hunkSlicedDiffBlocks(placements, refs);
}

function cardCoverageSummary(placements: PrWalkthroughHunkPlacement[], records: Map<string, NonNullable<PrWalkthroughCoverageSummary["records"]>[number]>): PrWalkthroughCardCoverageSummary {
	const hunkIds = uniqueStrings(placements.map(item => item.hunkId));
	const cardRecords = hunkIds.map(id => records.get(id)).filter((record): record is NonNullable<PrWalkthroughCoverageSummary["records"]>[number] => Boolean(record));
	return {
		totalHunks: cardRecords.length,
		primaryReviewed: cardRecords.filter(record => record.primaryState === "primary-reviewed").length,
		unread: cardRecords.filter(record => record.primaryState === "unread").length,
		skipped: cardRecords.filter(record => record.primaryState === "skipped").length,
		completionSweepRemaining: cardRecords.filter(record => record.primaryState === "completion-sweep-remaining").length,
		repeatedSecondaryReferences: cardRecords.reduce((sum, record) => sum + record.repeatedReferenceCount, 0),
		hunkIds,
	};
}

function indexReadReceipts(receipts: PrWalkthroughReadReceipt[]): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const receipt of receipts) {
		if (receipt.mode && receipt.mode !== "file") continue;
		for (const hunkId of receipt.hunkIds ?? []) {
			out.set(hunkId, uniqueStrings([...(out.get(hunkId) ?? []), receipt.id]));
		}
	}
	return out;
}

function uniqueCardRefs(refs: ResolvedHunkReference[]): Array<{ cardId: string; title: string }> {
	const seen = new Set<string>();
	const out: Array<{ cardId: string; title: string }> = [];
	for (const ref of refs) {
		if (seen.has(ref.cardId)) continue;
		seen.add(ref.cardId);
		out.push({ cardId: ref.cardId, title: ref.cardTitle });
	}
	return out;
}

function isMajorRemaining(hunk: IndexedHunk): boolean {
	return !hunk.generated && !hunk.binary && !hunk.sourceTruncated && hunk.changedLines >= 8 && !["test", "docs", "lockfile", "asset", "vendor", "generated"].includes(hunk.fileCategory);
}

function synthesisError(code: PrWalkthroughSynthesisErrorCode, message: string, details?: Record<string, unknown>): PrWalkthroughSynthesisError {
	const error = new Error(message) as PrWalkthroughSynthesisError;
	error.code = code;
	error.retryable = true;
	if (details) error.details = details;
	return error;
}

function parseDocument(root: Record<string, unknown>, errors: PrWalkthroughValidationError[]): PrWalkthroughYamlDocument | null {
	const schemaVersion = requiredNumber(root, "schema_version", errors, "$", { integer: true });
	if (schemaVersion !== undefined && schemaVersion !== 1) addError(errors, "$.schema_version", "Unsupported schema_version. Expected 1.");
	const prRoot = requiredRecord(root, "pr", errors, "$.");
	const walkthroughRoot = requiredRecord(root, "walkthrough", errors, "$.");
	if (!prRoot || !walkthroughRoot || schemaVersion !== 1) return null;

	const pr = parsePr(prRoot, errors);
	const walkthrough = parseWalkthrough(walkthroughRoot, errors);
	if (!pr || !walkthrough) return null;
	return { schema_version: 1, pr, walkthrough };
}

function parsePr(root: Record<string, unknown>, errors: PrWalkthroughValidationError[]): PrWalkthroughYamlPr | null {
	const provider = requiredEnum(root, "provider", PROVIDERS, errors, "$.pr.") as PrWalkthroughYamlPr["provider"] | undefined;
	const owner = requiredString(root, "owner", errors, "$.pr.");
	const repo = requiredString(root, "repo", errors, "$.pr.");
	const number = requiredNumber(root, "number", errors, "$.pr.", { integer: true, min: 1 });
	const title = requiredString(root, "title", errors, "$.pr.");
	const url = requiredString(root, "url", errors, "$.pr.");
	const baseSha = requiredString(root, "base_sha", errors, "$.pr.");
	const headSha = requiredString(root, "head_sha", errors, "$.pr.");
	if (baseSha && !SHA_RE.test(baseSha)) addError(errors, "$.pr.base_sha", "Must be a 7-40 character hexadecimal SHA.");
	if (headSha && !SHA_RE.test(headSha)) addError(errors, "$.pr.head_sha", "Must be a 7-40 character hexadecimal SHA.");
	const originalDescriptionRoot = requiredRecord(root, "original_description", errors, "$.pr.");
	const statsRoot = requiredRecord(root, "stats", errors, "$.pr.");
	if (!provider || !owner || !repo || number === undefined || !title || !url || !baseSha || !headSha || !originalDescriptionRoot || !statsRoot) return null;

	const body = requiredString(originalDescriptionRoot, "body", errors, "$.pr.original_description.", { allowEmpty: true });
	const source = requiredEnum(originalDescriptionRoot, "source", DESCRIPTION_SOURCES, errors, "$.pr.original_description.") as PrWalkthroughYamlPr["original_description"]["source"] | undefined;
	const fetchedAt = requiredString(originalDescriptionRoot, "fetched_at", errors, "$.pr.original_description.");
	const filesChanged = requiredNumber(statsRoot, "files_changed", errors, "$.pr.stats.", { integer: true, min: 0 });
	const additions = requiredNumber(statsRoot, "additions", errors, "$.pr.stats.", { integer: true, min: 0 });
	const deletions = requiredNumber(statsRoot, "deletions", errors, "$.pr.stats.", { integer: true, min: 0 });
	if (body === undefined || !source || !fetchedAt || filesChanged === undefined || additions === undefined || deletions === undefined) return null;
	return {
		provider,
		owner,
		repo,
		number,
		title,
		url,
		base_sha: baseSha,
		head_sha: headSha,
		original_description: { body, source, fetched_at: fetchedAt },
		stats: { files_changed: filesChanged, additions, deletions },
	};
}

function parseWalkthrough(root: Record<string, unknown>, errors: PrWalkthroughValidationError[]): PrWalkthroughYamlWalkthrough | null {
	const contextRoot = requiredRecord(root, "context", errors, "$.walkthrough.");
	const assessmentRoot = requiredRecord(root, "merge_assessment", errors, "$.walkthrough.");
	const designRoot = requiredArray(root, "design_decisions", errors, "$.walkthrough.");
	const chunksRoot = requiredArray(root, "review_chunks", errors, "$.walkthrough.");
	const omissionsRoot = requiredArray(root, "omissions_and_followups", errors, "$.walkthrough.");
	const auditRoot = requiredRecord(root, "audit", errors, "$.walkthrough.");
	const displayRoot = requiredRecord(root, "display", errors, "$.walkthrough.");
	if (!contextRoot || !assessmentRoot || !designRoot || !chunksRoot || !omissionsRoot || !auditRoot || !displayRoot) return null;

	const context = parseContext(contextRoot, errors);
	const mergeAssessment = parseMergeAssessment(assessmentRoot, errors);
	const designDecisions = parseDesignDecisions(designRoot, errors);
	const reviewChunks = parseReviewChunks(chunksRoot, errors);
	const omissions = parseOmissions(omissionsRoot, errors);
	const audit = parseAudit(auditRoot, errors);
	const display = parseDisplay(displayRoot, errors);
	if (!context || !mergeAssessment || !designDecisions || !reviewChunks || !omissions || !audit || !display) return null;
	return {
		context,
		merge_assessment: mergeAssessment,
		design_decisions: designDecisions,
		review_chunks: reviewChunks,
		omissions_and_followups: omissions,
		audit,
		display,
	};
}

function parseContext(root: Record<string, unknown>, errors: PrWalkthroughValidationError[]): PrWalkthroughYamlWalkthrough["context"] | null {
	const path = "$.walkthrough.context.";
	const diffBreakdown = root.diff_breakdown === undefined ? undefined : parseDiffBreakdown(requiredRecord(root, "diff_breakdown", errors, path), errors, `${path}diff_breakdown.`);
	const context = {
		why_created: requiredString(root, "why_created", errors, path),
		problem_solved: requiredString(root, "problem_solved", errors, path),
		why_worth_merging: requiredString(root, "why_worth_merging", errors, path),
		merge_concerns: requiredString(root, "merge_concerns", errors, path),
		author_intent: requiredString(root, "author_intent", errors, path),
		reviewer_map: requiredString(root, "reviewer_map", errors, path),
		...(diffBreakdown ? { diff_breakdown: diffBreakdown } : {}),
	};
	return allPresent(context) && diffBreakdown !== null ? context as PrWalkthroughYamlWalkthrough["context"] : null;
}

function parseDiffBreakdown(root: Record<string, unknown> | undefined, errors: PrWalkthroughValidationError[], path: string): PrWalkthroughYamlDiffBreakdown | null {
	if (!root) return null;
	const out = {
		prod_executable_code: parseDiffBreakdownCounts(root, "prod_executable_code", errors, path),
		test_code: parseDiffBreakdownCounts(root, "test_code", errors, path),
		code_and_comments: parseDiffBreakdownCounts(root, "code_and_comments", errors, path),
		docs_only: parseDiffBreakdownCounts(root, "docs_only", errors, path),
	};
	return allPresent(out) ? out as PrWalkthroughYamlDiffBreakdown : null;
}

function parseDiffBreakdownCounts(root: Record<string, unknown>, key: keyof PrWalkthroughYamlDiffBreakdown, errors: PrWalkthroughValidationError[], prefix: string): PrWalkthroughYamlDiffBreakdownCounts | undefined {
	const value = requiredRecord(root, key, errors, prefix);
	if (!value) return undefined;
	const path = `${prefix}${key}.`;
	const files = optionalNumber(value, "files", errors, path);
	const additions = optionalNumber(value, "additions", errors, path);
	const deletions = optionalNumber(value, "deletions", errors, path);
	const note = optionalString(value, "note", errors, path);
	return {
		...(files !== undefined ? { files } : {}),
		...(additions !== undefined ? { additions } : {}),
		...(deletions !== undefined ? { deletions } : {}),
		...(note ? { note } : {}),
	};
}

function parseMergeAssessment(root: Record<string, unknown>, errors: PrWalkthroughValidationError[]): PrWalkthroughYamlWalkthrough["merge_assessment"] | null {
	const path = "$.walkthrough.merge_assessment.";
	const recommendation = requiredEnum(root, "recommendation", RECOMMENDATIONS, errors, path) as PrWalkthroughYamlWalkthrough["merge_assessment"]["recommendation"] | undefined;
	const confidence = requiredEnum(root, "confidence", CONFIDENCES, errors, path) as PrWalkthroughYamlWalkthrough["merge_assessment"]["confidence"] | undefined;
	const summary = requiredString(root, "summary", errors, path);
	const blockingConcerns = requiredStringArray(root, "blocking_concerns", errors, path);
	const nonBlockingConcerns = requiredStringArray(root, "non_blocking_concerns", errors, path);
	if (!recommendation || !confidence || !summary || !blockingConcerns || !nonBlockingConcerns) return null;
	return { recommendation, confidence, summary, blocking_concerns: blockingConcerns, non_blocking_concerns: nonBlockingConcerns };
}

function parseDesignDecisions(items: unknown[], errors: PrWalkthroughValidationError[]): PrWalkthroughYamlDesignDecision[] | null {
	const out: PrWalkthroughYamlDesignDecision[] = [];
	items.forEach((item, index) => {
		const path = `$.walkthrough.design_decisions[${index}]`;
		if (!isRecord(item) || Array.isArray(item)) {
			addError(errors, path, "Expected an object.");
			return;
		}
		const id = requiredStableId(item, "id", errors, `${path}.`);
		const title = requiredString(item, "title", errors, `${path}.`);
		const navLabel = parseNavLabel(item, errors, `${path}.`);
		const explanation = requiredString(item, "explanation", errors, `${path}.`);
		const chosenApproach = requiredString(item, "chosen_approach", errors, `${path}.`);
		const alternatives = parseAlternatives(requiredArray(item, "alternatives_considered", errors, `${path}.`) ?? [], errors, `${path}.alternatives_considered`);
		const tradeoffs = requiredStringArray(item, "tradeoffs", errors, `${path}.`);
		const concerns = requiredStringArray(item, "suggested_reviewer_concerns", errors, `${path}.`);
		const hunks = parseRelevantHunks(requiredArray(item, "relevant_hunks", errors, `${path}.`) ?? [], errors, `${path}.relevant_hunks`);
		if (id && title && explanation && chosenApproach && alternatives && tradeoffs && concerns && hunks) {
			out.push({ id, title, ...(navLabel !== undefined ? { nav_label: navLabel } : {}), explanation, chosen_approach: chosenApproach, alternatives_considered: alternatives, tradeoffs, suggested_reviewer_concerns: concerns, relevant_hunks: hunks });
		}
	});
	validateUniqueIds(out, "$.walkthrough.design_decisions", errors);
	return errorsForPrefix(errors, "$.walkthrough.design_decisions") ? null : out;
}

function parseReviewChunks(items: unknown[], errors: PrWalkthroughValidationError[]): PrWalkthroughYamlReviewChunk[] | null {
	const out: PrWalkthroughYamlReviewChunk[] = [];
	items.forEach((item, index) => {
		const path = `$.walkthrough.review_chunks[${index}]`;
		if (!isRecord(item) || Array.isArray(item)) {
			addError(errors, path, "Expected an object.");
			return;
		}
		const id = requiredStableId(item, "id", errors, `${path}.`);
		const phase = requiredEnum(item, "phase", REVIEW_PHASES, errors, `${path}.`) as PrWalkthroughYamlReviewChunk["phase"] | undefined;
		const title = requiredString(item, "title", errors, `${path}.`);
		const navLabel = parseNavLabel(item, errors, `${path}.`);
		const reviewerGoal = requiredString(item, "reviewer_goal", errors, `${path}.`);
		const explanation = requiredString(item, "explanation", errors, `${path}.`);
		const files = requiredStringArray(item, "files", errors, `${path}.`);
		const narrative = item.narrative === undefined ? undefined : parseNarrative(requiredArray(item, "narrative", errors, `${path}.`) ?? [], errors, `${path}.narrative`);
		const hunkItems = item.relevant_hunks === undefined && narrative ? [] : requiredArray(item, "relevant_hunks", errors, `${path}.`) ?? [];
		const hunks = parseRelevantHunks(hunkItems, errors, `${path}.relevant_hunks`);
		const suggestedConcerns = parseSuggestedConcerns(requiredArray(item, "suggested_concerns", errors, `${path}.`) ?? [], errors, `${path}.suggested_concerns`);
		const positiveNotes = requiredStringArray(item, "positive_notes", errors, `${path}.`);
		if (id && phase && title && reviewerGoal && explanation && files && hunks && suggestedConcerns && positiveNotes && narrative !== null) {
			out.push({ id, phase, title, ...(navLabel !== undefined ? { nav_label: navLabel } : {}), reviewer_goal: reviewerGoal, explanation, files, relevant_hunks: hunks, ...(narrative ? { narrative } : {}), suggested_concerns: suggestedConcerns, positive_notes: positiveNotes });
		}
	});
	validateUniqueIds(out, "$.walkthrough.review_chunks", errors);
	return errorsForPrefix(errors, "$.walkthrough.review_chunks") ? null : out;
}

function parseOmissions(items: unknown[], errors: PrWalkthroughValidationError[]): PrWalkthroughYamlOmission[] | null {
	const out: PrWalkthroughYamlOmission[] = [];
	items.forEach((item, index) => {
		const path = `$.walkthrough.omissions_and_followups[${index}]`;
		if (!isRecord(item) || Array.isArray(item)) {
			addError(errors, path, "Expected an object.");
			return;
		}
		const category = requiredEnum(item, "category", OMISSION_CATEGORIES, errors, `${path}.`) as PrWalkthroughYamlOmission["category"] | undefined;
		const expectedArtifact = requiredString(item, "expected_artifact", errors, `${path}.`);
		const evidenceChecked = requiredString(item, "evidence_checked", errors, `${path}.`);
		const concern = requiredString(item, "concern", errors, `${path}.`);
		const suggestedComment = requiredString(item, "suggested_comment", errors, `${path}.`);
		const severity = requiredEnum(item, "severity", OMISSION_SEVERITIES, errors, `${path}.`) as PrWalkthroughYamlOmission["severity"] | undefined;
		if (category && expectedArtifact && evidenceChecked && concern && suggestedComment && severity) out.push({ category, expected_artifact: expectedArtifact, evidence_checked: evidenceChecked, concern, suggested_comment: suggestedComment, severity });
	});
	return errorsForPrefix(errors, "$.walkthrough.omissions_and_followups") ? null : out;
}

function parseAudit(root: Record<string, unknown>, errors: PrWalkthroughValidationError[]): PrWalkthroughYamlWalkthrough["audit"] | null {
	const path = "$.walkthrough.audit.";
	const remaining = requiredStringArray(root, "remaining_changed_areas", errors, path);
	const lowSignal = requiredStringArray(root, "low_signal_or_mechanical_changes", errors, path);
	const generated = requiredStringArray(root, "generated_or_binary_files", errors, path);
	const checklist = requiredStringArray(root, "reviewer_checklist", errors, path);
	if (!remaining || !lowSignal || !generated || !checklist) return null;
	return { remaining_changed_areas: remaining, low_signal_or_mechanical_changes: lowSignal, generated_or_binary_files: generated, reviewer_checklist: checklist };
}

function parseDisplay(root: Record<string, unknown>, errors: PrWalkthroughValidationError[]): PrWalkthroughYamlWalkthrough["display"] | null {
	const path = "$.walkthrough.display.";
	const phaseOrder = requiredEnumArray(root, "phase_order", PHASES, errors, path) as PrWalkthroughPhaseId[] | undefined;
	const chunkOrder = requiredStringArray(root, "chunk_order", errors, path);
	if (!phaseOrder || !chunkOrder) return null;
	return { phase_order: phaseOrder, chunk_order: chunkOrder };
}

function parseAlternatives(items: unknown[], errors: PrWalkthroughValidationError[], path: string): Array<{ option: string; pros: string[]; cons: string[] }> | null {
	const out: Array<{ option: string; pros: string[]; cons: string[] }> = [];
	items.forEach((item, index) => {
		const itemPath = `${path}[${index}]`;
		if (!isRecord(item) || Array.isArray(item)) {
			addError(errors, itemPath, "Expected an object.");
			return;
		}
		const option = requiredString(item, "option", errors, `${itemPath}.`);
		const pros = requiredStringArray(item, "pros", errors, `${itemPath}.`);
		const cons = requiredStringArray(item, "cons", errors, `${itemPath}.`);
		if (option && pros && cons) out.push({ option, pros, cons });
	});
	return errorsForPrefix(errors, path) ? null : out;
}

function parseRelevantHunks(items: unknown[], errors: PrWalkthroughValidationError[], path: string): PrWalkthroughYamlRelevantHunk[] | null {
	const out: PrWalkthroughYamlRelevantHunk[] = [];
	items.forEach((item, index) => {
		const itemPath = `${path}[${index}]`;
		if (!isRecord(item) || Array.isArray(item)) {
			addError(errors, itemPath, "Expected an object.");
			return;
		}
		const reference = parseHunkReference(item, errors, itemPath, { requireWhy: true });
		if (reference?.why_relevant) out.push(reference as PrWalkthroughYamlRelevantHunk);
	});
	return errorsForPrefix(errors, path) ? null : out;
}

function parseHunkReference(root: Record<string, unknown>, errors: PrWalkthroughValidationError[], path: string, options: { requireWhy?: boolean } = {}): PrWalkthroughYamlHunkReference | null {
	const hunkId = optionalString(root, "hunk_id", errors, `${path}.`);
	const file = optionalString(root, "file", errors, `${path}.`);
	const hunkHeader = optionalString(root, "hunk_header", errors, `${path}.`);
	const hunkIndex = optionalNumber(root, "hunk_index", errors, `${path}.`, { integer: true, min: 0 });
	const oldStart = optionalNumber(root, "old_start", errors, `${path}.`, { integer: true, min: 0 });
	const oldLines = optionalNumber(root, "old_lines", errors, `${path}.`, { integer: true, min: 0 });
	const newStart = optionalNumber(root, "new_start", errors, `${path}.`, { integer: true, min: 0 });
	const newLines = optionalNumber(root, "new_lines", errors, `${path}.`, { integer: true, min: 0 });
	const lineRange = optionalString(root, "line_range", errors, `${path}.`);
	const placement = root.placement === undefined ? undefined : requiredEnum(root, "placement", HUNK_PLACEMENTS, errors, `${path}.`) as PrWalkthroughYamlHunkPlacement | undefined;
	const whyRelevant = options.requireWhy ? requiredString(root, "why_relevant", errors, `${path}.`) : optionalString(root, "why_relevant", errors, `${path}.`);
	const primaryCardId = optionalString(root, "primary_card_id", errors, `${path}.`);
	const skipReason = root.skip_reason === undefined ? undefined : requiredEnum(root, "skip_reason", HUNK_SKIP_REASONS, errors, `${path}.`);
	// A `placement: skip` reference identifies a file/area to exclude from review.
	// Hunkless changed blocks (binary files, mode-only changes) expose no
	// header/index/coordinates, so a file-only skip is the only way to name them.
	// The resolver stays strict: a file-only reference that matches more than one
	// hunk still fails closed with PRW_HUNK_REF_UNRESOLVED.
	const fileOnlySkip = placement === "skip" && Boolean(file);
	if (!hunkId && !(file && hunkHeader) && !(file && (hunkIndex !== undefined || oldStart !== undefined || newStart !== undefined)) && !fileOnlySkip) {
		addError(errors, path, "Expected hunk_id, a file plus hunk_header/hunk_index/coordinates, or a file for placement: skip.");
	}
	if (primaryCardId && !STABLE_ID_RE.test(primaryCardId)) addError(errors, `${path}.primary_card_id`, "Expected a stable card id.");
	if (errorsForPrefix(errors, path)) return null;
	return {
		...(hunkId ? { hunk_id: hunkId } : {}),
		...(file ? { file } : {}),
		...(hunkIndex !== undefined ? { hunk_index: hunkIndex } : {}),
		...(hunkHeader ? { hunk_header: hunkHeader } : {}),
		...(oldStart !== undefined ? { old_start: oldStart } : {}),
		...(oldLines !== undefined ? { old_lines: oldLines } : {}),
		...(newStart !== undefined ? { new_start: newStart } : {}),
		...(newLines !== undefined ? { new_lines: newLines } : {}),
		...(lineRange ? { line_range: lineRange } : {}),
		...(placement ? { placement } : {}),
		...(whyRelevant ? { why_relevant: whyRelevant } : {}),
		...(primaryCardId ? { primary_card_id: primaryCardId } : {}),
		...(skipReason ? { skip_reason: skipReason } : {}),
	};
}

function parseNarrative(items: unknown[], errors: PrWalkthroughValidationError[], path: string): PrWalkthroughYamlNarrativeEntry[] | null {
	const out: PrWalkthroughYamlNarrativeEntry[] = [];
	const seen = new Map<string, number>();
	items.forEach((item, index) => {
		const itemPath = `${path}[${index}]`;
		if (!isRecord(item) || Array.isArray(item)) {
			addError(errors, itemPath, "Expected an object.");
			return;
		}
		const id = requiredStableId(item, "id", errors, `${itemPath}.`);
		const type = requiredEnum(item, "type", NARRATIVE_TYPES, errors, `${itemPath}.`) as PrWalkthroughYamlNarrativeEntry["type"] | undefined;
		if (id) {
			const previous = seen.get(id);
			if (previous !== undefined) addError(errors, `${itemPath}.id`, `Duplicate narrative entry id ${id}; first used at ${path}[${previous}].id.`);
			else seen.set(id, index);
		}
		if (!id || !type) return;
		switch (type) {
			case "text": {
				const body = requiredString(item, "body", errors, `${itemPath}.`);
				if (body) out.push({ id, type, body });
				break;
			}
			case "diff": {
				const hunksRoot = requiredArray(item, "hunks", errors, `${itemPath}.`) ?? [];
				const hunks = parseNarrativeHunkReferences(hunksRoot, errors, `${itemPath}.hunks`);
				if (hunks) out.push({ id, type, hunks });
				break;
			}
			case "note": {
				const body = requiredString(item, "body", errors, `${itemPath}.`);
				const anchor = item.anchor === undefined ? undefined : parseAnchor(requiredRecord(item, "anchor", errors, `${itemPath}.`), errors, `${itemPath}.anchor`);
				if (body && anchor !== null) out.push({ id, type, body, ...(anchor ? { anchor } : {}) });
				break;
			}
			case "suggested_comment": {
				const severity = requiredEnum(item, "severity", CONCERN_SEVERITIES, errors, `${itemPath}.`) as "blocking" | "non_blocking" | "question" | "nit" | undefined;
				const intent = requiredEnum(item, "intent", COMMENT_INTENTS, errors, `${itemPath}.`) as "inline" | "summary" | undefined;
				const body = requiredString(item, "body", errors, `${itemPath}.`);
				const anchor = item.anchor === undefined ? undefined : parseAnchor(requiredRecord(item, "anchor", errors, `${itemPath}.`), errors, `${itemPath}.anchor`);
				if (intent === "inline" && !anchor) addError(errors, `${itemPath}.anchor`, "Inline suggested comments require an anchor.");
				if (severity && intent && body && anchor !== null) out.push({ id, type, severity, intent, body, ...(anchor ? { anchor } : {}) });
				break;
			}
			case "checklist": {
				const itemsValue = requiredStringArray(item, "items", errors, `${itemPath}.`);
				if (itemsValue) out.push({ id, type, items: itemsValue });
				break;
			}
		}
	});
	return errorsForPrefix(errors, path) ? null : out;
}

function parseNarrativeHunkReferences(items: unknown[], errors: PrWalkthroughValidationError[], path: string): PrWalkthroughYamlHunkReference[] | null {
	const out: PrWalkthroughYamlHunkReference[] = [];
	items.forEach((item, index) => {
		const itemPath = `${path}[${index}]`;
		if (!isRecord(item) || Array.isArray(item)) {
			addError(errors, itemPath, "Expected an object.");
			return;
		}
		const reference = parseHunkReference(item, errors, itemPath);
		if (reference) out.push(reference);
	});
	return errorsForPrefix(errors, path) ? null : out;
}

function parseSuggestedConcerns(items: unknown[], errors: PrWalkthroughValidationError[], path: string): PrWalkthroughYamlReviewChunk["suggested_concerns"] | null {
	const out: PrWalkthroughYamlReviewChunk["suggested_concerns"] = [];
	items.forEach((item, index) => {
		const itemPath = `${path}[${index}]`;
		if (!isRecord(item) || Array.isArray(item)) {
			addError(errors, itemPath, "Expected an object.");
			return;
		}
		const severity = requiredEnum(item, "severity", CONCERN_SEVERITIES, errors, `${itemPath}.`) as PrWalkthroughYamlReviewChunk["suggested_concerns"][number]["severity"] | undefined;
		const concern = requiredString(item, "concern", errors, `${itemPath}.`);
		const suggestedComment = requiredString(item, "suggested_comment", errors, `${itemPath}.`);
		const anchors = parseAnchors(requiredArray(item, "anchors", errors, `${itemPath}.`) ?? [], errors, `${itemPath}.anchors`);
		if (severity && concern && suggestedComment && anchors) out.push({ severity, concern, suggested_comment: suggestedComment, anchors });
	});
	return errorsForPrefix(errors, path) ? null : out;
}

function parseAnchors(items: unknown[], errors: PrWalkthroughValidationError[], path: string): PrWalkthroughYamlAnchor[] | null {
	const out: PrWalkthroughYamlAnchor[] = [];
	items.forEach((item, index) => {
		const itemPath = `${path}[${index}]`;
		if (!isRecord(item) || Array.isArray(item)) {
			addError(errors, itemPath, "Expected an object.");
			return;
		}
		const anchor = parseAnchor(item, errors, itemPath);
		if (anchor) out.push(anchor);
	});
	return errorsForPrefix(errors, path) ? null : out;
}

function parseAnchor(root: Record<string, unknown> | undefined, errors: PrWalkthroughValidationError[], path: string): PrWalkthroughYamlAnchor | null {
	if (!root) return null;
	const reference = parseHunkReference(root, errors, path);
	const lineRaw = root.line;
	if (lineRaw !== undefined && (!Number.isInteger(lineRaw) || Number(lineRaw) < 1)) addError(errors, `${path}.line`, "Expected a positive integer line number.");
	if (!reference || errorsForPrefix(errors, path)) return null;
	return { ...reference, ...(Number.isInteger(lineRaw) ? { line: Number(lineRaw) } : {}) };
}

function validateCrossFieldRules(document: PrWalkthroughYamlDocument, target: PrWalkthroughYamlLaunchTarget | undefined, errors: PrWalkthroughValidationError[]): void {
	if (target?.provider && target.provider !== document.pr.provider) addError(errors, "$.pr.provider", `Must match launch target provider ${target.provider}.`);
	if (target?.owner && normalizeIdentity(target.owner) !== normalizeIdentity(document.pr.owner)) addError(errors, "$.pr.owner", `Must match launch target owner ${target.owner}.`);
	if (target?.repo && normalizeIdentity(target.repo) !== normalizeIdentity(document.pr.repo)) addError(errors, "$.pr.repo", `Must match launch target repo ${target.repo}.`);
	if (target?.number !== undefined && String(target.number) !== String(document.pr.number)) addError(errors, "$.pr.number", `Must match launch target PR number ${target.number}.`);
	const targetUrl = target?.prUrl ?? target?.url;
	if (targetUrl && stripTrailingSlash(targetUrl) !== stripTrailingSlash(document.pr.url)) addError(errors, "$.pr.url", `Must match launch target URL ${targetUrl}.`);
	if (target?.baseSha && !shaMatches(target.baseSha, document.pr.base_sha)) addError(errors, "$.pr.base_sha", `Must match launch target base SHA ${target.baseSha}.`);
	if (target?.headSha && !shaMatches(target.headSha, document.pr.head_sha)) addError(errors, "$.pr.head_sha", `Must match launch target head SHA ${target.headSha}.`);

	const reviewChunkIds = new Set(document.walkthrough.review_chunks.map(chunk => chunk.id));
	for (const [index, id] of document.walkthrough.display.chunk_order.entries()) {
		if (!reviewChunkIds.has(id)) addError(errors, `$.walkthrough.display.chunk_order[${index}]`, `Unknown review chunk id ${id}.`);
	}
	if (!Object.values(document.walkthrough.context).some(value => typeof value === "string" && value.trim().length > 0)) {
		addError(errors, "$.walkthrough.context", "At least one context field must be non-empty.");
	}
	if (document.walkthrough.review_chunks.length === 0 && document.walkthrough.audit.reviewer_checklist.length === 0) {
		addError(errors, "$.walkthrough.review_chunks", "At least one review chunk or reviewer checklist item is required.");
	}
}

function buildOrientationCard(document: PrWalkthroughYamlDocument): PrWalkthroughCard {
	const context = document.walkthrough.context;
	const assessment = document.walkthrough.merge_assessment;
	return {
		id: "orientation-summary",
		phaseId: "orientation",
		title: "PR context",
		navLabel: "Orientation",
		// Back-compat: legacy renderers / stored payloads read summary/rationale/checklist.
		// The redesigned panel prefers `sections` (the guided beats below).
		summary: assessment.summary,
		rationale: compactJoin([
			`Author intent: ${context.author_intent}`,
			`Reviewer map: ${context.reviewer_map}`,
			`Merge assessment (${assessment.recommendation}, ${assessment.confidence} confidence): ${assessment.summary}`,
			`Merge concerns: ${context.merge_concerns}`,
		]),
		diffBlocks: [],
		checklist: compactArray([
			...assessment.blocking_concerns.map(item => `Blocking concern: ${item}`),
			...assessment.non_blocking_concerns.map(item => `Non-blocking concern: ${item}`),
			`Original PR description source: ${document.pr.original_description.source} at ${document.pr.original_description.fetched_at}`,
		]),
		sections: buildOrientationSections(document),
		cardSuggestions: compactArray([context.merge_concerns, ...assessment.blocking_concerns, ...assessment.non_blocking_concerns]),
	};
}

function buildOrientationSections(document: PrWalkthroughYamlDocument): PrWalkthroughCardSection[] {
	const context = document.walkthrough.context;
	const assessment = document.walkthrough.merge_assessment;

	const concerns: PrWalkthroughOrientationConcern[] = [
		...assessment.blocking_concerns.map((text): PrWalkthroughOrientationConcern => ({ severity: "blocking", text })),
		...assessment.non_blocking_concerns.map((text): PrWalkthroughOrientationConcern => ({ severity: "non_blocking", text })),
	];
	if (context.merge_concerns.trim().length > 0) concerns.push({ severity: "question", text: context.merge_concerns });

	const fileRoles = parseReviewerMapRoles(context.reviewer_map);

	return [
		{
			id: "what-changed-and-why",
			navLabel: "Overview",
			eyebrow: "Purpose",
			heading: "What changed and why",
			body: compactJoin([context.problem_solved, context.why_created, context.author_intent ? `How it works: ${context.author_intent}` : undefined]),
			showStats: true,
			diffBreakdown: diffBreakdownForDisplay(context.diff_breakdown),
		},
		{
			id: "original-pr-description",
			navLabel: "Original PR",
			eyebrow: "Source description",
			heading: "Original PR description",
			showOriginalDescription: true,
		},
		{
			id: "change-map",
			navLabel: "Change map",
			eyebrow: "Review map",
			heading: "Change map",
			// When the reviewer map parses into a structured file→role list, render only that
			// list — keeping the raw prose body too would duplicate every entry on screen.
			...(fileRoles.length > 0 ? { fileRoles } : { body: context.reviewer_map }),
		},
		{
			id: "risks-and-edge-cases",
			navLabel: "Risks",
			eyebrow: "Risk",
			heading: "Risks and edge cases",
			concerns,
		},
		{
			id: "merge-recommendation",
			navLabel: "Merge",
			eyebrow: "Decision",
			heading: "Merge recommendation",
			body: context.why_worth_merging,
			verdict: { recommendation: assessment.recommendation, confidence: assessment.confidence, summary: assessment.summary },
		},
	];
}

function diffBreakdownForDisplay(breakdown: PrWalkthroughYamlDiffBreakdown | undefined): PrWalkthroughDiffBreakdownItem[] | undefined {
	if (!breakdown) return undefined;
	const rows: Array<[string, PrWalkthroughYamlDiffBreakdownCounts]> = [
		["Prod executable code changes", breakdown.prod_executable_code],
		["Test code changes", breakdown.test_code],
		["All code + comments", breakdown.code_and_comments],
		["Docs only counts", breakdown.docs_only],
	];
	return rows.map(([label, counts]) => ({
		label,
		...(counts.files !== undefined ? { files: counts.files } : {}),
		...(counts.additions !== undefined ? { additions: counts.additions } : {}),
		...(counts.deletions !== undefined ? { deletions: counts.deletions } : {}),
		...(counts.note ? { note: counts.note } : {}),
	}));
}

function parseReviewerMapRoles(reviewerMap: string): PrWalkthroughOrientationFileRole[] {
	const roles: PrWalkthroughOrientationFileRole[] = [];
	for (const rawLine of reviewerMap.split(/\r?\n/)) {
		const match = /^\s*(core|support|verify|docs)\s*[:\-]\s*(.+)$/i.exec(rawLine);
		if (!match) continue;
		const role = match[1].toLowerCase() as PrWalkthroughOrientationFileRole["role"];
		const rest = match[2].trim();
		const noteSep = /\s[—-]\s/.exec(rest);
		if (noteSep && rest.slice(0, noteSep.index).trim().length > 0) {
			roles.push({ role, file: rest.slice(0, noteSep.index).trim(), note: rest.slice(noteSep.index + noteSep[0].length).trim() });
		} else {
			roles.push({ role, file: rest });
		}
	}
	return roles;
}

function buildOmissionsCard(omissions: PrWalkthroughYamlOmission[], existingCards: PrWalkthroughCard[]): PrWalkthroughCard | null {
	if (omissions.length === 0) return null;
	return {
		id: uniqueCardId("other-omissions-followups", existingCards),
		phaseId: "other",
		title: "Omissions and follow-ups",
		navLabel: deriveNavLabel("Omissions and follow-ups"),
		summary: omissions.map(item => `${item.category}: ${item.concern}`).join("\n"),
		rationale: omissions.map(item => `${item.expected_artifact} — evidence checked: ${item.evidence_checked}`).join("\n"),
		diffBlocks: [],
		cardSuggestions: omissions.map(item => `${item.severity}: ${item.suggested_comment}`),
		checklist: omissions.map(item => `${item.category}: ${item.expected_artifact}`),
	};
}

function buildAuditCard(document: PrWalkthroughYamlDocument, placement: HunkCoverageComputation, mapper: DiffReferenceMapper, existingCards: PrWalkthroughCard[]): PrWalkthroughCard {
	const audit = document.walkthrough.audit;
	const completionPlacements = placement.completionSweepPlacements;
	const groupedRemaining = groupPlacementsByFile(completionPlacements);
	const skipped = [...placement.records.values()].filter(record => record.primaryState === "skipped");
	return {
		id: uniqueCardId("audit-checklist", existingCards),
		phaseId: "audit",
		title: "Audit and review checklist",
		navLabel: deriveNavLabel("Audit and review checklist"),
		summary: compactJoin([
			formatList("Remaining changed areas", audit.remaining_changed_areas),
			completionPlacements.length > 0 ? `Completion sweep remaining: ${groupedRemaining}` : undefined,
			`Coverage: ${placement.summary.primaryReviewed} primary reviewed, ${placement.summary.unread} unread primary, ${placement.summary.skipped} skipped, ${placement.summary.completionSweepRemaining} remaining, ${placement.summary.repeatedSecondaryReferences} repeated references.`,
		]),
		rationale: compactJoin([
			formatList("Low-signal or mechanical changes", audit.low_signal_or_mechanical_changes),
			formatList("Generated or binary files", audit.generated_or_binary_files),
			skipped.length > 0 ? `Explicit skips: ${skipped.map(record => `${record.filePath} (${record.skippedReason ?? "other"})`).join("; ")}` : undefined,
		]),
		diffBlocks: hunkSlicedDiffBlocksFromPlacements(completionPlacements, mapper),
		hunkPlacements: completionPlacements,
		coverage: cardCoverageSummary(completionPlacements, placement.records),
		checklist: audit.reviewer_checklist,
	};
}

function mapSuggestedConcerns(chunk: PrWalkthroughYamlReviewChunk, cardId: string, mapper: DiffReferenceMapper, warnings: WalkthroughWarning[]): { comments: PrWalkthroughSuggestedComment[]; notes: string[] } {
	const comments: PrWalkthroughSuggestedComment[] = [];
	const notes: string[] = [];
	chunk.suggested_concerns.forEach((concern, concernIndex) => {
		let mapped = false;
		concern.anchors.forEach((anchor, anchorIndex) => {
			const match = mapper.tryResolveHunk(anchor);
			const line = match ? selectLine(match.hunk, anchor) : undefined;
			if (match && line) {
				mapped = true;
				comments.push({
					id: `suggested-${chunk.id}-${concernIndex + 1}-${anchorIndex + 1}`,
					cardId,
					diffBlockId: match.blockId,
					lineId: line.id,
					body: concern.suggested_comment,
				});
				return;
			}
			const file = anchor.file;
			if (file && !mapper.hasFile(file)) {
				warnings.push({ code: "unmapped_anchor", severity: "warning", message: `Could not map suggested concern anchor for chunk ${chunk.id}: ${file} ${anchor.hunk_header ?? anchor.hunk_id ?? ""}.`, filePath: file });
			}
			notes.push(`Unmapped suggested comment anchor (${concern.severity}): ${concern.concern} — ${concern.suggested_comment}`);
		});
		if (!mapped && concern.anchors.length === 0) notes.push(`${concern.severity}: ${concern.concern} — ${concern.suggested_comment}`);
	});
	return { comments, notes };
}

class DiffReferenceMapper {
	private readonly byFile = new Map<string, IndexedHunk[]>();
	private readonly byHunkId = new Map<string, IndexedHunk>();
	private readonly hunks: IndexedHunk[] = [];

	constructor(blocks: PrWalkthroughDiffBlock[]) {
		for (const block of blocks) {
			// Hunkless changed blocks (binary files, pure mode/rename changes, empty diffs)
			// still represent a changed file. Index a synthetic block-level hunk so the
			// coverage universe classifies it as skipped/completion-sweep-remaining rather
			// than silently dropping it from audit/coverage metadata.
			if (block.hunks.length === 0) {
				this.registerHunk(indexHunklessBlock(block), block);
				continue;
			}
			block.hunks.forEach((hunk, hunkIndex) => {
				this.registerHunk(indexHunk(block, hunk, hunkIndex), block);
			});
		}
	}

	private registerHunk(indexed: IndexedHunk, block: PrWalkthroughDiffBlock): void {
		this.hunks.push(indexed);
		this.byHunkId.set(indexed.hunkId, indexed);
		for (const file of [block.filePath, block.oldPath].filter((value): value is string => Boolean(value))) {
			const key = normalizePath(file);
			this.byFile.set(key, [...(this.byFile.get(key) ?? []), indexed]);
		}
	}

	allHunks(): IndexedHunk[] {
		return [...this.hunks];
	}

	hunkById(hunkId: string): IndexedHunk | undefined {
		return this.byHunkId.get(hunkId);
	}

	hasFile(file: string): boolean {
		return this.byFile.has(normalizePath(file));
	}

	tryResolveHunk(ref: PrWalkthroughYamlHunkReference): IndexedHunk | undefined {
		try {
			return this.resolveHunk(ref, "anchor", "anchor");
		} catch {
			return undefined;
		}
	}

	resolveHunk(ref: PrWalkthroughYamlHunkReference, path: string, cardId: string): IndexedHunk {
		if (ref.hunk_id) {
			const exact = this.byHunkId.get(ref.hunk_id);
			if (exact && referenceMatchesProvidedFields(exact, ref)) return exact;
			throw unresolvedHunkError(path, cardId, ref, exact ? 1 : 0, exact ? "hunk_id matched but supplied file/index/coordinates contradicted it" : "hunk_id did not match any changed hunk");
		}

		const candidates = ref.file ? [...(this.byFile.get(normalizePath(ref.file)) ?? [])] : [...this.hunks];
		let narrowed = candidates.filter(candidate => referenceMatchesProvidedFields(candidate, ref));
		if (ref.hunk_index === undefined && ref.old_start === undefined && ref.new_start === undefined && ref.hunk_header) {
			const headerMatches = candidates.filter(candidate => normalizeHunkHeader(candidate.hunkHeader) === normalizeHunkHeader(ref.hunk_header ?? ""));
			if (headerMatches.length > 0) narrowed = headerMatches.filter(candidate => referenceMatchesProvidedFields(candidate, ref));
		}
		if (narrowed.length === 1) return narrowed[0];

		if (ref.file && !hasHunkDisambiguator(ref) && candidates.length === 1) return candidates[0];

		throw unresolvedHunkError(path, cardId, ref, narrowed.length, narrowed.length > 1 ? "reference matched multiple hunks" : "reference did not match any hunk");
	}
}

function indexHunk(block: PrWalkthroughDiffBlock, hunk: PrWalkthroughHunk, hunkIndex: number): IndexedHunk {
	const coordinates = parseHunkCoordinates(hunk.header);
	const additions = hunk.lines.filter(line => line.kind === "add").length;
	const deletions = hunk.lines.filter(line => line.kind === "del").length;
	const hunkId = typeof hunk.id === "string" && hunk.id.trim().length > 0 ? hunk.id : fallbackHunkId(block, hunk, hunkIndex, coordinates);
	const sourceFlags = block as { sourceIsTruncated?: unknown; source_is_truncated?: unknown };
	return {
		hunkId,
		blockId: block.id,
		block,
		hunk: { ...hunk, id: hunkId },
		filePath: block.filePath,
		...(block.oldPath ? { oldPath: block.oldPath } : {}),
		hunkIndex,
		hunkHeader: hunk.header,
		...(coordinates ? { coordinates } : {}),
		changedLines: additions + deletions,
		additions,
		deletions,
		generated: Boolean(block.isGenerated),
		binary: Boolean(block.isBinary || block.status === "binary"),
		truncated: Boolean(block.isTruncated),
		sourceTruncated: Boolean(sourceFlags.sourceIsTruncated ?? sourceFlags.source_is_truncated ?? block.isTruncated),
		fileCategory: fileCategory(block.filePath, block),
	};
}

function blockLevelHunkId(block: PrWalkthroughDiffBlock): string {
	return `hunk-${hashString([block.filePath, block.oldPath ?? "", block.id, "block-level", block.status ?? ""].join("\u0000"))}`;
}

// Synthesizes an IndexedHunk for a changed block that produced no textual hunks
// (binary files, mode-only changes, empty diffs). The synthetic hunk carries the
// block-level flags so coverage can classify it (completion-sweep-remaining, or
// skipped when a reviewer explicitly marks it) and surface it in audit metadata.
function indexHunklessBlock(block: PrWalkthroughDiffBlock): IndexedHunk {
	const binary = Boolean(block.isBinary || block.status === "binary");
	const header = binary ? "Binary file (no textual diff)" : "File change (no textual hunks)";
	const hunkId = blockLevelHunkId(block);
	const sourceFlags = block as { sourceIsTruncated?: unknown; source_is_truncated?: unknown };
	return {
		hunkId,
		blockId: block.id,
		block,
		hunk: { id: hunkId, header, lines: [] },
		filePath: block.filePath,
		...(block.oldPath ? { oldPath: block.oldPath } : {}),
		hunkIndex: 0,
		hunkHeader: header,
		changedLines: 0,
		additions: 0,
		deletions: 0,
		generated: Boolean(block.isGenerated),
		binary,
		truncated: Boolean(block.isTruncated),
		sourceTruncated: Boolean(sourceFlags.sourceIsTruncated ?? sourceFlags.source_is_truncated ?? block.isTruncated),
		fileCategory: fileCategory(block.filePath, block),
	};
}

function hasHunkDisambiguator(ref: PrWalkthroughYamlHunkReference): boolean {
	return Boolean(
		ref.hunk_id
		|| ref.hunk_header
		|| ref.hunk_index !== undefined
		|| ref.old_start !== undefined
		|| ref.old_lines !== undefined
		|| ref.new_start !== undefined
		|| ref.new_lines !== undefined,
	);
}

function referenceMatchesProvidedFields(candidate: IndexedHunk, ref: PrWalkthroughYamlHunkReference): boolean {
	if (ref.file && normalizePath(ref.file) !== normalizePath(candidate.filePath) && (!candidate.oldPath || normalizePath(ref.file) !== normalizePath(candidate.oldPath))) return false;
	if (ref.hunk_index !== undefined && ref.hunk_index !== candidate.hunkIndex) return false;
	if (ref.hunk_header) {
		const supplied = parseHunkCoordinates(ref.hunk_header);
		const normalizedHeaderMatches = normalizeHunkHeader(candidate.hunkHeader) === normalizeHunkHeader(ref.hunk_header);
		const coordinatesMatch = supplied ? hunkCoordinatesEqual(candidate.coordinates, supplied) : false;
		if (!normalizedHeaderMatches && !coordinatesMatch) return false;
	}
	if (ref.old_start !== undefined && candidate.coordinates?.oldStart !== ref.old_start) return false;
	if (ref.old_lines !== undefined && candidate.coordinates?.oldCount !== ref.old_lines) return false;
	if (ref.new_start !== undefined && candidate.coordinates?.newStart !== ref.new_start) return false;
	if (ref.new_lines !== undefined && candidate.coordinates?.newCount !== ref.new_lines) return false;
	return true;
}

function unresolvedHunkError(path: string, cardId: string, ref: PrWalkthroughYamlHunkReference, candidateCount: number, reason: string): PrWalkthroughSynthesisError {
	return synthesisError("PRW_HUNK_REF_UNRESOLVED", "A hunk reference could not be resolved unambiguously.", {
		cardId,
		path,
		supplied: {
			...(ref.hunk_id ? { hunk_id: ref.hunk_id } : {}),
			...(ref.file ? { file: ref.file } : {}),
			...(ref.hunk_index !== undefined ? { hunk_index: ref.hunk_index } : {}),
			...(ref.hunk_header ? { hunk_header: ref.hunk_header } : {}),
			...(ref.old_start !== undefined ? { old_start: ref.old_start } : {}),
			...(ref.old_lines !== undefined ? { old_lines: ref.old_lines } : {}),
			...(ref.new_start !== undefined ? { new_start: ref.new_start } : {}),
			...(ref.new_lines !== undefined ? { new_lines: ref.new_lines } : {}),
		},
		candidateCount,
		reason,
	});
}

interface HunkCoordinates {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
}

function parseHunkCoordinates(header: string): HunkCoordinates | undefined {
	const match = /^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@(?:\s.*)?$/.exec(normalizeHunkHeader(header));
	if (!match) return undefined;
	return {
		oldStart: Number(match[1]),
		oldCount: match[2] === undefined ? 1 : Number(match[2]),
		newStart: Number(match[3]),
		newCount: match[4] === undefined ? 1 : Number(match[4]),
	};
}

function hunkCoordinatesEqual(left: HunkCoordinates | undefined, right: HunkCoordinates): boolean {
	return Boolean(left
		&& left.oldStart === right.oldStart
		&& left.oldCount === right.oldCount
		&& left.newStart === right.newStart
		&& left.newCount === right.newCount);
}

function flattenDiffBlocks(parsedDiff: WalkthroughParsedDiffForYamlMapping): PrWalkthroughDiffBlock[] {
	if (Array.isArray(parsedDiff.diffBlocks)) return uniqueBlocks(parsedDiff.diffBlocks);
	const blocks: PrWalkthroughDiffBlock[] = [];
	for (const file of parsedDiff.files ?? []) {
		if (!isRecord(file)) continue;
		if (Array.isArray(file.diffBlocks)) blocks.push(...file.diffBlocks.filter(isDiffBlock));
		else if (isDiffBlock(file)) blocks.push(file);
	}
	return uniqueBlocks(blocks);
}

function isDiffBlock(value: unknown): value is PrWalkthroughDiffBlock {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.filePath === "string" &&
		Array.isArray(value.hunks) &&
		value.hunks.every(hunk => isRecord(hunk) && typeof hunk.header === "string")
	);
}

function selectLine(hunk: PrWalkthroughHunk, anchor: PrWalkthroughYamlAnchor): PrWalkthroughDiffLine | undefined {
	const lineNumber = anchor.line ?? firstLineNumber(anchor.line_range);
	if (lineNumber !== undefined) {
		return hunk.lines.find(line => line.newLine === lineNumber || line.oldLine === lineNumber);
	}
	return hunk.lines.find(line => line.kind === "add") ?? hunk.lines.find(line => line.kind === "context") ?? hunk.lines[0];
}

function firstLineNumber(lineRange: string | undefined): number | undefined {
	if (!lineRange) return undefined;
	const match = /\d+/.exec(lineRange);
	return match ? Number(match[0]) : undefined;
}

function orderCards(cards: PrWalkthroughCard[], phaseOrder: PrWalkthroughPhaseId[]): PrWalkthroughCard[] {
	const phaseRank = new Map(phaseOrder.map((phase, index) => [phase, index]));
	return cards.map((card, index) => ({ card, index })).sort((a, b) => (phaseRank.get(a.card.phaseId) ?? 999) - (phaseRank.get(b.card.phaseId) ?? 999) || a.index - b.index).map(item => item.card);
}

function invalid(errors: PrWalkthroughValidationError[]): { ok: false; summary: PrWalkthroughValidationSummary } {
	return { ok: false, summary: { code: "YAML_SCHEMA_INVALID", message: "Walkthrough YAML did not match schema.", errors: errors.length > 0 ? errors : [{ path: "$", message: "Unknown validation error." }], retryable: true } };
}

function checkLimits(value: unknown, path: string, errors: PrWalkthroughValidationError[], maxStringLength: number, maxArrayItems: number): void {
	if (typeof value === "string" && value.length > maxStringLength) {
		addError(errors, path, `String is ${value.length} characters; limit is ${maxStringLength}. Shorten this field and retry.`);
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > maxArrayItems) addError(errors, path, `Array has ${value.length} items; limit is ${maxArrayItems}. Prioritize the most important entries.`);
		value.forEach((item, index) => checkLimits(item, `${path}[${index}]`, errors, maxStringLength, maxArrayItems));
		return;
	}
	if (isRecord(value)) {
		for (const [key, entry] of Object.entries(value)) checkLimits(entry, `${path}.${key}`, errors, maxStringLength, maxArrayItems);
	}
}

function requiredRecord(root: Record<string, unknown>, key: string, errors: PrWalkthroughValidationError[], prefix: string): Record<string, unknown> | undefined {
	const value = root[key];
	const path = `${prefix}${key}`;
	if (value === undefined) {
		addError(errors, path, "Required object is missing.");
		return undefined;
	}
	if (!isRecord(value) || Array.isArray(value)) {
		addError(errors, path, "Expected an object.");
		return undefined;
	}
	return value;
}

function requiredArray(root: Record<string, unknown>, key: string, errors: PrWalkthroughValidationError[], prefix: string): unknown[] | undefined {
	const value = root[key];
	const path = `${prefix}${key}`;
	if (value === undefined) {
		addError(errors, path, "Required array is missing.");
		return undefined;
	}
	if (!Array.isArray(value)) {
		addError(errors, path, "Expected an array.");
		return undefined;
	}
	return value;
}

function requiredString(root: Record<string, unknown>, key: string, errors: PrWalkthroughValidationError[], prefix: string, options: { allowEmpty?: boolean } = {}): string | undefined {
	const value = root[key];
	const path = `${prefix}${key}`;
	if (value === undefined) {
		addError(errors, path, "Required string is missing.");
		return undefined;
	}
	if (typeof value !== "string") {
		addError(errors, path, "Expected a string.");
		return undefined;
	}
	if (!options.allowEmpty && value.trim().length === 0) {
		addError(errors, path, "String must not be empty.");
		return undefined;
	}
	return value;
}

function optionalString(root: Record<string, unknown>, key: string, errors: PrWalkthroughValidationError[], prefix: string): string | undefined {
	const value = root[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		addError(errors, `${prefix}${key}`, "Expected a string.");
		return undefined;
	}
	return value;
}

function parseNavLabel(root: Record<string, unknown>, errors: PrWalkthroughValidationError[], prefix: string): string | undefined {
	const value = optionalString(root, "nav_label", errors, prefix);
	if (value === undefined) return undefined;
	// An empty / whitespace-only nav_label is treated as omitted so the caller
	// falls back to deriveNavLabel(title) instead of failing validation.
	if (value.trim().length === 0) return undefined;
	const error = navLabelError(value);
	if (error) {
		addError(errors, `${prefix}nav_label`, error);
		return undefined;
	}
	return value;
}

function requiredStableId(root: Record<string, unknown>, key: string, errors: PrWalkthroughValidationError[], prefix: string): string | undefined {
	const value = requiredString(root, key, errors, prefix);
	if (value && !STABLE_ID_RE.test(value)) addError(errors, `${prefix}${key}`, "Expected a stable id using letters, numbers, dot, underscore, colon, or dash; no spaces; max 96 chars.");
	return value;
}

function requiredStringArray(root: Record<string, unknown>, key: string, errors: PrWalkthroughValidationError[], prefix: string): string[] | undefined {
	const items = requiredArray(root, key, errors, prefix);
	if (!items) return undefined;
	const out: string[] = [];
	items.forEach((item, index) => {
		if (typeof item !== "string") addError(errors, `${prefix}${key}[${index}]`, "Expected a string.");
		else out.push(item);
	});
	return errorsForPrefix(errors, `${prefix}${key}`) ? undefined : out;
}

function requiredEnum(root: Record<string, unknown>, key: string, allowed: Set<string>, errors: PrWalkthroughValidationError[], prefix: string): string | undefined {
	const value = requiredString(root, key, errors, prefix);
	if (!value) return undefined;
	if (!allowed.has(value)) {
		addError(errors, `${prefix}${key}`, `Invalid value ${JSON.stringify(value)}. Expected one of: ${[...allowed].join(", ")}.`);
		return undefined;
	}
	return value;
}

function requiredEnumArray(root: Record<string, unknown>, key: string, allowed: Set<string>, errors: PrWalkthroughValidationError[], prefix: string): string[] | undefined {
	const items = requiredArray(root, key, errors, prefix);
	if (!items) return undefined;
	const out: string[] = [];
	items.forEach((item, index) => {
		if (typeof item !== "string") addError(errors, `${prefix}${key}[${index}]`, "Expected a string.");
		else if (!allowed.has(item)) addError(errors, `${prefix}${key}[${index}]`, `Invalid value ${JSON.stringify(item)}. Expected one of: ${[...allowed].join(", ")}.`);
		else out.push(item);
	});
	return errorsForPrefix(errors, `${prefix}${key}`) ? undefined : out;
}

function optionalNumber(root: Record<string, unknown>, key: string, errors: PrWalkthroughValidationError[], prefix: string, options: { integer?: boolean; min?: number } = {}): number | undefined {
	if (root[key] === undefined) return undefined;
	return requiredNumber(root, key, errors, prefix, options);
}

function requiredNumber(root: Record<string, unknown>, key: string, errors: PrWalkthroughValidationError[], prefix: string, options: { integer?: boolean; min?: number } = {}): number | undefined {
	const value = root[key];
	const path = `${prefix}${key}`;
	if (value === undefined) {
		addError(errors, path, "Required number is missing.");
		return undefined;
	}
	if (typeof value !== "number" || Number.isNaN(value)) {
		addError(errors, path, "Expected a number.");
		return undefined;
	}
	if (options.integer && !Number.isInteger(value)) addError(errors, path, "Expected an integer.");
	if (options.min !== undefined && value < options.min) addError(errors, path, `Expected a number >= ${options.min}.`);
	return value;
}

function validateUniqueIds(items: Array<{ id: string }>, path: string, errors: PrWalkthroughValidationError[]): void {
	const seen = new Map<string, number>();
	items.forEach((item, index) => {
		const previous = seen.get(item.id);
		if (previous !== undefined) addError(errors, `${path}[${index}].id`, `Duplicate id ${item.id}; first used at ${path}[${previous}].id.`);
		else seen.set(item.id, index);
	});
}

function addError(errors: PrWalkthroughValidationError[], path: string, message: string): void {
	errors.push({ path, message });
}

function errorsForPrefix(errors: PrWalkthroughValidationError[], prefix: string): boolean {
	return errors.some(error => error.path.startsWith(prefix));
}

function allPresent(record: Record<string, unknown>): boolean {
	return Object.values(record).every(value => value !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeIdentity(value: string): string {
	return value.trim().toLowerCase();
}

function stripTrailingSlash(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

function shaMatches(expected: string, actual: string): boolean {
	return actual.toLowerCase().startsWith(expected.toLowerCase()) || expected.toLowerCase().startsWith(actual.toLowerCase());
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^[ab]\//, "").trim().toLowerCase();
}

function normalizeHunkHeader(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function fallbackHunkId(block: PrWalkthroughDiffBlock, hunk: PrWalkthroughHunk, hunkIndex: number, coordinates: HunkCoordinates | undefined): string {
	return `hunk-${hashString([
		block.filePath,
		block.id,
		String(hunkIndex),
		hunk.header,
		`${coordinates?.oldStart ?? ""}:${coordinates?.oldCount ?? ""}`,
		`${coordinates?.newStart ?? ""}:${coordinates?.newCount ?? ""}`,
	].join("\u0000"))}`;
}

function hashString(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36);
}

function fileCategory(filePath: string, block: PrWalkthroughDiffBlock): string {
	const normalized = normalizePath(filePath);
	if (block.isGenerated || /(^|\/)(dist|build|generated|coverage|vendor)\//.test(normalized) || /\.min\.[a-z0-9]+$/.test(normalized)) return "generated";
	if (/(^|\/)(vendor|third_party|node_modules)\//.test(normalized)) return "vendor";
	if (/(^|\/)(__tests__|tests?|spec)\//.test(normalized) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)) return "test";
	if (/(^|\/)docs?\//.test(normalized) || /\.(md|mdx|rst|adoc)$/.test(normalized)) return "docs";
	if (/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|gemfile\.lock|poetry\.lock|cargo\.lock)$/.test(normalized)) return "lockfile";
	if (/\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|woff2?|ttf|eot|mp4|mov|mp3|wav)$/.test(normalized)) return "asset";
	return "source";
}

function groupPlacementsByFile(placements: PrWalkthroughHunkPlacement[]): string {
	const counts = new Map<string, number>();
	for (const placement of placements) counts.set(placement.filePath, (counts.get(placement.filePath) ?? 0) + 1);
	return [...counts.entries()].map(([file, count]) => `${file} (${count})`).join("; ");
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}

function compactArray(values: Array<string | undefined>): string[] {
	return values.map(value => value?.trim() ?? "").filter(Boolean);
}

function compactJoin(values: Array<string | undefined>): string {
	return compactArray(values).join("\n");
}

function formatList(label: string, values: string[]): string | undefined {
	const compact = compactArray(values);
	return compact.length > 0 ? `${label}: ${compact.join("; ")}` : undefined;
}

function formatAlternatives(values: Array<{ option: string; pros: string[]; cons: string[] }>): string | undefined {
	if (values.length === 0) return undefined;
	return `Alternatives: ${values.map(value => `${value.option} (pros: ${value.pros.join(", ") || "none"}; cons: ${value.cons.join(", ") || "none"})`).join("; ")}`;
}

function uniqueBlocks(blocks: PrWalkthroughDiffBlock[]): PrWalkthroughDiffBlock[] {
	const seen = new Set<string>();
	const out: PrWalkthroughDiffBlock[] = [];
	for (const block of blocks) {
		if (seen.has(block.id)) continue;
		seen.add(block.id);
		out.push(block);
	}
	return out;
}

function uniqueCardId(seed: string, existingCards: PrWalkthroughCard[]): string {
	const existing = new Set(existingCards.map(card => card.id));
	let id = seed.replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "card";
	const base = id;
	let suffix = 2;
	while (existing.has(id)) id = `${base}-${suffix++}`;
	return id;
}

function dedupeWarnings(warnings: WalkthroughWarning[]): WalkthroughWarning[] {
	const seen = new Set<string>();
	const out: WalkthroughWarning[] = [];
	for (const warning of warnings) {
		const key = `${warning.code}\u0000${warning.severity}\u0000${warning.message}\u0000${warning.filePath ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(warning);
	}
	return out;
}
