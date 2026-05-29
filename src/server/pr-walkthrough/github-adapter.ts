import { execFileSafe } from "../exec-file-safe.js";

export type GithubDiffLineSide = "old" | "new" | "context";
export type GithubDiffLineKind = "context" | "add" | "del";

export interface GithubDiffLine {
	id: string;
	side: GithubDiffLineSide;
	oldLine?: number;
	newLine?: number;
	text: string;
	kind: GithubDiffLineKind;
}

export interface GithubDiffHunk {
	id: string;
	header: string;
	lines: GithubDiffLine[];
}

export interface GithubDiffBlock {
	id: string;
	filePath: string;
	oldPath?: string;
	hunks: GithubDiffHunk[];
}

export interface GithubWalkthroughChangesetRef {
	baseSha: string;
	headSha: string;
	provider: "github";
	externalUrl: string;
	prUrl: string;
	prNumber: number;
	prTitle: string;
	title: string;
	filesChanged?: number;
	additions?: number;
	deletions?: number;
	owner: string;
	repo: string;
}

export interface GithubWalkthroughFile {
	filePath: string;
	oldPath?: string;
	status: "added" | "modified" | "deleted" | "renamed" | "copied" | "binary";
	additions: number;
	deletions: number;
	changes: number;
	patch?: string;
	blobUrl?: string;
	rawUrl?: string;
	contentsUrl?: string;
	diffBlocks: GithubDiffBlock[];
}

export interface GithubWalkthroughWarning {
	code: string;
	severity: "info" | "warning" | "error";
	message: string;
	filePath?: string;
}

export interface GithubWalkthroughExportCapability {
	provider: "github";
	available: boolean;
	owner: string;
	repo: string;
	prNumber: number;
	url: string;
	reason?: string;
}

export interface GithubResolvedPr {
	changesetId: string;
	changeset: GithubWalkthroughChangesetRef;
	files: GithubWalkthroughFile[];
	warnings: GithubWalkthroughWarning[];
	export: GithubWalkthroughExportCapability;
	provider: {
		name: "github";
		owner: string;
		repo: string;
		prNumber: number;
		prUrl: string;
		apiUrl: string;
		baseSha: string;
		headSha: string;
	};
}

export interface ResolveGithubPrOptions {
	cwd?: string;
	prUrl?: string;
	prNumber?: string | number;
	token?: string;
	fetch?: FetchLike;
	apiBaseUrl?: string;
	maxFiles?: number;
}

export interface ParsedGithubPrReference {
	owner?: string;
	repo?: string;
	number?: number;
	host?: string;
	url?: string;
}

interface GithubApiPullRequest {
	number: number;
	title: string;
	html_url: string;
	base: { sha: string };
	head: { sha: string };
	changed_files?: number;
	additions?: number;
	deletions?: number;
}

interface GithubApiChangedFile {
	filename: string;
	previous_filename?: string;
	status: string;
	additions?: number;
	deletions?: number;
	changes?: number;
	blob_url?: string;
	raw_url?: string;
	contents_url?: string;
	patch?: string;
}

interface FetchHeadersLike {
	get(name: string): string | null;
}

interface FetchResponseLike {
	ok: boolean;
	status: number;
	statusText: string;
	headers: FetchHeadersLike;
	json(): Promise<unknown>;
	text(): Promise<string>;
}

type FetchLike = (url: string, init?: {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}) => Promise<FetchResponseLike>;

export class GithubPrAdapterError extends Error {
	readonly status: number;
	readonly code: string;
	readonly warnings: GithubWalkthroughWarning[];

	constructor(message: string, options: { status?: number; code?: string; warnings?: GithubWalkthroughWarning[] } = {}) {
		super(message);
		this.name = "GithubPrAdapterError";
		this.status = options.status ?? 500;
		this.code = options.code ?? "github_pr_error";
		this.warnings = options.warnings ?? [];
	}
}

export function parseGithubPrReference(input: { prUrl?: string; prNumber?: string | number }): ParsedGithubPrReference {
	const number = normalizePrNumber(input.prNumber);
	const prUrl = cleanString(input.prUrl);
	if (!prUrl) return { number };

	let parsed: URL;
	try {
		parsed = new URL(prUrl);
	} catch {
		throw new GithubPrAdapterError(`Invalid GitHub PR URL: ${prUrl}`, { status: 400, code: "invalid_github_pr_url" });
	}

	const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/i.exec(parsed.pathname);
	if (!match) {
		throw new GithubPrAdapterError(`URL is not a GitHub pull request: ${prUrl}`, { status: 400, code: "not_github_pull_request" });
	}

	return {
		owner: decodeURIComponent(match[1]),
		repo: stripGitSuffix(decodeURIComponent(match[2])),
		number: Number(match[3]),
		host: parsed.hostname,
		url: prUrl,
	};
}

export function parseGithubRemoteUrl(remoteUrl: string): { owner: string; repo: string; host: string } | null {
	const trimmed = remoteUrl.trim();
	const scpLike = /^(?:git@)?([^:]+):([^/]+)\/(.+?)(?:\.git)?$/i.exec(trimmed);
	if (scpLike) return { host: scpLike[1], owner: scpLike[2], repo: stripGitSuffix(scpLike[3]) };

	try {
		const url = new URL(trimmed);
		const parts = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
		if (parts.length >= 2) return { host: url.hostname, owner: parts[0], repo: stripGitSuffix(parts[1]) };
	} catch {
		return null;
	}
	return null;
}

export async function resolveGithubPr(options: ResolveGithubPrOptions): Promise<GithubResolvedPr> {
	const warnings: GithubWalkthroughWarning[] = [];
	const parsed = parseGithubPrReference(options);
	const inferred = parsed.owner && parsed.repo ? undefined : await inferGithubRepository(options.cwd);
	const owner = parsed.owner ?? inferred?.owner;
	const repo = parsed.repo ?? inferred?.repo;
	const host = parsed.host ?? inferred?.host ?? "github.com";
	const number = parsed.number;

	if (!owner || !repo) {
		throw new GithubPrAdapterError("A GitHub PR number requires a GitHub origin remote to infer owner/repo", {
			status: 400,
			code: "github_repository_required",
		});
	}
	if (!number) {
		throw new GithubPrAdapterError("GitHub PR number is required", { status: 400, code: "github_pr_number_required" });
	}

	const token = cleanString(options.token) ?? cleanString(process.env.GITHUB_TOKEN) ?? cleanString(process.env.GH_TOKEN);
	if (!token) {
		warnings.push({
			code: "github_unauthenticated",
			severity: "info",
			message: "No GITHUB_TOKEN/GH_TOKEN configured; using unauthenticated GitHub API requests with lower rate limits.",
		});
	}

	const apiBaseUrl = cleanString(options.apiBaseUrl) ?? apiBaseUrlForHost(host);
	const fetchImpl = options.fetch ?? fetch;
	const headers = githubHeaders(token);
	const prApiUrl = `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
	const pr = await fetchGithubJson<GithubApiPullRequest>(fetchImpl, prApiUrl, headers, warnings);
	const files = await fetchGithubFiles(fetchImpl, prApiUrl, headers, options.maxFiles ?? 300, warnings);
	const resolvedFiles = await enrichFilesWithDiffs({ cwd: options.cwd, baseSha: pr.base.sha, headSha: pr.head.sha, files, warnings });
	const prUrl = pr.html_url || parsed.url || `https://${host}/${owner}/${repo}/pull/${number}`;
	const changesetId = changesetIdForGithub(owner, repo, number, pr.head.sha);
	const exportAvailable = Boolean(token);

	return {
		changesetId,
		changeset: {
			baseSha: pr.base.sha,
			headSha: pr.head.sha,
			provider: "github",
			externalUrl: prUrl,
			prUrl,
			prNumber: pr.number,
			prTitle: pr.title,
			title: `PR #${pr.number}: ${pr.title}`,
			filesChanged: pr.changed_files,
			additions: pr.additions,
			deletions: pr.deletions,
			owner,
			repo,
		},
		files: resolvedFiles,
		warnings,
		export: {
			provider: "github",
			available: exportAvailable,
			owner,
			repo,
			prNumber: pr.number,
			url: prUrl,
			reason: exportAvailable ? undefined : "Set GITHUB_TOKEN or GH_TOKEN to submit a review back to GitHub.",
		},
		provider: {
			name: "github",
			owner,
			repo,
			prNumber: pr.number,
			prUrl,
			apiUrl: prApiUrl,
			baseSha: pr.base.sha,
			headSha: pr.head.sha,
		},
	};
}

async function inferGithubRepository(cwd: string | undefined): Promise<{ owner: string; repo: string; host: string } | undefined> {
	if (!cwd) return undefined;
	try {
		const { stdout } = await execFileSafe("git", ["remote", "get-url", "origin"], { cwd, timeout: 5_000, encoding: "utf8" });
		return parseGithubRemoteUrl(stdout) ?? undefined;
	} catch {
		return undefined;
	}
}

async function fetchGithubFiles(
	fetchImpl: FetchLike,
	prApiUrl: string,
	headers: Record<string, string>,
	maxFiles: number,
	warnings: GithubWalkthroughWarning[],
): Promise<GithubApiChangedFile[]> {
	const result: GithubApiChangedFile[] = [];
	for (let page = 1; result.length < maxFiles; page++) {
		const pageUrl = `${prApiUrl}/files?per_page=100&page=${page}`;
		const batch = await fetchGithubJson<GithubApiChangedFile[]>(fetchImpl, pageUrl, headers, warnings);
		result.push(...batch);
		if (batch.length < 100) break;
	}
	if (result.length > maxFiles) {
		warnings.push({ code: "github_files_truncated", severity: "warning", message: `GitHub changed files were truncated at ${maxFiles} files.` });
	}
	return result.slice(0, maxFiles);
}

async function fetchGithubJson<T>(
	fetchImpl: FetchLike,
	url: string,
	headers: Record<string, string>,
	warnings: GithubWalkthroughWarning[],
): Promise<T> {
	const response = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(20_000) });
	if (!response.ok) {
		const message = await response.text().catch(() => response.statusText);
		const warning = warningForGithubHttpFailure(response.status, response.headers);
		if (warning) warnings.push(warning);
		throw new GithubPrAdapterError(`GitHub API request failed (${response.status}): ${message || response.statusText}`, {
			status: response.status,
			code: response.status === 404 ? "github_pr_not_found" : "github_api_error",
			warnings,
		});
	}
	return await response.json() as T;
}

async function enrichFilesWithDiffs(input: {
	cwd?: string;
	baseSha: string;
	headSha: string;
	files: GithubApiChangedFile[];
	warnings: GithubWalkthroughWarning[];
}): Promise<GithubWalkthroughFile[]> {
	const localDiffAvailable = await hasLocalCommit(input.cwd, input.baseSha) && await hasLocalCommit(input.cwd, input.headSha);
	const enriched: GithubWalkthroughFile[] = [];
	for (const file of input.files) {
		const patch = localDiffAvailable
			? await readLocalPatchForFile(input.cwd, input.baseSha, input.headSha, file).catch(() => cleanString(file.patch))
			: cleanString(file.patch);
		const status = normalizeGithubFileStatus(file.status, patch);
		const block = parsePatchToDiffBlock({ filePath: file.filename, oldPath: file.previous_filename, patch, status });
		if (!patch) {
			input.warnings.push({
				code: status === "binary" ? "github_binary_file" : "github_file_without_patch",
				severity: status === "binary" ? "warning" : "info",
				message: status === "binary" ? "Binary file has no reviewable text diff." : "GitHub did not provide a text patch for this file.",
				filePath: file.filename,
			});
		}
		enriched.push({
			filePath: file.filename,
			oldPath: file.previous_filename,
			status,
			additions: file.additions ?? 0,
			deletions: file.deletions ?? 0,
			changes: file.changes ?? ((file.additions ?? 0) + (file.deletions ?? 0)),
			patch,
			blobUrl: file.blob_url,
			rawUrl: file.raw_url,
			contentsUrl: file.contents_url,
			diffBlocks: block.hunks.length > 0 ? [block] : [],
		});
	}
	return enriched;
}

async function hasLocalCommit(cwd: string | undefined, sha: string): Promise<boolean> {
	if (!cwd || !sha) return false;
	try {
		await execFileSafe("git", ["rev-parse", "--verify", `${sha}^{commit}`], { cwd, timeout: 5_000, encoding: "utf8" });
		return true;
	} catch {
		return false;
	}
}

async function readLocalPatchForFile(cwd: string | undefined, baseSha: string, headSha: string, file: GithubApiChangedFile): Promise<string | undefined> {
	if (!cwd) return undefined;
	const paths = file.previous_filename && file.previous_filename !== file.filename ? [file.previous_filename, file.filename] : [file.filename];
	const { stdout } = await execFileSafe("git", ["diff", "--no-ext-diff", "--find-renames", "--find-copies", "--binary", "--unified=80", baseSha, headSha, "--", ...paths], {
		cwd,
		timeout: 20_000,
		maxBuffer: 10 * 1024 * 1024,
		encoding: "utf8",
	});
	return extractPatchBody(stdout) || undefined;
}

function parsePatchToDiffBlock(input: { filePath: string; oldPath?: string; patch?: string; status: GithubWalkthroughFile["status"] }): GithubDiffBlock {
	const blockId = stableBlockId(input.filePath, input.oldPath);
	const hunks: GithubDiffHunk[] = [];
	const lines = (input.patch ?? "").split(/\r?\n/);
	let current: GithubDiffHunk | undefined;
	let oldLine = 0;
	let newLine = 0;
	for (const rawLine of lines) {
		const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/.exec(rawLine);
		if (hunkMatch) {
			oldLine = Number(hunkMatch[1]);
			newLine = Number(hunkMatch[2]);
			current = { id: `${blockId}:h${hunks.length}`, header: rawLine, lines: [] };
			hunks.push(current);
			continue;
		}
		if (!current || rawLine === "" || rawLine.startsWith("\\ No newline")) continue;
		const prefix = rawLine[0];
		const text = rawLine.slice(1);
		const lineIndex = current.lines.length;
		if (prefix === "+") {
			current.lines.push({ id: `${current.id}:l${lineIndex}`, side: "new", newLine, kind: "add", text });
			newLine += 1;
		} else if (prefix === "-") {
			current.lines.push({ id: `${current.id}:l${lineIndex}`, side: "old", oldLine, kind: "del", text });
			oldLine += 1;
		} else {
			current.lines.push({ id: `${current.id}:l${lineIndex}`, side: "context", oldLine, newLine, kind: "context", text: prefix === " " ? text : rawLine });
			oldLine += 1;
			newLine += 1;
		}
	}
	return { id: blockId, filePath: input.filePath, oldPath: input.oldPath, hunks };
}

function extractPatchBody(diff: string): string {
	const lines = diff.split(/\r?\n/);
	const firstHunk = lines.findIndex(line => line.startsWith("@@ "));
	return firstHunk >= 0 ? lines.slice(firstHunk).join("\n") : "";
}

function normalizeGithubFileStatus(status: string, patch?: string): GithubWalkthroughFile["status"] {
	if (!patch && /binary/i.test(status)) return "binary";
	switch (status) {
		case "added": return "added";
		case "removed": return "deleted";
		case "renamed": return "renamed";
		case "copied": return "copied";
		case "modified":
		case "changed":
		default:
			return patch ? "modified" : "binary";
	}
}

function warningForGithubHttpFailure(status: number, headers: FetchHeadersLike): GithubWalkthroughWarning | undefined {
	if (status === 401) return { code: "github_auth_failed", severity: "error", message: "GitHub rejected the configured token. Check GITHUB_TOKEN/GH_TOKEN." };
	if (status === 403) {
		const remaining = headers.get("x-ratelimit-remaining");
		return remaining === "0"
			? { code: "github_rate_limited", severity: "error", message: "GitHub API rate limit exceeded. Configure a token or retry after the reset time." }
			: { code: "github_permission_denied", severity: "error", message: "GitHub denied access to this pull request or repository." };
	}
	return undefined;
}

function githubHeaders(token: string | undefined): Record<string, string> {
	return {
		Accept: "application/vnd.github+json",
		"User-Agent": "bobbit-pr-walkthrough",
		"X-GitHub-Api-Version": "2022-11-28",
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
}

function apiBaseUrlForHost(host: string): string {
	return host.toLowerCase() === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
}

function changesetIdForGithub(owner: string, repo: string, number: number, headSha?: string): string {
	return `github:${owner}/${repo}#${number}:${shortSha(headSha) ?? "unknown"}`;
}

function stableBlockId(filePath: string, oldPath: string | undefined): string {
	const raw = oldPath && oldPath !== filePath ? `${oldPath}->${filePath}` : filePath;
	return `github:${raw.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "file"}`;
}

function shortSha(value: string | undefined): string | undefined {
	const cleaned = cleanString(value);
	return cleaned ? cleaned.slice(0, 7) : undefined;
}

function normalizePrNumber(value: string | number | undefined): number | undefined {
	const raw = typeof value === "number" ? String(Math.trunc(value)) : cleanString(value);
	if (!raw) return undefined;
	const normalized = raw.replace(/^#/, "").trim();
	if (!/^\d+$/.test(normalized)) return undefined;
	return Number(normalized);
}

function cleanString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stripGitSuffix(repo: string): string {
	return repo.replace(/\.git$/i, "");
}
