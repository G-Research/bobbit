import { spawn } from "node:child_process";

import { execFileSafe } from "../exec-file-safe.js";
import type { PrWalkthroughChangesetRef, WalkthroughLimits, WalkthroughWarning } from "../../shared/pr-walkthrough/types.js";
import { changesetIdForLocal } from "../../shared/pr-walkthrough/ids.js";
import { isLikelyGeneratedPath } from "../../shared/pr-walkthrough/generated-path.js";
import { parseUnifiedDiff, type ParsedWalkthroughDiffFile } from "./diff-parser.js";

export interface ResolveLocalChangesetRequest {
	cwd: string;
	baseSha: string;
	headSha: string;
	limits?: Partial<WalkthroughLimits>;
}

export interface LocalChangesetResolveResult {
	changesetId: string;
	changeset: PrWalkthroughChangesetRef;
	files: ParsedWalkthroughDiffFile[];
	warnings: WalkthroughWarning[];
	limits: WalkthroughLimits;
}

export interface NameStatusRecord {
	status: string;
	filePath: string;
	oldPath?: string;
}

const DEFAULT_LIMITS: WalkthroughLimits = {
	maxFiles: 200,
	maxDiffBytes: 3_000_000,
	maxLinesPerFile: 2_000,
};

const GIT_TIMEOUT_MS = 30_000;

export async function resolveLocalChangeset(request: ResolveLocalChangesetRequest): Promise<LocalChangesetResolveResult> {
	const limits = { ...DEFAULT_LIMITS, ...request.limits };
	const [baseSha, headSha] = await Promise.all([
		verifyCommit(request.cwd, request.baseSha, "baseSha"),
		verifyCommit(request.cwd, request.headSha, "headSha"),
	]);

	const [shortstatRaw, nameStatusRaw, diffCapture] = await Promise.all([
		runGit(request.cwd, ["diff", "--shortstat", `${baseSha}..${headSha}`]),
		runGit(request.cwd, ["diff", "--name-status", "-M", "-C", `${baseSha}..${headSha}`]),
		runGitLimited(request.cwd, ["diff", "--no-ext-diff", "--find-renames", "--find-copies", "--binary", "--unified=80", `${baseSha}..${headSha}`], limits.maxDiffBytes + 64_000),
	]);

	const warnings: WalkthroughWarning[] = [];
	const nameStatus = parseNameStatus(nameStatusRaw);
	let diffForParsing = diffCapture.stdout;
	if (diffCapture.truncated || Buffer.byteLength(diffCapture.stdout, "utf8") > limits.maxDiffBytes) {
		diffForParsing = truncateUtf8(diffCapture.stdout, limits.maxDiffBytes);
		warnings.push({ code: "diff-truncated", severity: "warning", message: `Diff output exceeded ${limits.maxDiffBytes} bytes and was truncated.` });
	}

	const parsed = parseUnifiedDiff(diffForParsing, {
		maxFiles: limits.maxFiles,
		maxLinesPerFile: limits.maxLinesPerFile,
		generatedPathMatcher: isLikelyGeneratedPath,
	});
	const files = mergeNameStatus(parsed.files, nameStatus);
	const omittedFiles = nameStatus.slice(files.length).map(record => record.filePath);
	const truncatedFiles = files.filter(file => file.truncated).map(file => file.filePath);
	if (omittedFiles.length > 0) {
		warnings.push({ code: "files-omitted", severity: "warning", message: `${omittedFiles.length} changed file(s) were omitted because the file limit was reached.` });
	}

	const stats = parseShortstat(shortstatRaw);
	const changeset: PrWalkthroughChangesetRef = {
		baseSha,
		headSha,
		provider: "local",
		title: `Local changes ${baseSha.slice(0, 8)}..${headSha.slice(0, 8)}`,
		filesChanged: stats.filesChanged || nameStatus.length || files.length,
		additions: stats.additions,
		deletions: stats.deletions,
	};

	const finalLimits: WalkthroughLimits = { ...limits, truncatedFiles, omittedFiles };
	return {
		changesetId: changesetIdForLocal(baseSha, headSha),
		changeset,
		files,
		warnings: dedupeWarnings([...warnings, ...parsed.warnings, ...generatedWarnings(files)]),
		limits: finalLimits,
	};
}

export function parseShortstat(raw: string): { filesChanged: number; additions: number; deletions: number } {
	return {
		filesChanged: numberFrom(/(\d+)\s+files? changed/.exec(raw)),
		additions: numberFrom(/(\d+)\s+insertions?\(\+\)/.exec(raw)),
		deletions: numberFrom(/(\d+)\s+deletions?\(-\)/.exec(raw)),
	};
}

export function parseNameStatus(raw: string): NameStatusRecord[] {
	return raw.split(/\r?\n/).filter(Boolean).map(line => {
		const parts = line.split("\t");
		const status = parts[0] ?? "";
		if (status.startsWith("R") || status.startsWith("C")) {
			return { status, oldPath: parts[1], filePath: parts[2] ?? parts[1] ?? "unknown" };
		}
		return { status, filePath: parts[1] ?? "unknown" };
	});
}

export { isLikelyGeneratedPath } from "../../shared/pr-walkthrough/generated-path.js";

async function verifyCommit(cwd: string, ref: string, label: string): Promise<string> {
	try {
		return (await runGit(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid ${label} ref "${ref}": ${message}`);
	}
}

async function runGit(cwd: string, args: readonly string[], maxBuffer = 10_000_000): Promise<string> {
	const result = await execFileSafe("git", args, {
		cwd,
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		maxBuffer,
	});
	return result.stdout;
}

async function runGitLimited(cwd: string, args: readonly string[], maxBytes: number): Promise<{ stdout: string; truncated: boolean }> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		const stderr: Buffer[] = [];
		let capturedBytes = 0;
		let truncated = false;
		let settled = false;
		const timer = setTimeout(() => {
			truncated = true;
			child.kill();
		}, GIT_TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => {
			if (capturedBytes < maxBytes) {
				const remaining = maxBytes - capturedBytes;
				chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
				capturedBytes += Math.min(chunk.length, remaining);
			}
			if (chunk.length > 0 && capturedBytes >= maxBytes) {
				truncated = true;
				child.kill();
			}
		});
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", error => {
			clearTimeout(timer);
			if (!settled) {
				settled = true;
				reject(error);
			}
		});
		child.on("close", code => {
			clearTimeout(timer);
			if (settled) return;
			settled = true;
			if (code && !truncated) {
				reject(new Error(Buffer.concat(stderr).toString("utf8") || `git ${args.join(" ")} exited with ${code}`));
				return;
			}
			resolve({ stdout: Buffer.concat(chunks).toString("utf8"), truncated });
		});
	});
}

function mergeNameStatus(files: ParsedWalkthroughDiffFile[], records: NameStatusRecord[]): ParsedWalkthroughDiffFile[] {
	const byPath = new Map(records.map(record => [record.filePath, record]));
	for (const file of files) {
		const record = byPath.get(file.filePath);
		if (!record) continue;
		file.oldPath = record.oldPath ?? file.oldPath;
		if (record.status.startsWith("A")) file.status = file.isBinary ? "binary" : "added";
		else if (record.status.startsWith("D")) file.status = file.isBinary ? "binary" : "deleted";
		else if (record.status.startsWith("R")) file.status = file.isBinary ? "binary" : "renamed";
		else if (record.status.startsWith("C")) file.status = file.isBinary ? "binary" : "copied";
	}
	return files;
}

function generatedWarnings(files: ParsedWalkthroughDiffFile[]): WalkthroughWarning[] {
	return files
		.filter(file => file.isGenerated)
		.map(file => ({ code: "generated-file", severity: "info" as const, message: `${file.filePath} looks generated and may be low-signal for review.`, filePath: file.filePath }));
}

function dedupeWarnings(warnings: WalkthroughWarning[]): WalkthroughWarning[] {
	const seen = new Set<string>();
	return warnings.filter(warning => {
		const key = `${warning.code}:${warning.filePath ?? ""}:${warning.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function truncateUtf8(value: string, maxBytes: number): string {
	return Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
}

function numberFrom(match: RegExpExecArray | null): number {
	return match ? Number(match[1]) : 0;
}
