import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes as cryptoRandomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getCallSites } from "node:util";

/**
 * Trusted, test-only evidence captured at the last production-owned adapter
 * before a destructive or remote mutation. Normal production calls are a no-op:
 * records are accepted only while the verification harness has installed a
 * cryptographically correlated capability.
 *
 * This module deliberately contains no command runner, HTTP route, queue, or
 * persistence dependency. Those boundaries transport only its opaque tokens and
 * reserved envelope; they cannot manufacture capture records or signed
 * assertions.
 */

export const FINAL_MUTATION_TARGET_EVIDENCE_VERSION = "bobbit:final-mutation-target/v1" as const;
export const FINAL_MUTATION_TARGET_QUEUE_ENVELOPE_KEY = "__bobbitFinalMutationTargetEvidence" as const;
export const FINAL_MUTATION_TARGET_CORRELATION_HEADER = "x-bobbit-final-mutation-target-evidence" as const;
export const DEFAULT_FINAL_MUTATION_TARGET_EVIDENCE_TTL_MS = 15 * 60 * 1_000;
export const MAX_FINAL_MUTATION_TARGET_CAPTURE_ATTEMPTS = 256;

const TOKEN_PREFIX = "fmte1";
const SIGNING_KEY_BYTES = 32;
const NONCE_BYTES = 32;
const TOKEN_ID_BYTES = 16;
const MAX_TOKEN_BYTES = 512 * 1_024;
const MAX_CAPTURE_EVIDENCE_BYTES = 320 * 1_024;
const MAX_ID_BYTES = 1_024;
const MAX_VALUE_BYTES = 16 * 1_024;
const FUTURE_SKEW_MS = 30_000;
const MODULE_STACK_PATH = /(?:^|[\\/])src[\\/]server[\\/]agent[\\/]systems-review-target-evidence\.(?:[cm]?js|ts)$/u;
const INTERNAL_CAPTURE_FUNCTIONS = new Set([
	"captureAdapterSource",
	"captureFinalMutationTarget",
	"FinalMutationTargetEvidenceBroker.capture",
	"capture",
]);
const REGISTERED_FINAL_ADAPTERS = Object.freeze([
	Object.freeze({ functionName: "mergeChildBranchLocal", source: /(?:^|[\\/])src[\\/]server[\\/]skills[\\/]git\.ts(?::\d+:\d+)?$/u }),
	Object.freeze({ functionName: "mergeChildBranchLocal", source: /[\\/]\.profiles[\\/]testing-v2[\\/]server-prebundle[\\/][a-zA-Z0-9_-]+[\\/]chunks[\\/]chunk-[a-zA-Z0-9_-]+\.mjs(?::\d+:\d+)?$/u }),
	Object.freeze({ functionName: "mergeChildBranchLocal", source: /[\\/]dist[\\/]server[\\/]skills[\\/]git\.js(?::\d+:\d+)?$/u }),
]);
// Capture the Node intrinsic while the trusted server loads this module. Unlike
// Error.stack, util.getCallSites does not consult caller-controlled
// Error.prepareStackTrace. Keeping the original reference also resists later
// monkey-patching by test code in the same process.
const trustedGetCallSites = getCallSites;

const CAPABILITY_BRAND: unique symbol = Symbol("FinalMutationTargetEvidenceCapability");

export type FinalMutationTargetTestKind = "integration" | "browser";
export type FinalMutationTargetCorrelationAudience = "queue" | "cross-process";

export interface FinalMutationTargetEvidenceBinding {
	/** Logical Systems review execution which requested the target proof. */
	readonly executionId: string;
	/** Registered test command, not an arbitrary command line supplied by a test. */
	readonly commandId: string;
	/** Stable test identity supplied by the registered integration/browser runner. */
	readonly testId: string;
	readonly testKind: FinalMutationTargetTestKind;
	readonly baseOid: string;
	readonly headOid: string;
	readonly actionId: string;
	readonly coverageItemId: string;
	readonly ttlMs?: number;
}

export interface CaptureFinalMutationTargetInput {
	/** Optional only for a registered production adapter; the capability supplies the immutable binding. */
	readonly actionId?: string;
	readonly coverageItemId?: string;
	readonly resolvedTarget: string;
	readonly resolvedScope: string;
	/** Adapter-owned effect classification, for example `git-command` or `remote-request`. */
	readonly effectKind: string;
}

export interface FinalMutationTargetCaptureRecord {
	readonly actionId: string;
	readonly coverageItemId: string;
	readonly resolvedTarget: string;
	readonly resolvedScope: string;
	readonly effectKind: string;
	/** One-based attempt number. Retries produce distinct records. */
	readonly attempt: number;
	readonly capturedAt: number;
	/** First stack frame outside this substrate; consumers must allowlist a production adapter. */
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

export interface CapturedFinalMutationTargetAssertion<T> {
	/** The invocation's unmodified return value. */
	readonly value: T;
	/** Opaque signed evidence for the verification harness to consume once. */
	readonly assertionToken: string;
	/** Immutable projection for diagnostics; the signature covers this exact evidence. */
	readonly evidence: FinalMutationTargetAssertionEvidence;
}

export interface AssertCapturedFinalMutationTargetInput<T> {
	readonly actionId: string;
	readonly expectedTarget: string;
	readonly expectedScope: string;
	readonly invoke: () => T | Promise<T>;
}

/**
 * Server-owned values used when consuming an assertion. Requiring every binding
 * prevents a valid assertion from being replayed for another action, coverage
 * item, test, command, commit pair, or verification execution.
 */
export interface FinalMutationTargetAssertionExpectation {
	readonly executionId: string;
	readonly commandId: string;
	readonly testId: string;
	readonly testKind: FinalMutationTargetTestKind;
	readonly baseOid: string;
	readonly headOid: string;
	readonly actionId: string;
	readonly coverageItemId: string;
	/**
	 * Must accept only registered final production adapters. This is what rejects
	 * captures made by a route, test helper, callback, or tautological test.
	 */
	readonly isRegisteredFinalAdapterSource: (source: string) => boolean;
}

export interface SignedFinalMutationTargetQueueEnvelope {
	readonly version: typeof FINAL_MUTATION_TARGET_EVIDENCE_VERSION;
	readonly token: string;
}

export type FinalMutationTargetQueuePayload<T extends Record<string, unknown>> = T & {
	readonly [FINAL_MUTATION_TARGET_QUEUE_ENVELOPE_KEY]?: SignedFinalMutationTargetQueueEnvelope;
};

/** Opaque by construction: only a broker-created object is present in its WeakMap. */
export interface FinalMutationTargetEvidenceCapability {
	readonly [CAPABILITY_BRAND]: true;
}

export type FinalMutationTargetEvidenceErrorCode =
	| "invalid-binding"
	| "invalid-capability"
	| "missing-context"
	| "expired-context"
	| "closed-context"
	| "uncorrelated-capture"
	| "concurrent-assertion"
	| "capture-binding-mismatch"
	| "capture-limit"
	| "missing-capture"
	| "target-mismatch"
	| "scope-mismatch"
	| "invalid-token"
	| "token-binding-mismatch"
	| "replayed-assertion"
	| "unregistered-adapter"
	| "reserved-envelope-collision";

export class FinalMutationTargetEvidenceError extends Error {
	readonly code: FinalMutationTargetEvidenceErrorCode;

	constructor(code: FinalMutationTargetEvidenceErrorCode, message: string) {
		super(message);
		this.name = "FinalMutationTargetEvidenceError";
		this.code = code;
	}
}

export interface FinalMutationTargetEvidenceBrokerOptions {
	/** At least 32 bytes. Copied on construction and never exposed again. */
	readonly signingKey?: Uint8Array;
	readonly now?: () => number;
	readonly randomBytes?: (size: number) => Uint8Array;
}

type SessionStatus = "open" | "asserting" | "asserted" | "failed" | "consumed";

interface EvidenceSession {
	readonly binding: Readonly<Required<Omit<FinalMutationTargetEvidenceBinding, "ttlMs">>>;
	/** This capability is single-use, so its nonce is also the assertion invocation nonce. */
	readonly nonce: string;
	readonly issuedAt: number;
	readonly expiresAt: number;
	readonly records: FinalMutationTargetCaptureRecord[];
	recordBytes: number;
	status: SessionStatus;
	assertionToken?: string;
}

interface CorrelationClaims {
	readonly version: typeof FINAL_MUTATION_TARGET_EVIDENCE_VERSION;
	readonly purpose: "correlation";
	readonly audience: FinalMutationTargetCorrelationAudience;
	readonly tokenId: string;
	readonly nonce: string;
	readonly actionId: string;
	readonly coverageItemId: string;
	readonly issuedAt: number;
	readonly expiresAt: number;
}

interface EvidenceContextStore {
	readonly broker: FinalMutationTargetEvidenceBroker;
	readonly session: EvidenceSession;
	/** `harness` cannot capture; an effect must cross a signed production transport boundary. */
	readonly channel: "harness" | FinalMutationTargetCorrelationAudience;
}

const evidenceContext = new AsyncLocalStorage<EvidenceContextStore>();

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function requireText(value: unknown, field: string, maxBytes = MAX_ID_BYTES): string {
	if (
		typeof value !== "string"
		|| value.length === 0
		|| byteLength(value) > maxBytes
		|| /[\u0000-\u001f\u007f]/u.test(value)
	) {
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

function requireTimestamp(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new FinalMutationTargetEvidenceError("invalid-token", `${field} must be a non-negative safe integer`);
	}
	return value;
}

function copyRandomBytes(randomBytes: (size: number) => Uint8Array, size: number, label: string): Buffer {
	const value = randomBytes(size);
	if (!(value instanceof Uint8Array) || value.byteLength !== size) {
		throw new FinalMutationTargetEvidenceError("invalid-binding", `${label} must return exactly ${size} random bytes`);
	}
	return Buffer.from(value);
}

function safeEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left, "utf8");
	const rightBytes = Buffer.from(right, "utf8");
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function captureAdapterSource(): string {
	// Use generated/runtime identity. Source-map metadata can be supplied by the
	// caller and therefore cannot establish a trusted production adapter. Bundled
	// builds may put this module and its caller in hashed entry files, so skip the
	// substrate by function identity as well as by its development source path.
	for (const callSite of trustedGetCallSites(30, { sourceMap: false })) {
		const functionName = callSite.functionName ?? "";
		if (
			!callSite.scriptName
			|| MODULE_STACK_PATH.test(callSite.scriptName.replace(/:\d+:\d+$/u, ""))
			|| INTERNAL_CAPTURE_FUNCTIONS.has(functionName)
			|| functionName.endsWith(".capture")
		) continue;
		const location = `${callSite.scriptName}:${callSite.lineNumber}:${callSite.columnNumber}`;
		return functionName ? `${functionName} (${location})` : location;
	}
	throw new FinalMutationTargetEvidenceError(
		"unregistered-adapter",
		"Could not determine the final mutation adapter source",
	);
}

/**
 * Server-owned allowlist for final production adapters. Tests and routes cannot
 * become trusted merely by choosing a source label: both the runtime function
 * identity and its generated/development production module path must match.
 */
export function isRegisteredFinalMutationTargetAdapterSource(source: string): boolean {
	if (typeof source !== "string") return false;
	const match = /^([^ (]+) \((.+)\)$/u.exec(source);
	if (!match) return false;
	const [, functionName, rawLocation] = match;
	const normalizedLocation = rawLocation.replace(/\\/g, "/");
	return REGISTERED_FINAL_ADAPTERS.some(adapter => (
		adapter.functionName === functionName
		&& adapter.source.test(normalizedLocation)
	));
}

function immutableRecord(record: FinalMutationTargetCaptureRecord): FinalMutationTargetCaptureRecord {
	return Object.freeze({ ...record });
}

function immutableEvidence(evidence: FinalMutationTargetAssertionEvidence): FinalMutationTargetAssertionEvidence {
	return Object.freeze({
		...evidence,
		attempts: Object.freeze(evidence.attempts.map(immutableRecord)),
	});
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateCaptureRecord(value: unknown): FinalMutationTargetCaptureRecord {
	if (!isPlainRecord(value) || !hasExactKeys(value, [
		"actionId",
		"adapterSource",
		"attempt",
		"capturedAt",
		"coverageItemId",
		"effectKind",
		"resolvedScope",
		"resolvedTarget",
	])) {
		throw new FinalMutationTargetEvidenceError("invalid-token", "Assertion contains a malformed capture record");
	}
	const attempt = requireTimestamp(value.attempt, "attempt");
	if (attempt < 1 || attempt > MAX_FINAL_MUTATION_TARGET_CAPTURE_ATTEMPTS) {
		throw new FinalMutationTargetEvidenceError("invalid-token", "Assertion capture attempt is outside the allowed range");
	}
	return immutableRecord({
		actionId: requireText(value.actionId, "actionId"),
		coverageItemId: requireText(value.coverageItemId, "coverageItemId"),
		resolvedTarget: requireText(value.resolvedTarget, "resolvedTarget", MAX_VALUE_BYTES),
		resolvedScope: requireText(value.resolvedScope, "resolvedScope", MAX_VALUE_BYTES),
		effectKind: requireText(value.effectKind, "effectKind"),
		attempt,
		capturedAt: requireTimestamp(value.capturedAt, "capturedAt"),
		adapterSource: requireText(value.adapterSource, "adapterSource", MAX_VALUE_BYTES),
	});
}

function validateAssertionEvidence(value: unknown): FinalMutationTargetAssertionEvidence {
	if (!isPlainRecord(value) || !hasExactKeys(value, [
		"actionId",
		"attempts",
		"baseOid",
		"commandId",
		"coverageItemId",
		"effectOutcome",
		"executionId",
		"expectedScope",
		"expectedTarget",
		"expiresAt",
		"headOid",
		"issuedAt",
		"nonce",
		"testId",
		"testKind",
		"version",
	])) {
		throw new FinalMutationTargetEvidenceError("invalid-token", "Malformed final mutation assertion payload");
	}
	if (value.version !== FINAL_MUTATION_TARGET_EVIDENCE_VERSION || value.effectOutcome !== "succeeded") {
		throw new FinalMutationTargetEvidenceError("invalid-token", "Unsupported assertion version or effect outcome");
	}
	if (value.testKind !== "integration" && value.testKind !== "browser") {
		throw new FinalMutationTargetEvidenceError("invalid-token", "Only integration and browser assertions are accepted");
	}
	if (!Array.isArray(value.attempts) || value.attempts.length === 0 || value.attempts.length > MAX_FINAL_MUTATION_TARGET_CAPTURE_ATTEMPTS) {
		throw new FinalMutationTargetEvidenceError("invalid-token", "Assertion must contain a bounded non-empty attempt list");
	}
	const attempts = value.attempts.map(validateCaptureRecord);
	attempts.forEach((attempt, index) => {
		if (attempt.attempt !== index + 1) {
			throw new FinalMutationTargetEvidenceError("invalid-token", "Assertion attempt sequence is not gap-free");
		}
	});
	const evidence = immutableEvidence({
		version: FINAL_MUTATION_TARGET_EVIDENCE_VERSION,
		nonce: requireText(value.nonce, "nonce"),
		executionId: requireText(value.executionId, "executionId"),
		commandId: requireText(value.commandId, "commandId"),
		testId: requireText(value.testId, "testId"),
		testKind: value.testKind,
		baseOid: requireOid(value.baseOid, "baseOid"),
		headOid: requireOid(value.headOid, "headOid"),
		actionId: requireText(value.actionId, "actionId"),
		coverageItemId: requireText(value.coverageItemId, "coverageItemId"),
		expectedTarget: requireText(value.expectedTarget, "expectedTarget", MAX_VALUE_BYTES),
		expectedScope: requireText(value.expectedScope, "expectedScope", MAX_VALUE_BYTES),
		effectOutcome: "succeeded",
		attempts,
		issuedAt: requireTimestamp(value.issuedAt, "issuedAt"),
		expiresAt: requireTimestamp(value.expiresAt, "expiresAt"),
	});
	if (evidence.expiresAt <= evidence.issuedAt) {
		throw new FinalMutationTargetEvidenceError("invalid-token", "Assertion expiry must be after issuance");
	}
	for (const attempt of evidence.attempts) {
		if (
			attempt.actionId !== evidence.actionId
			|| attempt.coverageItemId !== evidence.coverageItemId
			|| attempt.resolvedTarget !== evidence.expectedTarget
			|| attempt.resolvedScope !== evidence.expectedScope
			// Captures precede assertion issuance and must still fall within its
			// capability lifetime. A future capture would indicate a rewritten token.
			|| attempt.capturedAt > evidence.issuedAt
			|| attempt.capturedAt > evidence.expiresAt
		) {
			throw new FinalMutationTargetEvidenceError("invalid-token", "Assertion attempt does not match its signed invariant");
		}
	}
	return evidence;
}

export class FinalMutationTargetEvidenceBroker {
	private readonly signingKey: Buffer;
	private readonly now: () => number;
	private readonly randomBytes: (size: number) => Uint8Array;
	private readonly sessionsByCapability = new WeakMap<object, EvidenceSession>();
	private readonly sessionsByNonce = new Map<string, EvidenceSession>();
	private readonly consumedAssertionNonces = new Set<string>();

	constructor(options: FinalMutationTargetEvidenceBrokerOptions = {}) {
		const key = options.signingKey ?? cryptoRandomBytes(SIGNING_KEY_BYTES);
		if (!(key instanceof Uint8Array) || key.byteLength < SIGNING_KEY_BYTES) {
			throw new FinalMutationTargetEvidenceError(
				"invalid-binding",
				`Final mutation evidence signing key must contain at least ${SIGNING_KEY_BYTES} bytes`,
			);
		}
		this.signingKey = Buffer.from(key);
		this.now = options.now ?? Date.now;
		this.randomBytes = options.randomBytes ?? cryptoRandomBytes;
	}

	createCapability(binding: FinalMutationTargetEvidenceBinding): FinalMutationTargetEvidenceCapability {
		const now = this.checkedNow();
		const ttlMs = binding.ttlMs ?? DEFAULT_FINAL_MUTATION_TARGET_EVIDENCE_TTL_MS;
		if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
			throw new FinalMutationTargetEvidenceError("invalid-binding", "ttlMs must be a positive safe integer");
		}
		const expiresAt = now + ttlMs;
		if (!Number.isSafeInteger(expiresAt)) {
			throw new FinalMutationTargetEvidenceError("invalid-binding", "Capability expiry exceeds the safe integer range");
		}
		if (binding.testKind !== "integration" && binding.testKind !== "browser") {
			throw new FinalMutationTargetEvidenceError(
				"invalid-binding",
				"Final mutation target evidence is restricted to registered integration or browser tests",
			);
		}
		const normalizedBinding = Object.freeze({
			executionId: requireText(binding.executionId, "executionId"),
			commandId: requireText(binding.commandId, "commandId"),
			testId: requireText(binding.testId, "testId"),
			testKind: binding.testKind,
			baseOid: requireOid(binding.baseOid, "baseOid"),
			headOid: requireOid(binding.headOid, "headOid"),
			actionId: requireText(binding.actionId, "actionId"),
			coverageItemId: requireText(binding.coverageItemId, "coverageItemId"),
		});
		const nonce = copyRandomBytes(this.randomBytes, NONCE_BYTES, "Capability random source").toString("base64url");
		if (this.sessionsByNonce.has(nonce)) {
			throw new FinalMutationTargetEvidenceError("invalid-binding", "Capability random source produced a duplicate nonce");
		}
		const session: EvidenceSession = {
			binding: normalizedBinding,
			nonce,
			issuedAt: now,
			expiresAt,
			records: [],
			recordBytes: 0,
			status: "open",
		};
		const capability = Object.freeze({ [CAPABILITY_BRAND]: true }) as FinalMutationTargetEvidenceCapability;
		this.sessionsByCapability.set(capability, session);
		this.sessionsByNonce.set(nonce, session);
		this.pruneExpiredSessions(now);
		return capability;
	}

	runWithCapability<T>(capability: FinalMutationTargetEvidenceCapability, callback: () => T): T {
		const session = this.sessionsByCapability.get(capability);
		if (!session) {
			throw new FinalMutationTargetEvidenceError("invalid-capability", "Unknown final mutation target evidence capability");
		}
		this.requireOpenSession(session);
		return this.runWithSession(session, "harness", callback);
	}

	createQueueEnvelope(): SignedFinalMutationTargetQueueEnvelope | undefined {
		const store = this.currentStore(false);
		if (!store) return undefined;
		return Object.freeze({
			version: FINAL_MUTATION_TARGET_EVIDENCE_VERSION,
			token: this.mintCorrelationTokenForSession(store.session, "queue"),
		});
	}

	attachQueueEnvelope<T extends Record<string, unknown>>(payload: T): FinalMutationTargetQueuePayload<T> {
		const envelope = this.createQueueEnvelope();
		// Preserve identity and mutability outside verification. Queue serializers
		// may call this unconditionally without changing ordinary production jobs.
		if (!envelope) return payload;
		if (Object.prototype.hasOwnProperty.call(payload, FINAL_MUTATION_TARGET_QUEUE_ENVELOPE_KEY)) {
			throw new FinalMutationTargetEvidenceError(
				"reserved-envelope-collision",
				`Queue payload already contains reserved key ${FINAL_MUTATION_TARGET_QUEUE_ENVELOPE_KEY}`,
			);
		}
		return {
			...payload,
			[FINAL_MUTATION_TARGET_QUEUE_ENVELOPE_KEY]: envelope,
		} as FinalMutationTargetQueuePayload<T>;
	}

	runWithQueueEnvelope<T>(envelope: unknown, callback: () => T): T {
		if (
			!isPlainRecord(envelope)
			|| !hasExactKeys(envelope, ["token", "version"])
			|| envelope.version !== FINAL_MUTATION_TARGET_EVIDENCE_VERSION
			|| typeof envelope.token !== "string"
		) {
			throw new FinalMutationTargetEvidenceError("invalid-token", "Malformed final mutation queue envelope");
		}
		return this.runWithCorrelation(envelope.token, "queue", callback);
	}

	mintCrossProcessToken(): string | undefined {
		const store = this.currentStore(false);
		if (!store) return undefined;
		return this.mintCorrelationTokenForSession(store.session, "cross-process");
	}

	runWithCrossProcessToken<T>(token: unknown, callback: () => T): T {
		if (typeof token !== "string") {
			throw new FinalMutationTargetEvidenceError("invalid-token", "Missing final mutation cross-process token");
		}
		return this.runWithCorrelation(token, "cross-process", callback);
	}

	async assertCaptured<T>(input: AssertCapturedFinalMutationTargetInput<T>): Promise<CapturedFinalMutationTargetAssertion<T>> {
		const store = this.currentStore(true);
		const session = store.session;
		this.requireOpenSession(session);
		const actionId = requireText(input.actionId, "actionId");
		const expectedTarget = requireText(input.expectedTarget, "expectedTarget", MAX_VALUE_BYTES);
		const expectedScope = requireText(input.expectedScope, "expectedScope", MAX_VALUE_BYTES);
		if (typeof input.invoke !== "function") {
			throw new FinalMutationTargetEvidenceError("invalid-binding", "invoke must be a function");
		}
		if (actionId !== session.binding.actionId) {
			throw new FinalMutationTargetEvidenceError(
				"capture-binding-mismatch",
				"Assertion actionId does not match the harness-issued capability",
			);
		}
		if (session.records.length !== 0) {
			throw new FinalMutationTargetEvidenceError(
				"concurrent-assertion",
				"Capture records existed before the asserted invocation began",
			);
		}
		session.status = "asserting";
		let value: T;
		try {
			value = await input.invoke();
		} catch (error) {
			session.status = "failed";
			throw error;
		}
		// Close capture synchronously after the awaited invocation. A late callback
		// cannot append evidence after the invariant has been checked and signed.
		session.status = "asserted";
		if (session.records.length === 0) {
			throw new FinalMutationTargetEvidenceError(
				"missing-capture",
				"Invocation completed without a capture from a final mutation adapter",
			);
		}
		for (const record of session.records) {
			if (record.resolvedTarget !== expectedTarget) {
				throw new FinalMutationTargetEvidenceError(
					"target-mismatch",
					`Captured mutation target did not match on attempt ${record.attempt}`,
				);
			}
			if (record.resolvedScope !== expectedScope) {
				throw new FinalMutationTargetEvidenceError(
					"scope-mismatch",
					`Captured mutation scope did not match on attempt ${record.attempt}`,
				);
			}
		}
		const issuedAt = this.checkedNow();
		const evidence = immutableEvidence({
			version: FINAL_MUTATION_TARGET_EVIDENCE_VERSION,
			nonce: session.nonce,
			...session.binding,
			expectedTarget,
			expectedScope,
			effectOutcome: "succeeded",
			attempts: session.records,
			issuedAt,
			expiresAt: session.expiresAt,
		});
		if (issuedAt >= evidence.expiresAt) {
			session.status = "failed";
			throw new FinalMutationTargetEvidenceError("expired-context", "Final mutation assertion capability expired during invocation");
		}
		const assertionToken = this.encodeSigned("assertion", evidence);
		session.assertionToken = assertionToken;
		return Object.freeze({ value, assertionToken, evidence });
	}

	consumeAssertion(
		token: unknown,
		expected: FinalMutationTargetAssertionExpectation,
	): FinalMutationTargetAssertionEvidence {
		if (typeof token !== "string") {
			throw new FinalMutationTargetEvidenceError("invalid-token", "Missing final mutation target assertion token");
		}
		const evidence = validateAssertionEvidence(this.decodeSigned(token, "assertion"));
		const now = this.checkedNow();
		if (evidence.issuedAt > now + FUTURE_SKEW_MS || now > evidence.expiresAt) {
			throw new FinalMutationTargetEvidenceError("invalid-token", "Final mutation target assertion is expired or future-issued");
		}
		if (this.consumedAssertionNonces.has(evidence.nonce)) {
			throw new FinalMutationTargetEvidenceError("replayed-assertion", "Final mutation target assertion was already consumed");
		}
		const session = this.sessionsByNonce.get(evidence.nonce);
		if (!session || !session.assertionToken || !safeEqual(session.assertionToken, token)) {
			throw new FinalMutationTargetEvidenceError("invalid-token", "Assertion was not issued by an active evidence capability");
		}
		this.assertExpectedBinding(evidence, expected);
		for (const attempt of evidence.attempts) {
			let registered = false;
			try {
				registered = expected.isRegisteredFinalAdapterSource(attempt.adapterSource) === true;
			} catch {
				registered = false;
			}
			if (!registered) {
				throw new FinalMutationTargetEvidenceError(
					"unregistered-adapter",
					`Capture attempt ${attempt.attempt} did not originate from a registered final production adapter`,
				);
			}
		}
		this.consumedAssertionNonces.add(evidence.nonce);
		session.status = "consumed";
		this.sessionsByNonce.delete(evidence.nonce);
		return evidence;
	}

	/** Called only through the module-level adapter API while this broker owns the active context. */
	capture(input: CaptureFinalMutationTargetInput): FinalMutationTargetCaptureRecord | undefined {
		const store = this.currentStore(false);
		if (!store) return undefined;
		const session = store.session;
		if (store.channel === "harness") {
			throw new FinalMutationTargetEvidenceError(
				"uncorrelated-capture",
				"Final mutation capture did not cross a signed queue or process boundary",
			);
		}
		if (session.status !== "asserting") {
			throw new FinalMutationTargetEvidenceError(
				"closed-context",
				"Final mutation capture occurred outside the asserted invocation",
			);
		}
		if (this.checkedNow() > session.expiresAt) {
			session.status = "failed";
			throw new FinalMutationTargetEvidenceError("expired-context", "Final mutation target evidence capability expired");
		}
		const actionId = input.actionId === undefined ? session.binding.actionId : requireText(input.actionId, "actionId");
		const coverageItemId = input.coverageItemId === undefined ? session.binding.coverageItemId : requireText(input.coverageItemId, "coverageItemId");
		if (actionId !== session.binding.actionId || coverageItemId !== session.binding.coverageItemId) {
			session.status = "failed";
			throw new FinalMutationTargetEvidenceError(
				"capture-binding-mismatch",
				"Final adapter action or coverage item did not match the correlated capability",
			);
		}
		if (session.records.length >= MAX_FINAL_MUTATION_TARGET_CAPTURE_ATTEMPTS) {
			session.status = "failed";
			throw new FinalMutationTargetEvidenceError("capture-limit", "Final mutation target capture attempt limit exceeded");
		}
		const record = immutableRecord({
			actionId,
			coverageItemId,
			resolvedTarget: requireText(input.resolvedTarget, "resolvedTarget", MAX_VALUE_BYTES),
			resolvedScope: requireText(input.resolvedScope, "resolvedScope", MAX_VALUE_BYTES),
			effectKind: requireText(input.effectKind, "effectKind"),
			attempt: session.records.length + 1,
			capturedAt: this.checkedNow(),
			adapterSource: captureAdapterSource(),
		});
		const recordBytes = byteLength(JSON.stringify(record));
		if (session.recordBytes + recordBytes > MAX_CAPTURE_EVIDENCE_BYTES) {
			session.status = "failed";
			throw new FinalMutationTargetEvidenceError(
				"capture-limit",
				"Final mutation target capture evidence exceeds its signed assertion budget",
			);
		}
		session.records.push(record);
		session.recordBytes += recordBytes;
		return record;
	}

	private runWithCorrelation<T>(token: string, audience: FinalMutationTargetCorrelationAudience, callback: () => T): T {
		const claims = this.validateCorrelationClaims(this.decodeSigned(token, "correlation"), audience);
		const session = this.sessionsByNonce.get(claims.nonce);
		if (
			!session
			|| claims.actionId !== session.binding.actionId
			|| claims.coverageItemId !== session.binding.coverageItemId
			|| claims.expiresAt !== session.expiresAt
		) {
			throw new FinalMutationTargetEvidenceError("token-binding-mismatch", "Correlation token does not match an active capability");
		}
		if (claims.issuedAt < session.issuedAt || claims.issuedAt > this.checkedNow() + FUTURE_SKEW_MS) {
			throw new FinalMutationTargetEvidenceError("invalid-token", "Correlation token has an invalid issuance time");
		}
		this.requireAssertingSession(session);
		return this.runWithSession(session, audience, callback);
	}

	private runWithSession<T>(
		session: EvidenceSession,
		channel: "harness" | FinalMutationTargetCorrelationAudience,
		callback: () => T,
	): T {
		if (typeof callback !== "function") {
			throw new FinalMutationTargetEvidenceError("invalid-binding", "Evidence context callback must be a function");
		}
		const current = evidenceContext.getStore();
		if (current) {
			if (current.broker !== this || current.session !== session) {
				throw new FinalMutationTargetEvidenceError("invalid-capability", "Cannot nest distinct final mutation evidence capabilities");
			}
			if (current.channel === channel) return callback();
		}
		return evidenceContext.run({ broker: this, session, channel }, callback);
	}

	private currentStore(required: true): EvidenceContextStore;
	private currentStore(required: false): EvidenceContextStore | undefined;
	private currentStore(required: boolean): EvidenceContextStore | undefined {
		const store = evidenceContext.getStore();
		if (!store || store.broker !== this) {
			if (required) {
				throw new FinalMutationTargetEvidenceError("missing-context", "No final mutation target evidence capability is active");
			}
			return undefined;
		}
		return store;
	}

	private requireOpenSession(session: EvidenceSession): void {
		if (this.checkedNow() > session.expiresAt) {
			session.status = "failed";
			throw new FinalMutationTargetEvidenceError("expired-context", "Final mutation target evidence capability expired");
		}
		if (session.status !== "open") {
			throw new FinalMutationTargetEvidenceError("closed-context", `Evidence capability is ${session.status}`);
		}
	}

	private requireOpenOrAssertingSession(session: EvidenceSession): void {
		if (this.checkedNow() > session.expiresAt) {
			session.status = "failed";
			throw new FinalMutationTargetEvidenceError("expired-context", "Final mutation target evidence capability expired");
		}
		if (session.status !== "open" && session.status !== "asserting") {
			throw new FinalMutationTargetEvidenceError("closed-context", `Evidence capability is ${session.status}`);
		}
	}

	private requireAssertingSession(session: EvidenceSession): void {
		this.requireOpenOrAssertingSession(session);
		if (session.status !== "asserting") {
			throw new FinalMutationTargetEvidenceError(
				"closed-context",
				"Correlation tokens can be minted only during the asserted invocation",
			);
		}
	}

	private mintCorrelationTokenForSession(
		session: EvidenceSession,
		audience: FinalMutationTargetCorrelationAudience,
	): string {
		// A token minted while merely `open` could be retained and replayed into a
		// later assertion. Mint only after the helper has started this single-use
		// invocation; retries within that invocation intentionally share it.
		this.requireAssertingSession(session);
		const claims: CorrelationClaims = {
			version: FINAL_MUTATION_TARGET_EVIDENCE_VERSION,
			purpose: "correlation",
			audience,
			tokenId: copyRandomBytes(this.randomBytes, TOKEN_ID_BYTES, "Correlation random source").toString("base64url"),
			nonce: session.nonce,
			actionId: session.binding.actionId,
			coverageItemId: session.binding.coverageItemId,
			issuedAt: this.checkedNow(),
			expiresAt: session.expiresAt,
		};
		return this.encodeSigned("correlation", claims);
	}

	private validateCorrelationClaims(value: unknown, audience: FinalMutationTargetCorrelationAudience): CorrelationClaims {
		if (!isPlainRecord(value) || !hasExactKeys(value, [
			"actionId",
			"audience",
			"coverageItemId",
			"expiresAt",
			"issuedAt",
			"nonce",
			"purpose",
			"tokenId",
			"version",
		])) {
			throw new FinalMutationTargetEvidenceError("invalid-token", "Malformed final mutation correlation token");
		}
		if (
			value.version !== FINAL_MUTATION_TARGET_EVIDENCE_VERSION
			|| value.purpose !== "correlation"
			|| value.audience !== audience
		) {
			throw new FinalMutationTargetEvidenceError("invalid-token", "Correlation token version, purpose, or audience mismatch");
		}
		const claims: CorrelationClaims = {
			version: FINAL_MUTATION_TARGET_EVIDENCE_VERSION,
			purpose: "correlation",
			audience,
			tokenId: requireText(value.tokenId, "tokenId"),
			nonce: requireText(value.nonce, "nonce"),
			actionId: requireText(value.actionId, "actionId"),
			coverageItemId: requireText(value.coverageItemId, "coverageItemId"),
			issuedAt: requireTimestamp(value.issuedAt, "issuedAt"),
			expiresAt: requireTimestamp(value.expiresAt, "expiresAt"),
		};
		const now = this.checkedNow();
		if (claims.expiresAt <= claims.issuedAt || claims.issuedAt > now + FUTURE_SKEW_MS || now > claims.expiresAt) {
			throw new FinalMutationTargetEvidenceError("invalid-token", "Correlation token is expired or future-issued");
		}
		return claims;
	}

	private assertExpectedBinding(
		evidence: FinalMutationTargetAssertionEvidence,
		expected: FinalMutationTargetAssertionExpectation,
	): void {
		if (typeof expected?.isRegisteredFinalAdapterSource !== "function") {
			throw new FinalMutationTargetEvidenceError("invalid-binding", "A registered final-adapter source validator is required");
		}
		const expectedBinding = {
			executionId: requireText(expected.executionId, "executionId"),
			commandId: requireText(expected.commandId, "commandId"),
			testId: requireText(expected.testId, "testId"),
			testKind: expected.testKind,
			baseOid: requireOid(expected.baseOid, "baseOid"),
			headOid: requireOid(expected.headOid, "headOid"),
			actionId: requireText(expected.actionId, "actionId"),
			coverageItemId: requireText(expected.coverageItemId, "coverageItemId"),
		};
		if (expectedBinding.testKind !== "integration" && expectedBinding.testKind !== "browser") {
			throw new FinalMutationTargetEvidenceError("invalid-binding", "Expected test kind must be integration or browser");
		}
		for (const key of Object.keys(expectedBinding) as Array<keyof typeof expectedBinding>) {
			if (evidence[key] !== expectedBinding[key]) {
				throw new FinalMutationTargetEvidenceError(
					"token-binding-mismatch",
					`Final mutation target assertion ${key} did not match the registered run`,
				);
			}
		}
	}

	private encodeSigned(purpose: "correlation" | "assertion", value: unknown): string {
		const body = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
		const signature = this.sign(purpose, body);
		const token = `${TOKEN_PREFIX}.${body}.${signature}`;
		if (byteLength(token) > MAX_TOKEN_BYTES) {
			throw new FinalMutationTargetEvidenceError("invalid-token", "Final mutation target evidence token exceeds its size limit");
		}
		return token;
	}

	private decodeSigned(token: string, purpose: "correlation" | "assertion"): unknown {
		if (byteLength(token) > MAX_TOKEN_BYTES) {
			throw new FinalMutationTargetEvidenceError("invalid-token", "Final mutation target evidence token exceeds its size limit");
		}
		const parts = token.split(".");
		if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) {
			throw new FinalMutationTargetEvidenceError("invalid-token", "Malformed final mutation target evidence token");
		}
		const expected = this.sign(purpose, parts[1]);
		if (!safeEqual(parts[2], expected)) {
			throw new FinalMutationTargetEvidenceError("invalid-token", "Invalid final mutation target evidence signature");
		}
		try {
			const bytes = Buffer.from(parts[1], "base64url");
			if (bytes.toString("base64url") !== parts[1]) throw new Error("non-canonical base64url");
			return JSON.parse(bytes.toString("utf8")) as unknown;
		} catch {
			throw new FinalMutationTargetEvidenceError("invalid-token", "Invalid final mutation target evidence payload");
		}
	}

	private sign(purpose: "correlation" | "assertion", body: string): string {
		return createHmac("sha256", this.signingKey)
			.update(FINAL_MUTATION_TARGET_EVIDENCE_VERSION, "utf8")
			.update("\0", "utf8")
			.update(purpose, "utf8")
			.update("\0", "utf8")
			.update(body, "ascii")
			.digest("base64url");
	}

	private checkedNow(): number {
		const now = this.now();
		if (!Number.isSafeInteger(now) || now < 0) {
			throw new FinalMutationTargetEvidenceError("invalid-binding", "Evidence clock returned an invalid timestamp");
		}
		return now;
	}

	private pruneExpiredSessions(now: number): void {
		for (const [nonce, session] of this.sessionsByNonce) {
			if (session.expiresAt < now && session.status !== "asserting") {
				session.status = "failed";
				this.sessionsByNonce.delete(nonce);
			}
		}
	}
}

export interface RegisteredFinalMutationTargetAssertion {
	readonly assertionId: string;
	readonly evidence: FinalMutationTargetAssertionEvidence;
	readonly registeredAt: number;
}

export interface FinalMutationTargetAssertionRegistryExpectation {
	readonly executionId: string;
	readonly baseOid: string;
	readonly headOid: string;
	readonly actionId: string;
	readonly coverageItemId: string;
}

interface RegisteredAssertionRecord extends RegisteredFinalMutationTargetAssertion {
	readonly token: string;
	consumedExpectation?: string;
}

function registryExpectationKey(expected: FinalMutationTargetAssertionRegistryExpectation): string {
	return [
		requireText(expected.executionId, "executionId"),
		requireOid(expected.baseOid, "baseOid"),
		requireOid(expected.headOid, "headOid"),
		requireText(expected.actionId, "actionId"),
		requireText(expected.coverageItemId, "coverageItemId"),
	].join("\0");
}

/**
 * Harness-owned assertion registry. Reviewers receive only the random assertion
 * id; the signed token and registered command/test bindings never cross into the
 * review submission. Consumption is idempotent only for the identical immutable
 * expectation, so a correctable final-synthesis retry cannot burn valid proof
 * while cross-action, cross-coverage, and cross-execution replay still fails.
 */
export class FinalMutationTargetAssertionRegistry {
	private readonly assertions = new Map<string, RegisteredAssertionRecord>();

	constructor(
		private readonly broker: FinalMutationTargetEvidenceBroker,
		private readonly isRegisteredFinalAdapterSource: (source: string) => boolean = isRegisteredFinalMutationTargetAdapterSource,
		private readonly now: () => number = Date.now,
		private readonly createId: () => string = randomUUID,
	) {}

	register<T>(assertion: CapturedFinalMutationTargetAssertion<T>): RegisteredFinalMutationTargetAssertion {
		if (!assertion || typeof assertion.assertionToken !== "string" || !assertion.evidence) {
			throw new FinalMutationTargetEvidenceError("invalid-token", "A broker-issued final mutation assertion is required");
		}
		const assertionId = `target-assertion:${this.createId()}`;
		if (this.assertions.has(assertionId)) {
			throw new FinalMutationTargetEvidenceError("invalid-binding", "Assertion id source produced a duplicate identifier");
		}
		const record: RegisteredAssertionRecord = {
			assertionId,
			token: assertion.assertionToken,
			evidence: assertion.evidence,
			registeredAt: this.now(),
		};
		this.assertions.set(assertionId, record);
		return Object.freeze({ assertionId, evidence: record.evidence, registeredAt: record.registeredAt });
	}

	validateAndConsume(
		assertionId: string,
		expected: FinalMutationTargetAssertionRegistryExpectation,
	): boolean {
		const record = this.assertions.get(assertionId);
		if (!record) return false;
		let expectationKey: string;
		try {
			expectationKey = registryExpectationKey(expected);
		} catch {
			return false;
		}
		if (record.consumedExpectation !== undefined) return safeEqual(record.consumedExpectation, expectationKey);
		const evidence = record.evidence;
		try {
			consumeFinalMutationTargetAssertion(this.broker, record.token, {
				executionId: expected.executionId,
				commandId: evidence.commandId,
				testId: evidence.testId,
				testKind: evidence.testKind,
				baseOid: expected.baseOid,
				headOid: expected.headOid,
				actionId: expected.actionId,
				coverageItemId: expected.coverageItemId,
				isRegisteredFinalAdapterSource: this.isRegisteredFinalAdapterSource,
			});
			record.consumedExpectation = expectationKey;
			return true;
		} catch {
			return false;
		}
	}

	discardExecution(executionId: string): void {
		for (const [assertionId, record] of this.assertions) {
			if (record.evidence.executionId === executionId) this.assertions.delete(assertionId);
		}
	}
}

/**
 * Harness-only capability creation. The harness retains its broker as the signing
 * authority; a separately constructed broker cannot mint an assertion that the
 * harness broker will consume.
 */
export function createFinalMutationTargetEvidenceCapability(
	broker: FinalMutationTargetEvidenceBroker,
	binding: FinalMutationTargetEvidenceBinding,
): FinalMutationTargetEvidenceCapability {
	return broker.createCapability(binding);
}

/** Install an in-process AsyncLocalStorage correlation for an asserted test invocation. */
export function runWithFinalMutationTargetEvidenceCapability<T>(
	broker: FinalMutationTargetEvidenceBroker,
	capability: FinalMutationTargetEvidenceCapability,
	callback: () => T,
): T {
	return broker.runWithCapability(capability, callback);
}

/**
 * Called by a production final-effect adapter immediately before the effect.
 * Returns undefined outside a harness-issued test correlation and never changes
 * normal production behavior.
 */
export function captureFinalMutationTarget(
	input: CaptureFinalMutationTargetInput,
): FinalMutationTargetCaptureRecord | undefined {
	const store = evidenceContext.getStore();
	return store?.broker.capture(input);
}

/** Test helper: the caller supplies only the invariant and invocation, never actual values. */
export async function assertCapturedFinalMutationTarget<T>(
	input: AssertCapturedFinalMutationTargetInput<T>,
): Promise<CapturedFinalMutationTargetAssertion<T>> {
	const store = evidenceContext.getStore();
	if (!store) {
		throw new FinalMutationTargetEvidenceError("missing-context", "No final mutation target evidence capability is active");
	}
	return store.broker.assertCaptured(input);
}

/** Add the reserved signed correlation envelope without mutating the original job payload. */
export function attachFinalMutationTargetQueueEnvelope<T extends Record<string, unknown>>(
	payload: T,
): FinalMutationTargetQueuePayload<T> {
	const store = evidenceContext.getStore();
	return store ? store.broker.attachQueueEnvelope(payload) : payload;
}

/** Restore a queue/job correlation using the runner-owned signing authority. */
export function runWithFinalMutationTargetQueueEnvelope<T>(
	broker: FinalMutationTargetEvidenceBroker,
	envelope: unknown,
	callback: () => T,
): T {
	return broker.runWithQueueEnvelope(envelope, callback);
}

/** Mint the opaque value propagated through the test-only browser/process header. */
export function mintFinalMutationTargetCrossProcessToken(): string | undefined {
	return evidenceContext.getStore()?.broker.mintCrossProcessToken();
}

/** Restore a browser/process correlation using the runner-owned signing authority. */
export function runWithFinalMutationTargetCrossProcessToken<T>(
	broker: FinalMutationTargetEvidenceBroker,
	token: unknown,
	callback: () => T,
): T {
	return broker.runWithCrossProcessToken(token, callback);
}

/** Consume once and bind the signed assertion to server-owned registered-run metadata. */
export function consumeFinalMutationTargetAssertion(
	broker: FinalMutationTargetEvidenceBroker,
	token: unknown,
	expected: FinalMutationTargetAssertionExpectation,
): FinalMutationTargetAssertionEvidence {
	return broker.consumeAssertion(token, expected);
}
