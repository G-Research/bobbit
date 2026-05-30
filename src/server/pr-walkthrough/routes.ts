import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { bobbitStateDir } from "../bobbit-dir.js";

const execFile = promisify(execFileCb);
const STORE_SCHEMA_VERSION = 1;

type JsonReader = (req: http.IncomingMessage) => Promise<any>;

type WalkthroughWarning = {
	code: string;
	severity: "info" | "warning" | "error";
	message: string;
	filePath?: string;
};

type DiffLine = {
	id: string;
	side: "old" | "new" | "context";
	oldLine?: number;
	newLine?: number;
	text: string;
	kind: "context" | "add" | "del";
};

type DiffHunk = { id: string; header: string; lines: DiffLine[] };
type DiffBlock = { id: string; filePath: string; oldPath?: string; status?: string; hunks: DiffHunk[]; externalUrl?: string; blobUrl?: string; rawUrl?: string; contentsUrl?: string };
type WalkthroughCard = {
	id: string;
	phaseId: "orientation" | "design" | "significant" | "other" | "audit";
	title: string;
	summary: string;
	rationale?: string;
	diffBlocks: DiffBlock[];
	checklist?: string[];
	cardSuggestions?: string[];
	suggestedComments?: Array<{ id: string; cardId: string; diffBlockId: string; lineId: string; body: string }>;
};

type WalkthroughChangeset = {
	baseSha: string;
	headSha: string;
	provider?: string;
	externalUrl?: string;
	prUrl?: string;
	prNumber?: string | number;
	prTitle?: string;
	title?: string;
	filesChanged?: number;
	additions?: number;
	deletions?: number;
};

type WalkthroughResolveResult = {
	changesetId: string;
	changeset: WalkthroughChangeset;
	cards: WalkthroughCard[];
	warnings: WalkthroughWarning[];
	limits?: Record<string, unknown>;
	export?: WalkthroughExportCapability;
};

type WalkthroughExportCapability = {
	provider?: string;
	available: boolean;
	reason?: string;
	previewOnly?: boolean;
	[key: string]: unknown;
};

type StoredWalkthrough = {
	schemaVersion: number;
	updatedAt: string;
	payload: WalkthroughResolveResult;
};

export type PrWalkthroughRouteDeps = {
	defaultCwd: string;
	readBody: JsonReader;
};

type WalkthroughLlmAdapter = (input: Record<string, unknown>) => Promise<unknown> | unknown;
let synthesisAdapterForTesting: WalkthroughLlmAdapter | undefined;
let configuredSynthesisAdapter: WalkthroughLlmAdapter | undefined | null;

export function setPrWalkthroughSynthesisAdapterForTesting(adapter: WalkthroughLlmAdapter | undefined): void {
	synthesisAdapterForTesting = adapter;
}

export async function handlePrWalkthroughApiRoute(
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
	deps: PrWalkthroughRouteDeps,
): Promise<boolean> {
	if (!url.pathname.startsWith("/api/pr-walkthrough")) return false;

	const json = (data: unknown, status = 200) => {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify(data));
	};
	const fail = (status: number, message: string, extra?: Record<string, unknown>) => {
		json({ error: message, ...extra }, status);
	};

	try {
		if (url.pathname === "/api/pr-walkthrough/resolve" && req.method === "POST") {
			const body = await deps.readBody(req);
			if (!body || typeof body !== "object") {
				fail(400, "Invalid resolve request");
				return true;
			}
			const result = await resolveWalkthrough(body, deps);
			await storeWalkthrough(result);
			json(result);
			return true;
		}

		const previewMatch = url.pathname.match(/^\/api\/pr-walkthrough\/(.+)\/export\/preview$/);
		if (previewMatch && req.method === "POST") {
			const changesetId = decodeURIComponent(previewMatch[1]);
			const stored = await loadWalkthrough(changesetId);
			if (!stored) {
				fail(404, `Walkthrough not found: ${changesetId}`);
				return true;
			}
			const draft = await deps.readBody(req);
			if (!draft || typeof draft !== "object") {
				fail(400, "Invalid review draft");
				return true;
			}
			json(await buildExportPreview(changesetId, stored.payload, draft));
			return true;
		}

		const submitMatch = url.pathname.match(/^\/api\/pr-walkthrough\/(.+)\/export\/submit$/);
		if (submitMatch && req.method === "POST") {
			const changesetId = decodeURIComponent(submitMatch[1]);
			const stored = await loadWalkthrough(changesetId);
			if (!stored) {
				fail(404, `Walkthrough not found: ${changesetId}`);
				return true;
			}
			const body = await deps.readBody(req);
			if (!body || typeof body !== "object") {
				fail(400, "Invalid export submit request");
				return true;
			}
			if (body.confirm !== true) {
				fail(400, "Explicit confirmation is required before submitting a GitHub review", { code: "CONFIRMATION_REQUIRED" });
				return true;
			}
			const result = await submitExport(changesetId, stored.payload, body);
			json(result, result.ok ? 200 : typeof result.status === "number" ? result.status : 400);
			return true;
		}

		const getMatch = url.pathname.match(/^\/api\/pr-walkthrough\/(.+)$/);
		if (getMatch && req.method === "GET") {
			const changesetId = decodeURIComponent(getMatch[1]);
			const stored = await loadWalkthrough(changesetId);
			if (!stored) {
				fail(404, `Walkthrough not found: ${changesetId}`);
				return true;
			}
			json({ ...stored.payload, updatedAt: stored.updatedAt, schemaVersion: stored.schemaVersion });
			return true;
		}

		fail(405, "Unsupported PR walkthrough route");
		return true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const typed = typedRouteError(err);
		const status = typed?.status ?? (/not found|unknown|invalid|missing|required/i.test(message) ? 400 : 500);
		fail(status, message, typed?.extra);
		return true;
	}
}

async function resolveWalkthrough(body: Record<string, unknown>, deps: PrWalkthroughRouteDeps): Promise<WalkthroughResolveResult> {
	if (body.fixture === true) return fixtureWalkthrough();

	const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : deps.defaultCwd;
	const baseSha = stringValue(body.baseSha);
	const headSha = stringValue(body.headSha);
	const prUrl = stringValue(body.prUrl);
	const prNumber = typeof body.prNumber === "number" || typeof body.prNumber === "string" ? body.prNumber : undefined;
	const wantsGithub = Boolean(prUrl || prNumber || body.provider === "github");

	if (wantsGithub && baseSha && headSha) {
		const local = await resolveLocalWithDelegation(cwd, baseSha, headSha);
		const gh = parseGithubRef(prUrl, prNumber, cwd);
		const head = shortSha(local.changeset.headSha);
		const changesetId = gh ? changesetIdForGithub(gh.owner, gh.repo, gh.number, head) : `github:unknown#${prNumber ?? "unknown"}:${head}`;
		return {
			...local,
			changesetId,
			changeset: {
				...local.changeset,
				provider: "github",
				prUrl: prUrl || gh?.url,
				prNumber: prNumber ?? gh?.number,
				externalUrl: prUrl || gh?.url,
				title: gh ? `PR #${gh.number}: ${local.changeset.title ?? "Walkthrough"}` : local.changeset.title,
			},
			export: { provider: "github", available: false, previewOnly: true, reason: "GitHub submission requires adapter credentials; preview is available." },
		};
	}

	if (wantsGithub) {
		const delegated = await tryResolveGithubWithDelegation({ cwd, prUrl, prNumber });
		if (delegated) return delegated;
		throw new Error("GitHub PR resolution is unavailable without local baseSha/headSha or the GitHub adapter");
	}

	if (!baseSha || !headSha) throw new Error("baseSha and headSha are required for local walkthrough resolution");
	return resolveLocalWithDelegation(cwd, baseSha, headSha);
}

async function resolveLocalWithDelegation(cwd: string, baseSha: string, headSha: string): Promise<WalkthroughResolveResult> {
	const delegated = await tryResolveLocalWithModules(cwd, baseSha, headSha);
	if (delegated) return delegated;
	return resolveLocalFallback(cwd, baseSha, headSha);
}

async function tryResolveLocalWithModules(cwd: string, baseSha: string, headSha: string): Promise<WalkthroughResolveResult | undefined> {
	const gitModule = await optionalPrModule("git-changeset");
	const resolveLocalChangeset = gitModule?.resolveLocalChangeset;
	if (typeof resolveLocalChangeset !== "function") return undefined;
	const resolved = await resolveLocalChangeset({ cwd, baseSha, headSha });
	if (isResolveResult(resolved)) return resolved;

	const changeset = resolved?.changeset ?? resolved?.metadata ?? resolved;
	const files = Array.isArray(resolved?.files) ? resolved.files : [];
	const warnings = Array.isArray(resolved?.warnings) ? resolved.warnings : [];
	const changesetId = typeof resolved?.changesetId === "string" ? resolved.changesetId : changesetIdForLocal(changeset?.baseSha ?? baseSha, changeset?.headSha ?? headSha);
	let cards = Array.isArray(resolved?.cards) ? resolved.cards : undefined;
	cards ??= await synthesizeCardsForResolver(changeset, files, warnings);
	return {
		changesetId,
		changeset,
		cards,
		warnings,
		limits: resolved?.limits,
		export: resolved?.export ?? { available: false, reason: "Local changesets can be previewed but not submitted to GitHub." },
	};
}

async function tryResolveGithubWithDelegation(input: Record<string, unknown>): Promise<WalkthroughResolveResult | undefined> {
	const module = await optionalPrModule("github-adapter");
	const resolveGithubPr = module?.resolveGithubPr;
	if (typeof resolveGithubPr !== "function") return undefined;
	const resolved = await resolveGithubPr(input);
	return normalizeGithubResolvedWalkthrough(resolved);
}

export async function normalizeGithubResolvedWalkthrough(resolved: any): Promise<WalkthroughResolveResult | undefined> {
	if (isResolveResult(resolved)) return resolved;
	if (!resolved?.changeset) return undefined;
	const warnings = Array.isArray(resolved.warnings) ? resolved.warnings : [];
	const files = Array.isArray(resolved.files) ? resolved.files : [];
	const cards = Array.isArray(resolved.cards)
		? resolved.cards
		: await synthesizeCardsForResolver(resolved.changeset, files, warnings);
	return {
		changesetId: typeof resolved.changesetId === "string" ? resolved.changesetId : changesetIdForLocal(resolved.changeset.baseSha, resolved.changeset.headSha),
		changeset: resolved.changeset,
		cards,
		warnings,
		limits: resolved.limits,
		export: resolved.export,
	};
}

async function synthesizeCardsForResolver(changeset: WalkthroughChangeset, files: any[], warnings: WalkthroughWarning[]): Promise<WalkthroughCard[]> {
	const synthesisModule = await optionalPrModule("card-synthesis");
	const synthesize = synthesisModule?.synthesiseWalkthroughCards ?? synthesisModule?.synthesizeWalkthroughCards;
	if (typeof synthesize === "function") {
		const llm = await resolveConfiguredSynthesisAdapter();
		const cards = await synthesize(changeset, files, { warnings, ...(llm ? { allowLlm: true, llm } : {}) });
		if (Array.isArray(cards) && cards.length > 0) return cards;
	}
	return synthesizeFallbackCards(changeset, flattenDiffBlocks(files), warnings);
}

async function resolveConfiguredSynthesisAdapter(): Promise<WalkthroughLlmAdapter | undefined> {
	if (synthesisAdapterForTesting) return synthesisAdapterForTesting;
	if (configuredSynthesisAdapter !== undefined) return configuredSynthesisAdapter ?? undefined;
	const modulePath = stringValue(process.env.BOBBIT_PR_WALKTHROUGH_SYNTHESIS_ADAPTER);
	if (!modulePath) {
		configuredSynthesisAdapter = null;
		return undefined;
	}
	const module = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
	const adapter = module.default ?? module.synthesiseWalkthroughCards ?? module.synthesizeWalkthroughCards ?? module.synthesise;
	configuredSynthesisAdapter = typeof adapter === "function" ? adapter : null;
	return configuredSynthesisAdapter ?? undefined;
}

function flattenDiffBlocks(files: any[]): DiffBlock[] {
	const blocks: DiffBlock[] = [];
	for (const file of files) {
		if (Array.isArray(file?.diffBlocks)) blocks.push(...file.diffBlocks.filter(isDiffBlock));
		else if (isDiffBlock(file)) blocks.push(file);
	}
	return blocks;
}

function isDiffBlock(value: any): value is DiffBlock {
	return typeof value?.id === "string" && typeof value?.filePath === "string" && Array.isArray(value?.hunks);
}

async function resolveLocalFallback(cwd: string, baseSha: string, headSha: string): Promise<WalkthroughResolveResult> {
	const base = await git(cwd, ["rev-parse", "--verify", `${baseSha}^{commit}`]).catch(() => {
		throw new Error(`Invalid baseSha: ${baseSha}`);
	});
	const head = await git(cwd, ["rev-parse", "--verify", `${headSha}^{commit}`]).catch(() => {
		throw new Error(`Invalid headSha: ${headSha}`);
	});
	const fullBase = base.trim();
	const fullHead = head.trim();
	const diff = await git(cwd, ["diff", "--no-ext-diff", "--find-renames", "--find-copies", "--binary", "--unified=80", fullBase, fullHead]);
	const nameStatus = await git(cwd, ["diff", "--name-status", "-M", "-C", fullBase, fullHead]);
	const shortstat = await git(cwd, ["diff", "--shortstat", fullBase, fullHead]).catch(() => "");
	const warnings: WalkthroughWarning[] = [];
	const blocks = parseUnifiedDiff(diff, warnings);
	applyNameStatus(blocks, nameStatus);
	const stats = parseShortstat(shortstat, blocks.length);
	const changeset: WalkthroughChangeset = {
		baseSha: fullBase,
		headSha: fullHead,
		provider: "local",
		title: `${shortSha(fullBase)}..${shortSha(fullHead)}`,
		filesChanged: stats.filesChanged,
		additions: stats.additions,
		deletions: stats.deletions,
	};
	const cards = synthesizeFallbackCards(changeset, blocks, warnings);
	return {
		changesetId: changesetIdForLocal(fullBase, fullHead),
		changeset,
		cards,
		warnings,
		export: { available: false, reason: "Local changesets can be previewed but not submitted to GitHub." },
	};
}

function parseUnifiedDiff(diff: string, warnings: WalkthroughWarning[]): DiffBlock[] {
	const lines = diff.split(/\r?\n/);
	const blocks: DiffBlock[] = [];
	let block: DiffBlock | undefined;
	let hunk: DiffHunk | undefined;
	let oldLine = 0;
	let newLine = 0;
	let hunkIndex = -1;

	for (const raw of lines) {
		if (raw.startsWith("diff --git ")) {
			const match = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
			const filePath = match?.[2] ?? raw.replace(/^diff --git\s+/, "");
			block = { id: `block-${blocks.length + 1}-${slug(filePath)}`, filePath, oldPath: match?.[1], status: "modified", hunks: [] };
			blocks.push(block);
			hunk = undefined;
			hunkIndex = -1;
			continue;
		}
		if (!block) continue;
		if (raw.startsWith("new file mode")) block.status = "added";
		else if (raw.startsWith("deleted file mode")) block.status = "deleted";
		else if (raw.startsWith("rename from ")) { block.oldPath = raw.slice("rename from ".length); block.status = "renamed"; }
		else if (raw.startsWith("rename to ")) { block.filePath = raw.slice("rename to ".length); block.id = block.id.replace(/-[^-]*$/, `-${slug(block.filePath)}`); }
		else if (raw.startsWith("copy from ")) { block.oldPath = raw.slice("copy from ".length); block.status = "copied"; }
		else if (raw.startsWith("Binary files ")) {
			block.status = "binary";
			warnings.push({ code: "binary-file", severity: "warning", message: `Binary file cannot be rendered: ${block.filePath}`, filePath: block.filePath });
		}
		else if (raw.startsWith("--- ")) {
			const p = raw.slice(4).trim();
			if (p.startsWith("a/")) block.oldPath = p.slice(2);
		}
		else if (raw.startsWith("+++ ")) {
			const p = raw.slice(4).trim();
			if (p.startsWith("b/")) block.filePath = p.slice(2);
		}
		else if (raw.startsWith("@@ ")) {
			const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			oldLine = match ? Number(match[1]) : 0;
			newLine = match ? Number(match[2]) : 0;
			hunkIndex += 1;
			hunk = { id: `${block.id}-h${hunkIndex + 1}`, header: raw, lines: [] };
			block.hunks.push(hunk);
		}
		else if (hunk && (raw.startsWith(" ") || raw.startsWith("+") || raw.startsWith("-"))) {
			const lineIndex = hunk.lines.length;
			const prefix = raw[0];
			const text = raw.slice(1);
			if (prefix === " ") {
				hunk.lines.push({ id: `${block.id}:h${hunkIndex}:l${lineIndex}`, side: "context", oldLine, newLine, kind: "context", text });
				oldLine += 1;
				newLine += 1;
			} else if (prefix === "+") {
				hunk.lines.push({ id: `${block.id}:h${hunkIndex}:l${lineIndex}`, side: "new", newLine, kind: "add", text });
				newLine += 1;
			} else {
				hunk.lines.push({ id: `${block.id}:h${hunkIndex}:l${lineIndex}`, side: "old", oldLine, kind: "del", text });
				oldLine += 1;
			}
		}
	}
	return blocks;
}

function applyNameStatus(blocks: DiffBlock[], nameStatus: string): void {
	for (const line of nameStatus.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		const code = parts[0];
		const status = code.startsWith("R") ? "renamed"
			: code.startsWith("C") ? "copied"
			: code === "A" ? "added"
			: code === "D" ? "deleted"
			: code === "M" ? "modified"
			: undefined;
		const filePath = parts.at(-1);
		const block = blocks.find(item => item.filePath === filePath || item.oldPath === filePath);
		if (block && status) {
			block.status = block.status === "binary" ? "binary" : status;
			if ((status === "renamed" || status === "copied") && parts[1]) block.oldPath = parts[1];
		}
	}
}

function synthesizeFallbackCards(changeset: WalkthroughChangeset, files: DiffBlock[], warnings: WalkthroughWarning[]): WalkthroughCard[] {
	const cards: WalkthroughCard[] = [{
		id: "orientation-summary",
		phaseId: "orientation",
		title: changeset.title ? `Review ${changeset.title}` : "Review changeset",
		summary: `${changeset.filesChanged ?? files.length} files changed with ${changeset.additions ?? 0} additions and ${changeset.deletions ?? 0} deletions.`,
		rationale: warnings.length ? `${warnings.length} warnings need reviewer attention.` : "Generated from the resolved changeset.",
		diffBlocks: files.slice(0, 1),
		checklist: ["Confirm scope", "Check generated warnings", "Review changed files"],
	}];
	if (files.length > 0) {
		const reviewBlocks = files.filter(file => file.status !== "binary");
		cards.push({
			id: "significant-files",
			phaseId: "significant",
			title: "Changed files",
			summary: `Review ${reviewBlocks.length || files.length} diff-backed file${(reviewBlocks.length || files.length) === 1 ? "" : "s"}.`,
			diffBlocks: reviewBlocks.length ? reviewBlocks : files,
		});
		cards.push({
			id: "audit-coverage",
			phaseId: "audit",
			title: "Audit remaining coverage",
			summary: "Final pass over the resolved diff and any unreviewable files.",
			diffBlocks: files,
			cardSuggestions: warnings.map(warning => warning.message),
		});
	}
	return cards;
}

async function buildExportPreview(changesetId: string, payload: WalkthroughResolveResult, draft: any): Promise<Record<string, unknown>> {
	const delegated = await tryBuildExportPreview(changesetId, payload, draft);
	if (delegated) return delegated;

	const comments = Array.isArray(draft.comments) ? draft.comments : [];
	const rows = comments.map((comment: any) => mapComment(comment, payload.cards));
	const cardComments = comments.filter((comment: any) => !comment.diffBlockId && !comment.lineId);
	const body = [
		`Review draft for ${payload.changeset.title ?? changesetId}`,
		...cardComments.map((comment: any) => {
			const card = payload.cards.find(item => item.id === comment.cardId);
			return `- ${card?.title ?? comment.cardId}: ${comment.body ?? ""}`;
		}),
	].join("\n");
	return {
		changesetId,
		provider: payload.changeset.provider,
		available: payload.export?.available ?? false,
		canSubmit: Boolean(payload.export?.available && payload.export.provider === "github" && rows.some((row: any) => row.valid)),
		body,
		rows,
		warnings: rows.filter((row: any) => !row.valid).map((row: any) => ({ code: "unmappable-comment", severity: "warning", message: row.reason, commentId: row.commentId })),
	};
}

async function tryBuildExportPreview(changesetId: string, payload: WalkthroughResolveResult, draft: any): Promise<Record<string, unknown> | undefined> {
	const module = await optionalPrModule("export-mapper");
	const buildGithubReviewPreview = module?.buildGithubReviewPreview;
	if (typeof buildGithubReviewPreview !== "function") return undefined;
	return buildGithubReviewPreview(draft, payload.cards, payload.changeset, { changesetId, export: payload.export });
}

function mapComment(comment: any, cards: WalkthroughCard[]): Record<string, unknown> {
	if (!comment?.diffBlockId || !comment?.lineId) {
		return { commentId: comment?.id, body: comment?.body ?? "", valid: false, reason: "Card-level comments are included in the review body." };
	}
	const card = cards.find(item => item.id === comment.cardId);
	const block = card?.diffBlocks.find(item => item.id === comment.diffBlockId);
	const line = block?.hunks.flatMap(hunk => hunk.lines).find(item => item.id === comment.lineId);
	if (!card || !block || !line) {
		return { commentId: comment.id, body: comment.body ?? "", valid: false, reason: "Comment anchor no longer maps to a resolved diff line." };
	}
	const lineNumber = line.newLine ?? line.oldLine;
	if (!lineNumber) {
		return { commentId: comment.id, path: block.filePath, body: comment.body ?? "", valid: false, reason: "Diff line has no GitHub-reviewable line number." };
	}
	return {
		commentId: comment.id,
		path: block.filePath,
		side: line.side === "old" ? "LEFT" : "RIGHT",
		line: lineNumber,
		body: comment.body ?? "",
		valid: true,
	};
}

async function submitExport(changesetId: string, payload: WalkthroughResolveResult, body: any): Promise<Record<string, unknown>> {
	void changesetId;
	if (payload.export?.provider !== "github" || payload.export.available !== true) {
		return { ok: false, error: "GitHub review submission is unavailable for this walkthrough", code: "EXPORT_UNAVAILABLE" };
	}
	const module = await optionalPrModule("export-mapper");
	const buildGithubReviewPreview = module?.buildGithubReviewPreview;
	const submitGithubReview = module?.submitGithubReview;
	if (typeof buildGithubReviewPreview === "function" && typeof submitGithubReview === "function") {
		const preview = buildGithubReviewPreview(body.draft, payload.cards, payload.changeset);
		return submitGithubReview(preview, { confirm: true, event: body.event });
	}
	return { ok: false, error: "GitHub review submission adapter is unavailable", code: "EXPORT_ADAPTER_UNAVAILABLE" };
}

export const submitExportForTesting = submitExport;

async function storeWalkthrough(payload: WalkthroughResolveResult): Promise<void> {
	const module = await optionalPrModule("walkthrough-store");
	const store = module?.storeWalkthrough ?? module?.saveWalkthrough;
	if (typeof store === "function") {
		await store(payload);
		return;
	}
	const stored: StoredWalkthrough = { schemaVersion: STORE_SCHEMA_VERSION, updatedAt: new Date().toISOString(), payload };
	await fs.mkdir(storeDir(), { recursive: true });
	await fs.writeFile(storePath(payload.changesetId), JSON.stringify(stored, null, 2), "utf-8");
}

async function loadWalkthrough(changesetId: string): Promise<StoredWalkthrough | undefined> {
	const module = await optionalPrModule("walkthrough-store");
	const load = module?.loadWalkthrough ?? module?.getWalkthrough;
	if (typeof load === "function") {
		const loaded = await load(changesetId);
		if (loaded?.payload) return loaded;
		if (loaded?.changesetId) return { schemaVersion: STORE_SCHEMA_VERSION, updatedAt: loaded.updatedAt ?? new Date().toISOString(), payload: loaded };
	}
	try {
		const raw = await fs.readFile(storePath(changesetId), "utf-8");
		const parsed = JSON.parse(raw) as StoredWalkthrough;
		if (parsed.schemaVersion !== STORE_SCHEMA_VERSION) return undefined;
		return parsed;
	} catch (err: any) {
		if (err?.code === "ENOENT") return undefined;
		throw err;
	}
}

function storeDir(): string {
	return path.join(bobbitStateDir(), "pr-walkthrough");
}

function storePath(changesetId: string): string {
	return path.join(storeDir(), `${Buffer.from(changesetId).toString("base64url")}.json`);
}

function typedRouteError(err: unknown): { status: number; extra: Record<string, unknown> } | undefined {
	if (!err || typeof err !== "object") return undefined;
	const candidate = err as { status?: unknown; code?: unknown; warnings?: unknown };
	const status = typeof candidate.status === "number" && candidate.status >= 400 && candidate.status < 600 ? candidate.status : undefined;
	if (!status && typeof candidate.code !== "string" && !Array.isArray(candidate.warnings)) return undefined;
	return {
		status: status ?? 500,
		extra: {
			...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
			...(Array.isArray(candidate.warnings) ? { warnings: candidate.warnings } : {}),
		},
	};
}

async function optionalPrModule(name: string): Promise<any | undefined> {
	try {
		return await import(`./${name}.js`);
	} catch (err: any) {
		if (err?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find module|module not found/i.test(String(err?.message))) return undefined;
		throw err;
	}
}

function isResolveResult(value: any): value is WalkthroughResolveResult {
	return typeof value?.changesetId === "string" && value?.changeset && Array.isArray(value?.cards) && Array.isArray(value?.warnings);
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 });
	return stdout;
}

function parseShortstat(shortstat: string, fallbackFiles: number): { filesChanged: number; additions: number; deletions: number } {
	return {
		filesChanged: Number(shortstat.match(/(\d+) files? changed/)?.[1] ?? fallbackFiles),
		additions: Number(shortstat.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0),
		deletions: Number(shortstat.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0),
	};
}

function changesetIdForLocal(baseSha: string, headSha: string): string {
	return `${shortSha(baseSha)}..${shortSha(headSha)}`;
}

function changesetIdForGithub(owner: string, repo: string, number: string | number, headSha?: string): string {
	return `github:${owner}/${repo}#${number}:${headSha || "unknown"}`;
}

function shortSha(sha: string): string {
	return sha.slice(0, 7);
}

function slug(value: string): string {
	const clean = value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48);
	return clean || "file";
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseGithubRef(prUrl: string | undefined, prNumber: string | number | undefined, cwd: string): { owner: string; repo: string; number: string | number; url: string } | undefined {
	if (prUrl) {
		const match = prUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
		if (match) return { owner: match[1], repo: match[2], number: prNumber ?? match[3], url: prUrl };
	}
	void cwd;
	return undefined;
}

function fixtureWalkthrough(): WalkthroughResolveResult {
	const changeset: WalkthroughChangeset = {
		baseSha: "fixture-base",
		headSha: "fixture-head",
		provider: "fixture",
		title: "Fixture PR walkthrough",
		filesChanged: 1,
		additions: 1,
		deletions: 0,
	};
	const block: DiffBlock = {
		id: "fixture-block",
		filePath: "README.md",
		hunks: [{ id: "fixture-block-h1", header: "@@ -0,0 +1 @@", lines: [{ id: "fixture-block:h0:l0", side: "new", newLine: 1, kind: "add", text: "Fixture walkthrough" }] }],
	};
	return {
		changesetId: "fixture-base..fixture-head",
		changeset,
		cards: [{ id: "orientation-summary", phaseId: "orientation", title: "Fixture walkthrough", summary: "Fixture-backed walkthrough for tests and development.", diffBlocks: [block] }],
		warnings: [],
		export: { available: false, reason: "Fixture walkthroughs cannot be submitted." },
	};
}
