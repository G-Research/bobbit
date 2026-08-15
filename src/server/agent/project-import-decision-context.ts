import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ProjectImportDecisionHookContext } from "./decision-hook-contract.js";
import type { Component } from "./project-config-store.js";
import type { RegisteredProject } from "./project-registry.js";

export const DETECTED_PROJECT_LANGUAGES = [
	"c", "cpp", "csharp", "dart", "elixir", "go", "haskell", "java",
	"javascript", "kotlin", "lua", "php", "python", "ruby", "rust",
	"scala", "shell", "sql", "swift", "typescript",
] as const;
export type DetectedProjectLanguage = typeof DETECTED_PROJECT_LANGUAGES[number];

export interface ProjectImportComponent {
	readonly id: string;
	readonly root: string;
	readonly languages: readonly DetectedProjectLanguage[];
}

export interface ProjectImportDecisionContext extends ProjectImportDecisionHookContext {}

export const MAX_PROJECT_IMPORT_COMPONENTS = 30;
export const MAX_PROJECT_IMPORT_OWNED_ROOTS = MAX_PROJECT_IMPORT_COMPONENTS + 1;
export const MAX_PROJECT_IMPORT_ROOT_ENTRIES = 256;
export const MAX_PROJECT_IMPORT_LANGUAGES = 12;
export const MAX_PROJECT_IMPORT_PATH_LENGTH = 4_096;
export const MAX_PROJECT_IMPORT_IDENTIFIER_LENGTH = 128;

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LANGUAGES = new Set<string>(DETECTED_PROJECT_LANGUAGES);

/** Fixed failure that never includes configuration- or filesystem-controlled text. */
export class ProjectImportDecisionContextError extends Error {
	readonly code = "PROJECT_IMPORT_CONTEXT_UNAVAILABLE";
	constructor() {
		super("PROJECT_IMPORT_CONTEXT_UNAVAILABLE");
		this.name = "ProjectImportDecisionContextError";
	}
}

export function isDetectedProjectLanguage(value: unknown): value is DetectedProjectLanguage {
	return typeof value === "string" && LANGUAGES.has(value);
}

/**
 * Build the only context visible to a project-import decision hook. Every path
 * is server-canonicalized and every list is bounded before it crosses the pack
 * boundary; this deliberately is not a source-tree scanner.
 */
export function buildProjectImportDecisionContext(input: {
	project: Pick<RegisteredProject, "id" | "rootPath">;
	importId: string;
	components: readonly Component[];
	fs?: Pick<typeof fs, "realpathSync" | "opendirSync">;
}): ProjectImportDecisionContext {
	const fileSystem = input.fs ?? fs;
	const projectId = requireIdentifier(input.project?.id);
	const importId = requireIdentifier(input.importId);
	// Select a fixed prefix before resolving any component path. Persisted
	// component order is stable, while this ensures configuration-controlled
	// input can never cause unbounded filesystem work.
	const selectedComponents = selectComponents(input.components);
	const projectRoot = canonicalProjectImportRoot(input.project?.rootPath, fileSystem);

	const components: ProjectImportComponent[] = [];
	for (const { component, index } of selectedComponents) {
		const root = canonicalComponentRoot(fileSystem, projectRoot, component);
		if (!root) continue;
		components.push(Object.freeze({
			id: componentId(index, component),
			root,
			languages: Object.freeze(detectLanguages(fileSystem, root)),
		}));
	}

	components.sort(compareComponents);
	const boundedComponents = Object.freeze(components
		.filter((component, index) => index === 0 || components[index - 1]!.root !== component.root)
		.slice(0, MAX_PROJECT_IMPORT_COMPONENTS));
	const ownedRoots = Object.freeze([...new Set([projectRoot, ...boundedComponents.map(component => component.root)])].sort(compareText));
	return Object.freeze({
		event: "projectImported" as const,
		projectId,
		importId,
		projectRoot,
		ownedRoots,
		components: boundedComponents,
	});
}

/**
 * Strictly revalidate a context read from durable storage. This does not rescan
 * the filesystem: replay must receive the immutable snapshot admitted at import.
 */
export function validateProjectImportDecisionContext(
	raw: unknown,
	expected?: { projectId: string; importId: string; projectRoot: string },
): ProjectImportDecisionContext {
	if (!isRecord(raw) || !onlyKeys(raw, ["event", "projectId", "importId", "projectRoot", "ownedRoots", "components"])
		|| raw.event !== "projectImported") throw unavailable();
	const projectId = requireIdentifier(raw.projectId);
	const importId = requireIdentifier(raw.importId);
	const projectRoot = requireCanonicalAbsolutePath(raw.projectRoot);
	if (expected && (projectId !== requireIdentifier(expected.projectId)
		|| importId !== requireIdentifier(expected.importId)
		|| projectRoot !== requireCanonicalAbsolutePath(expected.projectRoot))) throw unavailable();
	if (!Array.isArray(raw.ownedRoots) || raw.ownedRoots.length < 1 || raw.ownedRoots.length > MAX_PROJECT_IMPORT_OWNED_ROOTS) throw unavailable();
	const ownedRoots = raw.ownedRoots.map(requireCanonicalAbsolutePath);
	if (!isSortedUnique(ownedRoots) || ownedRoots[0] !== projectRoot || ownedRoots.some(root => !isWithin(root, projectRoot))) throw unavailable();
	if (!Array.isArray(raw.components) || raw.components.length > MAX_PROJECT_IMPORT_COMPONENTS) throw unavailable();
	const components = raw.components.map(validateComponentSnapshot);
	if (!isSorted(components, compareComponents) || !isSortedUnique(components.map(component => component.root))
		|| components.some(component => !ownedRoots.includes(component.root) || !isWithin(component.root, projectRoot))) throw unavailable();
	return Object.freeze({
		event: "projectImported" as const,
		projectId,
		importId,
		projectRoot,
		ownedRoots: Object.freeze([...ownedRoots]),
		components: Object.freeze(components),
	});
}

/** Resolve the current registered root before matching it to a durable snapshot. */
export function canonicalProjectImportRoot(
	candidate: unknown,
	fileSystem: Pick<typeof fs, "realpathSync" | "opendirSync"> = fs,
): string {
	return canonicalPath(fileSystem, candidate);
}

function canonicalComponentRoot(
	fileSystem: Pick<typeof fs, "realpathSync" | "opendirSync">,
	projectRoot: string,
	component: Component,
): string | undefined {
	try {
		// path.resolve permits an absolute or traversing persisted path only until
		// realpath/containment rejects it; no lexical component root is exposed.
		const candidate = path.resolve(projectRoot, component.repo, component.relativePath ?? "");
		const root = canonicalPath(fileSystem, candidate);
		return isWithin(root, projectRoot) ? root : undefined;
	} catch {
		return undefined;
	}
}

function canonicalPath(fileSystem: Pick<typeof fs, "realpathSync" | "opendirSync">, candidate: unknown): string {
	if (typeof candidate !== "string" || candidate.length === 0) throw unavailable();
	try {
		const resolved = fileSystem.realpathSync(candidate);
		if (typeof resolved !== "string" || resolved.length === 0 || resolved.length > MAX_PROJECT_IMPORT_PATH_LENGTH || !path.isAbsolute(resolved)) throw unavailable();
		return resolved;
	} catch (error) {
		if (error instanceof ProjectImportDecisionContextError) throw error;
		throw unavailable();
	}
}

function detectLanguages(fileSystem: Pick<typeof fs, "realpathSync" | "opendirSync">, root: string): DetectedProjectLanguage[] {
	const found = new Set<DetectedProjectLanguage>();
	let directory: ReturnType<typeof fs.opendirSync> | undefined;
	try {
		directory = fileSystem.opendirSync(root);
		for (let count = 0; count < MAX_PROJECT_IMPORT_ROOT_ENTRIES; count++) {
			const entry = directory.readSync();
			if (!entry) break;
			for (const language of languagesForEntry(entry.name)) found.add(language);
		}
	} catch {
		return [];
	} finally {
		// A directory handle consumes a process resource. Close it on normal,
		// exhausted, and failed reads, and never let a close failure escape.
		try { directory?.closeSync(); } catch { /* best effort after a read failure */ }
	}
	return [...found].sort(compareText).slice(0, MAX_PROJECT_IMPORT_LANGUAGES);
}

function languagesForEntry(entry: string): readonly DetectedProjectLanguage[] {
	const lower = entry.toLowerCase();
	if (lower === "package.json" || /\.(ts|tsx|mts|cts)$/.test(lower)) return ["typescript"];
	if (/\.(js|jsx|mjs|cjs)$/.test(lower)) return ["javascript"];
	if (lower === "go.mod" || lower.endsWith(".go")) return ["go"];
	if (lower === "cargo.toml" || lower.endsWith(".rs")) return ["rust"];
	if (lower.endsWith(".c") || lower.endsWith(".h")) return ["c"];
	if (/\.(cc|cp|cpp|cxx|c\+\+|hh|hpp|hxx)$/.test(lower)) return ["cpp"];
	if (lower.endsWith(".cs")) return ["csharp"];
	if (lower.endsWith(".dart")) return ["dart"];
	if (/\.(ex|exs)$/.test(lower)) return ["elixir"];
	if (lower.endsWith(".hs")) return ["haskell"];
	if (lower.endsWith(".java")) return ["java"];
	if (/\.(kt|kts)$/.test(lower)) return ["kotlin"];
	if (lower.endsWith(".lua")) return ["lua"];
	if (lower.endsWith(".php")) return ["php"];
	if (lower.endsWith(".py")) return ["python"];
	if (lower.endsWith(".rb")) return ["ruby"];
	if (/\.(scala|sc)$/.test(lower)) return ["scala"];
	if (/\.(sh|bash|zsh|fish)$/.test(lower)) return ["shell"];
	if (lower.endsWith(".sql")) return ["sql"];
	if (lower.endsWith(".swift")) return ["swift"];
	return [];
}

function componentId(index: number, component: Pick<Component, "name" | "repo" | "relativePath">): string {
	const fingerprint = base32(createHash("sha256").update(JSON.stringify({
		name: component.name,
		repo: component.repo,
		relativePath: component.relativePath ?? null,
	})).digest());
	return `component-${index}-${fingerprint}`;
}

function base32(bytes: Uint8Array): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
	let out = "";
	let value = 0;
	let bits = 0;
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += alphabet[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
	return out;
}

function validateComponentSnapshot(raw: unknown): ProjectImportComponent {
	if (!isRecord(raw) || !onlyKeys(raw, ["id", "root", "languages"])) throw unavailable();
	const id = requireIdentifier(raw.id);
	const root = requireCanonicalAbsolutePath(raw.root);
	if (!Array.isArray(raw.languages) || raw.languages.length > MAX_PROJECT_IMPORT_LANGUAGES) throw unavailable();
	const languages = raw.languages.map(language => {
		if (!isDetectedProjectLanguage(language)) throw unavailable();
		return language;
	});
	if (!isSortedUnique(languages)) throw unavailable();
	return Object.freeze({ id, root, languages: Object.freeze(languages) });
}

function selectComponents(input: readonly Component[]): readonly { component: Component; index: number }[] {
	if (!Array.isArray(input)) throw unavailable();
	try {
		const selected: { component: Component; index: number }[] = [];
		// Do not iterate or sort the unbounded caller array. Array.prototype.slice
		// reads only this fixed prefix even when a hostile runtime value is supplied.
		const prefix = Array.prototype.slice.call(input, 0, MAX_PROJECT_IMPORT_COMPONENTS) as unknown[];
		for (let index = 0; index < prefix.length; index++) {
			const component = prefix[index];
			if (isComponent(component)) selected.push({ component, index });
		}
		return selected;
	} catch {
		throw unavailable();
	}
}

function isComponent(value: unknown): value is Component {
	return isRecord(value) && typeof value.name === "string" && typeof value.repo === "string"
		&& (value.relativePath === undefined || typeof value.relativePath === "string");
}

function requireIdentifier(value: unknown): string {
	if (typeof value !== "string" || !IDENTIFIER_RE.test(value) || value.length > MAX_PROJECT_IMPORT_IDENTIFIER_LENGTH) throw unavailable();
	return value;
}

function requireCanonicalAbsolutePath(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_PROJECT_IMPORT_PATH_LENGTH
		|| !path.isAbsolute(value) || path.normalize(value) !== value) throw unavailable();
	return value;
}

function isWithin(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every(key => allowed.includes(key));
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function compareComponents(a: ProjectImportComponent, b: ProjectImportComponent): number {
	return compareText(a.root, b.root) || compareText(a.id, b.id);
}
function isSorted<T>(values: readonly T[], compare: (a: T, b: T) => number): boolean {
	return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) <= 0);
}
function isSortedUnique(values: readonly string[]): boolean {
	return values.every((value, index) => index === 0 || compareText(values[index - 1]!, value) < 0);
}
function unavailable(): ProjectImportDecisionContextError { return new ProjectImportDecisionContextError(); }
