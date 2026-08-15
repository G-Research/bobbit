import fs from "node:fs";
import path from "node:path";
import {
	CODE_INTELLIGENCE_LANGUAGE_MATRIX,
	walkLanguageDetectionPaths,
	type AstGrepLanguageAlias,
	type CodeIntelligenceLanguage,
	type LanguageDetectorFs,
} from "../lib/language-matrix.ts";

export interface ComponentLanguageDetectionInput {
	/** Stable configured component name; no absolute path is returned to callers. */
	component: string;
	/** Exact component root in the active linked worktree. */
	root: string;
}

export interface LanguageDetectionEvidence {
	fileCount: number;
	matchedGlobs: readonly string[];
	rootMarkers: readonly string[];
}

/**
 * This is intentionally a static capability offer, not a runtime probe. LSP is
 * disabled by default even when its declaration is present.
 */
export interface LanguageDetection {
	component: string;
	languageId: AstGrepLanguageAlias;
	evidence: LanguageDetectionEvidence;
	structuralSearch: "available" | "unsupported";
	lsp: "disabled" | "ready" | "requires-toolchain" | "unsupported";
	missing: readonly [];
}

export interface LanguageDetectionFs extends LanguageDetectorFs {}

/**
 * Detect matrix-declared languages below one configured component root. The walk
 * is bounded, never follows symlinks, and only inspects filenames/markers; it
 * does not execute, install, or configure anything.
 */
export function detectComponentLanguages(
	input: ComponentLanguageDetectionInput,
	seams: LanguageDetectionFs = fs,
): LanguageDetection[] {
	if (!input.component.trim() || !input.root.trim()) return [];

	const counts = new Map<AstGrepLanguageAlias, number>();
	const globs = new Map<AstGrepLanguageAlias, Set<string>>();
	const rootMarkers = new Set<string>();
	const rootPath = path.resolve(input.root);
	walkLanguageDetectionPaths([input.root], seams, (filePath) => {
		if (path.dirname(path.resolve(filePath)) === rootPath) rootMarkers.add(path.basename(filePath));
		collectFileEvidence(filePath, counts, globs);
	});

	const rootMarkerNames = [...rootMarkers].sort();
	const detected: LanguageDetection[] = [];
	for (const language of CODE_INTELLIGENCE_LANGUAGE_MATRIX as readonly CodeIntelligenceLanguage[]) {
		const fileCount = counts.get(language.id as AstGrepLanguageAlias) ?? 0;
		if (fileCount < language.evidence.minimumFiles) continue;
		const matchedMarkers = language.evidence.rootMarkers.filter((marker) => rootMarkerNames.some((name) => markerMatches(marker, name)));
		detected.push({
			component: input.component,
			languageId: language.id as AstGrepLanguageAlias,
			evidence: {
				fileCount,
				matchedGlobs: [...(globs.get(language.id as AstGrepLanguageAlias) ?? [])].sort(),
				rootMarkers: matchedMarkers,
			},
			structuralSearch: language.structuralSearch.state === "supported" ? "available" : "unsupported",
			lsp: language.lsp ? "disabled" : "unsupported",
			missing: [],
		});
	}
	return detected.sort((left, right) => left.languageId.localeCompare(right.languageId));
}

/** Alias kept for callers that describe the operation rather than its scope. */
export const detectLanguagesForComponent = detectComponentLanguages;

function collectFileEvidence(
	filePath: string,
	counts: Map<AstGrepLanguageAlias, number>,
	globs: Map<AstGrepLanguageAlias, Set<string>>,
): void {
	const extension = path.extname(filePath).toLowerCase();
	for (const language of CODE_INTELLIGENCE_LANGUAGE_MATRIX) {
		const matched = language.evidence.globs.filter((glob) => path.extname(glob).toLowerCase() === extension);
		if (matched.length === 0) continue;
		counts.set(language.id, (counts.get(language.id) ?? 0) + 1);
		const knownGlobs = globs.get(language.id) ?? new Set<string>();
		for (const glob of matched) knownGlobs.add(glob);
		globs.set(language.id, knownGlobs);
	}
}

function markerMatches(marker: string, name: string): boolean {
	const expression = `^${marker.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`;
	return new RegExp(expression).test(name);
}

