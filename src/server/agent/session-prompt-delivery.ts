import type { MessageAuthor } from "../../shared/message-author.js";
import type { ErroredPromptRecoveryDecision, PromptSource } from "./session-manager.js";

export type SessionPromptMode = "prompt" | "steer";

export interface DeliverableSessionLike {
	id: string;
	status: string;
	nonInteractive?: boolean;
	title?: string;
	lastTurnErrored?: boolean;
}

export interface DeliverSessionPromptDeps {
	getSession(id: string): DeliverableSessionLike | undefined;
	enqueuePrompt(
		id: string,
		message: string,
		opts?: { isSteered?: boolean; source?: PromptSource; author?: MessageAuthor },
	): Promise<{ status: "dispatched" | "queued" }>;
	deliverLiveSteer(id: string, message: string, opts?: { source?: PromptSource; author?: MessageAuthor }): Promise<unknown>;
	getErroredPromptRecoveryDecision?(id: string): ErroredPromptRecoveryDecision;
	enqueuePromptForRetryRecovery?(
		id: string,
		message: string,
		opts?: { isSteered?: boolean; source?: PromptSource; author?: MessageAuthor },
	): Promise<{ status: "queued"; queuedId?: string }> | { status: "queued"; queuedId?: string };
	retryLastPrompt?(id: string, opts?: { auto?: boolean; preserveQueueIds?: string[] }): Promise<void>;
}

export interface DeliverSessionPromptOptions {
	mode?: SessionPromptMode;
	defaultMode: SessionPromptMode;
	allowPromptNonInteractive?: boolean;
	source?: PromptSource;
	/** Trusted author resolved by the server; never accepted from browser payloads. */
	author?: MessageAuthor;
}

export interface DeliverSessionPromptTarget {
	sessionId: string;
	title?: string;
}

export type DeliverSessionPromptRecovery = {
	status: "recovered";
	reason: ErroredPromptRecoveryDecision["reason"];
	queued: boolean;
	queuedId?: string;
};

export type DeliverSessionPromptResult =
	| { ok: true; mode: SessionPromptMode; status: "dispatched" | "queued"; target: DeliverSessionPromptTarget }
	| { ok: true; mode: SessionPromptMode; status: "recovered"; recovered: true; recovery: DeliverSessionPromptRecovery; target: DeliverSessionPromptTarget }
	| { ok: true; mode: SessionPromptMode; dispatched: true; target: DeliverSessionPromptTarget };

export class SessionPromptDeliveryError extends Error {
	constructor(message: string, readonly code: string, readonly status: number) {
		super(message);
		this.name = "SessionPromptDeliveryError";
	}
}

export function parseSessionPromptMode(value: unknown, defaultMode: SessionPromptMode): SessionPromptMode {
	const mode = value ?? defaultMode;
	if (mode === "prompt" || mode === "steer") return mode;
	throw new SessionPromptDeliveryError("Invalid mode. Must be 'prompt' or 'steer'.", "INVALID_MODE", 400);
}

function canRecoverErroredPrompt(deps: DeliverSessionPromptDeps): boolean {
	return !!deps.getErroredPromptRecoveryDecision && !!deps.enqueuePromptForRetryRecovery && !!deps.retryLastPrompt;
}

function recoveryBlockedMessage(decision: Exclude<ErroredPromptRecoveryDecision, { recoverable: true }>): string {
	return `Cannot recover errored session prompt automatically: ${decision.message}`;
}

function queuePromptOptions(
	mode: SessionPromptMode,
	source?: PromptSource,
	author?: MessageAuthor,
): { isSteered?: boolean; source?: PromptSource; author?: MessageAuthor } {
	const base = mode === "steer" ? { isSteered: true, source } : { source };
	return author ? { ...base, author } : base;
}

export async function deliverSessionPrompt(
	deps: DeliverSessionPromptDeps,
	sessionId: string,
	message: string,
	opts: DeliverSessionPromptOptions,
): Promise<DeliverSessionPromptResult> {
	const mode = parseSessionPromptMode(opts.mode, opts.defaultMode);
	const session = deps.getSession(sessionId);
	if (!session) {
		throw new SessionPromptDeliveryError(`Session ${sessionId} is not live or was not found.`, "SESSION_NOT_FOUND", 404);
	}
	// A failed poisoned-history respawn deliberately leaves the old SessionInfo
	// behind as a terminated rollback capsule. SessionManager.enqueuePrompt can
	// revive that exact capsule in place, but this shared REST/tool boundary used
	// to reject it before the recovery path was reachable. Keep the exception
	// narrow: only the poison classifier may admit a terminated session.
	const terminatedRecovery = session.status === "terminated" && session.lastTurnErrored
		? deps.getErroredPromptRecoveryDecision?.(sessionId)
		: undefined;
	const recoverablePoisonRollback = terminatedRecovery?.recoverable === true
		&& terminatedRecovery.reason === "poisoned-history";
	if (session.status === "terminated" && !recoverablePoisonRollback) {
		throw new SessionPromptDeliveryError(`Session ${sessionId} is terminated.`, "SESSION_TERMINATED", 409);
	}
	const target: DeliverSessionPromptTarget = { sessionId: session.id };
	if (typeof session.title === "string" && session.title.trim()) {
		target.title = session.title;
	}

	if (mode === "prompt" && session.nonInteractive && !opts.allowPromptNonInteractive) {
		throw new SessionPromptDeliveryError(
			"Cannot prompt a non-interactive (automated review) session.",
			"NON_INTERACTIVE_PROMPT",
			400,
		);
	}

	if (mode === "steer" && session.status === "streaming") {
		await deps.deliverLiveSteer(sessionId, message, opts.author
			? { source: opts.source, author: opts.author }
			: { source: opts.source });
		return { ok: true, mode, dispatched: true, target };
	}

	if (mode === "steer" && session.nonInteractive) {
		throw new SessionPromptDeliveryError(
			"Cannot enqueue a steered prompt for a non-interactive (automated review) session; steer can only redirect it while streaming.",
			"NON_INTERACTIVE_STEER",
			400,
		);
	}

	if (session.lastTurnErrored && (recoverablePoisonRollback || (session.status === "idle" && canRecoverErroredPrompt(deps)))) {
		const recovery = terminatedRecovery ?? deps.getErroredPromptRecoveryDecision!(sessionId);
		if (!recovery.recoverable) {
			throw new SessionPromptDeliveryError(recoveryBlockedMessage(recovery), "PROMPT_RECOVERY_BLOCKED", 409);
		}
		// Orphan tool-result history is repaired by enqueuePrompt's user-driven
		// follow-up path. Do not queue the new intent behind a replay of the old
		// prompt, and do not call retryLastPrompt(auto:true): poison recovery must
		// never be an automatic retry loop.
		if (recovery.reason === "poisoned-history") {
			const delivered = await deps.enqueuePrompt(sessionId, message, queuePromptOptions(mode, opts.source, opts.author));
			return {
				ok: true,
				mode,
				status: "recovered",
				recovered: true,
				recovery: {
					status: "recovered",
					reason: recovery.reason,
					queued: delivered.status === "queued",
				},
				target,
			};
		}
		const queued = await deps.enqueuePromptForRetryRecovery!(sessionId, message, queuePromptOptions(mode, opts.source, opts.author));
		await deps.retryLastPrompt!(sessionId, { auto: true, preserveQueueIds: queued.queuedId ? [queued.queuedId] : undefined });
		return {
			ok: true,
			mode,
			status: "recovered",
			recovered: true,
			recovery: {
				status: "recovered",
				reason: recovery.reason,
				queued: true,
				...(queued.queuedId ? { queuedId: queued.queuedId } : {}),
			},
			target,
		};
	}

	const result = await deps.enqueuePrompt(sessionId, message, queuePromptOptions(mode, opts.source, opts.author));
	return { ok: true, mode, status: result.status, target };
}
