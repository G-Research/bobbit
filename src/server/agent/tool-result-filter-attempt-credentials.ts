import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = "v1";
const MAX_AGE_MS = 10_000;
const MAX_FUTURE_SKEW_MS = 1_000;
const TOKEN_RE = /^v1\.([0-9a-z]+)\.([0-9a-f-]{36})\.([0-9a-f]{64})$/;

export interface ToolResultFilterGateCredential {
	runtimeGeneration: number;
	/** One-shot private bootstrap input; never put this in env or mounted source. */
	runtimeKey: string;
}

/**
 * Server-only owner for the private Pi result-gate callback credential.
 *
 * The generated gate receives the key in its core-loader source, derives one
 * HMAC-bound token per tool attempt, and sends only that one-use token to the
 * callback. It is valid only for the live server runtime and is never placed
 * in an environment variable, trace, transcript, log, or client response.
 */
export class ToolResultFilterAttemptCredentials {
	private readonly runtimes = new Map<string, ToolResultFilterGateCredential>();
	/** Bounded by the short credential lifetime; values are expiry timestamps. */
	private readonly consumed = new Map<string, number>();

	beginRuntime(sessionId: string, runtimeGeneration: number): ToolResultFilterGateCredential {
		const credential = Object.freeze({ runtimeGeneration, runtimeKey: randomBytes(32).toString("hex") });
		this.runtimes.set(sessionId, credential);
		// A fresh runtime cannot replay a completed attempt from its predecessor.
		for (const key of this.consumed.keys()) if (key.startsWith(`${sessionId}\u0000`)) this.consumed.delete(key);
		return credential;
	}

	/**
	 * Exact core-owned activation signal for the currently spawned Pi runtime.
	 * It is set only by beginRuntime while the private bootstrap is assembled,
	 * never by a callback/client claim.
	 */
	hasRuntime(sessionId: string): boolean {
		return this.runtimes.has(sessionId);
	}

	/** Invalidate a runtime before replacement, abort teardown, or termination. */
	invalidate(sessionId: string): void {
		this.runtimes.delete(sessionId);
		for (const key of this.consumed.keys()) if (key.startsWith(`${sessionId}\u0000`)) this.consumed.delete(key);
	}

	/**
	 * Verify and atomically consume a private gate token. False means no route
	 * work beyond synthetic rejection: callers must not admit, dispatch, or audit.
	 */
	consume(sessionId: string, toolCallId: unknown, presented: string | string[] | undefined, now = Date.now()): boolean {
		if (typeof toolCallId !== "string" || !toolCallId || typeof presented !== "string" || presented.length > 256) return false;
		const runtime = this.runtimes.get(sessionId);
		if (!runtime) return false;
		const parsed = TOKEN_RE.exec(presented);
		if (!parsed) return false;
		const [, issuedBase36, attemptId, signature] = parsed;
		const issuedAt = Number.parseInt(issuedBase36, 36);
		if (!Number.isSafeInteger(issuedAt) || issuedAt > now + MAX_FUTURE_SKEW_MS || now - issuedAt > MAX_AGE_MS) return false;
		const expected = sign(runtime.runtimeKey, sessionId, runtime.runtimeGeneration, toolCallId, issuedBase36, attemptId);
		if (!constantTimeEqual(signature, expected)) return false;
		for (const [key, expiry] of this.consumed) if (expiry <= now) this.consumed.delete(key);
		const key = `${sessionId}\u0000${signature}`;
		if (this.consumed.has(key)) return false;
		// JavaScript runs this synchronous section to completion: this is the
		// linearization point before any asynchronous worker/admission work.
		this.consumed.set(key, issuedAt + MAX_AGE_MS);
		return true;
	}
}

/** Used only by the generated private gate; exported for focused tests. */
export function createToolResultFilterAttemptToken(
	credential: ToolResultFilterGateCredential,
	sessionId: string,
	toolCallId: string,
	attemptId: string,
	issuedAt = Date.now(),
): string {
	const issuedBase36 = issuedAt.toString(36);
	return `${VERSION}.${issuedBase36}.${attemptId}.${sign(credential.runtimeKey, sessionId, credential.runtimeGeneration, toolCallId, issuedBase36, attemptId)}`;
}

function sign(key: string, sessionId: string, generation: number, toolCallId: string, issuedBase36: string, attemptId: string): string {
	return createHmac("sha256", key).update(`${VERSION}\u0000${sessionId}\u0000${generation}\u0000${toolCallId}\u0000${issuedBase36}\u0000${attemptId}`, "utf8").digest("hex");
}

function constantTimeEqual(actual: string, expected: string): boolean {
	try {
		const left = Buffer.from(actual, "hex");
		const right = Buffer.from(expected, "hex");
		return left.length === right.length && timingSafeEqual(left, right);
	} catch { return false; }
}
