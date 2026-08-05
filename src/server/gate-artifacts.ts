import fs from "node:fs";
import path from "node:path";

import type { GateStepDiagnosticArtifactMetadata, GateStepDiagnostics } from "./gate-diagnostics.js";
import type { ManagedGatePayloadRef } from "./agent/gate-store.js";
import {
	selectGateTextStream,
	selectManagedGatePayload,
	validateManagedGatePayloadRef,
	type ManagedPayloadSelection,
	type ManagedPayloadSelectionResult,
} from "./agent/gate-store-v2-persistence.js";

export const MAX_ARTIFACT_INDEX_FILES = 100;

export interface GateArtifactIndexFile {
	id: string;
	testName?: string;
	relativePath: string;
	bytes: number;
	kind: GateStepDiagnosticArtifactMetadata["kind"];
	retries?: number;
	retry?: number;
	contentType?: string;
}

interface RetainedArtifactBacking {
	path: string;
	contentRef?: ManagedGatePayloadRef;
}

// Backing paths and managed refs never become enumerable response properties.
// Only rows created from trusted diagnostics metadata can be resolved.
const retainedArtifactBacking = new WeakMap<GateArtifactIndexFile, RetainedArtifactBacking>();

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
		const validArtifacts = lookup.entries.length ? lookup.entries : lookup.index.files;
		this.validArtifactIds = [...new Set(validArtifacts.map(file => file.id))];
		this.validArtifacts = validArtifacts.map(file => ({
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
	return { id: relativePath, collapsible: false };
}

const TEXT_INSPECTABLE_ARTIFACT_EXTENSIONS = new Set([
	".css",
	".csv",
	".html",
	".js",
	".json",
	".log",
	".md",
	".mjs",
	".txt",
	".ts",
	".xml",
	".yaml",
	".yml",
]);

export function isTextInspectableArtifact(artifact: GateArtifactIndexFile): boolean {
	const contentType = artifact.contentType?.toLowerCase();
	if (contentType) {
		return contentType.startsWith("text/")
			|| contentType.includes("json")
			|| contentType.includes("javascript")
			|| contentType.includes("xml")
			|| contentType.includes("yaml");
	}
	return TEXT_INSPECTABLE_ARTIFACT_EXTENSIONS.has(path.extname(artifact.relativePath).toLowerCase());
}

function metadataRow(artifact: GateStepDiagnosticArtifactMetadata, id: string, retry?: number): GateArtifactIndexFile {
	const row: GateArtifactIndexFile = {
		id,
		relativePath: normalizeArtifactPath(artifact.relativePath),
		bytes: artifact.bytes,
		kind: artifact.kind,
	};
	retainedArtifactBacking.set(row, {
		path: artifact.path,
		...(artifact.contentRef ? { contentRef: artifact.contentRef } : {}),
	});
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
			const replacement = { ...row, retries: group.row.retries };
			retainedArtifactBacking.set(replacement, retainedArtifactBacking.get(row)!);
			group.row = replacement;
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
		const retryMatches = matches.filter(entry => (entry.retry ?? 0) === retry);
		if (retryMatches.length === 1) return retryMatches[0];
		if (retryMatches.length > 1) {
			throw new GateArtifactResolutionError(`Artifact "${artifactTarget}" retry ${retry} is ambiguous; use relativePath to select an exact file.`, lookup);
		}
		throw new GateArtifactResolutionError(`Unknown retry ${retry} for artifact "${artifactTarget}".`, lookup);
	}

	const primaryMatches = matches.filter(entry => entry.retry === undefined);
	if (primaryMatches.length === 1) return primaryMatches[0];
	if (primaryMatches.length > 1) {
		throw new GateArtifactResolutionError(`Artifact "${artifactTarget}" is ambiguous; use relativePath to select an exact file.`, lookup);
	}
	if (matches.length === 1) return matches[0];
	throw new GateArtifactResolutionError(`Artifact "${artifactTarget}" has multiple retries; pass retry or use relativePath to select an exact file.`, lookup);
}

export function isWithinDirectory(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function trustedStateDir(v2Root: string): string {
	return path.dirname(path.dirname(path.resolve(v2Root)));
}

export function validateRetainedArtifactPath(v2Root: string, diagnostics: GateStepDiagnostics, artifact: GateArtifactIndexFile): string;
/** @deprecated Fail-closed compatibility overload; callers must pass the owning v2 root. */
export function validateRetainedArtifactPath(diagnostics: GateStepDiagnostics, artifact: GateArtifactIndexFile): never;
export function validateRetainedArtifactPath(
	v2RootOrDiagnostics: string | GateStepDiagnostics,
	diagnosticsOrArtifact: GateStepDiagnostics | GateArtifactIndexFile,
	maybeArtifact?: GateArtifactIndexFile,
): string {
	if (typeof v2RootOrDiagnostics !== "string" || !maybeArtifact) {
		throw new Error(`Retained artifact inspection requires the owning gate v2 root.`);
	}
	const v2Root = v2RootOrDiagnostics;
	const diagnostics = diagnosticsOrArtifact as GateStepDiagnostics;
	const artifact = maybeArtifact;
	const backing = retainedArtifactBacking.get(artifact);
	if (!backing) throw new Error(`Artifact backing metadata is unavailable.`);
	if (backing.contentRef) {
		if (!validateManagedGatePayloadRef(v2Root, backing.contentRef)) throw new Error(`Managed artifact payload is missing, tampered, or unavailable.`);
		throw new Error(`Managed artifact payload requires bounded asynchronous inspection.`);
	}
	const diagnosticsRoot = path.join(trustedStateDir(v2Root), "gate-diagnostics");
	const baseDir = path.resolve(diagnostics.baseDir);
	const artifactsDir = path.resolve(baseDir, "artifacts");
	const candidate = path.resolve(backing.path);
	if (!isWithinDirectory(path.resolve(diagnosticsRoot), baseDir)) {
		throw new Error(`Diagnostics path is outside the owning project state.`);
	}
	if (!isWithinDirectory(baseDir, candidate)) {
		throw new Error(`Artifact path is outside retained diagnostics directory.`);
	}
	if (!isWithinDirectory(artifactsDir, candidate)) {
		throw new Error(`Artifact path is outside retained artifacts directory.`);
	}
	let diagnosticsRootReal: string;
	let rootReal: string;
	let candidateReal: string;
	try {
		diagnosticsRootReal = fs.realpathSync(diagnosticsRoot);
		rootReal = fs.realpathSync(artifactsDir);
		candidateReal = fs.realpathSync(candidate);
	} catch {
		throw new Error(`Artifact file is missing or unavailable.`);
	}
	if (!isWithinDirectory(diagnosticsRootReal, candidateReal) || !isWithinDirectory(rootReal, candidateReal)) {
		throw new Error(`Artifact realpath escapes retained artifacts directory.`);
	}
	const stat = fs.statSync(candidateReal);
	if (!stat.isFile()) throw new Error(`Artifact path is not a file.`);
	return candidateReal;
}

/**
 * Select one retained artifact without exposing its backing path/ref. Managed
 * fallbacks are root-bound and checksum-verified to EOF in the same pass.
 */
export async function selectRetainedGateArtifact(
	v2Root: string,
	diagnostics: GateStepDiagnostics,
	artifact: GateArtifactIndexFile,
	selection: ManagedPayloadSelection = {},
): Promise<ManagedPayloadSelectionResult | undefined> {
	const backing = retainedArtifactBacking.get(artifact);
	if (!backing) return undefined;
	if (backing.contentRef) return selectManagedGatePayload(v2Root, backing.contentRef, selection);
	let candidate: string;
	try { candidate = validateRetainedArtifactPath(v2Root, diagnostics, artifact); } catch { return undefined; }
	try {
		return await selectGateTextStream(fs.createReadStream(candidate, { highWaterMark: 64 * 1024 }), selection);
	} catch {
		return undefined;
	}
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
