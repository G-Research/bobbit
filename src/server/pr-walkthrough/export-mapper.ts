export type GithubReviewEvent = "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
export type GithubReviewSide = "RIGHT" | "LEFT";

export interface PrWalkthroughChangesetRef {
	baseSha: string;
	headSha: string;
	provider?: string;
	externalUrl?: string;
	prUrl?: string;
	prNumber?: string | number;
	prTitle?: string;
	prBody?: string;
	title?: string;
	owner?: string;
	repo?: string;
	repository?: string;
}

export interface PrWalkthroughDiffLine {
	id: string;
	side: "old" | "new" | "context";
	oldLine?: number;
	newLine?: number;
	text: string;
	kind: "context" | "add" | "del";
}

export interface PrWalkthroughHunk {
	id: string;
	header: string;
	lines: PrWalkthroughDiffLine[];
}

export interface PrWalkthroughDiffBlock {
	id: string;
	filePath: string;
	oldPath?: string;
	hunks: PrWalkthroughHunk[];
	status?: string;
	isBinary?: boolean;
	isTruncated?: boolean;
}

export interface PrWalkthroughCard {
	id: string;
	phaseId: string;
	title: string;
	summary: string;
	diffBlocks: PrWalkthroughDiffBlock[];
}

export interface PrWalkthroughComment {
	id: string;
	cardId: string;
	diffBlockId?: string;
	lineId?: string;
	body: string;
	source: "custom" | "suggested";
	createdAt: string;
	updatedAt?: string;
}

export interface PrWalkthroughDecision {
	cardId: string;
	value: "liked" | "disliked";
	commentIds: string[];
	updatedAt: string;
}

export interface PrWalkthroughReviewDraft {
	changeset: PrWalkthroughChangesetRef;
	decisions: Record<string, PrWalkthroughDecision>;
	comments: PrWalkthroughComment[];
	completedCardIds: string[];
	updatedAt: string;
}

export interface WalkthroughExportWarning {
	code: string;
	severity: "info" | "warning" | "error";
	message: string;
	commentId?: string;
}

export interface GithubReviewTarget {
	provider: "github";
	owner: string;
	repo: string;
	prNumber: number;
	prUrl?: string;
	headSha?: string;
}

export interface GithubReviewPreviewRow {
	id: string;
	commentId: string;
	cardId: string;
	cardTitle?: string;
	diffBlockId?: string;
	lineId?: string;
	path?: string;
	side?: GithubReviewSide;
	line?: number;
	body: string;
	valid: boolean;
	reason?: string;
}

export interface GithubReviewPreview {
	provider: "github";
	target?: GithubReviewTarget;
	body: string;
	rows: GithubReviewPreviewRow[];
	validCommentCount: number;
	unmappableCommentCount: number;
	warnings: WalkthroughExportWarning[];
	generatedAt: string;
}

export interface SubmitGithubReviewConfirmation {
	confirm?: boolean;
	event?: GithubReviewEvent;
	token?: string;
}

export interface SubmitGithubReviewOptions {
	fetch?: FetchLike;
	apiBaseUrl?: string;
	token?: string;
}

export interface GithubReviewSubmitResult {
	ok: boolean;
	status: number;
	submitted: boolean;
	message: string;
	reviewUrl?: string;
	response?: unknown;
	warnings?: WalkthroughExportWarning[];
}

interface IndexedLine {
	card: PrWalkthroughCard;
	block: PrWalkthroughDiffBlock;
	line: PrWalkthroughDiffLine;
}

interface FetchHeadersLike {
	get(name: string): string | null;
}

interface FetchResponseLike {
	ok: boolean;
	status: number;
	statusText: string;
	headers?: FetchHeadersLike;
	json(): Promise<unknown>;
	text(): Promise<string>;
}

type FetchLike = (url: string, init?: {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}) => Promise<FetchResponseLike>;

export function buildGithubReviewPreview(
	draft: PrWalkthroughReviewDraft,
	cards: PrWalkthroughCard[],
	changeset: PrWalkthroughChangesetRef = draft.changeset,
): GithubReviewPreview {
	const target = githubTargetFromChangeset(changeset);
	const warnings: WalkthroughExportWarning[] = [];
	if (!target) {
		warnings.push({ code: "github_target_missing", severity: "error", message: "This walkthrough is not linked to a GitHub pull request." });
	}

	const lineIndex = indexDiffLines(cards);
	const cardById = new Map(cards.map(card => [card.id, card]));
	const cardLevelComments: PrWalkthroughComment[] = [];
	const rows: GithubReviewPreviewRow[] = [];

	for (const comment of draft.comments) {
		const trimmedBody = comment.body.trim();
		if (!comment.diffBlockId && !comment.lineId) {
			if (trimmedBody) cardLevelComments.push({ ...comment, body: trimmedBody });
			continue;
		}
		const card = cardById.get(comment.cardId);
		const mapped = mapLineComment(comment, lineIndex, card);
		rows.push(mapped);
		if (!mapped.valid) {
			warnings.push({ code: "github_comment_unmappable", severity: "warning", message: mapped.reason ?? "Comment cannot be mapped to a GitHub review line.", commentId: comment.id });
		}
	}

	const validCommentCount = rows.filter(row => row.valid).length;
	const unmappableCommentCount = rows.length - validCommentCount;
	if (unmappableCommentCount > 0) {
		warnings.push({
			code: "github_unmappable_comments",
			severity: "warning",
			message: `${unmappableCommentCount} line comment${unmappableCommentCount === 1 ? "" : "s"} cannot be submitted to GitHub and will stay in the draft body/preview.`,
		});
	}

	return {
		provider: "github",
		target,
		body: buildReviewBody(draft, cards, cardLevelComments, rows),
		rows,
		validCommentCount,
		unmappableCommentCount,
		warnings,
		generatedAt: new Date().toISOString(),
	};
}

function externalNetworkBlockedForTests(): boolean {
	return process.env.BOBBIT_TEST_NO_EXTERNAL === "1" || process.env.BOBBIT_E2E === "1";
}

function isLocalHttpUrl(raw: string): boolean {
	try {
		const host = new URL(raw).hostname.toLowerCase();
		return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
	} catch {
		return false;
	}
}

export async function submitGithubReview(
	preview: GithubReviewPreview,
	confirmation: SubmitGithubReviewConfirmation,
	options: SubmitGithubReviewOptions = {},
): Promise<GithubReviewSubmitResult> {
	if (confirmation.confirm !== true) {
		return { ok: false, status: 400, submitted: false, message: "Explicit confirm=true is required before submitting a GitHub review." };
	}
	if (!preview.target) {
		return { ok: false, status: 400, submitted: false, message: "No GitHub pull request target is available for this review preview.", warnings: preview.warnings };
	}

	const token = cleanString(confirmation.token) ?? cleanString(options.token) ?? cleanString(process.env.GITHUB_TOKEN) ?? cleanString(process.env.GH_TOKEN);
	if (!token) {
		return { ok: false, status: 401, submitted: false, message: "Set GITHUB_TOKEN or GH_TOKEN before submitting a GitHub review.", warnings: preview.warnings };
	}

	const payload = createGithubReviewPayload(preview, confirmation.event ?? "COMMENT");
	const apiBaseUrl = cleanString(options.apiBaseUrl) ?? cleanString(process.env.BOBBIT_GITHUB_API_BASE_URL) ?? "https://api.github.com";
	if (externalNetworkBlockedForTests() && !options.fetch && !isLocalHttpUrl(apiBaseUrl)) {
		return { ok: false, status: 403, submitted: false, message: `External GitHub API access is disabled in tests: ${apiBaseUrl}`, warnings: preview.warnings };
	}
	const url = `${apiBaseUrl}/repos/${encodeURIComponent(preview.target.owner)}/${encodeURIComponent(preview.target.repo)}/pulls/${preview.target.prNumber}/reviews`;
	const response = await (options.fetch ?? fetch)(url, {
		method: "POST",
		headers: {
			Accept: "application/vnd.github+json",
			"Content-Type": "application/json",
			"User-Agent": "bobbit-pr-walkthrough",
			"X-GitHub-Api-Version": "2022-11-28",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(20_000),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => response.statusText);
		return { ok: false, status: response.status, submitted: false, message: `GitHub review submission failed (${response.status}): ${text || response.statusText}`, warnings: preview.warnings };
	}

	const json = await response.json().catch(() => ({}));
	return {
		ok: true,
		status: response.status,
		submitted: true,
		message: "GitHub review submitted.",
		reviewUrl: reviewUrlFromResponse(json),
		response: json,
		warnings: preview.warnings,
	};
}

export function createGithubReviewPayload(preview: GithubReviewPreview, event: GithubReviewEvent = "COMMENT"): Record<string, unknown> {
	const comments = preview.rows
		.filter(row => row.valid && row.path && row.side && Number.isInteger(row.line) && (row.line ?? 0) > 0)
		.map(row => ({ path: row.path, side: row.side, line: row.line, body: row.body }));
	return {
		body: preview.body,
		event,
		...(preview.target?.headSha ? { commit_id: preview.target.headSha } : {}),
		comments,
	};
}

function mapLineComment(comment: PrWalkthroughComment, lineIndex: Map<string, IndexedLine>, card: PrWalkthroughCard | undefined): GithubReviewPreviewRow {
	const base = {
		id: `row:${comment.id}`,
		commentId: comment.id,
		cardId: comment.cardId,
		cardTitle: card?.title,
		diffBlockId: comment.diffBlockId,
		lineId: comment.lineId,
		body: comment.body.trim(),
	};
	if (!base.body) return { ...base, valid: false, reason: "Comment body is empty." };
	if (!comment.diffBlockId || !comment.lineId) return { ...base, valid: false, reason: "Line comments need both a diff block and line anchor." };
	const indexed = lineIndex.get(lineKey(comment.cardId, comment.diffBlockId, comment.lineId));
	if (!indexed) return { ...base, valid: false, reason: "Diff line anchor was not found in the current walkthrough cards." };
	if (isUnreviewableBlock(indexed.block)) return { ...base, path: indexed.block.filePath, valid: false, reason: "This file has no GitHub-reviewable text diff." };
	const sideAndLine = githubSideAndLine(indexed.line);
	if (!sideAndLine) return { ...base, path: indexed.block.filePath, valid: false, reason: "Diff line has no old or new line number for GitHub." };
	return {
		...base,
		path: indexed.block.filePath,
		side: sideAndLine.side,
		line: sideAndLine.line,
		valid: true,
	};
}

function githubSideAndLine(line: PrWalkthroughDiffLine): { side: GithubReviewSide; line: number } | undefined {
	if (line.side !== "old" && typeof line.newLine === "number" && line.newLine > 0) return { side: "RIGHT", line: line.newLine };
	if (typeof line.oldLine === "number" && line.oldLine > 0) return { side: "LEFT", line: line.oldLine };
	return undefined;
}

function indexDiffLines(cards: PrWalkthroughCard[]): Map<string, IndexedLine> {
	const index = new Map<string, IndexedLine>();
	for (const card of cards) {
		for (const block of card.diffBlocks) {
			for (const hunk of block.hunks) {
				for (const line of hunk.lines) {
					index.set(lineKey(card.id, block.id, line.id), { card, block, line });
				}
			}
		}
	}
	return index;
}

function lineKey(cardId: string, diffBlockId: string, lineId: string): string {
	return `${cardId}\u0000${diffBlockId}\u0000${lineId}`;
}

function buildReviewBody(
	draft: PrWalkthroughReviewDraft,
	cards: PrWalkthroughCard[],
	cardLevelComments: PrWalkthroughComment[],
	rows: GithubReviewPreviewRow[],
): string {
	const cardById = new Map(cards.map(card => [card.id, card]));
	const liked = Object.values(draft.decisions).filter(decision => decision.value === "liked").length;
	const disliked = Object.values(draft.decisions).filter(decision => decision.value === "disliked").length;
	const lines = ["Bobbit PR walkthrough draft", ""];
	if (draft.changeset.title) lines.push(`Changeset: ${draft.changeset.title}`);
	if (draft.changeset.externalUrl || draft.changeset.prUrl) lines.push(`Source: ${draft.changeset.externalUrl ?? draft.changeset.prUrl}`);
	lines.push(`Reviewed cards: ${draft.completedCardIds.length}`);
	lines.push(`Decisions: ${liked} liked, ${disliked} disliked`);
	lines.push(`GitHub line comments ready: ${rows.filter(row => row.valid).length}`);

	const unmappableRows = rows.filter(row => !row.valid);
	if (unmappableRows.length > 0) {
		lines.push("", "Unmappable line comments:");
		for (const row of unmappableRows) lines.push(`- ${row.cardTitle ?? row.cardId}: ${row.body}${row.reason ? ` (${row.reason})` : ""}`);
	}

	if (cardLevelComments.length > 0) {
		lines.push("", "Card-level comments:");
		for (const comment of cardLevelComments) {
			const title = cardById.get(comment.cardId)?.title ?? comment.cardId;
			lines.push(`- ${title}: ${comment.body}`);
		}
	}

	return lines.join("\n").trim();
}

function githubTargetFromChangeset(changeset: PrWalkthroughChangesetRef): GithubReviewTarget | undefined {
	const url = cleanString(changeset.prUrl) ?? cleanString(changeset.externalUrl);
	const fromUrl = url ? parseGithubPullUrl(url) : undefined;
	const repoParts = splitRepository(cleanString(changeset.repository));
	const owner = cleanString(changeset.owner) ?? fromUrl?.owner ?? repoParts?.owner;
	const repo = cleanString(changeset.repo) ?? fromUrl?.repo ?? repoParts?.repo;
	const prNumber = normalizePrNumber(changeset.prNumber) ?? fromUrl?.number;
	if (!owner || !repo || !prNumber) return undefined;
	return { provider: "github", owner, repo, prNumber, prUrl: url, headSha: cleanString(changeset.headSha) };
}

function parseGithubPullUrl(value: string): { owner: string; repo: string; number: number } | undefined {
	try {
		const url = new URL(value);
		const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/i.exec(url.pathname);
		if (!match) return undefined;
		return { owner: decodeURIComponent(match[1]), repo: decodeURIComponent(match[2]).replace(/\.git$/i, ""), number: Number(match[3]) };
	} catch {
		return undefined;
	}
}

function splitRepository(repository: string | undefined): { owner: string; repo: string } | undefined {
	if (!repository) return undefined;
	const [owner, repo] = repository.split("/");
	return owner && repo ? { owner, repo } : undefined;
}

function normalizePrNumber(value: string | number | undefined): number | undefined {
	const raw = typeof value === "number" ? String(Math.trunc(value)) : cleanString(value);
	if (!raw) return undefined;
	const normalized = raw.replace(/^#/, "").trim();
	return /^\d+$/.test(normalized) ? Number(normalized) : undefined;
}

function isUnreviewableBlock(block: PrWalkthroughDiffBlock): boolean {
	return block.isBinary === true || block.isTruncated === true || /^(binary|truncated)$/i.test(block.status ?? "") || block.hunks.length === 0;
}

function reviewUrlFromResponse(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const htmlUrl = (value as { html_url?: unknown }).html_url;
	return typeof htmlUrl === "string" ? htmlUrl : undefined;
}

function cleanString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
