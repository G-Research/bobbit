import fs from "node:fs";
import path from "node:path";

import type { GateStepDiagnosticArtifactMetadata, GateStepDiagnostics } from "./gate-diagnostics.js";

export const MAX_ARTIFACT_INDEX_FILES = 100;

export interface GateArtifactIndexFile {
	id: string;
	testName?: string;
	path: string;
	relativePath: string;
	sourcePath: string;
	bytes: number;
	kind: GateStepDiagnosticArtifactMetadata["kind"];
	retries?: number;
	retry?: number;
	contentType?: string;
}

export interface GateArtifactIndex {
	count: number;
	totalBytes: number;
	truncated?: boolean;
	truncationReason?: string;
	files: GateArtifactIndexFile[];
}

export interface GateArtifactLookup {
	index: GateArtifactIndex;
	entries: GateArtifactIndexFile[];
}

export class GateArtifactResolutionError extends Error {
	status = 400;
	validArtifactIds: string[];
	validArtifacts: Array<{ id: string; relativePath: string; retry?: number }>;

	constructor(message: string, lookup: GateArtifactLookup) {
		super(message);
		this.name = "GateArtifactResolutionError";
		this.validArtifactIds = [...new Set(lookup.index.files.map(file => file.id))];
		this.validArtifacts = lookup.index.files.map(file => ({
			id: file.id,
			relativePath: file.relativePath,
			retry: file.retry,
		}));
	}
}

function normalizeArtifactPath(relativePath: string): string {
	return relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function artifactDirectorySlug(relativePath: string): string | undefined {
	const normalized = normalizeArtifactPath(relativePath);
	const parts = normalized.split("/");
	if (parts[0] === "test-results" && parts.length >= 3 && parts[1]) return parts[1];
	return undefined;
}

export function artifactBaseSlug(slug: string): { id: string; retry?: number } {
	const match = slug.match(/^(.*)-retry(\d+)$/);
	if (!match) return { id: slug };
	return { id: match[1], retry: Number(match[2]) };
}

export function artifactTestNameFromSlug(id: string): string | undefined {
	const text = id
		.replace(/-[a-f0-9]{5,}(?=-|$)/gi, "")
		.replace(/--/g, " › ")
		.replace(/-/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return text || undefined;
}

function artifactIdForMetadata(artifact: GateStepDiagnosticArtifactMetadata): { id: string; retry?: number; collapsible: boolean } {
	const relativePath = normalizeArtifactPath(artifact.relativePath);
	const errorContextMatch = relativePath.match(/^test-results\/([^/]+)\/error-context\.md$/);
	if (errorContextMatch) {
		const parsed = artifactBaseSlug(errorContextMatch[1]);
		return { ...parsed, collapsible: true };
	}
	const slug = artifactDirectorySlug(relativePath);
	if (slug) {
		const parsed = artifactBaseSlug(slug);
		return { ...parsed, collapsible: false };
	}
	return { id: relativePath, collapsible: false };
}

function metadataRow(artifact: GateStepDiagnosticArtifactMetadata, id: string, retry?: number): GateArtifactIndexFile {
	const row: GateArtifactIndexFile = {
		id,
		relativePath: normalizeArtifactPath(artifact.relativePath),
		path: artifact.path,
		sourcePath: artifact.sourcePath,
		bytes: artifact.bytes,
		kind: artifact.kind,
	};
	const testName = artifactTestNameFromSlug(id);
	if (testName) row.testName = testName;
	if (retry !== undefined) row.retry = retry;
	if (artifact.contentType) row.contentType = artifact.contentType;
	return row;
}

export function buildArtifactLookup(diagnostics: GateStepDiagnostics | undefined): GateArtifactLookup {
	const artifacts = diagnostics?.artifacts ?? [];
	const entries = artifacts.map(artifact => {
		const parsed = artifactIdForMetadata(artifact);
		return metadataRow(artifact, parsed.id, parsed.retry);
	});
	const totalBytes = artifacts.reduce((sum, artifact) => sum + Math.max(0, artifact.bytes || 0), 0);
	const collapsed = new Map<string, { row: GateArtifactIndexFile; retries: Set<number>; fileIndex: number }>();
	const files: GateArtifactIndexFile[] = [];

	for (const artifact of artifacts) {
		const parsed = artifactIdForMetadata(artifact);
		const row = metadataRow(artifact, parsed.id, parsed.retry);
		if (!parsed.collapsible) {
			files.push(row);
			continue;
		}
		let group = collapsed.get(parsed.id);
		if (!group) {
			group = { row, retries: new Set<number>(), fileIndex: files.length };
			collapsed.set(parsed.id, group);
			files.push(group.row);
		} else if (parsed.retry === undefined) {
			group.row = { ...row, retries: group.row.retries };
			files[group.fileIndex] = group.row;
		}
		if (parsed.retry !== undefined) group.retries.add(parsed.retry);
	}

	for (const group of collapsed.values()) {
		if (group.retries.size > 0) {
			group.row.retries = group.retries.size;
			files[group.fileIndex] = group.row;
		}
	}

	let truncated = diagnostics?.truncated;
	let truncationReason = diagnostics?.truncationReason;
	let cappedFiles = files;
	if (files.length > MAX_ARTIFACT_INDEX_FILES) {
		cappedFiles = files.slice(0, MAX_ARTIFACT_INDEX_FILES);
		truncated = true;
		truncationReason = truncationReason
			? `${truncationReason}; artifact index capped at ${MAX_ARTIFACT_INDEX_FILES} files`
			: `artifact index capped at ${MAX_ARTIFACT_INDEX_FILES} files`;
	}

	return {
		index: {
			count: artifacts.length,
			totalBytes,
			truncated,
			truncationReason,
			files: cappedFiles,
		},
		entries,
	};
}

export function buildArtifactIndex(diagnostics: GateStepDiagnostics | undefined): GateArtifactIndex {
	return buildArtifactLookup(diagnostics).index;
}

export function resolveArtifactFromLookup(
	lookup: GateArtifactLookup,
	artifactTarget: string,
	retry?: number,
): GateArtifactIndexFile {
	const normalizedTarget = normalizeArtifactPath(artifactTarget);
	const exact = lookup.entries.find(entry => entry.relativePath === normalizedTarget);
	if (exact) return exact;

	const matches = lookup.entries.filter(entry => entry.id === artifactTarget);
	if (!matches.length) {
		throw new GateArtifactResolutionError(`Unknown artifact "${artifactTarget}".`, lookup);
	}
	if (retry !== undefined) {
		const retryMatch = matches.find(entry => (entry.retry ?? 0) === retry);
		if (!retryMatch) {
			throw new GateArtifactResolutionError(`Unknown retry ${retry} for artifact "${artifactTarget}".`, lookup);
		}
		return retryMatch;
	}
	return matches.slice().sort((a, b) => (a.retry ?? 0) - (b.retry ?? 0))[0];
}

export function isWithinDirectory(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function validateRetainedArtifactPath(diagnostics: GateStepDiagnostics, artifact: GateArtifactIndexFile): string {
	const baseDir = path.resolve(diagnostics.baseDir);
	const artifactsDir = path.resolve(baseDir, "artifacts");
	const candidate = path.resolve(artifact.path);
	if (!isWithinDirectory(baseDir, candidate)) {
		throw new Error(`Artifact path is outside retained diagnostics directory.`);
	}
	if (!isWithinDirectory(artifactsDir, candidate)) {
		throw new Error(`Artifact path is outside retained artifacts directory.`);
	}
	let rootReal: string;
	let candidateReal: string;
	try {
		rootReal = fs.realpathSync(artifactsDir);
		candidateReal = fs.realpathSync(candidate);
	} catch {
		throw new Error(`Artifact file is missing or unavailable.`);
	}
	if (!isWithinDirectory(rootReal, candidateReal)) {
		throw new Error(`Artifact realpath escapes retained artifacts directory.`);
	}
	const stat = fs.statSync(candidateReal);
	if (!stat.isFile()) throw new Error(`Artifact path is not a file.`);
	return candidateReal;
}

export function stripPlaywrightErrorContextBoilerplate(text: string): string {
	const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
	if (!withoutBom.startsWith("# Instructions")) return text;
	const markers = [
		/^#{1,2} Test info\b/m,
		/^#{1,2} Test failure\b/m,
		/^#{1,2} Error details\b/m,
		/^#{1,2} Page snapshot\b/m,
		/^#{1,2} Test source\b/m,
		/^#{1,2} Error snapshot\b/m,
	];
	const markerIndex = markers
		.map(marker => {
			const match = marker.exec(withoutBom);
			return match ? match.index : -1;
		})
		.filter(index => index > 0)
		.sort((a, b) => a - b)[0];
	if (markerIndex === undefined) return text;

	const preamble = withoutBom.slice(0, markerIndex);
	if (!/\bPlaywright\b/i.test(preamble)) return text;
	return withoutBom.slice(markerIndex).replace(/^\s+/, "");
}
