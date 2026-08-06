import type { ThinkingLevel } from "../../shared/thinking-levels.js";
import { clampThinkingLevelForModel } from "./thinking-level-clamp.js";
import { applyVerifiedRuntimeSessionThinkingMutation } from "../ws/runtime-model-selection.js";
import type { ExtensionHookRef } from "./project-config-store.js";
import type { ServerMessage } from "../ws/protocol.js";

export type AdvisoryThinkingApplyResult =
	| { status: "applied"; effectiveThinkingLevel: ThinkingLevel }
	| { status: "pinned" | "denied" | "unavailable" | "failed" };

type AdvisoryLiveSession = {
	id: string;
	projectId?: string;
	rpcClient: Parameters<typeof applyVerifiedRuntimeSessionThinkingMutation>[1]["rpcClient"];
	clients: Parameters<typeof applyVerifiedRuntimeSessionThinkingMutation>[1]["clients"];
};

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
		/** Exact active declaration + grant lookup, evaluated immediately before use. */
		isAuthorized: (input: { projectId: string; source: ExtensionHookRef }) => boolean | Promise<boolean>;
		sessionManager: Parameters<typeof applyVerifiedRuntimeSessionThinkingMutation>[0];
		broadcast?: (sessionId: string, message: ServerMessage) => void;
	}) {}

	async apply(input: {
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
		if (persisted.humanSelectionPins?.thinkingLevel) return { status: "pinned" };
		try {
			if (!await this.deps.isAuthorized({ projectId: input.projectId, source: input.source })) return { status: "denied" };
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
				{ recovery: "none" },
			);
			return { status: "applied", effectiveThinkingLevel: verified.thinkingLevel };
		} catch {
			return { status: unavailable ? "unavailable" : "failed" };
		}
	}
}
