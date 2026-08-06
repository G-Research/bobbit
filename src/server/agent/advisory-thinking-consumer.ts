import type { ThinkingLevel } from "../../shared/thinking-levels.js";
import { clampThinkingLevelForModel } from "./thinking-level-clamp.js";
import { applyVerifiedRuntimeSessionThinkingMutation } from "../ws/runtime-model-selection.js";
import type { ExtensionHookRef } from "./project-config-store.js";
import type { ServerMessage } from "../ws/protocol.js";
import { SESSION_COMMAND_SERIALISER, sessionCommandSerialisationKey } from "../ws/session-command-serialiser.js";

export type AdvisoryThinkingApplyResult =
	| { status: "applied"; effectiveThinkingLevel: ThinkingLevel }
	| { status: "pinned" | "denied" | "unavailable" | "failed" };

type AdvisoryLiveSession = {
	id: string;
	projectId?: string;
	rpcClient: Parameters<typeof applyVerifiedRuntimeSessionThinkingMutation>[1]["rpcClient"];
	clients: Parameters<typeof applyVerifiedRuntimeSessionThinkingMutation>[1]["clients"];
};

class AdvisoryPreMutationFenceError extends Error {
	constructor(readonly status: "pinned" | "denied" | "unavailable") {
		super(status);
	}
}

/**
 * The only EP-2 selection consumer. It deliberately owns no selection policy:
 * the dispatcher already chose a server-provenanced candidate; this adapter
 * rechecks the live session and authorization at the mutation boundary.
 */
export class AdvisoryThinkingConsumer {
	constructor(private readonly deps: {
		getSession: (sessionId: string) => AdvisoryLiveSession | undefined;
		getPersistedSession: (sessionId: string) => {
			projectId?: string;
			humanSelectionPins?: { thinkingLevel?: ThinkingLevel };
		} | undefined;
		/** Core-owned user/caller/role/default/durable policy fence, re-read at mutation time. */
		hasExplicitThinkingChoice?: (sessionId: string) => boolean;
		/** Exact active declaration + grant lookup, evaluated synchronously at the mutation boundary. */
		isAuthorized: (input: { projectId: string; source: ExtensionHookRef }) => boolean;
		sessionManager: Parameters<typeof applyVerifiedRuntimeSessionThinkingMutation>[0];
		broadcast?: (sessionId: string, message: ServerMessage) => void;
	}) {}

	async apply(input: {
		sessionId: string;
		projectId: string;
		requested: ThinkingLevel;
		source: ExtensionHookRef;
	}): Promise<AdvisoryThinkingApplyResult> {
		try {
			// Human WebSocket model/thinking commands use this exact owner and key.
			// Holding it across the live read, fence, mutation, and read-back closes
			// the otherwise unavoidable cross-origin selection TOCTOU window.
			return await SESSION_COMMAND_SERIALISER.serialise(
				sessionCommandSerialisationKey(input.sessionId),
				() => this.applyOwned(input),
			);
		} catch {
			return { status: "failed" };
		}
	}

	private assertPreMutationAuthority(
		input: { sessionId: string; projectId: string; source: ExtensionHookRef },
		expectedSession: AdvisoryLiveSession,
	): void {
		// This runs synchronously after the helper's live read/clamp/canonical
		// checks and immediately before setThinkingLevel. Do not move it across
		// an await or add recovery work here.
		const persisted = this.deps.getPersistedSession(input.sessionId);
		const session = this.deps.getSession(input.sessionId);
		if (
			!persisted
			|| !session
			|| session !== expectedSession
			|| persisted.projectId !== input.projectId
			|| session.projectId !== input.projectId
		) {
			throw new AdvisoryPreMutationFenceError("unavailable");
		}
		if (this.deps.hasExplicitThinkingChoice?.(input.sessionId) ?? !!persisted.humanSelectionPins?.thinkingLevel) {
			throw new AdvisoryPreMutationFenceError("pinned");
		}
		try {
			// isAuthorized re-derives both active declaration and exact decide grant.
			if (!this.deps.isAuthorized({ projectId: input.projectId, source: input.source })) {
				throw new AdvisoryPreMutationFenceError("denied");
			}
		} catch (error) {
			if (error instanceof AdvisoryPreMutationFenceError) throw error;
			throw new AdvisoryPreMutationFenceError("denied");
		}
	}

	private async applyOwned(input: {
		sessionId: string;
		projectId: string;
		requested: ThinkingLevel;
		source: ExtensionHookRef;
	}): Promise<AdvisoryThinkingApplyResult> {
		const persisted = this.deps.getPersistedSession(input.sessionId);
		const session = this.deps.getSession(input.sessionId);
		// A dormant, replaced, cross-project, or archived session cannot be an
		// extension apply target. Pins are checked before authorization/RPC work.
		if (!persisted || !session || persisted.projectId !== input.projectId || session.projectId !== input.projectId) {
			return { status: "unavailable" };
		}
		if (this.deps.hasExplicitThinkingChoice?.(input.sessionId) ?? !!persisted.humanSelectionPins?.thinkingLevel) return { status: "pinned" };
		try {
			if (!this.deps.isAuthorized({ projectId: input.projectId, source: input.source })) return { status: "denied" };
		} catch {
			return { status: "denied" };
		}

		let unavailable = false;
		try {
			const verified = await applyVerifiedRuntimeSessionThinkingMutation(
				this.deps.sessionManager,
				session,
				(current) => {
					const clamped = clampThinkingLevelForModel(input.requested, current.provider, current.id);
					if (!clamped) {
						unavailable = true;
						throw new Error("advisory thinking level is unavailable for the live model");
					}
					return clamped;
				},
				this.deps.broadcast ? (_clients, message) => this.deps.broadcast!(input.sessionId, message) : undefined,
				{
					recovery: "none",
					beforeSetThinkingLevel: () => this.assertPreMutationAuthority(input, session),
				},
			);
			return { status: "applied", effectiveThinkingLevel: verified.thinkingLevel };
		} catch (error) {
			if (error instanceof AdvisoryPreMutationFenceError) return { status: error.status };
			return { status: unavailable ? "unavailable" : "failed" };
		}
	}
}
