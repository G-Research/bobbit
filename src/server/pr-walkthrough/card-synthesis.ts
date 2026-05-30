// The shared PR walkthrough model is produced by the upstream model task. Keep this
// import pointed at that contract while retaining local structural types so this
// module can be validated independently when the shared file is not present yet.
// @ts-ignore Upstream shared model may be absent on this parallel task branch.
import type { PrWalkthroughCard as SharedPrWalkthroughCard, PrWalkthroughChangesetRef as SharedPrWalkthroughChangesetRef, PrWalkthroughDiffBlock as SharedPrWalkthroughDiffBlock, PrWalkthroughDiffLine as SharedPrWalkthroughDiffLine, PrWalkthroughHunk as SharedPrWalkthroughHunk, PrWalkthroughPhaseId as SharedPrWalkthroughPhaseId, PrWalkthroughSuggestedComment as SharedPrWalkthroughSuggestedComment, WalkthroughWarning as SharedWalkthroughWarning } from "../../shared/pr-walkthrough/types.js";

type PreserveShared<T> = unknown extends T ? unknown : T;
type LocalPhaseId = "orientation" | "design" | "significant" | "other" | "audit";
type PrWalkthroughPhaseId = LocalPhaseId & PreserveShared<SharedPrWalkthroughPhaseId>;

type PrWalkthroughDiffLine = {
	id: string;
	side: "old" | "new" | "context";
	oldLine?: number;
	newLine?: number;
	text: string;
	kind: "context" | "add" | "del";
} & PreserveShared<SharedPrWalkthroughDiffLine>;

type PrWalkthroughHunk = {
	id: string;
	header: string;
	lines: PrWalkthroughDiffLine[];
} & PreserveShared<SharedPrWalkthroughHunk>;

type PrWalkthroughDiffBlock = {
	id: string;
	filePath: string;
	oldPath?: string;
	hunks: PrWalkthroughHunk[];
} & PreserveShared<SharedPrWalkthroughDiffBlock>;

type PrWalkthroughSuggestedComment = {
	id: string;
	cardId: string;
	diffBlockId: string;
	lineId: string;
	body: string;
} & PreserveShared<SharedPrWalkthroughSuggestedComment>;

type PrWalkthroughCard = {
	id: string;
	phaseId: PrWalkthroughPhaseId;
	title: string;
	summary: string;
	rationale?: string;
	diffBlocks: PrWalkthroughDiffBlock[];
	suggestedComments?: PrWalkthroughSuggestedComment[];
	cardSuggestions?: string[];
	checklist?: string[];
} & PreserveShared<SharedPrWalkthroughCard>;

type PrWalkthroughChangesetRef = {
	baseSha: string;
	headSha: string;
	provider?: string;
	externalUrl?: string;
	prUrl?: string;
	prNumber?: string | number;
	prTitle?: string;
	prBody?: string;
	title?: string;
	filesChanged?: number;
	additions?: number;
	deletions?: number;
} & PreserveShared<SharedPrWalkthroughChangesetRef>;

type WalkthroughWarning = {
	code: string;
	severity: "info" | "warning" | "error";
	message: string;
	filePath?: string;
} & PreserveShared<SharedWalkthroughWarning>;

export type WalkthroughFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "binary";

export interface WalkthroughParsedFile {
	filePath: string;
	oldPath?: string;
	status?: WalkthroughFileStatus | string;
	diffBlocks?: PrWalkthroughDiffBlock[];
	warnings?: WalkthroughWarning[];
	isGenerated?: boolean;
	isTruncated?: boolean;
	isBinary?: boolean;
}

export interface WalkthroughLlmCardCandidate {
	id?: unknown;
	phaseId?: unknown;
	title?: unknown;
	summary?: unknown;
	rationale?: unknown;
	diffBlockIds?: unknown;
	diffBlocks?: unknown;
	suggestedComments?: unknown;
	cardSuggestions?: unknown;
	checklist?: unknown;
}

export interface WalkthroughCardSynthesisOptions {
	warnings?: WalkthroughWarning[];
	allowLlm?: boolean;
	maxLlmInputBytes?: number;
	llm?: ((input: WalkthroughLlmInput) => Promise<unknown> | unknown) | { synthesiseWalkthroughCards(input: WalkthroughLlmInput): Promise<unknown> | unknown };
	maxCards?: number;
}

export interface WalkthroughLlmInput {
	changeset: PrWalkthroughChangesetRef;
	files: WalkthroughParsedFile[];
	warnings: WalkthroughWarning[];
	diffBlockIds: string[];
}

const PHASES = new Set<PrWalkthroughPhaseId>(["orientation", "design", "significant", "other", "audit"]);
const DEFAULT_MAX_LLM_INPUT_BYTES = 48_000;
const DEFAULT_MAX_CARDS = 12;
const MAX_BLOCKS_PER_FALLBACK_CARD = 6;

interface WeightedBlock {
	block: PrWalkthroughDiffBlock;
	file: WalkthroughParsedFile;
	weight: number;
	category: "generated" | "truncated" | "deleted" | "renamed" | "binary" | "normal";
	topLevel: string;
}

interface DiffHunkForSynthesis {
	lines: PrWalkthroughDiffLine[];
}

interface DiffBlockForSynthesis {
	hunks: DiffHunkForSynthesis[];
}

interface BlockGroup {
	key: string;
	label: string;
	blocks: WeightedBlock[];
	weight: number;
}

export async function synthesiseWalkthroughCards(
	changeset: PrWalkthroughChangesetRef,
	files: WalkthroughParsedFile[],
	options: WalkthroughCardSynthesisOptions = {},
): Promise<PrWalkthroughCard[]> {
	const warnings = options.warnings ?? collectFileWarnings(files);
	const llmCards = await tryLlmSynthesis(changeset, files, warnings, options);
	if (llmCards.length > 0) {
		const orientation = buildOrientationCard(changeset, files, warnings);
		return limitCards([orientation, ...llmCards.filter(card => card.phaseId !== "orientation")], options.maxCards);
	}
	return limitCards(buildFallbackCards(changeset, files, warnings), options.maxCards);
}

export function validateSynthesisedCards(raw: unknown, files: WalkthroughParsedFile[]): PrWalkthroughCard[] {
	const candidates = extractCardCandidates(raw);
	const blockById = new Map<string, PrWalkthroughDiffBlock>();
	const lineIdsByBlock = new Map<string, Set<string>>();
	for (const block of flattenBlocks(files)) {
		blockById.set(block.id, block);
		lineIdsByBlock.set(block.id, new Set(lineIdsForBlock(block)));
	}

	const cards: PrWalkthroughCard[] = [];
	const seen = new Set<string>();
	const usedBlockIds = new Set<string>();
	for (const candidate of candidates) {
		if (!isRecord(candidate)) continue;
		const phaseId = typeof candidate.phaseId === "string" && PHASES.has(candidate.phaseId as PrWalkthroughPhaseId) ? candidate.phaseId as PrWalkthroughPhaseId : undefined;
		const title = stringValue(candidate.title);
		const summary = stringValue(candidate.summary);
		if (!phaseId || !title || !summary) continue;

		const blockIds = unique(candidateBlockIds(candidate)).filter(blockId => !usedBlockIds.has(blockId));
		const diffBlocks = blockIds.map(id => blockById.get(id)).filter((block): block is PrWalkthroughDiffBlock => Boolean(block));
		if (diffBlocks.length === 0 && phaseId !== "orientation") continue;
		for (const block of diffBlocks) usedBlockIds.add(block.id);

		const id = stableCardId(`${phaseId}-${title}`, seen);
		const suggestedComments = validateSuggestedComments(candidate.suggestedComments, id, diffBlocks, lineIdsByBlock);
		cards.push({
			id,
			phaseId,
			title,
			summary,
			rationale: stringValue(candidate.rationale),
			diffBlocks,
			...(suggestedComments.length > 0 ? { suggestedComments } : {}),
			...stringArrayProp("cardSuggestions", candidate.cardSuggestions),
			...stringArrayProp("checklist", candidate.checklist),
		});
	}
	return cards;
}

function buildFallbackCards(
	changeset: PrWalkthroughChangesetRef,
	files: WalkthroughParsedFile[],
	warnings: WalkthroughWarning[],
): PrWalkthroughCard[] {
	const weighted = flattenWeightedBlocks(files);
	const cards: PrWalkthroughCard[] = [buildOrientationCard(changeset, files, warnings)];
	if (weighted.length === 0) return cards;

	const special = weighted.filter(block => block.category !== "normal");
	const normal = weighted.filter(block => block.category === "normal");
	const groups = groupByTopLevel(normal).sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
	const assigned = new Set<string>();

	const designGroup = groups.shift();
	if (designGroup) cards.push(buildGroupCard("design", designGroup, assigned));

	const significantGroups = groups.splice(0, 1);
	for (const group of significantGroups) cards.push(buildGroupCard("significant", group, assigned));

	const specialGroup = buildSpecialGroup(special);
	if (specialGroup) cards.push(buildGroupCard("other", specialGroup, assigned));

	const smallGroups: BlockGroup[] = [];
	while (groups.length > 0 && totalBlocks(smallGroups) < MAX_BLOCKS_PER_FALLBACK_CARD && (groups.length > 1 || (smallGroups.length === 0 && cards.length < 4))) {
		smallGroups.push(groups.pop() as BlockGroup);
	}
	if (smallGroups.length > 0) cards.push(buildOtherSmallChangesCard(smallGroups, assigned));

	const remaining = weighted.filter(item => !assigned.has(item.block.id));
	cards.push(buildAuditCard(remaining));
	return cards;
}

function buildOrientationCard(
	changeset: PrWalkthroughChangesetRef,
	files: WalkthroughParsedFile[],
	warnings: WalkthroughWarning[],
): PrWalkthroughCard {
	const prTitle = changeset.prTitle ?? changeset.title ?? "this PR";
	const prBody = stringValue(changeset.prBody);
	const changedAreas = summarizeChangedAreas(files);
	const why = compactText(extractPrSection(prBody, ["why", "motivation", "problem", "summary"]) || firstParagraph(prBody) || prTitle);
	const context = compactText(extractPrSection(prBody, ["context", "background", "notes", "implementation"]) || (changedAreas ? `Main changed areas: ${changedAreas}.` : "No additional PR context was provided."));
	const testing = compactText(extractPrSection(prBody, ["test", "tests", "testing", "validation", "test plan"]) || "No testing strategy was specified in the PR description.");
	const warningSummary = warnings.length > 0 ? ` ${warnings.length} warning${warnings.length === 1 ? "" : "s"} need reviewer attention.` : "";
	return {
		id: "orientation-summary",
		phaseId: "orientation",
		title: "PR context",
		summary: `Why this PR was raised: ${why}${warningSummary}`,
		rationale: `Context to understand the PR: ${context}`,
		diffBlocks: [],
		checklist: [`Testing strategy: ${testing}`, ...warnings.slice(0, 2).map(warning => warning.filePath ? `${warning.filePath}: ${warning.message}` : warning.message)],
		cardSuggestions: warnings.slice(0, 3).map(warning => warning.filePath ? `${warning.filePath}: ${warning.message}` : warning.message),
	};
}

function buildGroupCard(phaseId: PrWalkthroughPhaseId, group: BlockGroup, assigned: Set<string>): PrWalkthroughCard {
	const blocks = selectBlocks(group.blocks, MAX_BLOCKS_PER_FALLBACK_CARD);
	for (const item of blocks) assigned.add(item.block.id);
	const fileList = unique(blocks.map(item => item.file.filePath));
	const titlePrefix = phaseId === "design" ? "Review architecture changes" : phaseId === "other" ? "Review edge-case files" : "Review significant changes";
	return {
		id: stableCardId(`${phaseId}-${group.key}`),
		phaseId,
		title: `${titlePrefix} in ${group.label}`,
		summary: `${formatCount(blocks.length, "diff block")} covering ${formatCount(fileList.length, "file")} with ${group.weight} changed lines.`,
		rationale: phaseId === "design"
			? "This top-level area carries the largest change weight and should be checked for design-level implications."
			: "These hunks are grouped by path and change weight so related concerns can be reviewed together.",
		diffBlocks: blocks.map(item => item.block),
		checklist: ["Check behavior changes", "Verify tests or safeguards", "Leave line comments where needed"],
	};
}

function buildOtherSmallChangesCard(groups: BlockGroup[], assigned: Set<string>): PrWalkthroughCard {
	const blocks = groups.flatMap(group => selectBlocks(group.blocks, MAX_BLOCKS_PER_FALLBACK_CARD)).slice(0, MAX_BLOCKS_PER_FALLBACK_CARD);
	for (const item of blocks) assigned.add(item.block.id);
	return {
		id: "other-small-changes",
		phaseId: "other",
		title: "Review smaller remaining files",
		summary: `${formatCount(blocks.length, "diff block")} from lower-risk or smaller path groups.`,
		rationale: "Small changes are grouped together to keep the walkthrough concise while preserving review anchors.",
		diffBlocks: blocks.map(item => item.block),
		checklist: ["Check for incidental regressions", "Confirm generated/low-risk classification is appropriate"],
	};
}

function buildAuditCard(remaining: WeightedBlock[]): PrWalkthroughCard {
	const blocks = selectBlocks(remaining, MAX_BLOCKS_PER_FALLBACK_CARD);
	return {
		id: "audit-remaining-hunks",
		phaseId: "audit",
		title: blocks.length > 0 ? "Audit remaining representative hunks" : "Audit walkthrough coverage",
		summary: blocks.length > 0
			? `${formatCount(blocks.length, "remaining diff block")} were not assigned to earlier logical cards and should receive a final pass.`
			: "All reviewable diff blocks were assigned to earlier cards; use this step to verify decisions and draft review output.",
		rationale: "The audit phase catches omissions without duplicating blocks already reviewed in earlier fallback cards.",
		diffBlocks: blocks.map(item => item.block),
		checklist: ["Confirm all phases are complete", "Review unresolved warnings", "Prepare final draft"],
	};
}

function buildSpecialGroup(blocks: WeightedBlock[]): BlockGroup | undefined {
	if (blocks.length === 0) return undefined;
	return {
		key: "special-files",
		label: "generated, binary, renamed, or deleted files",
		blocks: [...blocks].sort((a, b) => categoryOrder(a.category) - categoryOrder(b.category) || b.weight - a.weight || a.block.id.localeCompare(b.block.id)),
		weight: blocks.reduce((sum, item) => sum + item.weight, 0),
	};
}

function categoryOrder(category: WeightedBlock["category"]): number {
	return ["generated", "truncated", "binary", "deleted", "renamed", "normal"].indexOf(category);
}

function groupByTopLevel(blocks: WeightedBlock[]): BlockGroup[] {
	const groups = new Map<string, BlockGroup>();
	for (const block of blocks) {
		const existing = groups.get(block.topLevel) ?? { key: block.topLevel, label: block.topLevel, blocks: [], weight: 0 };
		existing.blocks.push(block);
		existing.weight += block.weight;
		groups.set(block.topLevel, existing);
	}
	return [...groups.values()];
}

function flattenWeightedBlocks(files: WalkthroughParsedFile[]): WeightedBlock[] {
	const weighted: WeightedBlock[] = [];
	for (const file of files) {
		for (const block of blocksForFile(file)) {
			weighted.push({
				block,
				file,
				weight: blockWeight(block),
				category: blockCategory(file),
				topLevel: topLevelPath(file.filePath || block.filePath),
			});
		}
	}
	return weighted.sort((a, b) => b.weight - a.weight || a.block.id.localeCompare(b.block.id));
}

function flattenBlocks(files: WalkthroughParsedFile[]): PrWalkthroughDiffBlock[] {
	return files.flatMap(file => blocksForFile(file));
}

function blocksForFile(file: WalkthroughParsedFile): PrWalkthroughDiffBlock[] {
	if (Array.isArray(file.diffBlocks)) return file.diffBlocks;
	const maybeBlock = file as WalkthroughParsedFile & Partial<PrWalkthroughDiffBlock>;
	return typeof maybeBlock.id === "string" && Array.isArray(maybeBlock.hunks) ? [maybeBlock as PrWalkthroughDiffBlock] : [];
}

function blockWeight(block: PrWalkthroughDiffBlock): number {
	let total = 0;
	for (const hunk of hunksForBlock(block)) {
		for (const line of hunk.lines) total += lineWeight(line);
	}
	return total;
}

function lineIdsForBlock(block: PrWalkthroughDiffBlock): string[] {
	return hunksForBlock(block).flatMap(hunk => hunk.lines.map(line => line.id));
}

function hunksForBlock(block: PrWalkthroughDiffBlock): DiffHunkForSynthesis[] {
	return (block as PrWalkthroughDiffBlock & DiffBlockForSynthesis).hunks;
}

function lineWeight(line: PrWalkthroughDiffLine): number {
	return line.kind === "context" ? 0 : 1;
}

function blockCategory(file: WalkthroughParsedFile): WeightedBlock["category"] {
	if (file.isBinary || file.status === "binary") return "binary";
	if (file.isGenerated || (file.warnings ?? []).some(warning => /generated/i.test(warning.code) || /generated/i.test(warning.message))) return "generated";
	if (file.isTruncated || (file.warnings ?? []).some(warning => /truncat/i.test(warning.code) || /truncat/i.test(warning.message))) return "truncated";
	if (file.status === "deleted") return "deleted";
	if (file.status === "renamed" || file.status === "copied") return "renamed";
	return "normal";
}

function topLevelPath(filePath: string): string {
	const normalised = filePath.replaceAll("\\", "/");
	const [first, second] = normalised.split("/");
	if (!second) return first || "root";
	if (first === "src" || first === "tests" || first === "docs") return `${first}/${second}`;
	return first;
}

function selectBlocks(blocks: WeightedBlock[], max: number): WeightedBlock[] {
	return blocks.slice(0, max);
}

function totalBlocks(groups: BlockGroup[]): number {
	return groups.reduce((sum, group) => sum + group.blocks.length, 0);
}

async function tryLlmSynthesis(
	changeset: PrWalkthroughChangesetRef,
	files: WalkthroughParsedFile[],
	warnings: WalkthroughWarning[],
	options: WalkthroughCardSynthesisOptions,
): Promise<PrWalkthroughCard[]> {
	if (!options.allowLlm || !options.llm) return [];
	const input: WalkthroughLlmInput = { changeset, files, warnings, diffBlockIds: flattenBlocks(files).map(block => block.id) };
	if (byteLength(input) > (options.maxLlmInputBytes ?? DEFAULT_MAX_LLM_INPUT_BYTES)) return [];
	try {
		const raw = typeof options.llm === "function" ? await options.llm(input) : await options.llm.synthesiseWalkthroughCards(input);
		return validateSynthesisedCards(parseLlmJson(raw), files);
	} catch {
		return [];
	}
}

function parseLlmJson(raw: unknown): unknown {
	if (typeof raw !== "string") return raw;
	const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
		return raw;
	}
}

function extractCardCandidates(raw: unknown): unknown[] {
	if (Array.isArray(raw)) return raw;
	if (isRecord(raw) && Array.isArray(raw.cards)) return raw.cards;
	return [];
}

function candidateBlockIds(candidate: Record<string, unknown>): string[] {
	const fromIds = Array.isArray(candidate.diffBlockIds) ? candidate.diffBlockIds.filter((id): id is string => typeof id === "string") : [];
	const fromBlocks = Array.isArray(candidate.diffBlocks)
		? candidate.diffBlocks.flatMap(block => isRecord(block) && typeof block.id === "string" ? [block.id] : typeof block === "string" ? [block] : [])
		: [];
	return [...fromIds, ...fromBlocks];
}

function validateSuggestedComments(
	raw: unknown,
	cardId: string,
	diffBlocks: PrWalkthroughDiffBlock[],
	lineIdsByBlock: Map<string, Set<string>>,
): PrWalkthroughSuggestedComment[] {
	if (!Array.isArray(raw)) return [];
	const validBlocks = new Set(diffBlocks.map(block => block.id));
	const comments: PrWalkthroughSuggestedComment[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (!isRecord(item)) continue;
		const diffBlockId = stringValue(item.diffBlockId);
		const lineId = stringValue(item.lineId);
		const body = stringValue(item.body);
		if (!diffBlockId || !lineId || !body || !validBlocks.has(diffBlockId) || !lineIdsByBlock.get(diffBlockId)?.has(lineId)) continue;
		comments.push({ id: stableCardId(`suggest-${cardId}-${diffBlockId}-${lineId}`, seen), cardId, diffBlockId, lineId, body });
	}
	return comments;
}

function stringArrayProp(key: "cardSuggestions" | "checklist", raw: unknown): Partial<Pick<PrWalkthroughCard, "cardSuggestions" | "checklist">> {
	const values = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [];
	return values.length > 0 ? { [key]: values } : {};
}

function collectFileWarnings(files: WalkthroughParsedFile[]): WalkthroughWarning[] {
	return files.flatMap(file => file.warnings ?? []);
}

function byteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf-8");
}

function formatCount(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function summarizeChangedAreas(files: WalkthroughParsedFile[]): string {
	return unique(files.map(file => file.filePath.split(/[\\/]/)[0]).filter(Boolean)).slice(0, 5).join(", ");
}

function extractPrSection(body: string | undefined, names: string[]): string | undefined {
	if (!body) return undefined;
	const lines = body.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const heading = normalizeHeading(lines[index]);
		if (!heading || !names.some(name => heading.includes(name))) continue;
		const section: string[] = [];
		for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
			if (normalizeHeading(lines[cursor])) break;
			section.push(lines[cursor]);
		}
		const text = compactText(section.join("\n"));
		if (text) return text;
	}
	return undefined;
}

function normalizeHeading(line: string): string | undefined {
	const cleaned = line.trim().replace(/^#{1,6}\s*/, "").replace(/[*_`:-]+$/g, "").trim().toLowerCase();
	if (!cleaned || cleaned.length > 80) return undefined;
	return /^(why|motivation|problem|summary|context|background|notes|implementation|test|tests|testing|validation|test plan)\b/.test(cleaned) ? cleaned : undefined;
}

function firstParagraph(body: string | undefined): string | undefined {
	return body?.split(/\n\s*\n/).map(part => compactText(part)).find(Boolean);
}

function compactText(value: string | undefined, maxLength = 220): string {
	const compact = (value ?? "")
		.replace(/<!--.*?-->/gs, " ")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/^[-*+]\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	return compact.length > maxLength ? `${compact.slice(0, maxLength - 1).trimEnd()}…` : compact;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

function stableCardId(input: string, seen?: Set<string>): string {
	const base = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "card";
	if (!seen) return base;
	let candidate = base;
	let suffix = 2;
	while (seen.has(candidate)) candidate = `${base}-${suffix++}`;
	seen.add(candidate);
	return candidate;
}

function limitCards(cards: PrWalkthroughCard[], maxCards = DEFAULT_MAX_CARDS): PrWalkthroughCard[] {
	return cards.slice(0, Math.max(1, maxCards));
}
