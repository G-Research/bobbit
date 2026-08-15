import fs from "node:fs";
import path from "node:path";
import {
	CODE_INTELLIGENCE_LANGUAGE_MATRIX,
	MAX_LANGUAGE_DETECTION_ENTRIES,
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

const ignoredDirectories = new Set([
	".git", ".hg", ".svn", "node_modules", "dist", "build", "coverage", ".next", ".cache", "vendor",
]);

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
	const rootMarkers = readRootMarkers(input.root, seams);
	const pending = [input.root];
	let scanned = 0;

	while (pending.length > 0 && scanned < MAX_LANGUAGE_DETECTION_ENTRIES) {
		const current = pending.pop()!;
		let stat: fs.Stats;
		try { stat = seams.lstatSync(current); } catch { continue; }
		if (stat.isSymbolicLink()) continue;
		if (stat.isFile()) {
			collectFileEvidence(current, counts, globs);
			continue;
		}
		if (!stat.isDirectory()) continue;
		let entries: fs.Dirent[];
		try { entries = seams.readdirSync(current, { withFileTypes: true }) as fs.Dirent[]; } catch { continue; }
		for (const entry of entries) {
			if (scanned++ >= MAX_LANGUAGE_DETECTION_ENTRIES) break;
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
			pending.push(path.join(current, entry.name));
		}
	}

	const detected: LanguageDetection[] = [];
	for (const language of CODE_INTELLIGENCE_LANGUAGE_MATRIX as readonly CodeIntelligenceLanguage[]) {
		const fileCount = counts.get(language.id as AstGrepLanguageAlias) ?? 0;
		if (fileCount < language.evidence.minimumFiles) continue;
		const matchedMarkers = language.evidence.rootMarkers.filter((marker) => rootMarkers.some((name) => markerMatches(marker, name)));
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

function readRootMarkers(root: string, seams: LanguageDetectionFs): readonly string[] {
	try {
		const stat = seams.lstatSync(root);
		if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
		return (seams.readdirSync(root, { withFileTypes: true }) as fs.Dirent[])
			.filter((entry) => !entry.isSymbolicLink())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

function markerMatches(marker: string, name: string): boolean {
	const expression = `^${marker.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`;
	return new RegExp(expression).test(name);
}

