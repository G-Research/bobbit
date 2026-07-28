import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes as cryptoRandomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getCallSites } from "node:util";
import type { SystemsReviewEligibleTargetAssertion, SystemsReviewTargetEffectKind } from "./systems-review-types.js";

/**
 * Trusted target evidence is collected only while the verification harness is
 * running an actual registered integration/browser command. The command gets
 * one opaque correlation token. Production high-level actions establish the
 * action identity and expected target/scope; the last production adapter
 * reports the actual target/scope. Neither tests nor reviewers can label a
 * capture, choose a coverage item, or invoke an arbitrary callback through the
 * harness.
 */

export const FINAL_MUTATION_TARGET_EVIDENCE_VERSION = "bobbit:final-mutation-target/v2" as const;
export const FINAL_MUTATION_TARGET_CORRELATION_HEADER = "x-bobbit-final-mutation-target-evidence" as const;
export const FINAL_MUTATION_TARGET_CORRELATION_ENV = "BOBBIT_FINAL_MUTATION_TARGET_EVIDENCE" as const;
export const DEFAULT_FINAL_MUTATION_TARGET_EVIDENCE_TTL_MS = 15 * 60 * 1_000;
export const MAX_FINAL_MUTATION_TARGET_CAPTURE_ATTEMPTS = 256;

const TOKEN_PREFIX = "fmtec2";
const SIGNING_KEY_BYTES = 32;
const NONCE_BYTES = 32;
const MAX_TOKEN_BYTES = 512 * 1_024;
const MAX_ID_BYTES = 1_024;
const MAX_VALUE_BYTES = 16 * 1_024;
const MODULE_STACK_PATH = /(?:^|[\\/])src[\\/]server[\\/]agent[\\/]systems-review-target-evidence\.(?:[cm]?js|ts)$/u;
const INTERNAL_CAPTURE_FUNCTIONS = new Set([
	"captureAdapterSource",
	"captureFinalMutationTarget",
	"FinalMutationTargetCommandEvidenceBroker.capture",
	"capture",
]);
const REGISTERED_FINAL_ADAPTERS = Object.freeze([
	Object.freeze({ id: "bobbit.git.merge-child", effectKind: "git-merge" as const, functionName: "mergeChildBranchLocal", source: /(?:^|[\\/])src[\\/]server[\\/]skills[\\/]git\.ts(?::\d+:\d+)?$/u }),
	Object.freeze({ id: "bobbit.git.merge-child", effectKind: "git-merge" as const, functionName: "mergeChildBranchLocal", source: /[\\/]\.profiles[\\/]testing-v2[\\/]server-prebundle[\\/][a-zA-Z0-9_-]+[\\/]chunks[\\/]chunk-[a-zA-Z0-9_-]+\.mjs(?::\d+:\d+)?$/u }),
	Object.freeze({ id: "bobbit.git.merge-child", effectKind: "git-merge" as const, functionName: "mergeChildBranchLocal", source: /[\\/]dist[\\/]server[\\/]skills[\\/]git\.js(?::\d+:\d+)?$/u }),
]);
const TARGET_EFFECT_KINDS = new Set<SystemsReviewTargetEffectKind>([
	"git-merge", "git-push", "filesystem-delete", "persistence-write", "queue-effect", "remote-request", "unknown",
]);
const trustedGetCallSites = getCallSites;
const COMMAND_CAPABILITY_BRAND: unique symbol = Symbol("FinalMutationTargetCommandCapability");
const ACTION_PROVENANCE_BRAND: unique symbol = Symbol("FinalMutationTargetActionProvenance");

export type FinalMutationTargetTestKind = "integration" | "browser";

export interface CaptureFinalMutationTargetInput {
	/** Caller labels are rejected during command evidence capture. */
	readonly actionId?: string;
	readonly coverageItemId?: string;
	readonly resolvedTarget: string;
	readonly resolvedScope: string;
	readonly effectKind: SystemsReviewTargetEffectKind;
}

export interface FinalMutationTargetCaptureRecord {
	readonly actionId: string;
	readonly coverageItemId: string;
	readonly resolvedTarget: string;
	readonly resolvedScope: string;
	readonly effectKind: SystemsReviewTargetEffectKind;
	readonly attempt: number;
	readonly capturedAt: number;
	readonly adapterSource: string;
}

export interface FinalMutationTargetAssertionEvidence {
	readonly version: typeof FINAL_MUTATION_TARGET_EVIDENCE_VERSION;
	readonly nonce: string;
	readonly executionId: string;
	readonly commandId: string;
	readonly testId: string;
	readonly testKind: FinalMutationTargetTestKind;
	readonly baseOid: string;
	readonly headOid: string;
	readonly actionId: string;
	readonly coverageItemId: string;
	readonly expectedTarget: string;
	readonly expectedScope: string;
	readonly effectOutcome: "succeeded";
	readonly attempts: readonly FinalMutationTargetCaptureRecord[];
	readonly issuedAt: number;
	readonly expiresAt: number;
}

export interface RegisteredFinalMutationTargetAssertion extends SystemsReviewEligibleTargetAssertion {
	readonly coverageItemId: string;
	readonly executionId: string;
	readonly evidence: FinalMutationTargetAssertionEvidence;
	readonly registeredAt: number;
}

export interface FinalMutationTargetAssertionRegistryExpectation {
	readonly executionId: string;
	readonly baseOid: string;
	readonly headOid: string;
	/** Coverage owns the immutable production action binding; callers need not duplicate it. */
	readonly actionId?: string;
	readonly coverageItemId: string;
	readonly requiredAdapterIds: readonly string[];
}

export interface FinalMutationTargetCommandCoverageBinding {
	readonly coverageItemId: string;
	readonly baseOid: string;
	readonly headOid: string;
	readonly requiredActionIds: readonly string[];
	readonly requiredAdapterIds: readonly string[];
}

export interface FinalMutationTargetCommandBinding {
	readonly executionId: string;
	readonly commandId: string;
	readonly testId: string;
	readonly testKind: FinalMutationTargetTestKind;
	readonly coverage: readonly FinalMutationTargetCommandCoverageBinding[];
	readonly ttlMs?: number;
}

export interface FinalMutationTargetCommandCapability {
	readonly [COMMAND_CAPABILITY_BRAND]: true;
}

export interface FinalMutationTargetCommandRun {
	readonly capability: FinalMutationTargetCommandCapability;
	readonly correlationToken: string;
}

export interface FinalMutationTargetActionProvenance {
	readonly [ACTION_PROVENANCE_BRAND]: true;
	readonly id: string;
	readonly adapterIds: readonly string[];
}

export type FinalMutationTargetEvidenceErrorCode =
	| "invalid-binding"
	| "invalid-capability"
	| "invalid-token"
	| "expired-context"
	| "closed-context"
	| "uncorrelated-capture"
	| "capture-binding-mismatch"
	| "capture-limit"
	| "target-mismatch"
	| "scope-mismatch"
	| "unregistered-adapter"
	| "replayed-assertion";

export class FinalMutationTargetEvidenceError extends Error {
	readonly code: FinalMutationTargetEvidenceErrorCode;

	constructor(code: FinalMutationTargetEvidenceErrorCode, message: string) {
		super(message);
		this.name = "FinalMutationTargetEvidenceError";
		this.code = code;
	}
}

export interface FinalMutationTargetEvidenceBrokerOptions {
	readonly signingKey?: Uint8Array;
	readonly now?: () => number;
	readonly randomBytes?: (size: number) => Uint8Array;
}

interface CommandCaptureRecord extends FinalMutationTargetCaptureRecord {
	readonly expectedTarget: string;
	readonly expectedScope: string;
	readonly invocationId: string;
	readonly adapterId: string;
}

interface CommandEvidenceSession {
	readonly binding: Readonly<Omit<FinalMutationTargetCommandBinding, "ttlMs">>;
	readonly nonce: string;
	readonly issuedAt: number;
	readonly expiresAt: number;
	readonly records: CommandCaptureRecord[];
	readonly actionInvocations: Map<string, string>;
	readonly successfulInvocations: Map<string, string>;
	status: "running" | "completed" | "failed";
}

interface CommandEvidenceContextStore {
	readonly broker: FinalMutationTargetCommandEvidenceBroker;
	readonly session: CommandEvidenceSession;
}

interface ActionProvenanceContextStore {
	readonly command: CommandEvidenceContextStore;
	readonly provenance: FinalMutationTargetActionProvenance;
	readonly invocationId: string;
	readonly expectedTarget: string;
	readonly expectedScope: string;
}

const commandEvidenceContext = new AsyncLocalStorage<CommandEvidenceContextStore>();
const actionProvenanceContext = new AsyncLocalStorage<ActionProvenanceContextStore>();

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function requireText(value: unknown, field: string, maxBytes = MAX_ID_BYTES): string {
	if (typeof value !== "string" || value.length === 0 || byteLength(value) > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
		throw new FinalMutationTargetEvidenceError("invalid-binding", `${field} must be non-empty bounded text without control characters`);
	}
	return value;
}

function requireOid(value: unknown, field: string): string {
	const oid = requireText(value, field, 64).toLowerCase();
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid)) {
		throw new FinalMutationTargetEvidenceError("invalid-binding", `${field} must be a complete SHA-1 or SHA-256 object id`);
	}
	return oid;
}

function requireEffectKind(value: unknown): SystemsReviewTargetEffectKind {
	const effectKind = requireText(value, "effectKind") as SystemsReviewTargetEffectKind;
	if (!TARGET_EFFECT_KINDS.has(effectKind)) throw new FinalMutationTargetEvidenceError("invalid-binding", "effectKind is unsupported");
	return effectKind;
}

function safeEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left, "utf8");
	const rightBytes = Buffer.from(right, "utf8");
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function checkedRandomBytes(randomBytes: (size: number) => Uint8Array, size: number): Buffer {
	const value = randomBytes(size);
	if (!(value instanceof Uint8Array) || value.byteLength !== size) throw new FinalMutationTargetEvidenceError("invalid-binding", "Evidence random source returned invalid bytes");
	return Buffer.from(value);
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function immutableTargetSet(values: readonly string[]): string {
	const unique = [...new Set(values)].sort();
	if (unique.length === 1) return unique[0];
	return `set:sha256:${createHash("sha256").update(stableJson(unique)).digest("hex")}`;
}

function immutableRecord(record: FinalMutationTargetCaptureRecord): FinalMutationTargetCaptureRecord {
	return Object.freeze({ ...record });
}

function immutableEvidence(evidence: FinalMutationTargetAssertionEvidence): FinalMutationTargetAssertionEvidence {
	return Object.freeze({ ...evidence, attempts: Object.freeze(evidence.attempts.map(immutableRecord)) });
}

function captureAdapterSource(): string {
	for (const callSite of trustedGetCallSites(30, { sourceMap: false })) {
		const functionName = callSite.functionName ?? "";
		if (!callSite.scriptName || MODULE_STACK_PATH.test(callSite.scriptName.replace(/:\d+:\d+$/u, "")) || INTERNAL_CAPTURE_FUNCTIONS.has(functionName) || functionName.endsWith(".capture")) continue;
		const location = `${callSite.scriptName}:${callSite.lineNumber}:${callSite.columnNumber}`;
		return functionName ? `${functionName} (${location})` : location;
	}
	throw new FinalMutationTargetEvidenceError("unregistered-adapter", "Could not determine final mutation adapter source");
}

export function resolveRegisteredFinalMutationTargetAdapter(source: string, effectKind: SystemsReviewTargetEffectKind): string | undefined {
	if (typeof source !== "string" || !TARGET_EFFECT_KINDS.has(effectKind)) return undefined;
	const match = /^([^ (]+) \((.+)\)$/u.exec(source);
	if (!match) return undefined;
	const [, functionName, rawLocation] = match;
	const normalizedLocation = rawLocation.replace(/\\/g, "/");
	return REGISTERED_FINAL_ADAPTERS.find(adapter => adapter.functionName === functionName && adapter.effectKind === effectKind && adapter.source.test(normalizedLocation))?.id;
}

export function isRegisteredFinalMutationTargetAdapterSource(source: string): boolean {
	return [...TARGET_EFFECT_KINDS].some(effectKind => !!resolveRegisteredFinalMutationTargetAdapter(source, effectKind));
}

function defineAction(id: string, adapterIds: readonly string[]): FinalMutationTargetActionProvenance {
	return Object.freeze({
		[ACTION_PROVENANCE_BRAND]: true as const,
		id,
		adapterIds: Object.freeze([...adapterIds]),
	});
}

/** Closed, production-owned action identities. */
export const FINAL_MUTATION_TARGET_ACTIONS = Object.freeze({
	mergeChildGoal: defineAction("bobbit.goal.merge-child", ["bobbit.git.merge-child"]),
});

function validateCoverage(value: FinalMutationTargetCommandCoverageBinding): FinalMutationTargetCommandCoverageBinding {
	if (!Array.isArray(value.requiredActionIds) || value.requiredActionIds.length === 0) throw new FinalMutationTargetEvidenceError("invalid-binding", "Command evidence requires patch-derived production action provenance");
	if (!Array.isArray(value.requiredAdapterIds) || value.requiredAdapterIds.length === 0) throw new FinalMutationTargetEvidenceError("invalid-binding", "Command evidence requires a patch-derived final adapter");
	return Object.freeze({
		coverageItemId: requireText(value.coverageItemId, "coverageItemId"),
		baseOid: requireOid(value.baseOid, "baseOid"),
		headOid: requireOid(value.headOid, "headOid"),
		requiredActionIds: Object.freeze([...new Set(value.requiredActionIds.map(id => requireText(id, "requiredActionId")))].sort()),
		requiredAdapterIds: Object.freeze([...new Set(value.requiredAdapterIds.map(id => requireText(id, "requiredAdapterId")))].sort()),
	});
}

/** Harness-owned command evidence broker. */
export class FinalMutationTargetCommandEvidenceBroker {
	private readonly signingKey: Buffer;
	private readonly now: () => number;
	private readonly randomBytes: (size: number) => Uint8Array;
	private readonly sessionsByCapability = new WeakMap<object, CommandEvidenceSession>();
	private readonly sessionsByNonce = new Map<string, CommandEvidenceSession>();
	private readonly consumedAttestations = new Set<string>();

	constructor(options: FinalMutationTargetEvidenceBrokerOptions = {}) {
		const key = options.signingKey ?? cryptoRandomBytes(SIGNING_KEY_BYTES);
		if (!(key instanceof Uint8Array) || key.byteLength < SIGNING_KEY_BYTES) throw new FinalMutationTargetEvidenceError("invalid-binding", `Evidence signing key must contain at least ${SIGNING_KEY_BYTES} bytes`);
		this.signingKey = Buffer.from(key);
		this.now = options.now ?? Date.now;
		this.randomBytes = options.randomBytes ?? cryptoRandomBytes;
	}

	begin(binding: FinalMutationTargetCommandBinding): FinalMutationTargetCommandRun {
		if (binding.testKind !== "integration" && binding.testKind !== "browser") throw new FinalMutationTargetEvidenceError("invalid-binding", "Only registered integration or browser commands can collect target evidence");
		if (!Array.isArray(binding.coverage) || binding.coverage.length === 0) throw new FinalMutationTargetEvidenceError("invalid-binding", "Command evidence has no immutable coverage binding");
		const issuedAt = this.checkedNow();
		const ttlMs = binding.ttlMs ?? DEFAULT_FINAL_MUTATION_TARGET_EVIDENCE_TTL_MS;
		if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(issuedAt + ttlMs)) throw new FinalMutationTargetEvidenceError("invalid-binding", "Command evidence ttlMs is invalid");
		const normalized = Object.freeze({
			executionId: requireText(binding.executionId, "executionId"),
			commandId: requireText(binding.commandId, "commandId"),
			testId: requireText(binding.testId, "testId"),
			testKind: binding.testKind,
			coverage: Object.freeze(binding.coverage.map(validateCoverage)),
		});
		const nonce = checkedRandomBytes(this.randomBytes, NONCE_BYTES).toString("base64url");
		if (this.sessionsByNonce.has(nonce)) throw new FinalMutationTargetEvidenceError("invalid-binding", "Evidence nonce was reused");
		const session: CommandEvidenceSession = {
			binding: normalized,
			nonce,
			issuedAt,
			expiresAt: issuedAt + ttlMs,
			records: [],
			actionInvocations: new Map(),
			successfulInvocations: new Map(),
			status: "running",
		};
		const capability = Object.freeze({ [COMMAND_CAPABILITY_BRAND]: true }) as FinalMutationTargetCommandCapability;
		this.sessionsByCapability.set(capability, session);
		this.sessionsByNonce.set(nonce, session);
		const correlationToken = this.encode({
			purpose: "verification-command",
			nonce,
			issuedAt,
			expiresAt: session.expiresAt,
			bindingDigest: this.bindingDigest(normalized),
		});
		return Object.freeze({ capability, correlationToken });
	}

	runWithCorrelation<T>(token: unknown, callback: () => T): T {
		if (typeof token !== "string" || typeof callback !== "function") throw new FinalMutationTargetEvidenceError("invalid-token", "Missing verification command correlation");
		const claims = this.decode(token) as Record<string, unknown>;
		if (claims.purpose !== "verification-command") throw new FinalMutationTargetEvidenceError("invalid-token", "Correlation is not a verification command capability");
		const nonce = requireText(claims.nonce, "nonce");
		const session = this.sessionsByNonce.get(nonce);
		if (!session || session.status !== "running") throw new FinalMutationTargetEvidenceError("closed-context", "Verification command correlation is closed or unknown");
		if (this.checkedNow() > session.expiresAt || claims.expiresAt !== session.expiresAt) {
			session.status = "failed";
			throw new FinalMutationTargetEvidenceError("expired-context", "Verification command correlation expired");
		}
		if (claims.bindingDigest !== this.bindingDigest(session.binding)) throw new FinalMutationTargetEvidenceError("invalid-token", "Verification command correlation binding mismatch");
		return commandEvidenceContext.run({ broker: this, session }, callback);
	}

	capture(input: CaptureFinalMutationTargetInput): FinalMutationTargetCaptureRecord {
		const command = commandEvidenceContext.getStore();
		const action = actionProvenanceContext.getStore();
		if (!command || command.broker !== this || !action || action.command !== command) throw new FinalMutationTargetEvidenceError("uncorrelated-capture", "Final adapter capture lacks production action provenance");
		if (input.actionId !== undefined || input.coverageItemId !== undefined) throw new FinalMutationTargetEvidenceError("capture-binding-mismatch", "Final adapters cannot supply caller-selected action or coverage labels");
		if (command.session.status !== "running") throw new FinalMutationTargetEvidenceError("closed-context", "Verification command target capture is closed");
		if (command.session.records.length >= MAX_FINAL_MUTATION_TARGET_CAPTURE_ATTEMPTS) throw new FinalMutationTargetEvidenceError("capture-limit", "Target capture attempt limit exceeded");
		const adapterSource = captureAdapterSource();
		const effectKind = requireEffectKind(input.effectKind);
		const adapterId = resolveRegisteredFinalMutationTargetAdapter(adapterSource, effectKind);
		if (!adapterId || !action.provenance.adapterIds.includes(adapterId)) throw new FinalMutationTargetEvidenceError("unregistered-adapter", "Final adapter is not registered for the active production action");
		const resolvedTarget = requireText(input.resolvedTarget, "resolvedTarget", MAX_VALUE_BYTES);
		const resolvedScope = requireText(input.resolvedScope, "resolvedScope", MAX_VALUE_BYTES);
		if (resolvedTarget !== action.expectedTarget) throw new FinalMutationTargetEvidenceError("target-mismatch", "Final adapter target differs from the production action target");
		if (resolvedScope !== action.expectedScope) throw new FinalMutationTargetEvidenceError("scope-mismatch", "Final adapter scope differs from the production action scope");
		const record: CommandCaptureRecord = Object.freeze({
			actionId: action.provenance.id,
			coverageItemId: "command-phase-unmapped",
			resolvedTarget,
			resolvedScope,
			expectedTarget: action.expectedTarget,
			expectedScope: action.expectedScope,
			effectKind,
			attempt: command.session.records.length + 1,
			capturedAt: this.checkedNow(),
			adapterSource,
			adapterId,
			invocationId: action.invocationId,
		});
		command.session.records.push(record);
		return record;
	}

	complete(capability: FinalMutationTargetCommandCapability, commandPassed: boolean): RegisteredFinalMutationTargetAssertion[] {
		const session = this.sessionsByCapability.get(capability);
		if (!session || session.status !== "running") throw new FinalMutationTargetEvidenceError("invalid-capability", "Unknown or closed verification command capability");
		session.status = commandPassed ? "completed" : "failed";
		this.sessionsByNonce.delete(session.nonce);
		if (!commandPassed) return [];
		const successful = session.records.filter(record => session.successfulInvocations.has(record.invocationId));
		const assertions: RegisteredFinalMutationTargetAssertion[] = [];
		for (const coverage of session.binding.coverage) {
			for (const actionId of coverage.requiredActionIds) {
				const actionRecords = successful.filter(record => record.actionId === actionId);
				const invocationIds = [...session.actionInvocations].filter(([, id]) => id === actionId).map(([id]) => id);
				const completeCapture = invocationIds.length > 0
					&& invocationIds.every(id => session.successfulInvocations.has(id))
					&& invocationIds.every(id => actionRecords.some(record => record.invocationId === id));
				if (!completeCapture || actionRecords.some(record => !coverage.requiredAdapterIds.includes(record.adapterId))) continue;
				const issuedAt = this.checkedNow();
				if (issuedAt > session.expiresAt) continue;
				const evidence = immutableEvidence({
					version: FINAL_MUTATION_TARGET_EVIDENCE_VERSION,
					nonce: checkedRandomBytes(this.randomBytes, NONCE_BYTES).toString("base64url"),
					executionId: session.binding.executionId,
					commandId: session.binding.commandId,
					testId: session.binding.testId,
					testKind: session.binding.testKind,
					baseOid: coverage.baseOid,
					headOid: coverage.headOid,
					actionId,
					coverageItemId: coverage.coverageItemId,
					expectedTarget: immutableTargetSet(actionRecords.map(record => record.expectedTarget)),
					expectedScope: immutableTargetSet(actionRecords.map(record => record.expectedScope)),
					effectOutcome: "succeeded",
					attempts: actionRecords.map((record, index) => immutableRecord({ ...record, coverageItemId: coverage.coverageItemId, attempt: index + 1 })),
					issuedAt,
					expiresAt: session.expiresAt,
				});
				const consumed = this.consumeAttestation(this.encode({ purpose: "command-attestation", evidence }), session, coverage, actionId);
				assertions.push(Object.freeze({
					assertionId: `target-assertion:${randomUUID()}`,
					coverageItemId: coverage.coverageItemId,
					executionId: session.binding.executionId,
					actionId,
					commandId: session.binding.commandId,
					testId: session.binding.testId,
					testKind: session.binding.testKind,
					baseOid: coverage.baseOid,
					headOid: coverage.headOid,
					expectedTarget: consumed.expectedTarget,
					expectedScope: consumed.expectedScope,
					effectOutcome: "succeeded",
					adapterIds: Object.freeze([...new Set(actionRecords.map(record => record.adapterId))].sort()),
					effectKinds: Object.freeze([...new Set(actionRecords.map(record => record.effectKind))].sort()),
					evidence: consumed,
					registeredAt: issuedAt,
				}));
			}
		}
		return assertions;
	}

	private consumeAttestation(token: string, session: CommandEvidenceSession, coverage: FinalMutationTargetCommandCoverageBinding, actionId: string): FinalMutationTargetAssertionEvidence {
		const decoded = this.decode(token) as { purpose?: unknown; evidence?: FinalMutationTargetAssertionEvidence };
		const evidence = decoded.evidence;
		if (decoded.purpose !== "command-attestation" || !evidence || evidence.executionId !== session.binding.executionId || evidence.commandId !== session.binding.commandId || evidence.coverageItemId !== coverage.coverageItemId || evidence.actionId !== actionId || evidence.baseOid !== coverage.baseOid || evidence.headOid !== coverage.headOid) {
			throw new FinalMutationTargetEvidenceError("invalid-token", "Verification command attestation binding mismatch");
		}
		if (this.consumedAttestations.has(evidence.nonce)) throw new FinalMutationTargetEvidenceError("replayed-assertion", "Verification command attestation was replayed");
		this.consumedAttestations.add(evidence.nonce);
		return evidence;
	}

	private bindingDigest(binding: Readonly<Omit<FinalMutationTargetCommandBinding, "ttlMs">>): string {
		return createHmac("sha256", this.signingKey).update(stableJson(binding)).digest("hex");
	}

	private encode(value: unknown): string {
		const body = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
		const signature = createHmac("sha256", this.signingKey).update(FINAL_MUTATION_TARGET_EVIDENCE_VERSION).update("\0command\0").update(body).digest("base64url");
		const token = `${TOKEN_PREFIX}.${body}.${signature}`;
		if (byteLength(token) > MAX_TOKEN_BYTES) throw new FinalMutationTargetEvidenceError("invalid-token", "Evidence token exceeds its size limit");
		return token;
	}

	private decode(token: string): unknown {
		if (byteLength(token) > MAX_TOKEN_BYTES) throw new FinalMutationTargetEvidenceError("invalid-token", "Evidence token exceeds its size limit");
		const parts = token.split(".");
		if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) throw new FinalMutationTargetEvidenceError("invalid-token", "Malformed verification command evidence token");
		const expected = createHmac("sha256", this.signingKey).update(FINAL_MUTATION_TARGET_EVIDENCE_VERSION).update("\0command\0").update(parts[1]).digest("base64url");
		if (!safeEqual(parts[2], expected)) throw new FinalMutationTargetEvidenceError("invalid-token", "Invalid verification command evidence signature");
		try {
			const bytes = Buffer.from(parts[1], "base64url");
			if (bytes.toString("base64url") !== parts[1]) throw new Error("non-canonical payload");
			return JSON.parse(bytes.toString("utf8"));
		} catch {
			throw new FinalMutationTargetEvidenceError("invalid-token", "Malformed verification command evidence payload");
		}
	}

	private checkedNow(): number {
		const now = this.now();
		if (!Number.isSafeInteger(now) || now < 0) throw new FinalMutationTargetEvidenceError("invalid-binding", "Evidence clock returned an invalid timestamp");
		return now;
	}
}

/**
 * Establish production-owned action provenance around the actual effect. The
 * action resolves expected target/scope before entering its final adapter.
 */
export async function runWithFinalMutationTargetAction<T>(
	provenance: FinalMutationTargetActionProvenance,
	expected: { resolvedTarget: string; resolvedScope: string },
	invoke: () => T | Promise<T>,
	effectSucceeded: (value: T) => boolean = () => true,
): Promise<T> {
	const command = commandEvidenceContext.getStore();
	if (!command) return await invoke();
	if (!provenance || provenance[ACTION_PROVENANCE_BRAND] !== true || !Object.values(FINAL_MUTATION_TARGET_ACTIONS).includes(provenance)) throw new FinalMutationTargetEvidenceError("invalid-binding", "Unregistered production action provenance");
	const context: ActionProvenanceContextStore = {
		command,
		provenance,
		invocationId: randomUUID(),
		expectedTarget: requireText(expected.resolvedTarget, "resolvedTarget", MAX_VALUE_BYTES),
		expectedScope: requireText(expected.resolvedScope, "resolvedScope", MAX_VALUE_BYTES),
	};
	command.session.actionInvocations.set(context.invocationId, provenance.id);
	return actionProvenanceContext.run(context, async () => {
		const value = await invoke();
		if (effectSucceeded(value)) command.session.successfulInvocations.set(context.invocationId, provenance.id);
		return value;
	});
}

/** Called only by a registered final production adapter immediately before the effect. */
export function captureFinalMutationTarget(input: CaptureFinalMutationTargetInput): FinalMutationTargetCaptureRecord | undefined {
	const command = commandEvidenceContext.getStore();
	return command?.broker.capture(input);
}
