import { createHash } from "node:crypto";
import { redactSensitive } from "../auth/redact.js";

/**
 * A host-owned deadline is the only cancellation budget a lifecycle delivery may
 * consume. The absolute timestamp crosses the worker boundary; `signal` stays
 * local to the process that owns it.
 */
export interface LifecycleDeadline {
	readonly deadlineEpochMs: number;
	readonly signal: AbortSignal;
	remainingMs(now?: number): number;
	isExpired(now?: number): boolean;
	dispose(): void;
}

export type LifecycleDeliveryState = "completed" | "duplicate" | "retryable" | "terminal" | "timed_out" | "aborted";

export interface LifecycleDeliveryResult {
	state: LifecycleDeliveryState;
	/** The original in-flight delivery's settled result, when this call was coalesced. */
	original?: Exclude<LifecycleDeliveryState, "duplicate">;
	/** Bounded, redacted failure detail for host diagnostics; never raw provider data. */
	error?: string;
}

/** The subset of the host store needed to make a lifecycle delivery durable. */
export interface LifecycleDeliveryStore {
	read(key: string): Promise<
		| { state: "absent" }
		| { state: "present"; value: unknown }
		| { state: "error"; diagnostic: { code: string; retryable: boolean } }
	>;
	put(key: string, value: unknown): Promise<unknown>;
}

export interface DeliverLifecycleOptions {
	/** Stable host-owned event identity; it must not contain provider content. */
	key: string;
	deadline: LifecycleDeadline;
	store?: LifecycleDeliveryStore;
	deliver: (signal: AbortSignal) => Promise<void>;
}

const DELIVERY_PREFIX = "__host/lifecycle-delivery/";
const inFlight = new Map<string, Promise<LifecycleDeliveryResult>>();

/**
 * Construct a deadline that honours both a local timeout and an upstream abort.
 * The parent owns this controller; workers receive only `deadlineEpochMs` and
 * derive a local signal from it.
 */
export function createLifecycleDeadline(timeoutMs: number, upstream?: AbortSignal): LifecycleDeadline {
	const bounded = Number.isFinite(timeoutMs) ? Math.max(0, Math.floor(timeoutMs)) : 0;
	const deadlineEpochMs = Date.now() + bounded;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const abortTimeout = (): void => controller.abort(new Error("lifecycle deadline exceeded"));
	const forwardAbort = (): void => controller.abort(upstream?.reason);
	if (upstream?.aborted) forwardAbort();
	else if (upstream) upstream.addEventListener("abort", forwardAbort, { once: true });
	if (!controller.signal.aborted) {
		if (bounded === 0) abortTimeout();
		else timer = setTimeout(abortTimeout, bounded);
	}
	return {
		deadlineEpochMs,
		signal: controller.signal,
		remainingMs: (now = Date.now()) => Math.max(0, deadlineEpochMs - now),
		isExpired: (now = Date.now()) => controller.signal.aborted || now >= deadlineEpochMs,
		dispose: () => {
			if (timer) clearTimeout(timer);
			upstream?.removeEventListener("abort", forwardAbort);
		},
	};
}

/**
 * Suppress concurrent and restart/replay lifecycle delivery. The durable marker
 * is written only after `deliver` succeeds and the deadline fence is still open;
 * a timeout, abort, or failed marker write can therefore never look committed.
 */
export async function deliverLifecycleOnce(options: DeliverLifecycleOptions): Promise<LifecycleDeliveryResult> {
	const markerKey = lifecycleDeliveryMarkerKey(options.key);
	const running = inFlight.get(markerKey);
	if (running) {
		const result = await running;
		// Coalescing only suppresses a delivery which actually completed. A failed
		// owner wrote no marker, so hiding its outcome as a duplicate would falsely
		// report success and prevent callers from logging or retrying the work.
		if (result.state !== "completed" && result.state !== "duplicate") return result;
		return { state: "duplicate", original: result.state === "duplicate" ? undefined : result.state };
	}
	const operation = runDelivery(markerKey, options);
	inFlight.set(markerKey, operation);
	try {
		return await operation;
	} finally {
		if (inFlight.get(markerKey) === operation) inFlight.delete(markerKey);
	}
}

/** Stable bounded store key without exposing an arbitrary event identifier. */
export function lifecycleDeliveryMarkerKey(key: string): string {
	const digest = createHash("sha256").update(key).digest("hex");
	return `${DELIVERY_PREFIX}${digest}`;
}

async function runDelivery(markerKey: string, options: DeliverLifecycleOptions): Promise<LifecycleDeliveryResult> {
	if (options.deadline.signal.aborted) return deadlineState(options.deadline);
	if (options.store) {
		let previous: Awaited<ReturnType<LifecycleDeliveryStore["read"]>>;
		try {
			previous = await options.store.read(markerKey);
		} catch (error) {
			return classifyFailure(error);
		}
		if (options.deadline.signal.aborted) return deadlineState(options.deadline);
		if (previous.state === "present") return { state: "duplicate" };
		if (previous.state === "error") return { state: previous.diagnostic.retryable ? "retryable" : "terminal" };
	}
	try {
		await options.deliver(options.deadline.signal);
	} catch (error) {
		return options.deadline.signal.aborted ? deadlineState(options.deadline) : classifyFailure(error);
	}
	if (options.deadline.signal.aborted) return deadlineState(options.deadline);
	if (!options.store) return { state: "completed" };
	try {
		// The marker is the commit fence: no durable "completed" result is exposed
		// until the provider work and marker write both return before the deadline.
		await options.store.put(markerKey, { version: 1, completedAt: Date.now() });
		return options.deadline.signal.aborted ? deadlineState(options.deadline) : { state: "completed" };
	} catch (error) {
		return options.deadline.signal.aborted ? deadlineState(options.deadline) : classifyFailure(error);
	}
}

function deadlineState(deadline: LifecycleDeadline): LifecycleDeliveryResult {
	return { state: Date.now() >= deadline.deadlineEpochMs ? "timed_out" : "aborted" };
}

function classifyFailure(error: unknown): LifecycleDeliveryResult {
	const status = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
	const detail = lifecycleFailureDiagnostic(error);
	if (status === 408 || status === 504) return { state: "timed_out", error: detail };
	if (status === 499) return { state: "aborted", error: detail };
	if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) return { state: "terminal", error: detail };
	return { state: "retryable", error: detail };
}

/** Keep provider-owned failure text safe for a bounded host diagnostic. */
function lifecycleFailureDiagnostic(error: unknown): string {
	let message: string;
	try {
		message = error instanceof Error ? error.message : String(error);
	} catch {
		return "unknown lifecycle delivery failure";
	}
	const normalized = redactSensitive(message)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	return normalized.slice(0, 500) || "unknown lifecycle delivery failure";
}
