import { createHash } from "node:crypto";
import {
	isSafeExtensionGrantIdentifier,
	type ExtensionHookRef,
} from "./project-config-store.js";

/** The only dynamic selector stages. This deliberately has no tools stage. */
export type CapabilitySelectorStage = "skills" | "mcp";

/** Untrusted proposal returned from a selector hook. */
export interface CapabilityProposal {
	add: readonly string[];
	omit?: readonly string[];
	reason: string;
	confidence: number;
}

export type ValidatedCapabilityProposal = Readonly<{
	add: readonly string[];
	omit: readonly string[];
	reason: string;
	confidence: number;
}>;

/** Core-attached provenance and precedence; hook output cannot supply either. */
export interface CapabilitySelectionCandidate {
	readonly source: Readonly<ExtensionHookRef>;
	readonly priority: number;
	readonly proposal: ValidatedCapabilityProposal;
}

export interface CapabilitySelectionReduction {
	readonly selected: readonly string[];
	readonly winner?: CapabilitySelectionCandidate;
}

export const DYNAMIC_CAPABILITY_SELECTION_VERSION = 1;
export interface DynamicCapabilitySelection {
	readonly version: typeof DYNAMIC_CAPABILITY_SELECTION_VERSION;
	readonly queryFingerprint: string;
	/** A valid skills proposal won; false preserves the legacy skills surface. */
	readonly skillsAuthoritative: boolean;
	readonly skills: readonly string[];
	/** A valid MCP proposal won; false preserves the legacy MCP surface. */
	readonly mcpAuthoritative: boolean;
	readonly mcp: readonly string[];
	readonly skillsFingerprint: string;
	readonly mcpFingerprint: string;
	readonly selectionFingerprint: string;
}

export const MAX_CAPABILITY_IDENTIFIER_LENGTH = 128;
export const MAX_CAPABILITY_PROPOSAL_IDS = 128;
export const MAX_CAPABILITY_REASON_LENGTH = 512;
export const MAX_CAPABILITY_QUERY_BYTES = 8 * 1024;

export class DynamicCapabilityContractError extends Error {
	constructor(public readonly code: string) {
		super(code);
		this.name = "DynamicCapabilityContractError";
	}
}

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROPOSAL_KEYS = new Set(["add", "omit", "reason", "confidence"]);
const SELECTION_KEYS = new Set(["version", "queryFingerprint", "skillsAuthoritative", "skills", "mcpAuthoritative", "mcp", "skillsFingerprint", "mcpFingerprint", "selectionFingerprint"]);
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;

function fail(code: string): never { throw new DynamicCapabilityContractError(code); }

function isRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, code: string): void {
	for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code);
}

function lexical(a: string, b: string): number {
	return a === b ? 0 : a < b ? -1 : 1;
}

/** A model-facing id, never a path, config, or tool-operation expression. */
export function isSafeCapabilityIdentifier(value: unknown): value is string {
	return typeof value === "string" && IDENTIFIER_RE.test(value);
}

function normalizedIdentifiers(raw: unknown, code: string, max = MAX_CAPABILITY_PROPOSAL_IDS): readonly string[] {
	if (!Array.isArray(raw) || raw.length > max) fail(code);
	const values: string[] = [];
	for (const value of raw) {
		if (!isSafeCapabilityIdentifier(value)) fail(code);
		values.push(value);
	}
	return Object.freeze([...new Set(values)].sort(lexical));
}

function safeReason(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_CAPABILITY_REASON_LENGTH
		|| /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) fail("INVALID_CAPABILITY_PROPOSAL");
	return value;
}

/** Strictly validates a hook proposal and canonically resolves add/omit overlap to omit. */
export function validateCapabilityProposal(raw: unknown): ValidatedCapabilityProposal {
	if (!isRecord(raw)) fail("INVALID_CAPABILITY_PROPOSAL");
	onlyKeys(raw, PROPOSAL_KEYS, "UNKNOWN_CAPABILITY_PROPOSAL_FIELD");
	const add = normalizedIdentifiers(raw.add, "INVALID_CAPABILITY_PROPOSAL");
	const omit = raw.omit === undefined ? Object.freeze([] as string[]) : normalizedIdentifiers(raw.omit, "INVALID_CAPABILITY_PROPOSAL");
	const reason = safeReason(raw.reason);
	if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
		fail("INVALID_CAPABILITY_PROPOSAL");
	}
	const omissions = new Set(omit);
	return Object.freeze({
		add: Object.freeze(add.filter(id => !omissions.has(id))),
		omit,
		reason,
		confidence: raw.confidence,
	});
}

/** A bounded, frozen copy of core's candidate ceiling. Invalid entries fail closed. */
export function snapshotCapabilityAvailability(raw: unknown): readonly string[] {
	if (!Array.isArray(raw)) return Object.freeze([] as string[]);
	return Object.freeze([...new Set(raw.filter(isSafeCapabilityIdentifier))].sort(lexical));
}

/**
 * Copies only core-provenanced selector results. This intentionally reparses the
 * proposal so a caller cannot bypass the worker-boundary contract with a cast.
 */
export function createCapabilitySelectionCandidate(raw: unknown): CapabilitySelectionCandidate | undefined {
	if (!isRecord(raw) || !isRecord(raw.source)
		|| !isSafeExtensionGrantIdentifier(raw.source.packId) || !isSafeExtensionGrantIdentifier(raw.source.hookId)
		|| typeof raw.priority !== "number" || !Number.isSafeInteger(raw.priority) || raw.priority < 0) return undefined;
	try {
		return Object.freeze({
			source: Object.freeze({ packId: raw.source.packId, hookId: raw.source.hookId }),
			priority: raw.priority,
			proposal: validateCapabilityProposal(raw.proposal),
		});
	} catch {
		return undefined;
	}
}

function compareCandidates(a: CapabilitySelectionCandidate, b: CapabilitySelectionCandidate): number {
	if (a.proposal.confidence !== b.proposal.confidence) return b.proposal.confidence - a.proposal.confidence;
	if (a.priority !== b.priority) return b.priority - a.priority;
	if (a.source.packId !== b.source.packId) return lexical(a.source.packId, b.source.packId);
	return lexical(a.source.hookId, b.source.hookId);
}

/**
 * Selects one deterministic winner, then narrows its output to core's fixed
 * ceiling. The reducer never admits a hook-proposed identifier by itself.
 */
export function reduceCapabilitySelectionCandidates(
	rawCandidates: readonly unknown[],
	available: unknown,
): Readonly<CapabilitySelectionReduction> {
	let winner: CapabilitySelectionCandidate | undefined;
	for (const raw of Array.isArray(rawCandidates) ? rawCandidates : []) {
		const candidate = createCapabilitySelectionCandidate(raw);
		if (candidate && (!winner || compareCandidates(candidate, winner) < 0)) winner = candidate;
	}
	if (!winner) return Object.freeze({ selected: Object.freeze([] as string[]) });
	const ceiling = new Set(snapshotCapabilityAvailability(available));
	const omitted = new Set(winner.proposal.omit);
	const selected = Object.freeze(winner.proposal.add.filter(id => ceiling.has(id) && !omitted.has(id)));
	return Object.freeze({ selected, winner });
}

/** Filters an existing discovered/policy-permitted list without mutating it. */
export function filterSelectedCapabilities<T>(
	available: readonly T[],
	selected: readonly string[] | undefined,
	identifier: (candidate: T) => string,
): readonly T[] {
	if (!selected) return Object.freeze([...available]);
	const selectedSet = new Set(snapshotCapabilityAvailability(selected));
	return Object.freeze(available.filter(candidate => selectedSet.has(identifier(candidate))));
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/**
 * Produces the exact bounded query seen by selectors and represented by a
 * snapshot fingerprint. Iterating code points keeps UTF-8 truncation valid.
 */
export function canonicalizeCapabilityQuery(query: unknown): string {
	if (typeof query !== "string") return "";
	if (Buffer.byteLength(query, "utf8") <= MAX_CAPABILITY_QUERY_BYTES) return query;
	let output = "";
	let bytes = 0;
	for (const char of query) {
		const charBytes = Buffer.byteLength(char, "utf8");
		if (bytes + charBytes > MAX_CAPABILITY_QUERY_BYTES) break;
		output += char;
		bytes += charBytes;
	}
	return output;
}

function queryFingerprint(query: string): string {
	return fingerprint(["dynamic-capability-query", canonicalizeCapabilityQuery(query)]);
}

function listFingerprint(stage: CapabilitySelectorStage, authoritative: boolean, ids: readonly string[]): string {
	return fingerprint(["dynamic-capability", DYNAMIC_CAPABILITY_SELECTION_VERSION, stage, authoritative, ids]);
}

function selectionFingerprint(query: string, skillsAuthoritative: boolean, skills: readonly string[], mcpAuthoritative: boolean, mcp: readonly string[]): string {
	return fingerprint(["dynamic-capability-selection", DYNAMIC_CAPABILITY_SELECTION_VERSION, query, skillsAuthoritative, skills, mcpAuthoritative, mcp]);
}

/** Creates the durable, query-redacted, immutable session snapshot. */
export function createDynamicCapabilitySelection(
	query: unknown,
	skills: unknown,
	mcp: unknown,
	authority: Readonly<{ skills: boolean; mcp: boolean }> = { skills: true, mcp: true },
): DynamicCapabilitySelection {
	if (typeof authority.skills !== "boolean" || typeof authority.mcp !== "boolean") fail("INVALID_DYNAMIC_CAPABILITY_SELECTION");
	const normalizedSkills = snapshotCapabilityAvailability(skills);
	const normalizedMcp = snapshotCapabilityAvailability(mcp);
	const queryHash = queryFingerprint(canonicalizeCapabilityQuery(query));
	const skillsFingerprint = listFingerprint("skills", authority.skills, normalizedSkills);
	const mcpFingerprint = listFingerprint("mcp", authority.mcp, normalizedMcp);
	return Object.freeze({
		version: DYNAMIC_CAPABILITY_SELECTION_VERSION,
		queryFingerprint: queryHash,
		skillsAuthoritative: authority.skills,
		skills: normalizedSkills,
		mcpAuthoritative: authority.mcp,
		mcp: normalizedMcp,
		skillsFingerprint,
		mcpFingerprint,
		selectionFingerprint: selectionFingerprint(queryHash, authority.skills, normalizedSkills, authority.mcp, normalizedMcp),
	});
}

/** Validates persisted state without retaining legacy or malformed snapshots. */
export function validateDynamicCapabilitySelection(raw: unknown): DynamicCapabilitySelection | undefined {
	if (!isRecord(raw)) return undefined;
	try {
		onlyKeys(raw, SELECTION_KEYS, "INVALID_DYNAMIC_CAPABILITY_SELECTION");
		if (raw.version !== DYNAMIC_CAPABILITY_SELECTION_VERSION
			|| typeof raw.queryFingerprint !== "string" || !FINGERPRINT_RE.test(raw.queryFingerprint)
			|| typeof raw.skillsAuthoritative !== "boolean" || typeof raw.mcpAuthoritative !== "boolean") return undefined;
		const skills = normalizedIdentifiers(raw.skills, "INVALID_DYNAMIC_CAPABILITY_SELECTION");
		const mcp = normalizedIdentifiers(raw.mcp, "INVALID_DYNAMIC_CAPABILITY_SELECTION");
		// Persisted snapshots are write-once canonical data. Do not silently repair
		// legacy or tampered arrays into a new durable selection.
		if (!Array.isArray(raw.skills) || !Array.isArray(raw.mcp)
			|| raw.skills.length !== skills.length || raw.mcp.length !== mcp.length
			|| raw.skills.some((id, index) => id !== skills[index])
			|| raw.mcp.some((id, index) => id !== mcp[index])) return undefined;
		const skillsFingerprint = listFingerprint("skills", raw.skillsAuthoritative, skills);
		const mcpFingerprint = listFingerprint("mcp", raw.mcpAuthoritative, mcp);
		const expectedSelectionFingerprint = selectionFingerprint(raw.queryFingerprint, raw.skillsAuthoritative, skills, raw.mcpAuthoritative, mcp);
		if (raw.skillsFingerprint !== skillsFingerprint || raw.mcpFingerprint !== mcpFingerprint
			|| raw.selectionFingerprint !== expectedSelectionFingerprint) return undefined;
		return Object.freeze({
			version: DYNAMIC_CAPABILITY_SELECTION_VERSION,
			queryFingerprint: raw.queryFingerprint,
			skillsAuthoritative: raw.skillsAuthoritative,
			skills,
			mcpAuthoritative: raw.mcpAuthoritative,
			mcp,
			skillsFingerprint,
			mcpFingerprint,
			selectionFingerprint: expectedSelectionFingerprint,
		});
	} catch {
		return undefined;
	}
}
