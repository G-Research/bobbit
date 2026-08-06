import { THINKING_LEVELS, isKnownThinkingLevel, type ThinkingLevel } from "../../shared/thinking-levels.js";
import {
	isSafeExtensionGrantIdentifier,
	type ExtensionHookRef,
} from "./project-config-store.js";

/** The closed selection vocabulary that extensions may advise on. */
export type AdvisorySelectionKind = "model" | "thinking" | "role" | "workflow";

/** A syntactically-valid selection is still only advice until the host admits it. */
export type AdvisorySelectionProposal =
	| { kind: "model"; provider: string; modelId: string }
	| { kind: "thinking"; thinkingLevel: string }
	| { kind: "role"; roleName: string }
	| { kind: "workflow"; workflowId: string };

/** Host-derived identifiers only; no labels, credentials, prompts, or bodies. */
export interface AdvisorySelectionAvailability {
	readonly models: readonly { readonly provider: string; readonly modelId: string }[];
	readonly thinkingLevels: readonly string[];
	readonly roles: readonly string[];
	readonly workflows: readonly string[];
}

export type ValidatedAdvisorySelectionProposal = Readonly<AdvisorySelectionProposal>;

/** Source and priority are attached by core, never read from hook output. */
export interface AdvisorySelectionCandidate {
	readonly source: Readonly<ExtensionHookRef>;
	readonly selection: ValidatedAdvisorySelectionProposal;
	/** Active-pack index; higher active pack precedence wins. */
	readonly priority: number;
}

/** One independently-selected winner per kind. */
export interface AdvisorySelectionReduction {
	readonly model?: AdvisorySelectionCandidate;
	readonly thinking?: AdvisorySelectionCandidate;
	readonly role?: AdvisorySelectionCandidate;
	readonly workflow?: AdvisorySelectionCandidate;
}

export class AdvisorySelectionContractError extends Error {
	constructor(public readonly code: string) {
		super(code);
		this.name = "AdvisorySelectionContractError";
	}
}

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MODEL_KEYS = new Set(["kind", "provider", "modelId"]);
const THINKING_KEYS = new Set(["kind", "thinkingLevel"]);
const ROLE_KEYS = new Set(["kind", "roleName"]);
const WORKFLOW_KEYS = new Set(["kind", "workflowId"]);

function fail(code: string): never { throw new AdvisorySelectionContractError(code); }

function isRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, code: string): void {
	for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code);
}

function identifier(value: unknown, code: string): string {
	if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) fail(code);
	return value;
}

function cloneModel(value: unknown): { readonly provider: string; readonly modelId: string } | undefined {
	if (!isRecord(value)) return undefined;
	const provider = typeof value.provider === "string" && IDENTIFIER_RE.test(value.provider) ? value.provider : undefined;
	const modelId = typeof value.modelId === "string" && IDENTIFIER_RE.test(value.modelId) ? value.modelId : undefined;
	return provider && modelId ? Object.freeze({ provider, modelId }) : undefined;
}

function lexical(a: string, b: string): number {
	return a === b ? 0 : a < b ? -1 : 1;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
	return Object.freeze([...new Set(values)].sort(lexical));
}

/**
 * Defensive worker-boundary copy of a host availability snapshot. Invalid host
 * entries are omitted rather than becoming an accidental admission path.
 */
export function snapshotAdvisorySelectionAvailability(raw: AdvisorySelectionAvailability): Readonly<AdvisorySelectionAvailability> {
	const models = Array.isArray(raw?.models)
		? raw.models.map(cloneModel).filter((value): value is { readonly provider: string; readonly modelId: string } => value !== undefined)
		: [];
	const modelKeys = new Set<string>();
	const uniqueModels = models
		.filter(model => {
			const key = `${model.provider}\u0000${model.modelId}`;
			if (modelKeys.has(key)) return false;
			modelKeys.add(key);
			return true;
		})
		.sort((a, b) => lexical(a.provider, b.provider) || lexical(a.modelId, b.modelId));
	const identifiers = (values: unknown): readonly string[] => Array.isArray(values)
		? uniqueSorted(values.filter((value): value is string => typeof value === "string" && IDENTIFIER_RE.test(value)))
		: [];
	const knownThinkingLevels = new Set(Array.isArray(raw?.thinkingLevels)
		? raw.thinkingLevels.map(isKnownThinkingLevel).filter((value): value is ThinkingLevel => value !== undefined)
		: []);
	const thinkingLevels = Object.freeze(THINKING_LEVELS.filter(level => knownThinkingLevels.has(level)));
	return Object.freeze({
		models: Object.freeze(uniqueModels),
		thinkingLevels,
		roles: identifiers(raw?.roles),
		workflows: identifiers(raw?.workflows),
	});
}

/** Strictly parse a hook's selection payload; policy fields are not part of this protocol. */
export function validateAdvisorySelectionProposal(raw: unknown): ValidatedAdvisorySelectionProposal {
	if (!isRecord(raw)) fail("INVALID_SELECTION");
	if (raw.kind === "model") {
		onlyKeys(raw, MODEL_KEYS, "UNKNOWN_SELECTION_FIELD");
		return Object.freeze({ kind: "model" as const, provider: identifier(raw.provider, "INVALID_SELECTION"), modelId: identifier(raw.modelId, "INVALID_SELECTION") });
	}
	if (raw.kind === "thinking") {
		onlyKeys(raw, THINKING_KEYS, "UNKNOWN_SELECTION_FIELD");
		const thinkingLevel = isKnownThinkingLevel(raw.thinkingLevel);
		if (!thinkingLevel) fail("INVALID_SELECTION");
		return Object.freeze({ kind: "thinking" as const, thinkingLevel });
	}
	if (raw.kind === "role") {
		onlyKeys(raw, ROLE_KEYS, "UNKNOWN_SELECTION_FIELD");
		return Object.freeze({ kind: "role" as const, roleName: identifier(raw.roleName, "INVALID_SELECTION") });
	}
	if (raw.kind === "workflow") {
		onlyKeys(raw, WORKFLOW_KEYS, "UNKNOWN_SELECTION_FIELD");
		return Object.freeze({ kind: "workflow" as const, workflowId: identifier(raw.workflowId, "INVALID_SELECTION") });
	}
	fail("INVALID_SELECTION");
}

/** Returns an immutable proposal only when it is present in the host snapshot. */
export function admitAdvisorySelection(
	proposal: ValidatedAdvisorySelectionProposal,
	availability: AdvisorySelectionAvailability,
): ValidatedAdvisorySelectionProposal | undefined {
	const snapshot = snapshotAdvisorySelectionAvailability(availability);
	if (proposal.kind === "model") {
		return snapshot.models.some(model => model.provider === proposal.provider && model.modelId === proposal.modelId)
			? Object.freeze({ ...proposal }) : undefined;
	}
	if (proposal.kind === "thinking") {
		return snapshot.thinkingLevels.includes(proposal.thinkingLevel) ? Object.freeze({ ...proposal }) : undefined;
	}
	if (proposal.kind === "role") {
		return snapshot.roles.includes(proposal.roleName) ? Object.freeze({ ...proposal }) : undefined;
	}
	return snapshot.workflows.includes(proposal.workflowId) ? Object.freeze({ ...proposal }) : undefined;
}

/**
 * Defensively copies core-provenanced candidates. The selection is reparsed so
 * callers cannot turn an arbitrary object into an accepted reducer input.
 */
export function createAdvisorySelectionCandidate(raw: unknown): AdvisorySelectionCandidate | undefined {
	if (!isRecord(raw) || !isRecord(raw.source)
		|| !isSafeExtensionGrantIdentifier(raw.source.packId) || !isSafeExtensionGrantIdentifier(raw.source.hookId)
		|| typeof raw.priority !== "number" || !Number.isSafeInteger(raw.priority) || raw.priority < 0) return undefined;
	try {
		const selection = validateAdvisorySelectionProposal(raw.selection);
		return Object.freeze({
			source: Object.freeze({ packId: raw.source.packId, hookId: raw.source.hookId }),
			selection,
			priority: raw.priority,
		});
	} catch {
		return undefined;
	}
}

function compareCandidates(a: AdvisorySelectionCandidate, b: AdvisorySelectionCandidate): number {
	if (a.priority !== b.priority) return b.priority - a.priority;
	if (a.source.packId !== b.source.packId) return a.source.packId < b.source.packId ? -1 : 1;
	if (a.source.hookId !== b.source.hookId) return a.source.hookId < b.source.hookId ? -1 : 1;
	return 0;
}

/**
 * Deterministically choose each kind independently. Completion order is not an
 * input: only server-attached pack priority and source identity may break ties.
 */
export function reduceAdvisorySelectionCandidates(rawCandidates: readonly unknown[]): Readonly<AdvisorySelectionReduction> {
	const winners: Partial<Record<AdvisorySelectionKind, AdvisorySelectionCandidate>> = {};
	for (const raw of Array.isArray(rawCandidates) ? rawCandidates : []) {
		const candidate = createAdvisorySelectionCandidate(raw);
		if (!candidate) continue;
		const current = winners[candidate.selection.kind];
		if (!current || compareCandidates(candidate, current) < 0) winners[candidate.selection.kind] = candidate;
	}
	return Object.freeze(winners);
}
