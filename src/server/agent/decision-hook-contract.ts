import type { HookScopeContext } from "./lifecycle-hub.js";

/** The only session lifecycle events that may surface an interactive decision. */
export type DecisionLifecycleEvent = "sessionSetup" | "beforePrompt" | "afterTurn" | "beforeCompact" | "sessionShutdown";
export type DecisionScope = "session" | "goal" | "project";
export type ProposalType = "goal" | "project" | "workflow" | "role" | "tool" | "staff";

export type DecisionValue =
	| { kind: "option"; value: string }
	| { kind: "other"; text: string };

export interface DecisionOption { value: string; label: string; }
export interface DecisionOtherSchema { minLength?: number; maxLength: number; pattern?: string; }
export interface ProposalSeed { proposalType: ProposalType; args: Record<string, unknown>; }
export type DecisionEffect = { kind: "none" } | { kind: "proposal"; proposals: Record<string, ProposalSeed> };

/** Untrusted value returned by a pack hook. It is validated before persistence. */
export interface ExtensionDecisionRequest {
	version: 1;
	key: string;
	title: string;
	question: string;
	options: readonly DecisionOption[];
	other: DecisionOtherSchema;
	default: DecisionValue;
	scope: DecisionScope;
	deadlineAt: string;
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
	| { kind: "advisory"; advisory: ExtensionAdvisory };

export interface ValidatedDecisionResolution {
	value: DecisionValue;
	actor: "user" | "deadline" | "headless";
	reason: "answered" | "deadline_elapsed" | "headless_default";
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
	readonly priorDecision?: DecisionValue;
}

export interface DecisionResolutionContext extends DecisionHookContext {
	readonly requestId: string;
	readonly resolution: ValidatedDecisionResolution;
}

export interface DecisionHookModule {
	decide(ctx: DecisionHookContext): Promise<DecisionHookOutput | null | undefined> | DecisionHookOutput | null | undefined;
	onDecision?(ctx: DecisionResolutionContext): Promise<void> | void;
}

export interface ValidateDecisionHookOutputOptions {
	/** Server time, not a pack-supplied timestamp. Defaults to the current time. */
	now?: Date | number;
}

/** Fixed machine-readable validation failure; never use pack-controlled messages in traces. */
export class DecisionHookContractError extends Error {
	constructor(public readonly code: string) {
		super(code);
		this.name = "DecisionHookContractError";
	}
}

export type ValidatedExtensionDecisionRequest = Readonly<{
	version: 1;
	key: string;
	title: string;
	question: string;
	options: readonly Readonly<DecisionOption>[];
	other: Readonly<DecisionOtherSchema>;
	default: Readonly<DecisionValue>;
	scope: DecisionScope;
	deadlineAt: string;
	effect: Readonly<DecisionEffect>;
}>;
export type ValidatedExtensionAdvisory = Readonly<ExtensionAdvisory>;
export type ValidatedDecisionHookOutput =
	| { kind: "request"; request: ValidatedExtensionDecisionRequest }
	| { kind: "advisory"; advisory: ValidatedExtensionAdvisory };

export const DECISION_DEADLINE_MIN_MS = 30_000;
export const DECISION_DEADLINE_MAX_MS = 7 * 24 * 60 * 60 * 1_000;

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PROPOSAL_TYPES = new Set<ProposalType>(["goal", "project", "workflow", "role", "tool", "staff"]);
const REQUEST_KEYS = new Set(["version", "key", "title", "question", "options", "other", "default", "scope", "deadlineAt", "effect"]);
const ADVISORY_KEYS = new Set(["version", "staffId", "title", "body", "key"]);
const OPTION_KEYS = new Set(["value", "label"]);
const OTHER_KEYS = new Set(["minLength", "maxLength", "pattern"]);
const OPTION_VALUE_KEYS = new Set(["kind", "value"]);
const OTHER_VALUE_KEYS = new Set(["kind", "text"]);
const EFFECT_NONE_KEYS = new Set(["kind"]);
const EFFECT_PROPOSAL_KEYS = new Set(["kind", "proposals"]);
const SEED_KEYS = new Set(["proposalType", "args"]);
const MAX_PATTERN_LENGTH = 256;
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
		if (!pattern.startsWith("^") || !pattern.endsWith("$")) fail("INVALID_OTHER_SCHEMA");
		try { new RegExp(pattern, "u"); } catch { fail("INVALID_OTHER_SCHEMA"); }
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
		if (other.pattern && !(new RegExp(other.pattern, "u")).test(text)) fail("INVALID_DECISION_VALUE");
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
	if (Object.keys(rawProposals).length !== expected.size) fail("INVALID_EFFECT");
	const proposals: Record<string, ProposalSeed> = {};
	for (const [value, seedRaw] of Object.entries(rawProposals)) {
		if (!expected.has(value)) fail("INVALID_EFFECT");
		const seed = requireRecord(seedRaw, "INVALID_EFFECT");
		onlyKeys(seed, SEED_KEYS, "UNKNOWN_PROPOSAL_FIELD");
		if (typeof seed.proposalType !== "string" || !PROPOSAL_TYPES.has(seed.proposalType as ProposalType)) fail("INVALID_EFFECT");
		const args = validateJson(requireRecord(seed.args, "INVALID_PROPOSAL_ARGS")) as Record<string, unknown>;
		proposals[value] = Object.freeze({ proposalType: seed.proposalType as ProposalType, args: Object.freeze(args) });
	}
	for (const value of expected) if (!proposals[value]) fail("INVALID_EFFECT");
	return Object.freeze({ kind: "proposal" as const, proposals: Object.freeze(proposals) });
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
	const options = request.options.map((rawOption) => {
		const option = requireRecord(rawOption, "INVALID_OPTIONS");
		onlyKeys(option, OPTION_KEYS, "UNKNOWN_OPTION_FIELD");
		const value = identifier(option.value, "INVALID_OPTIONS");
		if (value === "other" || seen.has(value)) fail("INVALID_OPTIONS");
		seen.add(value);
		return Object.freeze({ value, label: string(option.label, 120, "INVALID_OPTIONS") });
	});
	const other = validateOther(request.other);
	const fallback = validateDecisionValue(request.default, options, other);
	if (request.scope !== "session" && request.scope !== "goal" && request.scope !== "project") fail("INVALID_SCOPE");
	const deadlineAt = canonicalDeadline(request.deadlineAt, now);
	const effect = validateEffect(request.effect, options.map(option => option.value));
	return Object.freeze({ key, version: 1, title, question, options: Object.freeze(options), other, default: fallback, scope: request.scope, deadlineAt, effect });
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
	fail("INVALID_HOOK_OUTPUT");
}
