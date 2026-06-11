// src/server/extension-host/server-host-api.ts
//
// The SERVER-side Host API handed to a tool's action handlers as `ctx.host`
// (design docs/design/extension-host.md §4c / §5). It is the server-host
// analogue of the client `HostApi` (src/shared/extension-host/host-api.ts):
// the single, capability-scoped object through which a handler touches Bobbit
// internals.
//
// There is NO `gateway.fetch` and no raw passthrough — that escape hatch (and
// with it the Host-header trusted-base-URL token-leak surface) is removed in the
// durable v1 contract. Phase 1 exposes only the bound session/tool identity +
// `capabilities`; the frozen `session`/`store` namespaces throw a loud "reserved
// for Phase 2" so misuse is never silent. Handlers that genuinely need raw
// `fs`/`process`/`exec` import them directly.
//
// `callRoute` and `ui` are CLIENT-ONLY surfaces (renderers/panels). A server
// handler reaches its own pack's route by calling the function directly, and a
// server module has no UI to drive — so there is no server-side `callRoute`/`ui`
// by design (NOT an unimplemented gap). They are deliberately ABSENT from the
// server capability map; the frozen v1 CLIENT contract still reports
// `capabilities.callRoute === true` (see src/app/host-api.ts).

import { HOST_API_VERSION, HOST_CONTRACT_VERSION } from "../../shared/extension-host/host-api.js";
import type { PackStore } from "./pack-store.js";
import type { ReadTranscriptOpts, TranscriptEnvelope, ToolCallRecord } from "../../shared/extension-host/host-api.js";
import { transcriptToHostMessages, transcriptToToolCall, buildTranscriptEnvelope } from "./contract-adapter.js";
// SUB-GOAL C: the ambient `host.agents` capability is backed by the SAME shared
// OrchestrationCore that services the agent-tool `/orchestrate/*` routes. The type
// import is erased at runtime (no module cycle); the gateway injects the live
// instance through CreateServerHostApiOptions.orchestrationCore (an A seam).
import type { OrchestrationCore } from "../agent/orchestration-core.js";

/** Implemented in Slice B1 — ownership-scoped persistence. Mirrors HostStoreApi server-side. */
export interface ServerHostStoreApi {
	get<T = unknown>(key: string): Promise<T | null>;
	put<T = unknown>(key: string, value: T): Promise<void>;
	list(prefix?: string): Promise<string[]>;
}

/**
 * The ambient `host.agents` capability (orchestration-core §8.3) — sub-goal C.
 *
 * A POLL-BASED surface (NO blocking `wait`: the worker tier terminates a call on
 * timeout, so a handler `spawn`s then polls `status`/`list`/`read` across worker
 * calls). Every verb is bound to the calling session id (`opts.sessionId`) as the
 * owner AND filtered to the `childKind === "host-agents"` SOURCE DISCRIMINATOR, so
 * a pack handler sees ONLY the children IT spawned through `host.agents` — never an
 * agent-tool (`delegate`) child or `team` child of the same session, and never any
 * foreign session. There is NO parameter for a foreign/user session: the method
 * simply does not exist (mirrors `ServerHostSessionApi` being own-session-only).
 *
 * Hard invariant: a spawned child inherits the bound session's sandbox + credential
 * scope via `OrchestrationCore.spawn` and can never exceed it. The pack receives
 * orchestration VERBS, not transport (no token, no raw `fetch`).
 */
export interface ServerHostAgentsApi {
	/** Launch a child agent owned by the bound session (childKind "host-agents").
	 *  Throws if the bound session is itself a child (no grandchildren). */
	spawn(opts: {
		instructions: string;
		role?: string;
		model?: string;
		thinkingLevel?: string;
		readOnly?: boolean;
		context?: Record<string, string>;
		lifecycle?: "bare" | "full";
		/** Optional visible session title for the spawned child. Additive optional field
		 *  on the server-side host.agents capability (NOT the frozen versioned data
		 *  contract), threaded to `OrchestrationCore.SpawnOpts.title` → `createSession`.
		 *  When omitted the child defaults to "New session". */
		title?: string;
		/** When `true` with `lifecycle:"full"`, create the visible child but do NOT
		 *  enqueue `instructions` — the caller starts it later via `prompt`. Lets a
		 *  launcher write its binding before the child's first tool call (Decision A.5). */
		deferInitialPrompt?: boolean;
		/** NON-SECRET tool-scoping env vars set on the child process (additive,
		 *  alongside the gateway-set BOBBIT_SESSION_ID/SECRET). Read by tool policies
		 *  (e.g. the pr-walkthrough reviewer's launched-PR `gh` scoping). Plain metadata
		 *  ONLY — it never widens the child's owner-inherited sandbox/credential scope. */
		toolEnv?: Record<string, string>;
	}): Promise<{ childSessionId: string }>;
	/** Run-if-idle / queue a follow-up prompt to an owned host.agents child. */
	prompt(childSessionId: string, message: string): Promise<{ status: "dispatched" | "queued" }>;
	/** Terminate + archive an owned host.agents child. */
	dismiss(childSessionId: string): Promise<boolean>;
	/** List the bound session's host.agents children (source-filtered). */
	list(): Promise<Array<{ childSessionId: string; status: string; childKind: string }>>;
	/** Read an owned host.agents child's transcript/output. */
	read(childSessionId: string, opts?: ReadTranscriptOpts): Promise<unknown>;
	/** Poll an owned host.agents child's live status. */
	status(childSessionId: string): Promise<{ status: "idle" | "streaming" | "queued" | "preparing" | "terminated" }>;
}

/** Mirrors HostSessionApi server-side, but READ-ONLY. Slice B2 implements the
 *  own-session READS (`readTranscript`/`readToolCall`) through the contract adapter.
 *
 *  `postMessage` is deliberately ABSENT (Fix B): driving the agent is a CLIENT-ONLY
 *  capability, gated by a real user activation + the trusted per-session secret
 *  (src/app/host-api.ts + gesture-context.ts). A server route/action handler has no
 *  user gesture and could auto-drive the agent on a panel-triggered route call, so
 *  the server host MUST NOT expose a way to post. */
export interface ServerHostSessionApi {
	readTranscript(opts?: ReadTranscriptOpts): Promise<TranscriptEnvelope>;
	readToolCall(toolUseId: string): Promise<ToolCallRecord | null>;
}

/** Readonly capability map — the SINGLE SOURCE OF TRUTH for what is IMPLEMENTED on the
 *  server host. On a Phase-1 server host only the bound identity is available; the
 *  scoped Phase-2 capabilities are `false`.
 *
 *  NOTE: `callRoute` and `ui` are CLIENT-ONLY surfaces and are intentionally NOT
 *  members here (a server handler calls its routes directly; a server module has no
 *  UI). Their absence is by design, not an unimplemented gap. */
export interface ServerHostCapabilities {
	/** Phase-2 — transcript/message/event surface. False on a Phase-1 host. */
	readonly session: boolean;
	/** Ownership-scoped persistence (Slice B1). True once the store backend is wired. */
	readonly store: boolean;
	/** Ambient child-agent orchestration (sub-goal C). True once `host.agents` is
	 *  wired to the injected OrchestrationCore. */
	readonly agents: boolean;
	/** Convenience: feature-detect by name; returns the flag, or false for unknown names. */
	has(name: string): boolean;
}

/**
 * The server-side Host API. Phase 1 exposes the bound identity + `capabilities`;
 * `session`/`store` are frozen interfaces whose members throw until Phase 2 wires
 * them through the same authorization path (purely additive — no signature churn).
 */
export interface ServerHostApi {
	/** Frozen API version. See HOST_API_VERSION. */
	readonly version: number;
	/** Version of the Host-API-owned data contracts. See HOST_CONTRACT_VERSION. */
	readonly contractVersion: number;
	/** The SINGLE SOURCE OF TRUTH for which capabilities are implemented on this host. */
	readonly capabilities: ServerHostCapabilities;
	/** Ownership-scoped persistence (Slice B1) — scoped to the server-derived packId. */
	readonly store: ServerHostStoreApi;
	/** Transcript + message capabilities. PHASE 2 (frozen, not implemented). */
	readonly session: ServerHostSessionApi;
	/** Ambient child-agent orchestration (sub-goal C) — own host.agents children only. */
	readonly agents: ServerHostAgentsApi;
}

export interface CreateServerHostApiOptions {
	/** The verified calling session id (bound for the handler context). */
	sessionId: string;
	/** The verified tool_use id this action is acting on (bound identity). */
	toolUseId?: string;
	/** SERVER-DERIVED pack id (never caller-supplied) — the directory name under
	 *  `market-packs/` of the winning contribution. Empty for a non-pack (builtin).
	 *  Bound in closure; consumed by the scoped Phase-2 capabilities
	 *  (store/session/callRoute) when they land. See pack-identity.ts. */
	packId: string;
	/** SERVER-DERIVED contributing tool/group key (`${groupDir}/${tool}`). */
	contributionId: string;
	/** Slice B1 — the process-singleton pack store. When present, `ctx.host.store`
	 *  delegates to it scoped to the closure `packId`. */
	packStore?: PackStore;
	/** Read the BOUND (own) session's raw transcript JSONL (Slice B2). Injected by
	 *  the gateway so `session.read*` can map rows through the contract adapter.
	 *  Own-session by construction — there is no parameter for another session. When
	 *  absent (non-gateway context), the session reads throw a clear error. */
	readOwnTranscript?: () => Promise<string | null>;
	/** SUB-GOAL A SEAM (orchestration-core §8.3): the gateway injects the shared
	 *  OrchestrationCore so sub-goal C can implement the ambient `host.agents`
	 *  capability (spawn/prompt/dismiss/list/read/status) over the SAME core that
	 *  backs the agent-tool `/orchestrate/*` routes. Sub-goal A only passes it in
	 *  (the `agents` capability flag stays FALSE and no namespace is exposed); C
	 *  flips the flag + implements the namespace. Typed `unknown` here so A does
	 *  not freeze C's import shape. */
	orchestrationCore?: unknown;
	/** SUB-GOAL C: read a child session's live status for `host.agents.status`/`list`
	 *  (the OrchestrationCore exposes no public status accessor). Injected by the
	 *  gateway as `sessionManager.getSession(id)?.status`. Absent in non-gateway
	 *  contexts → status reports "preparing". */
	readChildStatus?: (sessionId: string) => string | undefined;
}

/**
 * Build the Phase-1 server Host API bound to a single verified session.
 * The returned object is what the ActionDispatcher hands to a handler as
 * `ctx.host`. It carries no raw transport: the only sanctioned pack→server path
 * is the action endpoint itself (which already authorizes + audits the call).
 */
export function createServerHostApi(opts: CreateServerHostApiOptions): ServerHostApi {
	// The bound identity is held in closure: sessionId + toolUseId (Phase 1) plus
	// the SERVER-DERIVED packId + contributionId (Slice A). The scoped Phase-2
	// capabilities (store/session/callRoute) read these when they land; no flag
	// flips in Slice A (identity is plumbing).
	void opts.toolUseId;
	void opts.contributionId;

	// Slice B2: own-session transcript reader (header-bound session, supplied by the
	// gateway). The reads below map its rows through the single contract adapter.
	const readOwnTranscript = opts.readOwnTranscript;
	const requireReader = (member: string): (() => Promise<string | null>) => {
		if (!readOwnTranscript) {
			throw new Error(`host.session.${member} requires a gateway transcript reader`);
		}
		return readOwnTranscript;
	};

	// Slice B1: `store` is IMPLEMENTED — flip the flag. It delegates to the
	// process-singleton PackStore, scoped to the SERVER-DERIVED closure packId
	// (never caller-supplied), so a handler can only ever touch its own pack's keys.
	// Slice C2: `session` flips TRUE (reads from B2 + write here = full namespace live).
	// `callRoute`/`ui` are client-only surfaces — deliberately absent (not gaps).
	// SUB-GOAL C: `agents` is IMPLEMENTED — flip the flag. The namespace closes over
	// the bound owner session id + the injected OrchestrationCore and exposes ONLY
	// the six poll-based verbs scoped to this session's `host-agents` children.
	const flags = { session: true, store: true, agents: true };
	const capabilities: ServerHostCapabilities = {
		...flags,
		has: (name: string) => (flags as Record<string, boolean>)[name] === true,
	};

	const packId = opts.packId;
	const packStore = opts.packStore;
	const requireStore = (): PackStore => {
		if (!packStore) throw new Error("host.store backend unavailable");
		return packStore;
	};
	const store: ServerHostStoreApi = {
		get: (key) => requireStore().get(packId, key),
		put: (key, value) => requireStore().put(packId, key, value),
		list: (prefix) => requireStore().list(packId, prefix),
	};

	// Slice B2: own-session READS are implemented against the contract adapter; the
	// `session` capability flag stays FALSE until C2 adds writes (the namespace flips
	// live as a whole — capability-signaling convention, design §0/§4 B2.3). Bobbit
	// lands the read bodies early purely to decouple the work.
	const session: ServerHostSessionApi = {
		readTranscript: async (sessionOpts) => {
			const jsonl = await requireReader("readTranscript")();
			return buildTranscriptEnvelope(transcriptToHostMessages(jsonl), sessionOpts);
		},
		readToolCall: async (toolUseId) => {
			const jsonl = await requireReader("readToolCall")();
			return transcriptToToolCall(jsonl, toolUseId);
		},
		// `postMessage` is intentionally NOT implemented on the server host (Fix B):
		// driving the agent is a client-only, user-activation + session-secret gated
		// capability. A server handler has no user gesture, so it must not be able to post.
	};

	// ── host.agents (sub-goal C) ────────────────────────────────────────────────
	// Source discriminator: every child this namespace mints carries
	// childKind="host-agents"; every verb filters to children of THIS session with
	// that kind, so host.agents can never see delegate/team children of the same
	// session nor any foreign session.
	const HOST_AGENTS_KIND = "host-agents";
	const ownerSessionId = opts.sessionId;
	const core = opts.orchestrationCore as OrchestrationCore | undefined;
	const readChildStatus = opts.readChildStatus;
	const requireCore = (): OrchestrationCore => {
		if (!core) throw new Error("host.agents backend unavailable");
		return core;
	};
	/** The bound session's host.agents children (source-filtered). */
	const ownHostAgentsChildren = () =>
		requireCore().list(ownerSessionId).filter((h) => h.childKind === HOST_AGENTS_KIND);
	/** Enforce that `childSessionId` is one of THIS session's host.agents children. */
	const requireOwnAgentsChild = (childSessionId: string): void => {
		if (!ownHostAgentsChildren().some((h) => h.sessionId === childSessionId)) {
			throw new Error(`host.agents: ${childSessionId} is not a host.agents child of this session`);
		}
	};
	type AgentStatus = "idle" | "streaming" | "queued" | "preparing" | "terminated";
	const mapStatus = (raw: string | undefined): AgentStatus => {
		switch (raw) {
			case "idle": return "idle";
			case "streaming":
			case "aborting": return "streaming";
			case "terminated": return "terminated";
			case "preparing":
			case "starting": return "preparing";
			default: return "preparing";
		}
	};
	const agents: ServerHostAgentsApi = {
		spawn: async (spawnOpts) => {
			const c = requireCore();
			// Recursion denial reuses A's shared guard (no grandchildren), surfaced as a
			// capability-specific message.
			try {
				c.assertCanSpawn(ownerSessionId);
			} catch {
				throw new Error("host.agents.spawn is not permitted for a child session");
			}
			const handle = await c.spawn({
				ownerSessionId,
				instructions: spawnOpts.instructions,
				role: spawnOpts.role,
				model: spawnOpts.model,
				thinkingLevel: spawnOpts.thinkingLevel,
				readOnly: spawnOpts.readOnly,
				context: spawnOpts.context,
				lifecycle: spawnOpts.lifecycle,
				title: spawnOpts.title,
				deferInitialPrompt: spawnOpts.deferInitialPrompt,
				toolEnv: spawnOpts.toolEnv,
				childKind: HOST_AGENTS_KIND,
			});
			return { childSessionId: handle.sessionId };
		},
		prompt: async (childSessionId, message) => {
			requireOwnAgentsChild(childSessionId);
			return requireCore().prompt(ownerSessionId, childSessionId, message);
		},
		dismiss: async (childSessionId) => {
			requireOwnAgentsChild(childSessionId);
			return requireCore().dismiss(ownerSessionId, childSessionId);
		},
		list: async () => ownHostAgentsChildren().map((h) => ({
			childSessionId: h.sessionId,
			status: mapStatus(readChildStatus?.(h.sessionId)),
			childKind: h.childKind,
		})),
		read: async (childSessionId, readOpts) => {
			requireOwnAgentsChild(childSessionId);
			return requireCore().read(ownerSessionId, childSessionId, readOpts);
		},
		status: async (childSessionId) => {
			requireOwnAgentsChild(childSessionId);
			return { status: mapStatus(readChildStatus?.(childSessionId)) };
		},
	};

	return { version: HOST_API_VERSION, contractVersion: HOST_CONTRACT_VERSION, capabilities, store, session, agents };
}
