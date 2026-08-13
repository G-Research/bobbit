import { isSafeExtensionGrantIdentifier } from "./project-config-store.js";

export type RequestMutationEvent = "beforePrompt" | "beforeToolCall";
export type PromptShapeIntent = "clarify" | "compress" | "redact" | "augment";
export type ToolSafetyDecision = "warn" | "deny";

export interface PromptShapeProposal {
	kind: "prompt-shape";
	version: 1;
	intent: PromptShapeIntent;
	text: string;
	reasonId: string;
}

export interface ToolSafetyProposal {
	kind: "tool-safety";
	version: 1;
	decision: ToolSafetyDecision;
	tool?: string;
	reasonId: string;
}

export type RequestMutationProposal = PromptShapeProposal | ToolSafetyProposal;
export type RequestMutationHookOutput =
	| { kind: "request-mutation"; proposal: RequestMutationProposal }
	| null | undefined;

export interface RequestMutationSource {
	packId: string;
	hookId: string;
	priority: number;
}

export interface PromptShapeRequest {
	sessionId: string;
	projectId: string;
	text: string;
}

export interface ToolSafetyRequest {
	sessionId: string;
	projectId: string;
	toolName: string;
}

/** Fixed core-owned labels only; extension `reasonId` is never exposed. */
export type RequestMutationReason =
	| "Grant required"
	| "Prompt mutation disabled"
	| "Malformed result"
	| "Over budget"
	| "Timed out"
	| "Lower-priority proposal"
	| "Tool warning"
	| "Tool denied"
	| "Prompt shaped"
	| "Unavailable";

/** Core-internal only; never a pack contribution or ModuleHost payload. */
export type PromptShapeOutcome =
	| { action: "pass"; reason: RequestMutationReason }
	| { action: "replace"; text: string; reason: RequestMutationReason };
export type ToolSafetyOutcome =
	| { action: "pass"; reason: RequestMutationReason }
	| { action: "warn"; reason: RequestMutationReason }
	| { action: "deny"; reason: RequestMutationReason };

/** An orderable core consumer, registered only when constructing the dispatcher. */
export interface RequestShaper {
	id: string;
	priority: number;
	shapePrompt?(request: PromptShapeRequest): PromptShapeOutcome | Promise<PromptShapeOutcome>;
	inspectTool?(request: ToolSafetyRequest): ToolSafetyOutcome | Promise<ToolSafetyOutcome>;
}

export interface PromptShapeCandidate {
	source: RequestMutationSource;
	proposal: PromptShapeProposal;
}

export interface ToolSafetyCandidate {
	source: RequestMutationSource;
	proposal: ToolSafetyProposal;
}

export interface PromptShapeReduction {
	action: "pass" | "replace";
	text?: string;
	reason: RequestMutationReason;
	source?: RequestMutationSource;
}

export interface ToolSafetyReduction {
	action: "pass" | "warn" | "deny";
	reason: RequestMutationReason;
	source?: RequestMutationSource;
}

export const MAX_REQUEST_MUTATION_PROMPT_BYTES = 32 * 1024;
export const MAX_REQUEST_MUTATION_RESULT_BYTES = 40 * 1024;
export const MAX_REQUEST_MUTATION_HOOKS = 16;
export const REQUEST_MUTATION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const PROMPT_KEYS = new Set(["kind", "version", "intent", "text", "reasonId"]);
const TOOL_KEYS = new Set(["kind", "version", "decision", "tool", "reasonId"]);
const OUTPUT_KEYS = new Set(["kind", "proposal"]);
const INTENTS = new Set<PromptShapeIntent>(["clarify", "compress", "redact", "augment"]);
const TOOL_DECISIONS = new Set<ToolSafetyDecision>(["warn", "deny"]);
const REASONS = new Set<RequestMutationReason>([
	"Grant required", "Prompt mutation disabled", "Malformed result", "Over budget", "Timed out",
	"Lower-priority proposal", "Tool warning", "Tool denied", "Prompt shaped", "Unavailable",
]);

export class RequestMutationContractError extends Error {
	constructor(public readonly code: string) {
		super(code);
		this.name = "RequestMutationContractError";
	}
}

function fail(code: string): never { throw new RequestMutationContractError(code); }
function isRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function record(value: unknown, code: string): Record<string, unknown> {
	if (!isRecord(value)) fail(code);
	return value;
}
function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, code: string): void {
	for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code);
}
function unsafeText(value: string): boolean {
	return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)
		|| /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i.test(value);
}
function boundedText(value: unknown, maxBytes: number, code: string): string {
	if (typeof value !== "string" || value.length === 0 || unsafeText(value) || Buffer.byteLength(value, "utf8") > maxBytes) fail(code);
	return value;
}
function safeIdentifier(value: unknown, code: string): string {
	if (typeof value !== "string" || !REQUEST_MUTATION_IDENTIFIER.test(value)) fail(code);
	return value;
}
function serializedBytes(value: unknown): number {
	try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return Number.POSITIVE_INFINITY; }
}

export function isRequestMutationReason(value: unknown): value is RequestMutationReason {
	return typeof value === "string" && REASONS.has(value as RequestMutationReason);
}

export function validatePromptShapeRequest(raw: unknown): PromptShapeRequest {
	const value = record(raw, "INVALID_PROMPT_REQUEST");
	onlyKeys(value, new Set(["sessionId", "projectId", "text"]), "INVALID_PROMPT_REQUEST");
	return Object.freeze({
		sessionId: safeIdentifier(value.sessionId, "INVALID_PROMPT_REQUEST"),
		projectId: safeIdentifier(value.projectId, "INVALID_PROMPT_REQUEST"),
		text: boundedText(value.text, MAX_REQUEST_MUTATION_PROMPT_BYTES, "INVALID_PROMPT_REQUEST"),
	});
}

export function validateToolSafetyRequest(raw: unknown): ToolSafetyRequest {
	const value = record(raw, "INVALID_TOOL_REQUEST");
	onlyKeys(value, new Set(["sessionId", "projectId", "toolName"]), "INVALID_TOOL_REQUEST");
	return Object.freeze({
		sessionId: safeIdentifier(value.sessionId, "INVALID_TOOL_REQUEST"),
		projectId: safeIdentifier(value.projectId, "INVALID_TOOL_REQUEST"),
		toolName: safeIdentifier(value.toolName, "INVALID_TOOL_REQUEST"),
	});
}

/** Validate an untrusted proposal against the one transient event it may affect. */
export function validateRequestMutationProposal(raw: unknown, event: RequestMutationEvent, request: PromptShapeRequest | ToolSafetyRequest): RequestMutationProposal {
	if (serializedBytes(raw) > MAX_REQUEST_MUTATION_RESULT_BYTES) fail("RESULT_TOO_LARGE");
	const value = record(raw, "INVALID_PROPOSAL");
	if (value.kind === "prompt-shape") {
		if (event !== "beforePrompt") fail("INVALID_PROPOSAL_EVENT");
		onlyKeys(value, PROMPT_KEYS, "UNKNOWN_PROPOSAL_FIELD");
		if (value.version !== 1 || typeof value.intent !== "string" || !INTENTS.has(value.intent as PromptShapeIntent)) fail("INVALID_PROMPT_PROPOSAL");
		return Object.freeze({
			kind: "prompt-shape", version: 1, intent: value.intent as PromptShapeIntent,
			text: boundedText(value.text, MAX_REQUEST_MUTATION_PROMPT_BYTES, "INVALID_PROMPT_PROPOSAL"),
			reasonId: safeIdentifier(value.reasonId, "INVALID_PROMPT_PROPOSAL"),
		});
	}
	if (value.kind !== "tool-safety" || event !== "beforeToolCall") fail("INVALID_PROPOSAL_EVENT");
	onlyKeys(value, TOOL_KEYS, "UNKNOWN_PROPOSAL_FIELD");
	if (value.version !== 1 || typeof value.decision !== "string" || !TOOL_DECISIONS.has(value.decision as ToolSafetyDecision)) fail("INVALID_TOOL_PROPOSAL");
	const tool = value.tool === undefined ? undefined : safeIdentifier(value.tool, "INVALID_TOOL_PROPOSAL");
	if (tool !== undefined && tool !== (request as ToolSafetyRequest).toolName) fail("TOOL_SCOPE_MISMATCH");
	return Object.freeze({
		kind: "tool-safety", version: 1, decision: value.decision as ToolSafetyDecision,
		...(tool === undefined ? {} : { tool }), reasonId: safeIdentifier(value.reasonId, "INVALID_TOOL_PROPOSAL"),
	});
}

/** Strict outer hook output validation. Nullish is the only no-op. */
export function validateRequestMutationHookOutput(raw: unknown, event: RequestMutationEvent, request: PromptShapeRequest | ToolSafetyRequest): RequestMutationProposal | null {
	if (raw === null || raw === undefined) return null;
	if (serializedBytes(raw) > MAX_REQUEST_MUTATION_RESULT_BYTES) fail("RESULT_TOO_LARGE");
	const output = record(raw, "INVALID_HOOK_OUTPUT");
	onlyKeys(output, OUTPUT_KEYS, "UNKNOWN_HOOK_OUTPUT_FIELD");
	if (output.kind !== "request-mutation") fail("INVALID_HOOK_OUTPUT");
	return validateRequestMutationProposal(output.proposal, event, request);
}

function validSource(source: unknown): source is RequestMutationSource {
	return isRecord(source)
		&& isSafeExtensionGrantIdentifier(source.packId)
		&& isSafeExtensionGrantIdentifier(source.hookId)
		&& typeof source.priority === "number" && Number.isFinite(source.priority);
}
function sourceKey(source: RequestMutationSource): string {
	// Dispatcher reserves the `core` principal for its internal-only shapers.
	return source.packId === "core" ? `core:${source.hookId}` : `extension:${source.packId}:${source.hookId}`;
}
function compareCodeUnits(a: string, b: string): number {
	return a === b ? 0 : a < b ? -1 : 1;
}
function compareSource(a: RequestMutationSource, b: RequestMutationSource): number {
	if (a.priority !== b.priority) return b.priority - a.priority;
	return compareCodeUnits(sourceKey(a), sourceKey(b));
}

/** Higher priority wins; tied sources are ordered by core-owned stable identity. */
export function reducePromptShape(candidates: readonly PromptShapeCandidate[]): PromptShapeReduction {
	const valid = candidates.filter(candidate => !!candidate && validSource(candidate.source) && isValidPromptCandidate(candidate.proposal));
	const winner = [...valid].sort((a, b) => compareSource(a.source, b.source))[0];
	return winner
		? Object.freeze({ action: "replace", text: winner.proposal.text, reason: "Prompt shaped", source: { ...winner.source } })
		: Object.freeze({ action: "pass", reason: "Unavailable" });
}

/** Deny has precedence over warning; priority only selects attribution within a severity. */
export function reduceToolSafety(candidates: readonly ToolSafetyCandidate[]): ToolSafetyReduction {
	const valid = candidates.filter(candidate => !!candidate && validSource(candidate.source) && isValidToolCandidate(candidate.proposal));
	const severity = (candidate: ToolSafetyCandidate) => candidate.proposal.decision === "deny" ? 2 : 1;
	const winner = [...valid].sort((a, b) => severity(b) - severity(a) || compareSource(a.source, b.source))[0];
	if (!winner) return Object.freeze({ action: "pass", reason: "Unavailable" });
	return Object.freeze({
		action: winner.proposal.decision,
		reason: winner.proposal.decision === "deny" ? "Tool denied" : "Tool warning",
		source: { ...winner.source },
	});
}

/** Guard direct core consumer returns so an accidental bad implementation cannot shape a turn. */
function isValidPromptCandidate(value: unknown): value is PromptShapeProposal {
	return isRecord(value) && value.kind === "prompt-shape" && value.version === 1
		&& typeof value.intent === "string" && INTENTS.has(value.intent as PromptShapeIntent)
		&& typeof value.reasonId === "string" && REQUEST_MUTATION_IDENTIFIER.test(value.reasonId)
		&& typeof value.text === "string" && value.text.length > 0 && !unsafeText(value.text)
		&& Buffer.byteLength(value.text, "utf8") <= MAX_REQUEST_MUTATION_PROMPT_BYTES;
}
function isValidToolCandidate(value: unknown): value is ToolSafetyProposal {
	return isRecord(value) && value.kind === "tool-safety" && value.version === 1
		&& typeof value.decision === "string" && TOOL_DECISIONS.has(value.decision as ToolSafetyDecision)
		&& typeof value.reasonId === "string" && REQUEST_MUTATION_IDENTIFIER.test(value.reasonId)
		&& (value.tool === undefined || typeof value.tool === "string" && REQUEST_MUTATION_IDENTIFIER.test(value.tool));
}

export function validatePromptShapeOutcome(raw: unknown): PromptShapeOutcome | undefined {
	if (!isRecord(raw) || !isRequestMutationReason(raw.reason)) return undefined;
	if (raw.action === "pass" && Object.keys(raw).length === 2) return { action: "pass", reason: raw.reason };
	if (raw.action === "replace" && Object.keys(raw).length === 3) {
		try { return { action: "replace", text: boundedText(raw.text, MAX_REQUEST_MUTATION_PROMPT_BYTES, "INVALID_CORE_OUTCOME"), reason: raw.reason }; } catch { return undefined; }
	}
	return undefined;
}

export function validateToolSafetyOutcome(raw: unknown): ToolSafetyOutcome | undefined {
	if (!isRecord(raw) || !isRequestMutationReason(raw.reason) || Object.keys(raw).length !== 2) return undefined;
	return raw.action === "pass" || raw.action === "warn" || raw.action === "deny" ? { action: raw.action, reason: raw.reason } : undefined;
}
