import { createHash } from "node:crypto";
import type { ProjectConfigStore } from "./project-config-store.js";
import {
	containsReservedCorePromptDelimiter,
	CORE_PROMPT_RESERVED_DELIMITER_TOKENS,
	EXTENSION_PROMPT_REGION_END,
	EXTENSION_PROMPT_REGION_START,
	extensionPromptSectionEnd as renderExtensionPromptSectionEnd,
	extensionPromptSectionStart as renderExtensionPromptSectionStart,
} from "./prompt-delimiters.js";

export {
	DYNAMIC_CONTEXT_END,
	DYNAMIC_CONTEXT_START,
	EXTENSION_PROMPT_REGION_END,
	EXTENSION_PROMPT_REGION_START,
	EXTENSION_PROMPT_SECTION_END,
	EXTENSION_PROMPT_SECTION_START,
} from "./prompt-delimiters.js";

/** Core-owned markers. Contributions may never contain these tokens. */
export const PROMPT_EXTENSION_RESERVED_DELIMITERS = CORE_PROMPT_RESERVED_DELIMITER_TOKENS;

/** Matches pack ids, hook ids, and pack-local prompt-section ids. */
export const PROMPT_EXTENSION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PROPOSAL_SECTIONS = 128;
const MAX_LITERAL_BYTES = 64 * 1024;

/** Hard defaults; a project may lower these caps but never raise them. */
export const DEFAULT_PROMPT_EXTENSION_BUDGET: PromptExtensionBudget = Object.freeze({
	maxBytesPerSection: 16 * 1024,
	maxBytesTotal: 64 * 1024,
});

export interface PromptExtensionBudget {
	maxBytesPerSection: number;
	maxBytesTotal: number;
}

/** A project-effective replacement for one pack-owned static section. */
export interface PromptExtensionOverride {
	packId: string;
	sectionId: string;
	content: string;
	/** Monotonic per-section revision; zero is reserved for no persisted override. */
	revision: number;
	updatedAt: string;
	updatedBy: string;
}

/** The only prompt-edit payload accepted in a project proposal. */
export interface PromptExtensionProposalSection {
	packId: string;
	sectionId: string;
	content: string;
	expectedRevision: number;
}

export interface PromptExtensionRenderSection {
	packId: string;
	sectionId: string;
	content: string;
}

export class PromptExtensionValidationError extends Error {
	constructor(
		readonly code: "INVALID_SECTION" | "RESERVED_DELIMITER" | "DUPLICATE_SECTION" | "OVER_BUDGET" | "STALE_REVISION" | "GRANT_REQUIRED" | "UNKNOWN_SECTION",
		message: string,
	) {
		super(message);
		this.name = "PromptExtensionValidationError";
	}
}

export function promptExtensionKey(packId: string, sectionId: string): string {
	return `${packId}\u0000${sectionId}`;
}

export function extensionPromptSectionStart(packId: string, sectionId: string): string {
	assertPromptExtensionIdentifier(packId, "packId");
	assertPromptExtensionIdentifier(sectionId, "sectionId");
	return renderExtensionPromptSectionStart(packId, sectionId);
}

export function extensionPromptSectionEnd(packId: string, sectionId: string): string {
	assertPromptExtensionIdentifier(packId, "packId");
	assertPromptExtensionIdentifier(sectionId, "sectionId");
	return renderExtensionPromptSectionEnd(packId, sectionId);
}

/** The canonical wrapped section used for budget accounting and prompt assembly. */
export function renderPromptExtensionSection(section: PromptExtensionRenderSection): string {
	validatePromptExtensionContent(section.content);
	return `${extensionPromptSectionStart(section.packId, section.sectionId)}\n${section.content}\n${extensionPromptSectionEnd(section.packId, section.sectionId)}`;
}

/** The canonical contiguous region. Empty inputs intentionally emit no marker. */
export function renderPromptExtensionRegion(sections: readonly PromptExtensionRenderSection[]): string {
	if (sections.length === 0) return "";
	return `${EXTENSION_PROMPT_REGION_START}\n${sections.map(renderPromptExtensionSection).join("\n")}\n${EXTENSION_PROMPT_REGION_END}`;
}

export function promptExtensionSectionBytes(section: PromptExtensionRenderSection): number {
	return Buffer.byteLength(renderPromptExtensionSection(section), "utf8");
}

export function promptExtensionRegionBytes(sections: readonly PromptExtensionRenderSection[]): number {
	return Buffer.byteLength(renderPromptExtensionRegion(sections), "utf8");
}

export function normalizePromptExtensionBudget(value: unknown): { value: PromptExtensionBudget; ok: boolean } {
	if (!isRecord(value)) return { value: { ...DEFAULT_PROMPT_EXTENSION_BUDGET }, ok: false };
	const perSection = value.maxBytesPerSection;
	const total = value.maxBytesTotal;
	if (!isBudgetLimit(perSection) || !isBudgetLimit(total) || perSection > DEFAULT_PROMPT_EXTENSION_BUDGET.maxBytesPerSection || total > DEFAULT_PROMPT_EXTENSION_BUDGET.maxBytesTotal || perSection > total) {
		return { value: { ...DEFAULT_PROMPT_EXTENSION_BUDGET }, ok: false };
	}
	return { value: { maxBytesPerSection: perSection, maxBytesTotal: total }, ok: true };
}

export function normalizePromptExtensionOverrides(value: unknown): { value: PromptExtensionOverride[]; ok: boolean } {
	if (!Array.isArray(value)) return { value: [], ok: false };
	const overrides: PromptExtensionOverride[] = [];
	const keys = new Set<string>();
	for (const candidate of value) {
		const normalized = normalizeOverride(candidate);
		if (!normalized || keys.has(promptExtensionKey(normalized.packId, normalized.sectionId))) return { value: [], ok: false };
		keys.add(promptExtensionKey(normalized.packId, normalized.sectionId));
		overrides.push(normalized);
	}
	return { value: overrides, ok: true };
}

/** Parse-time validation for project proposals. It has no grant/layout side effects. */
export function validatePromptExtensionProposalSections(value: unknown): PromptExtensionProposalSection[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PROPOSAL_SECTIONS) {
		throw new PromptExtensionValidationError("INVALID_SECTION", "extensionPromptSections must be a non-empty bounded array");
	}
	const sections: PromptExtensionProposalSection[] = [];
	const keys = new Set<string>();
	for (const candidate of value) {
		if (!isRecord(candidate)) throw new PromptExtensionValidationError("INVALID_SECTION", "extensionPromptSections entries must be mappings");
		const { packId, sectionId, content, expectedRevision } = candidate;
		assertPromptExtensionIdentifier(packId, "packId");
		assertPromptExtensionIdentifier(sectionId, "sectionId");
		validatePromptExtensionContent(content);
		if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision > Number.MAX_SAFE_INTEGER) {
			throw new PromptExtensionValidationError("INVALID_SECTION", "expectedRevision must be a non-negative integer");
		}
		const key = promptExtensionKey(packId, sectionId);
		if (keys.has(key)) throw new PromptExtensionValidationError("DUPLICATE_SECTION", "extensionPromptSections cannot name a section twice");
		keys.add(key);
		sections.push({ packId, sectionId, content, expectedRevision });
	}
	return sections;
}

/** Validate wrapper-inclusive limits without truncating any section. */
export function assertPromptExtensionBudget(
	sections: readonly PromptExtensionRenderSection[],
	budget: PromptExtensionBudget,
	declaredMaxBytes?: ReadonlyMap<string, number | undefined>,
): void {
	const normalized = normalizePromptExtensionBudget(budget);
	if (!normalized.ok) throw new PromptExtensionValidationError("OVER_BUDGET", "Prompt extension budget is invalid");
	const keys = new Set<string>();
	for (const section of sections) {
		const key = promptExtensionKey(section.packId, section.sectionId);
		if (keys.has(key)) throw new PromptExtensionValidationError("DUPLICATE_SECTION", "Duplicate prompt extension section");
		keys.add(key);
		const bytes = promptExtensionSectionBytes(section);
		const declaredCap = declaredMaxBytes?.get(key);
		const cap = typeof declaredCap === "number" ? Math.min(normalized.value.maxBytesPerSection, declaredCap) : normalized.value.maxBytesPerSection;
		if (!isBudgetLimit(cap) || bytes > cap) {
			throw new PromptExtensionValidationError("OVER_BUDGET", "Prompt extension section exceeds its UTF-8 byte budget");
		}
	}
	if (promptExtensionRegionBytes(sections) > normalized.value.maxBytesTotal) {
		throw new PromptExtensionValidationError("OVER_BUDGET", "Prompt extension region exceeds its UTF-8 byte budget");
	}
}

export interface AcceptPromptExtensionProposalOptions {
	/** Rechecked immediately before the one durable ProjectConfigStore publication. */
	hasStaticGrant(packId: string): boolean;
	/** Confirms a proposal cannot create an override for an unknown pack section. */
	hasSection?(packId: string, sectionId: string): boolean;
	now?: () => Date;
	actor: string;
	/** All manifest + override-effective sections after replacement, for aggregate wrapper-inclusive accounting. */
	resolveEffectiveSections: (overrides: readonly PromptExtensionOverride[]) => readonly PromptExtensionRenderSection[];
	declaredMaxBytes?: ReadonlyMap<string, number | undefined>;
}

/**
 * Accept a human-approved proposal through a CAS update. This never accepts
 * extension input directly: callers must first persist the ordinary project
 * proposal and place it in the human approval flow.
 */
export function acceptPromptExtensionProposal(
	store: ProjectConfigStore,
	changes: readonly PromptExtensionProposalSection[],
	opts: AcceptPromptExtensionProposalOptions,
): PromptExtensionOverride[] {
	const validated = validatePromptExtensionProposalSections(changes);
	const now = (opts.now ?? (() => new Date()))().toISOString();
	const current = store.getPromptExtensionOverrides();
	const byKey = new Map(current.map(row => [promptExtensionKey(row.packId, row.sectionId), row]));
	for (const change of validated) {
		if (!opts.hasStaticGrant(change.packId)) throw new PromptExtensionValidationError("GRANT_REQUIRED", "Static prompt grant is required");
		if (opts.hasSection && !opts.hasSection(change.packId, change.sectionId)) throw new PromptExtensionValidationError("UNKNOWN_SECTION", "Prompt extension section is not installed");
		const prior = byKey.get(promptExtensionKey(change.packId, change.sectionId));
		if ((prior?.revision ?? 0) !== change.expectedRevision) throw new PromptExtensionValidationError("STALE_REVISION", "Prompt extension section changed before approval");
	}
	for (const change of validated) {
		const key = promptExtensionKey(change.packId, change.sectionId);
		const prior = byKey.get(key);
		byKey.set(key, { packId: change.packId, sectionId: change.sectionId, content: change.content, revision: (prior?.revision ?? 0) + 1, updatedAt: now, updatedBy: opts.actor });
	}
	const next = [...byKey.values()].sort(compareOverrides);
	const effective = opts.resolveEffectiveSections(next);
	assertPromptExtensionBudget(effective, store.getPromptExtensionBudget(), opts.declaredMaxBytes);
	// mutate publishes only after all validation above has succeeded; no stale or
	// over-budget candidate can replace the prior effective project configuration.
	store.mutate(draft => draft.setPromptExtensionOverrides(next));
	return next.map(row => ({ ...row }));
}

export function promptExtensionContentDigest(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function normalizeOverride(value: unknown): PromptExtensionOverride | undefined {
	if (!isRecord(value)) return undefined;
	const { packId, sectionId, content, revision, updatedAt, updatedBy } = value;
	try {
		assertPromptExtensionIdentifier(packId, "packId");
		assertPromptExtensionIdentifier(sectionId, "sectionId");
		validatePromptExtensionContent(content);
	} catch { return undefined; }
	if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1 || revision > Number.MAX_SAFE_INTEGER
		|| !isCanonicalTimestamp(updatedAt) || !isPromptExtensionIdentifier(updatedBy)) return undefined;
	return { packId, sectionId, content, revision, updatedAt, updatedBy };
}

function isPromptExtensionIdentifier(value: unknown): value is string {
	return typeof value === "string" && PROMPT_EXTENSION_IDENTIFIER.test(value);
}

function assertPromptExtensionIdentifier(value: unknown, label: string): asserts value is string {
	if (!isPromptExtensionIdentifier(value)) {
		throw new PromptExtensionValidationError("INVALID_SECTION", `${label} must be a safe prompt extension identifier`);
	}
}

function validatePromptExtensionContent(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_LITERAL_BYTES) {
		throw new PromptExtensionValidationError("INVALID_SECTION", "Prompt extension content must be a non-empty bounded UTF-8 string");
	}
	if (containsReservedCorePromptDelimiter(value)) {
		throw new PromptExtensionValidationError("RESERVED_DELIMITER", "Prompt extension content contains a reserved delimiter");
	}
}

function isBudgetLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_LITERAL_BYTES;
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const date = new Date(value);
	return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function compareCodeUnits(left: string, right: string): number {
	return left === right ? 0 : left < right ? -1 : 1;
}

function compareOverrides(left: PromptExtensionOverride, right: PromptExtensionOverride): number {
	return compareCodeUnits(left.packId, right.packId) || compareCodeUnits(left.sectionId, right.sectionId);
}
