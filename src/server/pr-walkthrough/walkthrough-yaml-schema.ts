import { parseAllDocuments } from "yaml";

import { changesetIdForGithub } from "../../shared/pr-walkthrough/ids.js";
import { deriveNavLabel, navLabelError } from "../../shared/pr-walkthrough/nav-label.js";
import type {
	PrWalkthroughCard,
	PrWalkthroughCardSection,
	PrWalkthroughChangesetRef,
	PrWalkthroughDiffBlock,
	PrWalkthroughDiffLine,
	PrWalkthroughHunk,
	PrWalkthroughOrientationConcern,
	PrWalkthroughOrientationFileRole,
	PrWalkthroughPhaseId,
	PrWalkthroughSuggestedComment,
	WalkthroughWarning,
} from "../../shared/pr-walkthrough/types.js";
import type { WalkthroughStorePayload } from "./walkthrough-store.js";

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

export interface PrWalkthroughYamlRelevantHunk {
	file: string;
	hunk_header: string;
	line_range?: string;
	why_relevant: string;
}

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
	suggested_concerns: Array<{
		severity: "blocking" | "non_blocking" | "question" | "nit";
		concern: string;
		suggested_comment: string;
		anchors: PrWalkthroughYamlAnchor[];
	}>;
	positive_notes: string[];
}

export interface PrWalkthroughYamlAnchor {
	file: string;
	hunk_header: string;
	line_range?: string;
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

export interface MapYamlToWalkthroughPayloadOptions {
	changesetId?: string;
	target?: PrWalkthroughYamlLaunchTarget;
	warnings?: WalkthroughWarning[];
	limits?: WalkthroughStorePayload["limits"];
	export?: WalkthroughStorePayload["export"];
}

export interface WalkthroughParsedDiffForYamlMapping {
	changeset?: Partial<PrWalkthroughChangesetRef>;
	files?: unknown[];
	diffBlocks?: PrWalkthroughDiffBlock[];
	warnings?: WalkthroughWarning[];
	limits?: WalkthroughStorePayload["limits"];
	export?: WalkthroughStorePayload["export"];
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
): WalkthroughStorePayload {
	const diffBlocks = flattenDiffBlocks(parsedDiff);
	const mapper = new DiffReferenceMapper(diffBlocks);
	const warnings: WalkthroughWarning[] = [...(options.warnings ?? []), ...(parsedDiff.warnings ?? [])];
	const usedBlockIds = new Set<string>();
	const cards: PrWalkthroughCard[] = [];
	const changesetId = options.changesetId ?? options.target?.changesetId ?? changesetIdForGithub(document.pr.owner, document.pr.repo, document.pr.number, document.pr.head_sha);

	cards.push(buildOrientationCard(document));

	for (const decision of document.walkthrough.design_decisions) {
		const mapped = mapRelevantHunks(decision.relevant_hunks, mapper, `walkthrough.design_decisions[id=${decision.id}].relevant_hunks`, warnings);
		for (const block of mapped.blocks) usedBlockIds.add(block.id);
		cards.push({
			id: uniqueCardId(`design-${decision.id}`, cards),
			phaseId: "design",
			title: decision.title,
			navLabel: decision.nav_label ?? deriveNavLabel(decision.title),
			summary: decision.explanation,
			rationale: compactJoin([
				`Chosen approach: ${decision.chosen_approach}`,
				formatAlternatives(decision.alternatives_considered),
				formatList("Trade-offs", decision.tradeoffs),
			]),
			diffBlocks: mapped.blocks,
			cardSuggestions: compactArray([...decision.suggested_reviewer_concerns, ...mapped.notes]),
		});
	}

	const chunkById = new Map(document.walkthrough.review_chunks.map(chunk => [chunk.id, chunk]));
	const orderedChunks = [
		...document.walkthrough.display.chunk_order.map(id => chunkById.get(id)).filter((chunk): chunk is PrWalkthroughYamlReviewChunk => Boolean(chunk)),
		...document.walkthrough.review_chunks.filter(chunk => !document.walkthrough.display.chunk_order.includes(chunk.id)),
	];
	for (const chunk of orderedChunks) {
		const mappedHunks = mapRelevantHunks(chunk.relevant_hunks, mapper, `walkthrough.review_chunks[id=${chunk.id}].relevant_hunks`, warnings);
		const fileBlocks = mapper.blocksForFiles(chunk.files);
		const diffBlocksForCard = uniqueBlocks([...mappedHunks.blocks, ...fileBlocks]);
		for (const block of diffBlocksForCard) usedBlockIds.add(block.id);
		const cardId = uniqueCardId(`${chunk.phase}-${chunk.id}`, cards);
		const commentMapping = mapSuggestedConcerns(chunk, cardId, mapper, warnings);
		cards.push({
			id: cardId,
			phaseId: chunk.phase,
			title: chunk.title,
			navLabel: chunk.nav_label ?? deriveNavLabel(chunk.title),
			summary: chunk.explanation,
			rationale: compactJoin([`Reviewer goal: ${chunk.reviewer_goal}`, formatList("Positive notes", chunk.positive_notes)]),
			diffBlocks: diffBlocksForCard,
			...(commentMapping.comments.length > 0 ? { suggestedComments: commentMapping.comments } : {}),
			cardSuggestions: compactArray([...mappedHunks.notes, ...commentMapping.notes]),
		});
	}

	const omissionsCard = buildOmissionsCard(document.walkthrough.omissions_and_followups, cards);
	if (omissionsCard) cards.push(omissionsCard);

	cards.push(buildAuditCard(document, diffBlocks.filter(block => !usedBlockIds.has(block.id)), cards));

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
		limits: options.limits ?? parsedDiff.limits,
		export: options.export ?? parsedDiff.export,
	};
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
	const context = {
		why_created: requiredString(root, "why_created", errors, path),
		problem_solved: requiredString(root, "problem_solved", errors, path),
		why_worth_merging: requiredString(root, "why_worth_merging", errors, path),
		merge_concerns: requiredString(root, "merge_concerns", errors, path),
		author_intent: requiredString(root, "author_intent", errors, path),
		reviewer_map: requiredString(root, "reviewer_map", errors, path),
	};
	return allPresent(context) ? context as PrWalkthroughYamlWalkthrough["context"] : null;
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
		const hunks = parseRelevantHunks(requiredArray(item, "relevant_hunks", errors, `${path}.`) ?? [], errors, `${path}.relevant_hunks`, false);
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
		const hunks = parseRelevantHunks(requiredArray(item, "relevant_hunks", errors, `${path}.`) ?? [], errors, `${path}.relevant_hunks`, true);
		const suggestedConcerns = parseSuggestedConcerns(requiredArray(item, "suggested_concerns", errors, `${path}.`) ?? [], errors, `${path}.suggested_concerns`);
		const positiveNotes = requiredStringArray(item, "positive_notes", errors, `${path}.`);
		if (id && phase && title && reviewerGoal && explanation && files && hunks && suggestedConcerns && positiveNotes) {
			out.push({ id, phase, title, ...(navLabel !== undefined ? { nav_label: navLabel } : {}), reviewer_goal: reviewerGoal, explanation, files, relevant_hunks: hunks, suggested_concerns: suggestedConcerns, positive_notes: positiveNotes });
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

function parseRelevantHunks(items: unknown[], errors: PrWalkthroughValidationError[], path: string, lineRangeAllowed: boolean): PrWalkthroughYamlRelevantHunk[] | null {
	const out: PrWalkthroughYamlRelevantHunk[] = [];
	items.forEach((item, index) => {
		const itemPath = `${path}[${index}]`;
		if (!isRecord(item) || Array.isArray(item)) {
			addError(errors, itemPath, "Expected an object.");
			return;
		}
		const file = requiredString(item, "file", errors, `${itemPath}.`);
		const hunkHeader = requiredString(item, "hunk_header", errors, `${itemPath}.`);
		const whyRelevant = requiredString(item, "why_relevant", errors, `${itemPath}.`);
		const lineRange = optionalString(item, "line_range", errors, `${itemPath}.`);
		if (lineRange && !lineRangeAllowed) addError(errors, `${itemPath}.line_range`, "line_range is only supported on review chunk hunk references.");
		if (file && hunkHeader && whyRelevant) out.push({ file, hunk_header: hunkHeader, why_relevant: whyRelevant, ...(lineRange ? { line_range: lineRange } : {}) });
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
		const file = requiredString(item, "file", errors, `${itemPath}.`);
		const hunkHeader = requiredString(item, "hunk_header", errors, `${itemPath}.`);
		const lineRange = optionalString(item, "line_range", errors, `${itemPath}.`);
		const lineRaw = item.line;
		if (lineRaw !== undefined && (!Number.isInteger(lineRaw) || Number(lineRaw) < 1)) addError(errors, `${itemPath}.line`, "Expected a positive integer line number.");
		if (file && hunkHeader) out.push({ file, hunk_header: hunkHeader, ...(lineRange ? { line_range: lineRange } : {}), ...(Number.isInteger(lineRaw) ? { line: Number(lineRaw) } : {}) });
	});
	return errorsForPrefix(errors, path) ? null : out;
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
	if (!Object.values(document.walkthrough.context).some(value => value.trim().length > 0)) {
		addError(errors, "$.walkthrough.context", "At least one context field must be non-empty.");
	}
	if (document.walkthrough.review_chunks.length === 0 && document.walkthrough.audit.reviewer_checklist.length === 0) {
		addError(errors, "$.walkthrough.review_chunks", "At least one review chunk or audit checklist item is required.");
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
			id: "at-a-glance",
			navLabel: "At a glance",
			heading: "At a glance",
			body: assessment.summary,
			verdict: { recommendation: assessment.recommendation, confidence: assessment.confidence, summary: assessment.summary },
			showStats: true,
		},
		{
			id: "why-it-exists",
			navLabel: "Why it exists",
			eyebrow: "The problem",
			heading: "Why it exists",
			body: context.why_created,
		},
		{
			id: "what-it-changes",
			navLabel: "What it changes",
			eyebrow: "The change",
			heading: "What it changes",
			body: context.problem_solved,
		},
		{
			id: "should-merge",
			navLabel: "Should we merge",
			eyebrow: "The decision",
			heading: "Should it be merged?",
			body: compactJoin([mergeAnswerLine(assessment.recommendation, assessment.confidence), context.why_worth_merging]),
		},
		{
			id: "what-to-watch",
			navLabel: "What to watch",
			heading: "What to scrutinise",
			concerns,
		},
		{
			id: "where-to-look",
			navLabel: "Where to look",
			heading: "Where to look",
			body: context.reviewer_map,
			...(fileRoles.length > 0 ? { fileRoles } : {}),
			showOriginalDescription: true,
		},
	];
}

function mergeAnswerLine(recommendation: PrWalkthroughYamlWalkthrough["merge_assessment"]["recommendation"], confidence: string): string {
	switch (recommendation) {
		case "approve": return `Yes — approve, ${confidence} confidence.`;
		case "request_changes": return `Not yet — request changes, ${confidence} confidence.`;
		case "comment": return `Maybe — comment, ${confidence} confidence.`;
		default: return "Recommendation unclear.";
	}
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

function buildAuditCard(document: PrWalkthroughYamlDocument, remainingBlocks: PrWalkthroughDiffBlock[], existingCards: PrWalkthroughCard[]): PrWalkthroughCard {
	const audit = document.walkthrough.audit;
	return {
		id: uniqueCardId("audit-checklist", existingCards),
		phaseId: "audit",
		title: "Audit and review checklist",
		navLabel: deriveNavLabel("Audit and review checklist"),
		summary: compactJoin([
			formatList("Remaining changed areas", audit.remaining_changed_areas),
			remainingBlocks.length > 0 ? `Unassigned diff blocks: ${remainingBlocks.map(block => block.filePath).join(", ")}` : undefined,
		]),
		rationale: compactJoin([
			formatList("Low-signal or mechanical changes", audit.low_signal_or_mechanical_changes),
			formatList("Generated or binary files", audit.generated_or_binary_files),
		]),
		diffBlocks: remainingBlocks,
		checklist: audit.reviewer_checklist,
	};
}

function mapRelevantHunks(hunks: PrWalkthroughYamlRelevantHunk[], mapper: DiffReferenceMapper, path: string, warnings: WalkthroughWarning[]): { blocks: PrWalkthroughDiffBlock[]; notes: string[] } {
	const blocks: PrWalkthroughDiffBlock[] = [];
	const notes: string[] = [];
	hunks.forEach((hunk, index) => {
		const match = mapper.findHunkLenient(hunk.file, hunk.hunk_header);
		if (match) {
			blocks.push(match.block);
			return;
		}
		const fileBlock = mapper.blockForFile(hunk.file);
		const message = `${hunk.file} ${hunk.hunk_header}: ${hunk.why_relevant}`;
		if (fileBlock) {
			blocks.push(fileBlock);
			notes.push(`File-level fallback for hunk: ${message}`);
			return;
		}
		warnings.push({ code: "unmapped_hunk", severity: "warning", message: `Could not map hunk reference at ${path}[${index}]: ${message}`, filePath: hunk.file });
		notes.push(`Unmapped hunk: ${message}`);
	});
	return { blocks: uniqueBlocks(blocks), notes };
}

function mapSuggestedConcerns(chunk: PrWalkthroughYamlReviewChunk, cardId: string, mapper: DiffReferenceMapper, warnings: WalkthroughWarning[]): { comments: PrWalkthroughSuggestedComment[]; notes: string[] } {
	const comments: PrWalkthroughSuggestedComment[] = [];
	const notes: string[] = [];
	chunk.suggested_concerns.forEach((concern, concernIndex) => {
		let mapped = false;
		concern.anchors.forEach((anchor, anchorIndex) => {
			const match = anchor.line != null || anchor.line_range ? mapper.findHunkLenient(anchor.file, anchor.hunk_header) : mapper.findHunk(anchor.file, anchor.hunk_header);
			const line = match ? selectLine(match.hunk, anchor) : undefined;
			if (match && line) {
				mapped = true;
				comments.push({
					id: `suggested-${chunk.id}-${concernIndex + 1}-${anchorIndex + 1}`,
					cardId,
					diffBlockId: match.block.id,
					lineId: line.id,
					body: concern.suggested_comment,
				});
				return;
			}
			if (!mapper.blockForFile(anchor.file)) {
				warnings.push({ code: "unmapped_anchor", severity: "warning", message: `Could not map suggested concern anchor for chunk ${chunk.id}: ${anchor.file} ${anchor.hunk_header}.`, filePath: anchor.file });
			}
			notes.push(`Unmapped suggested comment anchor (${concern.severity}): ${concern.concern} — ${concern.suggested_comment}`);
		});
		if (!mapped && concern.anchors.length === 0) notes.push(`${concern.severity}: ${concern.concern} — ${concern.suggested_comment}`);
	});
	return { comments, notes };
}

class DiffReferenceMapper {
	private readonly byFile = new Map<string, PrWalkthroughDiffBlock[]>();

	constructor(blocks: PrWalkthroughDiffBlock[]) {
		for (const block of blocks) {
			for (const file of [block.filePath, block.oldPath].filter((value): value is string => Boolean(value))) {
				const key = normalizePath(file);
				this.byFile.set(key, [...(this.byFile.get(key) ?? []), block]);
			}
		}
	}

	blockForFile(file: string): PrWalkthroughDiffBlock | undefined {
		return this.blocksForFiles([file])[0];
	}

	blocksForFiles(files: string[]): PrWalkthroughDiffBlock[] {
		return uniqueBlocks(files.flatMap(file => this.byFile.get(normalizePath(file)) ?? []));
	}

	findHunk(file: string, hunkHeader: string): { block: PrWalkthroughDiffBlock; hunk: PrWalkthroughHunk } | undefined {
		const normalizedHeader = normalizeHunkHeader(hunkHeader);
		const coordinates = parseHunkCoordinates(hunkHeader);
		for (const block of this.byFile.get(normalizePath(file)) ?? []) {
			const hunk = block.hunks.find(candidate => candidate.header === hunkHeader || normalizeHunkHeader(candidate.header) === normalizedHeader);
			if (hunk) return { block, hunk };
			if (coordinates) {
				const coordinateMatch = block.hunks.find(candidate => hunkCoordinatesEqual(parseHunkCoordinates(candidate.header), coordinates));
				if (coordinateMatch) return { block, hunk: coordinateMatch };
			}
		}
		return undefined;
	}

	findHunkLenient(file: string, hunkHeader: string): { block: PrWalkthroughDiffBlock; hunk: PrWalkthroughHunk } | undefined {
		const strict = this.findHunk(file, hunkHeader);
		if (strict) return strict;
		const blocks = this.byFile.get(normalizePath(file)) ?? [];
		const totalHunkCount = blocks.reduce((count, item) => count + item.hunks.length, 0);
		const soleHunkBlock = totalHunkCount === 1 ? blocks.find(block => block.hunks.length === 1) : undefined;
		if (soleHunkBlock?.hunks[0]) return { block: soleHunkBlock, hunk: soleHunkBlock.hunks[0] };
		return undefined;
	}
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
