import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { PrWalkthroughChangesetRef, PrWalkthroughDiffBlock, PrWalkthroughDiffLine, PrWalkthroughHunk } from "../../shared/pr-walkthrough/types.js";
import { bobbitStateDir } from "../bobbit-dir.js";
import { storageKeyForChangesetId } from "./walkthrough-store.js";
import type { PrWalkthroughJobRecord, PrWalkthroughTarget, WalkthroughWarning } from "./walkthrough-agent-store.js";
import type { WalkthroughParsedDiffForYamlMapping } from "./walkthrough-yaml-schema.js";

export const PR_WALKTHROUGH_ANALYSIS_BUNDLE_SCHEMA_VERSION = 1;
export const PR_WALKTHROUGH_ANALYSIS_BUNDLE_KIND = "pr_walkthrough_analysis_bundle";
const STORE_DIR = "pr-walkthrough-analysis-bundles";

export const PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW = {
	maxContentBytes: 48 * 1024,
	maxHeaderBytes: 512,
	maxLineBytes: 8 * 1024,
	maxLines: 600,
	maxLinesPerHunk: 200,
} as const;
const READ_WINDOW_MARKER_RESERVE_BYTES = 1024;
const READ_WINDOW_GUIDANCE = "Bundle store windowed this file read before returning it. Request narrower slices with mode=file hunkOffset=<n> hunkLimit=1 when more hunk context is needed.";

export type PrWalkthroughAnalysisBundleTarget = {
	provider: "github" | string;
	owner?: string;
	repo?: string;
	number?: number;
	url?: string;
};

export type PrWalkthroughAnalysisBundleChangeset = {
	base_sha?: string;
	head_sha?: string;
	title?: string;
	body?: string;
	files_changed?: number;
	additions?: number;
	deletions?: number;
};

export type PrWalkthroughAnalysisBundleLine = {
	id?: string;
	kind: "context" | "add" | "del";
	side?: "old" | "new" | "context";
	old_line?: number;
	new_line?: number;
	text: string;
};

export type PrWalkthroughAnalysisBundleHunk = {
	id?: string;
	header: string;
	old_start?: number;
	old_lines?: number;
	new_start?: number;
	new_lines?: number;
	lines: PrWalkthroughAnalysisBundleLine[];
};

export type PrWalkthroughAnalysisBundleFile = {
	id?: string;
	path: string;
	old_path?: string | null;
	status?: string;
	additions?: number;
	deletions?: number;
	is_binary: boolean;
	is_generated: boolean;
	is_truncated: boolean;
	external_url?: string;
	blob_url?: string;
	raw_url?: string;
	contents_url?: string;
	hunks: PrWalkthroughAnalysisBundleHunk[];
};

export type PrWalkthroughAnalysisBundleExport = { provider: string; available: boolean; [key: string]: unknown };

export type PrWalkthroughAnalysisBundle = {
	schema_version: typeof PR_WALKTHROUGH_ANALYSIS_BUNDLE_SCHEMA_VERSION;
	kind: typeof PR_WALKTHROUGH_ANALYSIS_BUNDLE_KIND;
	generated_at: string;
	job_id: string;
	target: PrWalkthroughAnalysisBundleTarget;
	changeset: PrWalkthroughAnalysisBundleChangeset;
	limits?: Record<string, unknown>;
	warnings: WalkthroughWarning[];
	export?: PrWalkthroughAnalysisBundleExport;
	files: PrWalkthroughAnalysisBundleFile[];
};

export type PrWalkthroughAnalysisBundleMetadata = {
	schemaVersion: typeof PR_WALKTHROUGH_ANALYSIS_BUNDLE_SCHEMA_VERSION;
	kind: typeof PR_WALKTHROUGH_ANALYSIS_BUNDLE_KIND;
	artifactId: string;
	checksum: string;
	generatedAt: string;
	files: number;
};

type BundleFileReadWindowMetadata = {
	applied: boolean;
	maxContentBytes: number;
	maxHeaderBytes: number;
	maxLineBytes: number;
	maxLines: number;
	maxLinesPerHunk: number;
	selectedHunks: number;
	returnedHunks: number;
	returnedLines: number;
	markerLines: number;
	omittedLines: number;
	truncatedLines: number;
	omittedBytes: number;
	returnedBytes: number;
	reasons: string[];
	guidance: string;
};

export type ReadPrWalkthroughBundleRequest = {
	sessionId: string;
	jobId: string;
	mode?: "summary" | "manifest" | "files" | "file";
	path?: string;
	index?: number;
	offset?: number;
	limit?: number;
	hunkOffset?: number;
	hunkLimit?: number;
};

export class WalkthroughAnalysisBundleStore {
	private readonly rootDir: string;

	constructor(stateDir = bobbitStateDir()) {
		this.rootDir = path.join(stateDir, STORE_DIR, `v${PR_WALKTHROUGH_ANALYSIS_BUNDLE_SCHEMA_VERSION}`);
	}

	save(jobId: string, bundle: PrWalkthroughAnalysisBundle): { bundle: PrWalkthroughAnalysisBundle; metadata: PrWalkthroughAnalysisBundleMetadata } {
		const stored = sanitizeBundle({ ...bundle, job_id: jobId });
		fs.mkdirSync(this.rootDir, { recursive: true });
		const json = `${JSON.stringify(stored, null, 2)}\n`;
		fs.writeFileSync(this.filePath(jobId), json, "utf-8");
		return { bundle: stored, metadata: metadataForBundle(jobId, stored, json) };
	}

	load(jobId: string): PrWalkthroughAnalysisBundle | null {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.filePath(jobId), "utf-8"));
			return parseBundle(parsed, jobId);
		} catch {
			return null;
		}
	}

	read(job: PrWalkthroughJobRecord, request: Omit<ReadPrWalkthroughBundleRequest, "sessionId" | "jobId"> = {}): Record<string, unknown> {
		const bundle = this.load(job.jobId);
		if (!bundle) throw missingBundleError(job.jobId);
		const mode = request.mode ?? "manifest";
		const limit = clampInteger(request.limit, 1, 200, 50);
		const offset = clampInteger(request.offset, 0, Number.MAX_SAFE_INTEGER, 0);
		if (mode === "summary" || mode === "manifest") return manifestForBundle(bundle, mode, offset, limit);
		if (mode === "files") return { ...manifestForBundle(bundle, "files", offset, limit), files: bundle.files.slice(offset, offset + limit).map(fileManifest) };
		if (mode === "file") {
			const file = selectFile(bundle, request.path, request.index);
			if (!file) throw bundleReadError(404, "PR walkthrough bundle file not found", { code: "PR_WALKTHROUGH_BUNDLE_FILE_NOT_FOUND", retryable: false });
			const hunkOffset = clampInteger(request.hunkOffset ?? request.offset, 0, Number.MAX_SAFE_INTEGER, 0);
			const hunkLimit = clampInteger(request.hunkLimit ?? request.limit, 1, 200, 50);
			const hunks = file.hunks.slice(hunkOffset, hunkOffset + hunkLimit);
			const windowed = windowFileRead(file, hunks, hunkOffset);
			const hunkWindowTruncated = hunkOffset > 0 || hunkOffset + hunkLimit < file.hunks.length;
			return {
				bundle: bundleHeader(bundle),
				file: windowed.file,
				hunkOffset,
				hunkLimit,
				totalHunks: file.hunks.length,
				truncated: hunkWindowTruncated || windowed.window.applied,
				hunk_truncated: hunkWindowTruncated,
				read_window: windowed.window,
			};
		}
		throw bundleReadError(400, "Unsupported PR walkthrough bundle read mode", { code: "INVALID_BUNDLE_READ_REQUEST", retryable: false });
	}

	private filePath(jobId: string): string {
		return path.join(this.rootDir, `${storageKeyForChangesetId(jobId)}.json`);
	}
}

export function createAnalysisBundleFromParsedDiff(job: PrWalkthroughJobRecord, parsedDiff: WalkthroughParsedDiffForYamlMapping): PrWalkthroughAnalysisBundle {
	const changeset = parsedDiff.changeset ?? {};
	const files = bundleFilesFromParsedDiff(parsedDiff);
	return sanitizeBundle({
		schema_version: PR_WALKTHROUGH_ANALYSIS_BUNDLE_SCHEMA_VERSION,
		kind: PR_WALKTHROUGH_ANALYSIS_BUNDLE_KIND,
		generated_at: new Date().toISOString(),
		job_id: job.jobId,
		target: targetForBundle(job.target, changeset),
		changeset: {
			base_sha: stringValue(changeset.baseSha) ?? job.target.baseSha,
			head_sha: stringValue(changeset.headSha) ?? job.target.headSha,
			title: stringValue(changeset.prTitle) ?? stringValue(job.target.prTitle) ?? stringValue(changeset.title) ?? job.title,
			body: stringValue(changeset.prBody) ?? stringValue(job.target.prBody) ?? "",
			files_changed: numberValue(changeset.filesChanged) ?? files.length,
			additions: numberValue(changeset.additions) ?? sum(files, "additions"),
			deletions: numberValue(changeset.deletions) ?? sum(files, "deletions"),
		},
		limits: (parsedDiff.limits as Record<string, unknown> | undefined) ?? { max_files: 300, max_patch_bytes_per_file: 1_000_000, max_lines_per_file: 2_000 },
		warnings: [...(parsedDiff.warnings ?? [])],
		export: parsedDiff.export && typeof parsedDiff.export.provider === "string" ? parsedDiff.export as PrWalkthroughAnalysisBundleExport : undefined,
		files,
	});
}

export function analysisBundleToParsedDiff(bundle: PrWalkthroughAnalysisBundle): WalkthroughParsedDiffForYamlMapping {
	return {
		changeset: {
			baseSha: bundle.changeset.base_sha,
			headSha: bundle.changeset.head_sha,
			provider: bundle.target.provider,
			externalUrl: bundle.target.url,
			prUrl: bundle.target.url,
			prNumber: bundle.target.number,
			prTitle: bundle.changeset.title,
			prBody: bundle.changeset.body,
			title: bundle.changeset.title,
			filesChanged: bundle.changeset.files_changed,
			additions: bundle.changeset.additions,
			deletions: bundle.changeset.deletions,
		},
		files: bundle.files.map(file => ({
			filePath: file.path,
			oldPath: file.old_path ?? undefined,
			status: file.status,
			additions: file.additions,
			deletions: file.deletions,
			isBinary: file.is_binary,
			isGenerated: file.is_generated,
			isTruncated: file.is_truncated,
			externalUrl: file.external_url,
			blobUrl: file.blob_url,
			rawUrl: file.raw_url,
			contentsUrl: file.contents_url,
			diffBlocks: [diffBlockFromBundleFile(file)],
		})),
		warnings: bundle.warnings,
		limits: bundle.limits as WalkthroughParsedDiffForYamlMapping["limits"],
		export: bundle.export as WalkthroughParsedDiffForYamlMapping["export"],
	};
}

export function missingBundleError(jobId: string): Error & { status?: number; extra?: Record<string, unknown> } {
	return bundleReadError(409, `PR walkthrough analysis bundle is missing or unusable for job ${jobId}. Relaunch the walkthrough so the PR diff can be resolved before analysis.`, {
		code: "PR_WALKTHROUGH_BUNDLE_MISSING",
		retryable: true,
	});
}

function bundleFilesFromParsedDiff(parsedDiff: WalkthroughParsedDiffForYamlMapping): PrWalkthroughAnalysisBundleFile[] {
	const sourceFiles = Array.isArray(parsedDiff.files) ? parsedDiff.files.filter(isRecord) : [];
	if (sourceFiles.length > 0) return sourceFiles.map(bundleFileFromParsedFile).filter((file): file is PrWalkthroughAnalysisBundleFile => Boolean(file));
	return diffBlocksFromParsedDiff(parsedDiff).map(block => bundleFileFromDiffBlock(block));
}

function diffBlocksFromParsedDiff(parsedDiff: WalkthroughParsedDiffForYamlMapping): PrWalkthroughDiffBlock[] {
	if (Array.isArray(parsedDiff.diffBlocks)) return parsedDiff.diffBlocks.filter(isDiffBlock);
	const blocks: PrWalkthroughDiffBlock[] = [];
	for (const file of parsedDiff.files ?? []) {
		if (!isRecord(file)) continue;
		if (Array.isArray(file.diffBlocks)) blocks.push(...file.diffBlocks.filter(isDiffBlock));
		else if (isDiffBlock(file)) blocks.push(file);
	}
	return blocks;
}

function bundleFileFromParsedFile(file: Record<string, unknown>): PrWalkthroughAnalysisBundleFile | null {
	const blocks = Array.isArray(file.diffBlocks)
		? file.diffBlocks.filter(isDiffBlock)
		: isDiffBlock(file)
			? [file]
			: [];
	const primary = blocks[0];
	const filePath = stringValue(file.filePath) ?? stringValue(file.path) ?? primary?.filePath;
	if (!filePath) return null;
	return {
		id: stringValue(file.id) ?? primary?.id,
		path: filePath,
		old_path: stringValue(file.oldPath) ?? stringValue(file.old_path) ?? primary?.oldPath ?? null,
		status: stringValue(file.status) ?? primary?.status,
		additions: numberValue(file.additions),
		deletions: numberValue(file.deletions),
		is_binary: Boolean(file.isBinary ?? file.is_binary ?? primary?.isBinary),
		is_generated: Boolean(file.isGenerated ?? file.is_generated ?? primary?.isGenerated),
		is_truncated: Boolean(file.isTruncated ?? file.is_truncated ?? file.truncated ?? primary?.isTruncated),
		external_url: stringValue(file.externalUrl) ?? stringValue(file.external_url) ?? primary?.externalUrl,
		blob_url: stringValue(file.blobUrl) ?? stringValue(file.blob_url) ?? primary?.blobUrl,
		raw_url: stringValue(file.rawUrl) ?? stringValue(file.raw_url) ?? primary?.rawUrl,
		contents_url: stringValue(file.contentsUrl) ?? stringValue(file.contents_url) ?? primary?.contentsUrl,
		hunks: blocks.flatMap(block => block.hunks.map(bundleHunkFromDiffHunk)),
	};
}

function bundleFileFromDiffBlock(block: PrWalkthroughDiffBlock): PrWalkthroughAnalysisBundleFile {
	return {
		id: block.id,
		path: block.filePath,
		old_path: block.oldPath ?? null,
		status: block.status,
		additions: undefined,
		deletions: undefined,
		is_binary: Boolean(block.isBinary),
		is_generated: Boolean(block.isGenerated),
		is_truncated: Boolean(block.isTruncated),
		external_url: block.externalUrl,
		blob_url: block.blobUrl,
		raw_url: block.rawUrl,
		contents_url: block.contentsUrl,
		hunks: block.hunks.map(bundleHunkFromDiffHunk),
	};
}

function bundleHunkFromDiffHunk(hunk: PrWalkthroughHunk): PrWalkthroughAnalysisBundleHunk {
	const header = typeof hunk.header === "string" ? hunk.header : "";
	const parsed = parseHunkHeader(header);
	return {
		id: hunk.id,
		header,
		...parsed,
		lines: hunk.lines.map(line => ({
			id: line.id,
			kind: line.kind,
			side: line.side,
			old_line: line.oldLine,
			new_line: line.newLine,
			text: line.text,
		})),
	};
}

function diffBlockFromBundleFile(file: PrWalkthroughAnalysisBundleFile): PrWalkthroughDiffBlock {
	return {
		id: file.id ?? `bundle-${hashText(file.path).slice(0, 12)}`,
		filePath: file.path,
		oldPath: file.old_path ?? undefined,
		status: file.status as PrWalkthroughDiffBlock["status"],
		isBinary: file.is_binary,
		isGenerated: file.is_generated,
		isTruncated: file.is_truncated,
		externalUrl: file.external_url,
		blobUrl: file.blob_url,
		rawUrl: file.raw_url,
		contentsUrl: file.contents_url,
		hunks: file.hunks.map(hunk => {
			const header = typeof hunk.header === "string" ? hunk.header : "";
			return {
			id: hunk.id ?? `hunk-${hashText(`${file.path}\0${header}`).slice(0, 12)}`,
			header,
			lines: hunk.lines.map((line, index): PrWalkthroughDiffLine => ({
				id: line.id ?? `line-${hashText(`${file.path}\0${header}\0${index}`).slice(0, 12)}`,
				side: line.side ?? (line.kind === "add" ? "new" : line.kind === "del" ? "old" : "context"),
				oldLine: line.old_line,
				newLine: line.new_line,
				text: line.text,
				kind: line.kind,
			})),
			};
		}),
	};
}

function parseBundle(value: unknown, expectedJobId: string): PrWalkthroughAnalysisBundle | null {
	if (!isRecord(value)) return null;
	if (value.schema_version !== PR_WALKTHROUGH_ANALYSIS_BUNDLE_SCHEMA_VERSION || value.kind !== PR_WALKTHROUGH_ANALYSIS_BUNDLE_KIND) return null;
	if (value.job_id !== expectedJobId || !isRecord(value.target) || !isRecord(value.changeset) || !Array.isArray(value.files)) return null;
	return sanitizeBundle(value as PrWalkthroughAnalysisBundle);
}

function sanitizeBundle(bundle: PrWalkthroughAnalysisBundle): PrWalkthroughAnalysisBundle {
	return sanitizeValue(bundle) as PrWalkthroughAnalysisBundle;
}

function sanitizeValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitizeValue);
	if (!isRecord(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (isSensitiveKey(key)) continue;
		out[key] = sanitizeValue(entry);
	}
	return out;
}

function isSensitiveKey(key: string): boolean {
	if (/proof/i.test(key) && !/hash$/i.test(key)) return true;
	if (key === "header") return false; // diff hunk headers are required for anchor mapping and are not HTTP/auth headers.
	return /(^|[-_])(token|secret|authorization|auth[-_]?header|auth[-_]?headers|raw[-_]?headers|headers?)($|[-_])/i.test(key)
		|| /^(token|secret|authorization|auth|headers)$/i.test(key);
}

function metadataForBundle(jobId: string, bundle: PrWalkthroughAnalysisBundle, json?: string): PrWalkthroughAnalysisBundleMetadata {
	return {
		schemaVersion: PR_WALKTHROUGH_ANALYSIS_BUNDLE_SCHEMA_VERSION,
		kind: PR_WALKTHROUGH_ANALYSIS_BUNDLE_KIND,
		artifactId: storageKeyForChangesetId(jobId),
		checksum: createHash("sha256").update(json ?? JSON.stringify(bundle)).digest("hex"),
		generatedAt: bundle.generated_at,
		files: bundle.files.length,
	};
}

function targetForBundle(target: PrWalkthroughTarget, changeset: Partial<PrWalkthroughChangesetRef>): PrWalkthroughAnalysisBundleTarget {
	return {
		provider: target.provider,
		owner: target.owner,
		repo: target.repo,
		number: target.number,
		url: target.prUrl ?? stringValue(changeset.prUrl) ?? stringValue(changeset.externalUrl),
	};
}

function manifestForBundle(bundle: PrWalkthroughAnalysisBundle, mode: string, offset: number, limit: number): Record<string, unknown> {
	return {
		mode,
		bundle: bundleHeader(bundle),
		changeset: bundle.changeset,
		limits: bundle.limits,
		warnings: bundle.warnings,
		export: bundle.export,
		fileOffset: offset,
		fileLimit: limit,
		totalFiles: bundle.files.length,
		files: bundle.files.slice(offset, offset + limit).map(fileManifest),
		truncated: offset > 0 || offset + limit < bundle.files.length,
	};
}

function bundleHeader(bundle: PrWalkthroughAnalysisBundle): Record<string, unknown> {
	return {
		schema_version: bundle.schema_version,
		kind: bundle.kind,
		generated_at: bundle.generated_at,
		job_id: bundle.job_id,
		target: bundle.target,
	};
}

function fileManifest(file: PrWalkthroughAnalysisBundleFile): Record<string, unknown> {
	const readWindow = summarizeFileReadWindow(file);
	const readWindowed = Boolean(readWindow.applied);
	return {
		path: file.path,
		old_path: file.old_path,
		status: file.status,
		additions: file.additions,
		deletions: file.deletions,
		is_binary: file.is_binary,
		is_generated: file.is_generated,
		is_truncated: file.is_truncated || readWindowed,
		source_is_truncated: file.is_truncated,
		read_window: readWindow,
		hunks: file.hunks.length,
	};
}

function windowFileRead(file: PrWalkthroughAnalysisBundleFile, selectedHunks: PrWalkthroughAnalysisBundleHunk[], hunkOffset: number): { file: PrWalkthroughAnalysisBundleFile; window: BundleFileReadWindowMetadata } {
	const window = newFileReadWindowMetadata(selectedHunks.length);
	const reasons = new Set<string>();
	let remainingBytes = PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxContentBytes;
	let remainingLines = PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxLines;

	const hunks = selectedHunks.map((hunk, selectedIndex) => {
		const absoluteHunkIndex = hunkOffset + selectedIndex;
		const hunkWindow = {
			applied: false,
			omittedLines: 0,
			truncatedLines: 0,
			omittedBytes: 0,
		};
		const lines: PrWalkthroughAnalysisBundleLine[] = [];
		const header = windowTextToBudget(
			typeof hunk.header === "string" ? hunk.header : "",
			Math.min(PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxHeaderBytes, Math.max(0, remainingBytes - READ_WINDOW_MARKER_RESERVE_BYTES)),
			` … [hunk header truncated by bundle-store read window; request hunkOffset=${absoluteHunkIndex} hunkLimit=1 if needed]`,
		);
		remainingBytes = consumeWindowBytes(remainingBytes, header.text);
		window.returnedBytes += utf8Bytes(header.text);
		if (header.truncated) {
			hunkWindow.applied = true;
			hunkWindow.omittedBytes += header.omittedBytes;
			reasons.add("header-bytes");
		}

		let hunkReturnedSourceLines = 0;
		for (let lineIndex = 0; lineIndex < hunk.lines.length; lineIndex++) {
			const line = hunk.lines[lineIndex];
			if (hunkReturnedSourceLines >= PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxLinesPerHunk || remainingLines <= 0 || remainingBytes <= READ_WINDOW_MARKER_RESERVE_BYTES) {
				const omitted = summarizeOmittedLines(hunk.lines, lineIndex);
				hunkWindow.applied = true;
				hunkWindow.omittedLines += omitted.lines;
				hunkWindow.omittedBytes += omitted.bytes;
				if (remainingBytes <= READ_WINDOW_MARKER_RESERVE_BYTES) reasons.add("content-bytes");
				else reasons.add("line-window");
				break;
			}

			const availableForLine = Math.min(
				PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxLineBytes,
				Math.max(0, remainingBytes - READ_WINDOW_MARKER_RESERVE_BYTES),
			);
			const originalText = typeof line.text === "string" ? line.text : "";
			const text = windowTextToBudget(
				originalText,
				availableForLine,
				` … [line truncated by bundle-store read window; request hunkOffset=${absoluteHunkIndex} hunkLimit=1 if needed]`,
			);
			const returnedLine = { ...line, text: text.text } as PrWalkthroughAnalysisBundleLine & Record<string, unknown>;
			if (text.truncated) {
				returnedLine.is_truncated = true;
				returnedLine.truncated = true;
				returnedLine.read_window = {
					applied: true,
					originalBytes: text.originalBytes,
					returnedBytes: utf8Bytes(text.text),
					omittedBytes: text.omittedBytes,
				};
				hunkWindow.applied = true;
				hunkWindow.truncatedLines++;
				hunkWindow.omittedBytes += text.omittedBytes;
				reasons.add("line-bytes");
			}
			lines.push(returnedLine as PrWalkthroughAnalysisBundleLine);
			remainingBytes = consumeWindowBytes(remainingBytes, text.text);
			window.returnedBytes += utf8Bytes(text.text);
			window.returnedLines++;
			remainingLines--;
			hunkReturnedSourceLines++;
		}

		if (hunkWindow.applied) {
			appendWindowMarkerLine(lines, hunkWindowMarker(absoluteHunkIndex, hunkWindow), window, remainingBytes, (text) => {
				remainingBytes = consumeWindowBytes(remainingBytes, text);
			});
		}

		window.omittedLines += hunkWindow.omittedLines;
		window.truncatedLines += hunkWindow.truncatedLines;
		window.omittedBytes += hunkWindow.omittedBytes;
		const windowedHunk = { ...hunk, header: header.text, lines } as PrWalkthroughAnalysisBundleHunk & Record<string, unknown>;
		if (hunkWindow.applied) {
			windowedHunk.is_truncated = true;
			windowedHunk.truncated = true;
			windowedHunk.read_window = { ...hunkWindow, guidance: READ_WINDOW_GUIDANCE };
		}
		return windowedHunk as PrWalkthroughAnalysisBundleHunk;
	});

	window.applied = reasons.size > 0 || window.omittedLines > 0 || window.truncatedLines > 0 || window.omittedBytes > 0;
	window.reasons = [...reasons];
	if (window.applied && hunks.length > 0) prependWindowNotice(hunks[0], window);
	const windowedFile = { ...file, is_truncated: file.is_truncated || window.applied, hunks } as PrWalkthroughAnalysisBundleFile & Record<string, unknown>;
	windowedFile.truncated = windowedFile.is_truncated;
	windowedFile.read_window = window;
	return { file: windowedFile as PrWalkthroughAnalysisBundleFile, window };
}

function newFileReadWindowMetadata(selectedHunks: number): BundleFileReadWindowMetadata {
	return {
		applied: false,
		maxContentBytes: PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxContentBytes,
		maxHeaderBytes: PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxHeaderBytes,
		maxLineBytes: PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxLineBytes,
		maxLines: PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxLines,
		maxLinesPerHunk: PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxLinesPerHunk,
		selectedHunks,
		returnedHunks: selectedHunks,
		returnedLines: 0,
		markerLines: 0,
		omittedLines: 0,
		truncatedLines: 0,
		omittedBytes: 0,
		returnedBytes: 0,
		reasons: [],
		guidance: READ_WINDOW_GUIDANCE,
	};
}

function summarizeFileReadWindow(file: PrWalkthroughAnalysisBundleFile): Record<string, unknown> {
	let totalLines = 0;
	let totalBytes = 0;
	let longestLineBytes = 0;
	let longLines = 0;
	const reasons = new Set<string>();
	for (const hunk of file.hunks) {
		const headerBytes = utf8Bytes(typeof hunk.header === "string" ? hunk.header : "");
		if (headerBytes > PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxHeaderBytes) reasons.add("header-bytes");
		totalBytes += headerBytes;
		if (hunk.lines.length > PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxLinesPerHunk) reasons.add("line-window");
		for (const line of hunk.lines) {
			const lineBytes = utf8Bytes(typeof line.text === "string" ? line.text : "");
			totalLines++;
			totalBytes += lineBytes;
			longestLineBytes = Math.max(longestLineBytes, lineBytes);
			if (lineBytes > PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxLineBytes) {
				longLines++;
				reasons.add("line-bytes");
			}
		}
	}
	if (totalLines > PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxLines) reasons.add("line-window");
	if (totalBytes > PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxContentBytes) reasons.add("content-bytes");
	const applied = reasons.size > 0;
	return {
		applied,
		maxContentBytes: PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxContentBytes,
		maxHeaderBytes: PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxHeaderBytes,
		maxLineBytes: PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxLineBytes,
		maxLines: PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxLines,
		maxLinesPerHunk: PR_WALKTHROUGH_ANALYSIS_BUNDLE_FILE_READ_WINDOW.maxLinesPerHunk,
		totalLines,
		totalBytes,
		longestLineBytes,
		longLines,
		reasons: [...reasons],
		guidance: applied ? READ_WINDOW_GUIDANCE : undefined,
	};
}

function windowTextToBudget(text: string, maxBytes: number, marker: string): { text: string; truncated: boolean; originalBytes: number; omittedBytes: number } {
	const originalBytes = utf8Bytes(text);
	if (originalBytes <= maxBytes) return { text, truncated: false, originalBytes, omittedBytes: 0 };
	if (maxBytes <= 0) return { text: "", truncated: true, originalBytes, omittedBytes: originalBytes };
	const fallbackMarker = " … [truncated by bundle-store read window]";
	let suffix = marker;
	let prefixBytes = Math.max(0, maxBytes - utf8Bytes(suffix));
	let prefix = utf8Prefix(text, prefixBytes);
	let omittedBytes = originalBytes - utf8Bytes(prefix);
	suffix = marker.replace("request ", `${omittedBytes} bytes omitted; request `);
	prefixBytes = Math.max(0, maxBytes - utf8Bytes(suffix));
	if (prefixBytes === 0 && utf8Bytes(suffix) > maxBytes) suffix = utf8Prefix(fallbackMarker, maxBytes);
	else prefix = utf8Prefix(text, prefixBytes);
	omittedBytes = originalBytes - utf8Bytes(prefix);
	const clipped = utf8Prefix(`${prefix}${suffix}`, maxBytes);
	return { text: clipped, truncated: true, originalBytes, omittedBytes };
}

function appendWindowMarkerLine(lines: PrWalkthroughAnalysisBundleLine[], marker: string, window: BundleFileReadWindowMetadata, remainingBytes: number, consume: (text: string) => void): void {
	if (remainingBytes <= 0) return;
	const text = utf8Prefix(marker, Math.min(READ_WINDOW_MARKER_RESERVE_BYTES, remainingBytes));
	if (!text) return;
	lines.push({ kind: "context", side: "context", text });
	window.markerLines++;
	window.returnedBytes += utf8Bytes(text);
	consume(text);
}

function prependWindowNotice(hunk: PrWalkthroughAnalysisBundleHunk, window: BundleFileReadWindowMetadata): void {
	const text = `[bundle-store read window applied: omitted ${window.omittedLines} lines and ${window.omittedBytes} bytes; request narrower slices with hunkOffset=<n> hunkLimit=1 if needed]`;
	hunk.lines.unshift({ kind: "context", side: "context", text });
	window.markerLines++;
	window.returnedBytes += utf8Bytes(text);
}

function hunkWindowMarker(hunkIndex: number, window: { omittedLines: number; truncatedLines: number; omittedBytes: number }): string {
	return `[bundle-store read window: hunkOffset=${hunkIndex} windowed; omitted ${window.omittedLines} lines, truncated ${window.truncatedLines} long lines, ${window.omittedBytes} bytes omitted; request hunkOffset=${hunkIndex} hunkLimit=1 for a narrower slice]`;
}

function summarizeOmittedLines(lines: PrWalkthroughAnalysisBundleLine[], startIndex: number): { lines: number; bytes: number } {
	let bytes = 0;
	for (let i = startIndex; i < lines.length; i++) bytes += utf8Bytes(typeof lines[i].text === "string" ? lines[i].text : "");
	return { lines: Math.max(0, lines.length - startIndex), bytes };
}

function consumeWindowBytes(remaining: number, text: string): number {
	return Math.max(0, remaining - utf8Bytes(text) - 1);
}

function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function utf8Prefix(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (utf8Bytes(text) <= maxBytes) return text;
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (utf8Bytes(text.slice(0, mid)) <= maxBytes) low = mid;
		else high = mid - 1;
	}
	return text.slice(0, low);
}

function selectFile(bundle: PrWalkthroughAnalysisBundle, filePath: string | undefined, index: number | undefined): PrWalkthroughAnalysisBundleFile | undefined {
	if (filePath) return bundle.files.find(file => file.path === filePath || file.old_path === filePath);
	if (Number.isInteger(index) && index! >= 0) return bundle.files[index!];
	return bundle.files[0];
}

function bundleReadError(status: number, message: string, extra: Record<string, unknown>): Error & { status?: number; extra?: Record<string, unknown> } {
	const error = new Error(message) as Error & { status?: number; extra?: Record<string, unknown> };
	error.status = status;
	error.extra = extra;
	return error;
}

function parseHunkHeader(header: string): Pick<PrWalkthroughAnalysisBundleHunk, "old_start" | "old_lines" | "new_start" | "new_lines"> {
	const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
	if (!match) return {};
	return {
		old_start: Number(match[1]),
		old_lines: Number(match[2] ?? 1),
		new_start: Number(match[3]),
		new_lines: Number(match[4] ?? 1),
	};
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(n)));
}

function sum(files: PrWalkthroughAnalysisBundleFile[], key: "additions" | "deletions"): number {
	return files.reduce((total, file) => total + (file[key] ?? 0), 0);
}

function hashText(text: string): string {
	return createHash("sha1").update(text).digest("hex");
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
