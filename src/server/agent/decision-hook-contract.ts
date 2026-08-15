import type { HookScopeContext, TurnUsageSnapshot } from "./lifecycle-hub.js";
import type { DetectedProjectLanguage, ProjectImportComponent } from "./project-import-decision-context.js";
import {
	AdvisorySelectionContractError,
	validateAdvisorySelectionProposal,
	type AdvisorySelectionAvailability,
	type AdvisorySelectionProposal,
	type ValidatedAdvisorySelectionProposal,
} from "./advisory-selection-contract.js";
import {
	RequestMutationContractError,
	validateRequestMutationHookOutput,
	type RequestMutationEvent,
	type RequestMutationProposal,
	type PromptShapeRequest,
	type ToolSafetyRequest,
} from "./request-mutation-contract.js";

/** The only session lifecycle events that may surface an interactive decision. */
export type DecisionLifecycleEvent = "sessionSetup" | "beforePrompt" | "afterTurn" | "beforeCompact" | "sessionShutdown";
export type DecisionScope = "session" | "goal" | "project";
export type ProposalType = "goal" | "project" | "workflow" | "role" | "tool" | "staff";
/** `advisory` is a distinct output; requests may only ask for stricter decision classes. */
export type DecisionClass = "advisory" | "deferrable" | "consent-required";
export type RequestedDecisionClass = Exclude<DecisionClass, "advisory">;

export type DecisionValue =
	| { kind: "option"; value: string }
	| { kind: "other"; text: string };

export interface DecisionOption { value: string; label: string; }
export interface DecisionOtherSchema { minLength?: number; maxLength: number; pattern?: string; }
export interface ProposalSeed { proposalType: ProposalType; args: Record<string, unknown>; }
export type DecisionEffect = { kind: "none" } | {
	kind: "proposal";
	proposals: Record<string, ProposalSeed>;
	/** Declared negative choices which must terminalize without creating a draft. */
	noEffectValues?: readonly string[];
};

export type StaffTranscriptPattern = "repeated-user-correction" | "repeated-tool-failure" | "repeated-goal-blocker";
export interface StaffImprovementSignals {
	readonly windowTurns: number;
	readonly patterns: readonly Readonly<{ kind: StaffTranscriptPattern; count: number }>[];
}

/** Untrusted value returned by a pack hook. It is validated before persistence. */
export interface ExtensionDecisionRequest {
	version: 1;
	key: string;
	title: string;
	question: string;
	options: readonly DecisionOption[];
	other: DecisionOtherSchema;
	/** Required for deferrable requests and forbidden for consent-required requests. */
	default?: DecisionValue;
	scope: DecisionScope;
	deadlineAt: string;
	/** Absent requests retain the original deferrable behavior. */
	requestedClass?: RequestedDecisionClass;
	/** Pack-local routing label. It is bounded metadata, never policy authority. */
	intent?: string;
	effect?: DecisionEffect;
}

export interface ExtensionAdvisory {
	version: 1;
	staffId: string;
	title: string;
	body: string;
	key: string;
}

export type DecisionHookOutput =
	| { kind: "request"; request: ExtensionDecisionRequest }
	| { kind: "advisory"; advisory: ExtensionAdvisory }
	| { kind: "selection"; selection: AdvisorySelectionProposal }
	| { kind: "request-mutation"; proposal: RequestMutationProposal };

export interface ValidatedDecisionResolution {
	value: DecisionValue;
	actor: "user" | "deadline" | "headless";
	reason: "answered" | "deadline_elapsed" | "headless_default" | "consent_denied";
}

export interface DecisionHookContext {
	readonly event: DecisionLifecycleEvent;
	readonly sessionId: string;
	readonly projectId: string;
	readonly goalId?: string;
	readonly roleName?: string;
	readonly cwd: string;
	readonly scopeContext?: HookScopeContext;
	readonly config?: Readonly<Record<string, unknown>>;
	/** Optional core-owned fixed-label/count summary; never carries transcript data. */
	readonly staffImprovementSignals?: StaffImprovementSignals;
	readonly priorDecision?: DecisionValue;
}

/** Bounded server-derived context for the project registration lifecycle only. */
export interface ProjectImportDecisionHookContext {
	readonly event: "projectImported";
	readonly projectId: string;
	readonly importId: string;
	readonly projectRoot: string;
	readonly ownedRoots: readonly string[];
	readonly components: readonly ProjectImportComponent[];
}

export type { DetectedProjectLanguage, ProjectImportComponent } from "./project-import-decision-context.js";

/** Extended host context for typed advisory selection hooks. */
export interface AdvisorySelectionHookContext extends DecisionHookContext {
	/** Present only for afterTurn and copied from the terminal usage snapshot. */
	readonly usage?: TurnUsageSnapshot;
	/** Immutable host-derived identifiers; values outside it are not admissible. */
	readonly availableSelections: Readonly<AdvisorySelectionAvailability>;
}

export interface DecisionResolutionContext extends DecisionHookContext {
	readonly requestId: string;
	readonly resolution: ValidatedDecisionResolution;
}

export interface ProjectImportDecisionResolutionContext extends ProjectImportDecisionHookContext {
	readonly requestId: string;
	readonly resolution: ValidatedDecisionResolution;
}

/** Minimal, frozen context for a gated transient request-mutation hook. */
export interface RequestMutationHookContext {
	readonly event: RequestMutationEvent;
	readonly sessionId: string;
	readonly projectId: string;
	readonly cwd: string;
	readonly prompt?: string;
	readonly tool?: Readonly<{ name: string }>;
}

export interface DecisionHookModule {
	decide(ctx: DecisionHookContext | ProjectImportDecisionHookContext): Promise<DecisionHookOutput | null | undefined> | DecisionHookOutput | null | undefined;
	onDecision?(ctx: DecisionResolutionContext | ProjectImportDecisionResolutionContext): Promise<void> | void;
}

export interface ValidateDecisionHookOutputOptions {
	/** Server time, not a pack-supplied timestamp. Defaults to the current time. */
	now?: Date | number;
	/** Present only at the core-owned EP-4 application boundary. */
	requestMutation?: { event: RequestMutationEvent; request: PromptShapeRequest | ToolSafetyRequest };
}

/** Fixed machine-readable validation failure; never use pack-controlled messages in traces. */
export class DecisionHookContractError extends Error {
	constructor(public readonly code: string) {
		super(code);
		this.name = "DecisionHookContractError";
	}
}

type ValidatedDecisionRequestBase = Readonly<{
	version: 1;
	key: string;
	title: string;
	question: string;
	options: readonly Readonly<DecisionOption>[];
	other: Readonly<DecisionOtherSchema>;
	scope: DecisionScope;
	deadlineAt: string;
	intent?: string;
	effect: Readonly<DecisionEffect>;
}>;

/**
 * Runtime validation establishes the class/default invariant. The persisted
 * request shape remains broad so callers can compose compatibility overrides
 * before the validator normalizes an absent class to `deferrable`.
 */
export type ValidatedExtensionDecisionRequest = ValidatedDecisionRequestBase & Readonly<{
	requestedClass?: RequestedDecisionClass;
	default?: Readonly<DecisionValue>;
}>;
export type ValidatedExtensionAdvisory = Readonly<ExtensionAdvisory>;
export type ValidatedDecisionHookOutput =
	| { kind: "request"; request: ValidatedExtensionDecisionRequest }
	| { kind: "advisory"; advisory: ValidatedExtensionAdvisory }
	| { kind: "selection"; selection: ValidatedAdvisorySelectionProposal }
	| { kind: "request-mutation"; proposal: RequestMutationProposal };

export const DECISION_DEADLINE_MIN_MS = 30_000;
export const DECISION_DEADLINE_MAX_MS = 7 * 24 * 60 * 60 * 1_000;

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PROPOSAL_TYPES = new Set<ProposalType>(["goal", "project", "workflow", "role", "tool", "staff"]);
const REQUEST_KEYS = new Set(["version", "key", "title", "question", "options", "other", "default", "scope", "deadlineAt", "requestedClass", "intent", "effect"]);
const ADVISORY_KEYS = new Set(["version", "staffId", "title", "body", "key"]);
const OPTION_KEYS = new Set(["value", "label"]);
const OTHER_KEYS = new Set(["minLength", "maxLength", "pattern"]);
const OPTION_VALUE_KEYS = new Set(["kind", "value"]);
const OTHER_VALUE_KEYS = new Set(["kind", "text"]);
const EFFECT_NONE_KEYS = new Set(["kind"]);
const EFFECT_PROPOSAL_KEYS = new Set(["kind", "proposals", "noEffectValues"]);
const SEED_KEYS = new Set(["proposalType", "args"]);
const MAX_PATTERN_LENGTH = 256;
const MAX_SAFE_PATTERN_QUANTIFIER = 280;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_PROPERTIES = 64;
const MAX_JSON_ARRAY_LENGTH = 64;
const MAX_JSON_STRING_LENGTH = 10_000;

function fail(code: string): never { throw new DecisionHookContractError(code); }
function isRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
function requireRecord(value: unknown, code: string): Record<string, unknown> {
	if (!isRecord(value)) fail(code);
	return value;
}
function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, code: string): void {
	for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code);
}
function string(value: unknown, max: number, code: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max || unsafeText(value)) fail(code);
	return value;
}
function identifier(value: unknown, code: string): string {
	const result = string(value, 80, code);
	if (!IDENTIFIER_RE.test(result)) fail(code);
	return result;
}
function unsafeText(value: string): boolean {
	// Reject binary/control payloads and credential-bearing URLs. Text remains text:
	// hooks cannot smuggle opaque binary/config blobs into the decision surface.
	return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)
		|| /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i.test(value);
}
function finiteInteger(value: unknown, code: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(code);
	return value;
}
function canonicalDeadline(value: unknown, now: number): string {
	const raw = string(value, 32, "INVALID_DEADLINE");
	const parsed = new Date(raw);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== raw) fail("INVALID_DEADLINE");
	const delay = parsed.getTime() - now;
	if (delay < DECISION_DEADLINE_MIN_MS || delay > DECISION_DEADLINE_MAX_MS) fail("INVALID_DEADLINE");
	return raw;
}

function isAsciiDigit(value: string): boolean {
	return value >= "0" && value <= "9";
}

/**
 * Only accept an anchored concatenation of literals or character classes with
 * at most one simple quantifier. This intentionally excludes groups,
 * alternation, assertions, backreferences, and adjacent quantified atoms, so
 * the native RegExp engine has no backtracking search tree to explore.
 */
function isSafeOtherPattern(pattern: unknown): pattern is string {
	if (typeof pattern !== "string" || pattern.length < 2 || pattern.length > MAX_PATTERN_LENGTH || unsafeText(pattern)
		|| !pattern.startsWith("^") || !pattern.endsWith("$")) return false;

	const end = pattern.length - 1;
	let cursor = 1;
	let quantifierCount = 0;
	while (cursor < end) {
		const char = pattern[cursor];
		if (char === "[") {
			const classEnd = consumeSafeCharacterClass(pattern, cursor, end);
			if (classEnd === undefined) return false;
			cursor = classEnd;
		} else if (char === "\\") {
			if (!isSafeEscape(pattern[cursor + 1])) return false;
			cursor += 2;
		} else {
			// Every regexp metacharacter is either parsed above or rejected here.
			if ("^$\\.*+?()[]{}|".includes(char)) return false;
			cursor++;
		}

		if (cursor < end && "*+?{".includes(pattern[cursor])) {
			if (++quantifierCount > 1) return false;
			const quantifiedEnd = consumeSafeQuantifier(pattern, cursor, end);
			if (quantifiedEnd === undefined) return false;
			cursor = quantifiedEnd;
		}
	}
	return true;
}

function isSafeEscape(char: string | undefined): boolean {
	return char !== undefined && ("dDsSwW".includes(char) || "\\^$.*+?()[]{}|/-".includes(char));
}

function consumeSafeCharacterClass(pattern: string, cursor: number, end: number): number | undefined {
	cursor++;
	if (cursor < end && pattern[cursor] === "^") cursor++;
	let members = 0;
	while (cursor < end) {
		const char = pattern[cursor];
		if (char === "]") return members === 0 ? undefined : cursor + 1;
		if (char === "[") return undefined;
		if (char === "\\") {
			if (!isSafeEscape(pattern[cursor + 1])) return undefined;
			cursor += 2;
		} else {
			cursor++;
		}
		members++;
	}
	return undefined;
}

function consumeSafeQuantifier(pattern: string, cursor: number, end: number): number | undefined {
	if ("*+?".includes(pattern[cursor])) return cursor + 1;
	if (pattern[cursor] !== "{") return undefined;
	cursor++;
	const minimumStart = cursor;
	while (cursor < end && isAsciiDigit(pattern[cursor])) cursor++;
	if (cursor === minimumStart) return undefined;
	const minimum = Number(pattern.slice(minimumStart, cursor));
	if (minimum > MAX_SAFE_PATTERN_QUANTIFIER) return undefined;
	if (pattern[cursor] === "}") return cursor + 1;
	if (pattern[cursor] !== ",") return undefined;
	cursor++;
	const maximumStart = cursor;
	while (cursor < end && isAsciiDigit(pattern[cursor])) cursor++;
	if (cursor === maximumStart || pattern[cursor] !== "}") return undefined;
	const maximum = Number(pattern.slice(maximumStart, cursor));
	if (maximum < minimum || maximum > MAX_SAFE_PATTERN_QUANTIFIER) return undefined;
	return cursor + 1;
}

function safeOtherRegExp(pattern: unknown): RegExp | undefined {
	if (!isSafeOtherPattern(pattern)) return undefined;
	try { return new RegExp(pattern, "u"); } catch { return undefined; }
}

function validateOther(raw: unknown): Readonly<DecisionOtherSchema> {
	const other = requireRecord(raw, "INVALID_OTHER_SCHEMA");
	onlyKeys(other, OTHER_KEYS, "UNKNOWN_OTHER_FIELD");
	const maxLength = finiteInteger(other.maxLength, "INVALID_OTHER_SCHEMA");
	if (maxLength < 1 || maxLength > 280) fail("INVALID_OTHER_SCHEMA");
	let minLength: number | undefined;
	if (other.minLength !== undefined) {
		minLength = finiteInteger(other.minLength, "INVALID_OTHER_SCHEMA");
		if (minLength < 0 || minLength > maxLength) fail("INVALID_OTHER_SCHEMA");
	}
	let pattern: string | undefined;
	if (other.pattern !== undefined) {
		pattern = string(other.pattern, MAX_PATTERN_LENGTH, "INVALID_OTHER_SCHEMA");
		if (!safeOtherRegExp(pattern)) fail("INVALID_OTHER_SCHEMA");
	}
	return Object.freeze({ ...(minLength === undefined ? {} : { minLength }), maxLength, ...(pattern === undefined ? {} : { pattern }) });
}

/** Validate one answer/default against the already validated request controls. */
export function validateDecisionValue(raw: unknown, options: readonly DecisionOption[], other: DecisionOtherSchema): Readonly<DecisionValue> {
	const value = requireRecord(raw, "INVALID_DECISION_VALUE");
	if (value.kind === "option") {
		onlyKeys(value, OPTION_VALUE_KEYS, "UNKNOWN_DECISION_VALUE_FIELD");
		const selected = identifier(value.value, "INVALID_DECISION_VALUE");
		if (!options.some(option => option.value === selected)) fail("INVALID_DECISION_VALUE");
		return Object.freeze({ kind: "option" as const, value: selected });
	}
	if (value.kind === "other") {
		onlyKeys(value, OTHER_VALUE_KEYS, "UNKNOWN_DECISION_VALUE_FIELD");
		const text = string(value.text, 280, "INVALID_DECISION_VALUE");
		const minLength = other.minLength ?? 0;
		if (text.length < minLength || text.length > other.maxLength) fail("INVALID_DECISION_VALUE");
		if (other.pattern !== undefined) {
			// Revalidate before executing persisted schema data from older versions.
			const matcher = safeOtherRegExp(other.pattern);
			if (!matcher || !matcher.test(text)) fail("INVALID_DECISION_VALUE");
		}
		return Object.freeze({ kind: "other" as const, text });
	}
	fail("INVALID_DECISION_VALUE");
}

function validateJson(value: unknown, depth = 0): unknown {
	if (depth > MAX_JSON_DEPTH || value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") fail("INVALID_PROPOSAL_ARGS");
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail("INVALID_PROPOSAL_ARGS");
		return value;
	}
	if (typeof value === "string") return string(value, MAX_JSON_STRING_LENGTH, "INVALID_PROPOSAL_ARGS");
	if (Array.isArray(value)) {
		if (value.length > MAX_JSON_ARRAY_LENGTH) fail("INVALID_PROPOSAL_ARGS");
		return value.map(item => validateJson(item, depth + 1));
	}
	const object = requireRecord(value, "INVALID_PROPOSAL_ARGS");
	const entries = Object.entries(object);
	if (entries.length > MAX_JSON_PROPERTIES) fail("INVALID_PROPOSAL_ARGS");
	const out: Record<string, unknown> = {};
	for (const [key, item] of entries) {
		if (!IDENTIFIER_RE.test(key)) fail("INVALID_PROPOSAL_ARGS");
		out[key] = validateJson(item, depth + 1);
	}
	return out;
}

function validateEffect(raw: unknown, optionValues: readonly string[]): Readonly<DecisionEffect> {
	if (raw === undefined) return Object.freeze({ kind: "none" as const });
	const effect = requireRecord(raw, "INVALID_EFFECT");
	if (effect.kind === "none") {
		onlyKeys(effect, EFFECT_NONE_KEYS, "UNKNOWN_EFFECT_FIELD");
		return Object.freeze({ kind: "none" as const });
	}
	if (effect.kind !== "proposal") fail("INVALID_EFFECT");
	onlyKeys(effect, EFFECT_PROPOSAL_KEYS, "UNKNOWN_EFFECT_FIELD");
	const rawProposals = requireRecord(effect.proposals, "INVALID_EFFECT");
	const expected = new Set([...optionValues, "other"]);
	const noEffectValues = effect.noEffectValues === undefined ? [] : effect.noEffectValues;
	if (!Array.isArray(noEffectValues) || noEffectValues.some(value => typeof value !== "string" || !expected.has(value))) fail("INVALID_EFFECT");
	const noEffect = new Set(noEffectValues);
	if (noEffect.size !== noEffectValues.length) fail("INVALID_EFFECT");
	if (Object.keys(rawProposals).length !== expected.size - noEffect.size) fail("INVALID_EFFECT");
	const proposals: Record<string, ProposalSeed> = {};
	for (const [value, seedRaw] of Object.entries(rawProposals)) {
		if (!expected.has(value) || noEffect.has(value)) fail("INVALID_EFFECT");
		const seed = requireRecord(seedRaw, "INVALID_EFFECT");
		onlyKeys(seed, SEED_KEYS, "UNKNOWN_PROPOSAL_FIELD");
		if (typeof seed.proposalType !== "string" || !PROPOSAL_TYPES.has(seed.proposalType as ProposalType)) fail("INVALID_EFFECT");
		const args = validateJson(requireRecord(seed.args, "INVALID_PROPOSAL_ARGS")) as Record<string, unknown>;
		proposals[value] = Object.freeze({ proposalType: seed.proposalType as ProposalType, args: Object.freeze(args) });
	}
	for (const value of expected) if (!noEffect.has(value) && !proposals[value]) fail("INVALID_EFFECT");
	return Object.freeze({ kind: "proposal" as const, proposals: Object.freeze(proposals), ...(noEffect.size > 0 ? { noEffectValues: Object.freeze([...noEffect]) } : {}) });
}

function validateRequest(raw: unknown, now: number): ValidatedExtensionDecisionRequest {
	const request = requireRecord(raw, "INVALID_REQUEST");
	onlyKeys(request, REQUEST_KEYS, "UNKNOWN_REQUEST_FIELD");
	if (request.version !== 1) fail("INVALID_REQUEST");
	const key = identifier(request.key, "INVALID_REQUEST");
	const title = string(request.title, 120, "INVALID_REQUEST");
	const question = string(request.question, 320, "INVALID_REQUEST");
	if (!Array.isArray(request.options) || request.options.length < 2 || request.options.length > 8) fail("INVALID_OPTIONS");
	const seen = new Set<string>();
	const seenLabels = new Set<string>();
	const options = request.options.map((rawOption) => {
		const option = requireRecord(rawOption, "INVALID_OPTIONS");
		onlyKeys(option, OPTION_KEYS, "UNKNOWN_OPTION_FIELD");
		const value = identifier(option.value, "INVALID_OPTIONS");
		const label = string(option.label, 120, "INVALID_OPTIONS");
		const labelKey = label.toLowerCase();
		if (value === "other" || seen.has(value) || seenLabels.has(labelKey)
			|| labelKey === "other" || label === "__OTHER__") fail("INVALID_OPTIONS");
		seen.add(value);
		seenLabels.add(labelKey);
		return Object.freeze({ value, label });
	});
	const other = validateOther(request.other);
	const requestedClass = request.requestedClass ?? "deferrable";
	if (requestedClass !== "deferrable" && requestedClass !== "consent-required") fail("INVALID_REQUESTED_CLASS");
	const intent = request.intent === undefined ? undefined : identifier(request.intent, "INVALID_INTENT");
	if (requestedClass === "consent-required" && Object.hasOwn(request, "default")) fail("CONSENT_DEFAULT_FORBIDDEN");
	if (requestedClass === "deferrable" && !Object.hasOwn(request, "default")) fail("DEFAULT_REQUIRED");
	if (request.scope !== "session" && request.scope !== "goal" && request.scope !== "project") fail("INVALID_SCOPE");
	const scope: DecisionScope = request.scope;
	const deadlineAt = canonicalDeadline(request.deadlineAt, now);
	const effect = validateEffect(request.effect, options.map(option => option.value));
	const base = { key, version: 1 as const, title, question, options: Object.freeze(options), other, scope, deadlineAt, ...(intent === undefined ? {} : { intent }), effect };
	if (requestedClass === "consent-required") return Object.freeze({ ...base, requestedClass });
	const fallback = validateDecisionValue(request.default, options, other);
	return Object.freeze({ ...base, requestedClass, default: fallback });
}

function validateAdvisory(raw: unknown): ValidatedExtensionAdvisory {
	const advisory = requireRecord(raw, "INVALID_ADVISORY");
	onlyKeys(advisory, ADVISORY_KEYS, "UNKNOWN_ADVISORY_FIELD");
	if (advisory.version !== 1) fail("INVALID_ADVISORY");
	return Object.freeze({
		version: 1,
		staffId: identifier(advisory.staffId, "INVALID_ADVISORY"),
		title: string(advisory.title, 120, "INVALID_ADVISORY"),
		body: string(advisory.body, 1_000, "INVALID_ADVISORY"),
		key: identifier(advisory.key, "INVALID_ADVISORY"),
	});
}

function validateSelection(raw: unknown): ValidatedAdvisorySelectionProposal {
	try {
		return validateAdvisorySelectionProposal(raw);
	} catch (error) {
		if (error instanceof AdvisorySelectionContractError) fail(error.code);
		throw error;
	}
}

/**
 * Validate the full untrusted pack return. `null` and `undefined` are an allowed
 * no-op; every other unknown field or malformed nested value fails closed.
 */
export function validateDecisionHookOutput(raw: unknown, options: ValidateDecisionHookOutputOptions = {}): ValidatedDecisionHookOutput | null {
	if (raw === null || raw === undefined) return null;
	const output = requireRecord(raw, "INVALID_HOOK_OUTPUT");
	const nowValue = options.now ?? Date.now();
	const now = nowValue instanceof Date ? nowValue.getTime() : nowValue;
	if (!Number.isFinite(now)) fail("INVALID_NOW");
	if (output.kind === "request") {
		onlyKeys(output, new Set(["kind", "request"]), "UNKNOWN_HOOK_OUTPUT_FIELD");
		return Object.freeze({ kind: "request" as const, request: validateRequest(output.request, now) });
	}
	if (output.kind === "advisory") {
		onlyKeys(output, new Set(["kind", "advisory"]), "UNKNOWN_HOOK_OUTPUT_FIELD");
		return Object.freeze({ kind: "advisory" as const, advisory: validateAdvisory(output.advisory) });
	}
	if (output.kind === "selection") {
		onlyKeys(output, new Set(["kind", "selection"]), "UNKNOWN_HOOK_OUTPUT_FIELD");
		return Object.freeze({ kind: "selection" as const, selection: validateSelection(output.selection) });
	}
	if (output.kind === "request-mutation") {
		const context = options.requestMutation;
		if (!context) fail("INVALID_HOOK_OUTPUT");
		try {
			return Object.freeze({ kind: "request-mutation" as const, proposal: validateRequestMutationHookOutput(output, context.event, context.request)! });
		} catch (error) {
			if (error instanceof RequestMutationContractError) fail(error.code);
			throw error;
		}
	}
	fail("INVALID_HOOK_OUTPUT");
}

/**
 * Project-import hooks retain the shared output validator, then apply the one
 * lifecycle-specific scope fence before any request can reach persistence.
 */
export function validateProjectImportDecisionHookOutput(raw: unknown, options: ValidateDecisionHookOutputOptions = {}): ValidatedDecisionHookOutput | null {
	// A mutation is unavailable at this lifecycle boundary regardless of whether
	// its nested proposal would be valid for a prompt/tool request.
	if (isRecord(raw) && raw.kind === "request-mutation") fail("DECISION_OUTPUT_UNAVAILABLE");
	const output = validateDecisionHookOutput(raw, options);
	if (output?.kind === "request" && output.request.scope !== "project") fail("DECISION_SCOPE_UNAVAILABLE");
	return output;
}
