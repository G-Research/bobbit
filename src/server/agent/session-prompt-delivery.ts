import type { PromptSource } from "./session-manager.js";

export type SessionPromptMode = "prompt" | "steer";

export interface DeliverableSessionLike {
	id: string;
	status: string;
	nonInteractive?: boolean;
}

export interface DeliverSessionPromptDeps {
	getSession(id: string): DeliverableSessionLike | undefined;
	enqueuePrompt(
		id: string,
		message: string,
		opts?: { isSteered?: boolean; source?: PromptSource },
	): Promise<{ status: "dispatched" | "queued" }>;
	deliverLiveSteer(id: string, message: string, opts?: { source?: PromptSource }): Promise<unknown>;
}

export interface DeliverSessionPromptOptions {
	mode?: SessionPromptMode;
	defaultMode: SessionPromptMode;
	allowPromptNonInteractive?: boolean;
	source?: PromptSource;
}

export type DeliverSessionPromptResult =
	| { ok: true; mode: SessionPromptMode; status: "dispatched" | "queued" }
	| { ok: true; mode: SessionPromptMode; dispatched: true };

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
	if (session.status === "terminated") {
		throw new SessionPromptDeliveryError(`Session ${sessionId} is terminated.`, "SESSION_TERMINATED", 409);
	}

	if (mode === "prompt") {
		if (session.nonInteractive && !opts.allowPromptNonInteractive) {
			throw new SessionPromptDeliveryError(
				"Cannot prompt a non-interactive (automated review) session.",
				"NON_INTERACTIVE_PROMPT",
				400,
			);
		}
		const result = await deps.enqueuePrompt(sessionId, message, { source: opts.source });
		return { ok: true, mode, status: result.status };
	}

	if (session.status === "streaming") {
		await deps.deliverLiveSteer(sessionId, message, { source: opts.source });
		return { ok: true, mode, dispatched: true };
	}

	if (session.nonInteractive) {
		throw new SessionPromptDeliveryError(
			"Cannot enqueue a steered prompt for a non-interactive (automated review) session; steer can only redirect it while streaming.",
			"NON_INTERACTIVE_STEER",
			400,
		);
	}

	const result = await deps.enqueuePrompt(sessionId, message, { isSteered: true, source: opts.source });
	return { ok: true, mode, status: result.status };
}
