// src/server/agent/orchestration-core.ts
//
import { deliverSessionPrompt, type DeliverSessionPromptResult, type SessionPromptMode } from "./session-prompt-delivery.js";
import type { MessageAuthor } from "../../shared/message-author.js";
import { agentAuthorForSession } from "./message-author.js";
import type { ErroredPromptRecoveryDecision, PromptSource } from "./session-manager.js";

// OrchestrationCore — the ONE goal-agnostic implementation of "launch and
// orchestrate a child agent (a new, properly-scoped principal)".
//
// Background (docs/design/orchestration-core.md): "launch a child agent" used
// to be reimplemented in four divergent places (team-manager, the `delegate`
// extension, the legacy pr-walkthrough wiring, and the pr-walkthrough pack).
// This module is the single shared core. It owns the child-principal lifecycle
// by WRAPPING the existing, mature `SessionManager` primitives through a narrow
// injected view (`OrchestrationSessionView`) — it never duplicates session
// logic.
//
// Two entry points converge here:
//   • agent-process tools  → REST route (`/api/sessions/:id/orchestrate/*`) → core (in-process)
//   • extension-host packs → `host.agents` (sub-goal C)                     → core (in-process)
//
// Key invariants (see the design doc):
//   • Parent↔child linkage is DERIVED from existing persisted session fields
//     (`delegateOf` / `parentSessionId` + `childKind`) that match a server-created
//     child shape. There is NO new persisted registry. The core keeps an in-memory
//     index keyed on owner session id, rebuilt on boot from those fields (§3).
//   • "Blocking-ness" is RUNTIME-ONLY, never persisted (§4).
//   • ONE shared `wait` primitive with two policies (`all` / `first`) and
//     terminal-child handling that never rejects the aggregate (§2.3).
//   • Recursion is fully blocked at all depths: `assertCanSpawn` rejects a
//     bound-child owner AND `spawn` subtracts every spawn verb from the child's
//     `allowedTools` (§7).
//   • Model inheritance: a child inherits the owner's CURRENT model unless
//     overridden per-call (§2.2).

/** Spawn verbs a child must never inherit (recursion guard, §7). */
export const SPAWN_VERBS: readonly string[] = ["team_delegate", "team_spawn"];

/**
 * Tools a `readOnly` child must never inherit (§2.2). A read-only child is
 * enforced the same way pr-walkthrough enforces it: by RESTRICTING the child's
 * allow-list so the file/shell-mutating tools are never registered (and so can
 * never be invoked). The child keeps every read/search tool (`read`, `ls`,
 * `grep`, `find`, `read_session`, …) but loses raw write/edit/shell access.
 * Mirrors the intent of WALKTHROUGH_ALLOWED_TOOLS (which swaps `bash` for the
 * command-policed `readonly_bash`); a generic delegate has no policed shell, so
 * raw `bash`/`bash_bg` are dropped outright.
 */
export const READ_ONLY_DENY_TOOLS: readonly string[] = ["write", "edit", "bash", "bash_bg", "generate_image"];

export type ChildKind = "delegate" | "team" | "pr-walkthrough" | "host-agents" | (string & {});
export type SpawnLifecycle = "bare" | "full";

/** Live session statuses surfaced to orchestration callers. */
export type LiveChildStatus = "idle" | "streaming" | "queued" | "not-started";
/** Terminal statuses derived from a `waitForIdle` rejection (§2.3). */
export type TerminalChildStatus = "terminated" | "timeout" | "failed";
/** A child is SETTLED when its status is idle OR terminal. */
export type ChildStatus = LiveChildStatus | TerminalChildStatus;

export type DismissStatus = "dismissed" | "already-dismissed" | "not-owned" | "not-found" | "failed";
export interface DismissResult {
	ok: boolean;
	status: DismissStatus;
	sessionId: string;
	message: string;
	retryable: boolean;
}

export function dismissHttpStatus(result: DismissResult): number {
	switch (result.status) {
		case "not-owned": return 403;
		case "not-found": return 404;
		case "failed": return 500;
		default: return 200;
	}
}

const TERMINAL_STATUSES = new Set<ChildStatus>(["terminated", "timeout", "failed"]);
export function isTerminalStatus(s: ChildStatus): boolean {
	return TERMINAL_STATUSES.has(s);
}
export function isSettledStatus(s: ChildStatus): boolean {
	return s === "idle" || isTerminalStatus(s);
}

/** The raw session status vocabulary used by SessionManager. */
export type RawSessionStatus = "starting" | "preparing" | "idle" | "streaming" | "aborting" | "terminated";

/**
 * Map a live SessionManager status to the orchestration ChildStatus vocabulary.
 *
 * `queuedPromptCount` (M3): a NON-streaming child that has pending prompt-queue
 * rows is reported as `queued` rather than `idle`. `session.status` alone never
 * surfaces queued follow-up work, so callers thread the child's prompt-queue
 * length here (see `OrchestrationCore.liveChildStatus`).
 */
export function liveStatusToChildStatus(
	status: RawSessionStatus | string | undefined,
	opts?: { queuedPromptCount?: number },
): ChildStatus {
	switch (status) {
		case "idle": return (opts?.queuedPromptCount ?? 0) > 0 ? "queued" : "idle";
		case "streaming": return "streaming";
		case "aborting": return "streaming"; // still mid-turn from the caller's POV
		case "terminated": return "terminated";
		case "preparing":
		case "starting": return "not-started";
		default: return "not-started";
	}
}

/** Map a `waitForIdle` rejection to a terminal status (§2.3). */
export function classifyTerminal(err: unknown): TerminalChildStatus {
	const msg = err instanceof Error ? err.message : String(err ?? "");
	if (/timeout/i.test(msg)) return "timeout";
	if (/exited unexpectedly|process exit|not found/i.test(msg)) return "terminated";
	return "failed";
}

export interface SpawnOpts {
	/** The parent/owner session id; the in-memory index key. */
	ownerSessionId: string;
	instructions: string;
	/** Optional role injection (goal/team path). */
	role?: string;
	/** Default: inherit the owner's CURRENT model (resolveSessionModel). */
	model?: string;
	/** Default: inherit the owner's thinking level. */
	thinkingLevel?: string;
	/** Read-only marker. With NO explicit `lifecycle` a read-only child defaults
	 *  to lifecycle:"bare"; an explicit `lifecycle:"full"` still wins (a visible,
	 *  role-carrying read-only reviewer requires the full lifecycle — Decision A.1). */
	readOnly?: boolean;
	context?: Record<string, string>;
	/**
	 * NON-SECRET tool-scoping env vars to set on the child process (additive,
	 * alongside the gateway-set BOBBIT_SESSION_ID/SECRET). Used by tool policies
	 * that read process env — e.g. the pr-walkthrough reviewer's launched-PR
	 * `gh` scoping via `BOBBIT_WALKTHROUGH_TARGET_*`. This carries plain metadata
	 * ONLY; it MUST NOT widen the child's sandbox or project (credential) scope —
	 * those remain owner-inherited and are derived independently below.
	 */
	toolEnv?: Record<string, string>;
	/** Default "bare"; "full" opt-in (Lifecycle Hub). When set it wins over the
	 *  readOnly→bare default. */
	lifecycle?: SpawnLifecycle;
	/**
	 * When `true`, the FULL-lifecycle (`createSession`) path creates the visible
	 * child but does NOT enqueue `instructions` as a kickoff — the caller starts it
	 * later via an explicit follow-up `prompt` (Decision A.5). This lets a launcher
	 * write its `{childSessionId→…}` binding BEFORE the child's first tool call,
	 * closing the spawn/binding race. Only meaningful for the full lifecycle; the
	 * bare/delegate path is unaffected.
	 */
	deferInitialPrompt?: boolean;
	/** Default "delegate". */
	childKind?: ChildKind;
	title?: string;
	/**
	 * Worktree mode. `shared` = child shares owner cwd (delegate parity — the
	 * documented unbounded-lifetime race in non-blocking mode, §10). `sub-branch`
	 * = own worktree on a goal sub-branch (goal/team only).
	 */
	worktree?:
		| { mode: "shared"; cwd: string }
		| { mode: "sub-branch"; repoPath: string; goalId: string; branch: string; cwd: string };
}

export interface ChildHandle {
	sessionId: string;
	ownerSessionId: string;
	childKind: ChildKind;
	spawnedAt: number;
	title?: string;
	/** RUNTIME-ONLY — never persisted (§4). On boot every child is non-blocking. */
	blocking: boolean;
}

const RESTART_COLLECTION_REMINDER_EXCLUDED_CHILD_KINDS = new Set<ChildKind>([
	"team",
	"pr-walkthrough",
	"host-agents",
]);

/**
 * Whether a restored child belongs to the generic post-restart collection flow.
 * Non-collectable workflows opt out by child kind; all other child kinds keep
 * existing restart-reminder behaviour and can be collected through `team_wait`.
 * `host-agents` children are collected/polled by their owning extension workflow
 * (for example PR Walkthrough reviewers), not by generic `team_wait` reminders.
 */
export function shouldSendRestartCollectionReminder(handle: Pick<ChildHandle, "childKind">): boolean {
	return !RESTART_COLLECTION_REMINDER_EXCLUDED_CHILD_KINDS.has(handle.childKind);
}

export interface WaitResult {
	/** Session id of the first child that became settled (idle or terminal). */
	firstIdle?: string;
	/** Whether `firstIdle` settled as a terminal status (drives the header wording). */
	firstIsTerminal?: boolean;
	statuses: Array<{ sessionId: string; status: ChildStatus; title?: string }>;
	/** Short tail of `firstIdle`'s output. */
	outputTail?: string;
	/** Awaited children that are NEITHER idle NOR terminal. */
	remaining: number;
}

export interface ReapInput {
	childKind: ChildKind;
	ownerSessionId?: string;
	ownerExists: boolean;
	ownerArchived: boolean;
	/** Kind-specific terminal signal (e.g. walkthrough job ready/error). undefined ⇒ not terminal. */
	kindTerminal?: boolean;
	kindTerminalReason?: string;
}
export interface ReapDecision {
	reap: boolean;
	reason?: string;
}

/**
 * Generalized boot-reap decision (§5). Replaces the walkthrough-specific
 * `shouldReapWalkthroughChildOnBoot`; a thin per-kind adapter supplies
 * `kindTerminal` (e.g. pr-walkthrough job status) so existing behaviour stays
 * byte-identical. A child is reaped on boot ONLY when it is kind-terminal, or
 * its owner is gone / archived. A child whose owner is restoring is never reaped.
 */
export function shouldReapChildOnBoot(i: ReapInput): ReapDecision {
	if (i.kindTerminal) return { reap: true, reason: i.kindTerminalReason ?? "kind terminal" };
	if (!i.ownerSessionId || !i.ownerExists) return { reap: true, reason: "owner session no longer exists" };
	if (i.ownerArchived) return { reap: true, reason: "owner session is archived" };
	return { reap: false };
}

export interface OrchestrationAuditEvent {
	event: "spawn" | "prompt" | "steer" | "abort" | "dismiss" | "wait" | "reminder" | "reap";
	ownerSessionId: string;
	childSessionId?: string;
	childKind?: ChildKind;
	detail?: string;
}

/** Persisted session fields the index rebuild reads (structural subset). */
export interface PersistedSessionLike {
	id: string;
	title?: string;
	delegateOf?: string;
	/** Durable delegate task; present on server-created delegate children. */
	instructions?: string;
	parentSessionId?: string;
	childKind?: string;
	archived?: boolean;
	/**
	 * Owner sandbox + project (credential) scope — the ONE hard invariant
	 * (sandbox/credential inheritance, §8.3). The full-lifecycle `createSession`
	 * spawn path threads these from the OWNER so a child can never run outside
	 * the owner's sandbox or reach a project the owner cannot. The bare path
	 * inherits the same scope inside `createDelegateSession`. Read from the
	 * persisted owner record — never widened by a per-call option.
	 */
	sandboxed?: boolean;
	projectId?: string;
	/** @deprecated Legacy inert metadata retained for persisted-record compatibility. */
	worktreePushPolicy?: "local-only" | "publish";
	/** Owner's validated host-side cwd (never trust a container-internal cwd). */
	cwd?: string;
	/**
	 * GENERIC, pack-agnostic terminal marker (Decision E / Findings 3–4). Set
	 * server-side when a child session reaches a terminal state (e.g. a dismissed
	 * `host-agents` reviewer, or a completing submit endpoint). `shouldReapChildOnBoot`
	 * derives `ReapInput.kindTerminal` purely from this field — core reads NO
	 * pack-store keys and has NO per-pack knowledge.
	 */
	childTerminal?: boolean;
	/** Goal/team adapter ownership marker for role-agent sessions. */
	teamGoalId?: string;
	/** Team lead session that owns a goal/team worker. */
	teamLeadSessionId?: string;
	/** When the terminal marker was stamped (epoch ms). */
	terminalAt?: number;
}

/** Live session fields the core reads (structural subset of SessionInfo). */
export interface OrchestrationSessionLike {
	id: string;
	status: RawSessionStatus | string;
	title?: string;
	role?: string;
	staffId?: string;
	cwd?: string;
	allowedTools?: string[];
	/** Pending prompt-queue rows — drives the `queued` status mapping (M3). */
	queuedPromptCount?: number;
}

export interface ReadTranscriptLike {
	offset?: number;
	limit?: number;
	pattern?: string;
	case_sensitive?: boolean;
	context?: number;
	verbose?: boolean;
}

/**
 * The narrow injected surface of SessionManager. Keeping the core decoupled
 * from the full class makes it unit-testable with a fake.
 */
export interface OrchestrationSessionView {
	createDelegateSession(parentSessionId: string, opts: {
		instructions: string;
		cwd: string;
		title?: string;
		context?: Record<string, string>;
		allowedTools?: string[];
		initialModel?: string;
		initialThinkingLevel?: string;
		/** Optional role injection: threads role prompt + accessory through the
		 *  shared session-setup pipeline. Tools are NOT recomputed here (they are
		 *  already the spawn-verb/read-only-stripped role tools from childAllowedTools). */
		role?: string;
		/** NON-SECRET tool-scoping env vars (additive; never widens sandbox/project scope). */
		env?: Record<string, string>;
		/** Persisted so the source discriminator survives restart (§3). Default "delegate". */
		childKind?: string;
		/** Persisted read-only marker (§2.2). Tool gating is via `allowedTools`. */
		readOnly?: boolean;
		/** Initial task provenance: child instructions are relayed by the owner agent. */
		source?: PromptSource;
		author?: MessageAuthor;
	}): Promise<{ id: string }>;
	createSession(
		cwd: string,
		agentArgs: string[] | undefined,
		goalId: string | undefined,
		assistantType: string | undefined,
		opts?: Record<string, unknown>,
	): Promise<{ id: string }>;
	enqueuePrompt(sessionId: string, text: string, opts?: Record<string, unknown>): Promise<{ status: string }>;
	deliverLiveSteer(sessionId: string, message: string, opts?: Record<string, unknown>): Promise<unknown>;
	getErroredPromptRecoveryDecision?(sessionId: string): ErroredPromptRecoveryDecision;
	enqueuePromptForRetryRecovery?(sessionId: string, text: string, opts?: Record<string, unknown>): Promise<{ status: "queued"; queuedId?: string }> | { status: "queued"; queuedId?: string };
	retryLastPrompt?(sessionId: string, opts?: { auto?: boolean; preserveQueueIds?: string[] }): Promise<void>;
	waitForIdle(sessionId: string, timeoutMs: number): Promise<void>;
	getSessionOutput(sessionId: string): Promise<string>;
	getSession(id: string): OrchestrationSessionLike | undefined;
	/** Current accountable producer identity, including live staff/role metadata. */
	resolveSessionAgentAuthor?(id: string): MessageAuthor | undefined;
	getPersistedSession(id: string): PersistedSessionLike | undefined;
	terminateSession(id: string): Promise<boolean>;
	forceAbort(id: string, gracePeriodMs?: number): Promise<void>;
	/**
	 * Whether the session has a LIVE (running) agent process behind it (H1).
	 * `false` for a dormant/restored child (placeholder RpcBridge): `waitForIdle`
	 * on such a child would block on a dead client until timeout, so the core
	 * resolves it immediately from persisted output instead. Optional: when a
	 * view does not implement it the core falls back to the live `waitForIdle`
	 * path (its prior behaviour).
	 */
	isSessionLive?(id: string): boolean;
	/** Pending prompt-queue length for the `queued` status mapping (M3). Optional. */
	getQueuedPromptCount?(id: string): number;
	/**
	 * Stamp the GENERIC persisted terminal marker (`childTerminal:true` +
	 * `terminalAt`) on a child session, so the generic boot-reap
	 * (`shouldReapChildOnBoot` reading `PersistedSessionLike.childTerminal`) can
	 * remove it after a restart even if a dismiss never ran (Decision E /
	 * Findings 3–4). Called best-effort by `dismiss`. The real SessionManager
	 * implementation writes via `updateSessionMeta`/`updateArchivedMeta`. Optional:
	 * when a view does not implement it, `dismiss` simply skips the stamp.
	 */
	markChildTerminal?(childSessionId: string): void;
}

export interface OrchestrationCoreDeps {
	sessionManager: OrchestrationSessionView;
	/** Returns `${provider}/${id}` for the owner's CURRENT model (server.ts:1536 shape). */
	resolveSessionModel: (id: string) => string | undefined;
	resolveSessionThinking?: (id: string) => string | undefined;
	/**
	 * Returns the owner's FULL effective tool catalogue (every tool the owner is
	 * granted). Used to synthesize an explicit "all-except-spawn-verbs" allow-list
	 * for the child when the owner is UNRESTRICTED — so a child never carries a
	 * spawn verb in its REGISTERED tool set (§7). `assertCanSpawn` stays the
	 * runtime belt. Optional: when absent/empty (e.g. no tool manager in tests),
	 * the child falls back to inheriting the owner's allow-list unchanged.
	 */
	resolveEffectiveTools?: (id: string) => string[] | undefined;
	/**
	 * Resolve a ROLE's effective tool grants (the explicit allow-list a role
	 * session would receive), for role-carrying spawns (Decision A.2). Production
	 * wires it to `computeEffectiveAllowedTools(toolManager, role, groupPolicyStore,
	 * mcpManager)`. When a `role` is set on a spawn the child is granted the ROLE's
	 * tools and NEVER falls back to the owner's — if this dep is absent or returns
	 * empty, the spawn throws `ROLE_TOOLS_UNRESOLVED` (FAIL CLOSED).
	 */
	resolveRoleAllowedTools?: (roleName: string, projectId?: string) => string[] | undefined;
	audit?: (event: OrchestrationAuditEvent) => void;
	/** Optional reader for the `read` verb (delegates to read_session machinery). */
	readTranscript?: (sessionId: string, opts?: ReadTranscriptLike) => Promise<unknown>;
}

export class OrchestrationCoreError extends Error {
	constructor(message: string, readonly code: string = "ORCHESTRATION_ERROR") {
		super(message);
		this.name = "OrchestrationCoreError";
	}
}

const OUTPUT_TAIL_CHARS = 1500;

export class OrchestrationCore {
	/** In-memory index keyed on owner session id (NOT persisted). */
	private index = new Map<string, ChildHandle[]>();
	/** childSessionId → owner/kind record for idempotent duplicate dismiss classification. */
	private dismissedChildren = new Map<string, { ownerSessionId: string; childKind?: ChildKind }>();

	constructor(private deps: OrchestrationCoreDeps) {}

	private audit(ev: OrchestrationAuditEvent): void {
		try {
			if (this.deps.audit) this.deps.audit(ev);
			// Internal orchestration trail (spawn/wait/terminal) — debug-only by default.
			else if (process.env.BOBBIT_DEBUG) console.log(`[orchestration] ${ev.event} owner=${ev.ownerSessionId} child=${ev.childSessionId ?? "-"} kind=${ev.childKind ?? "-"}${ev.detail ? ` ${ev.detail}` : ""}`);
		} catch { /* audit must never throw into the orchestration path */ }
	}

	/**
	 * The SINGLE recursion guard (§7). Throws if `ownerId` is itself a bound
	 * child (has `delegateOf` or any `childKind`). Called by BOTH the agent-tool
	 * spawn path (A) and `host.agents.spawn` (C). No child of any kind spawns
	 * grandchildren.
	 */
	assertCanSpawn(ownerId: string): void {
		const ps = this.deps.sessionManager.getPersistedSession(ownerId);
		if (ps && (ps.delegateOf || ps.childKind)) {
			throw new OrchestrationCoreError(
				"Spawning child agents is not permitted from a child session (no grandchildren).",
				"NO_GRANDCHILDREN",
			);
		}
	}

	/**
	 * Compute the child's allowedTools = owner's effective set MINUS every spawn
	 * verb (§7). A child must never have a spawn verb REGISTERED, so even when the
	 * owner is unrestricted (no explicit allow-list) we resolve the owner's full
	 * effective tool catalogue and subtract the spawn verbs — producing an
	 * explicit "all-except-spawn-verbs" list rather than `undefined` (which the
	 * tool-activation layer treats as "all tools", spawn verbs included).
	 */
	private childAllowedTools(ownerId: string, readOnly?: boolean, role?: string): string[] | undefined {
		// A spawn verb is ALWAYS stripped (recursion guard, §7); a mutating tool is
		// additionally stripped for a read-only child (§2.2) so it is never even
		// REGISTERED on the child — the same allow-list mechanism pr-walkthrough uses.
		const deny = (t: string): boolean =>
			SPAWN_VERBS.includes(t) || (readOnly === true && READ_ONLY_DENY_TOOLS.includes(t));
		// FAIL CLOSED (Decision A.2): a role-carrying spawn is granted the ROLE's
		// tools, NEVER the owner's. If the role's grants cannot be resolved
		// (dep absent / empty), throw rather than silently inheriting the owner's
		// broader tools. The owner-derived fallback below is reached ONLY for
		// role-LESS delegate/team spawns.
		if (role) {
			// Thread the OWNER's projectId so a project-scoped/custom role resolves via
			// the owner's project cascade (mirrors the full-lifecycle path which reads
			// `ownerPs?.projectId`); otherwise a role that only exists in the owner's
			// project would fail closed with ROLE_TOOLS_UNRESOLVED.
			const projectId = this.deps.sessionManager.getPersistedSession(ownerId)?.projectId;
			const roleTools = this.deps.resolveRoleAllowedTools?.(role, projectId);
			if (!roleTools || roleTools.length === 0) {
				throw new OrchestrationCoreError(
					`Cannot resolve tool grants for role ${role}`, "ROLE_TOOLS_UNRESOLVED");
			}
			return roleTools.filter(t => !deny(t));
		}
		const explicit = this.deps.sessionManager.getSession(ownerId)?.allowedTools;
		if (explicit && explicit.length > 0) {
			return explicit.filter(t => !deny(t));
		}
		// Owner is UNRESTRICTED — synthesize an explicit list from the full
		// effective catalogue so spawn (and, when read-only, mutating) verbs are
		// never registered on the child.
		const effective = this.deps.resolveEffectiveTools?.(ownerId);
		if (effective && effective.length > 0) {
			return effective.filter(t => !deny(t));
		}
		// No catalogue available (e.g. no tool manager) — cannot synthesize a list;
		// fall back to undefined. assertCanSpawn still blocks recursion at runtime.
		// (Production always wires resolveEffectiveTools, so a read-only child always
		// gets an enforced allow-list here.)
		return undefined;
	}

	private addHandle(handle: ChildHandle): void {
		const list = this.index.get(handle.ownerSessionId) ?? [];
		const existingIndex = list.findIndex(h => h.sessionId === handle.sessionId);
		if (existingIndex === -1) {
			list.push(handle);
		} else {
			list[existingIndex] = { ...list[existingIndex], ...handle };
		}
		this.index.set(handle.ownerSessionId, list);
	}

	private trustedRestorableChild(ps: PersistedSessionLike): { ownerSessionId: string; childKind: ChildKind } | undefined {
		if (ps.archived) return undefined;
		if (ps.delegateOf) {
			// `delegateOf` was historically API-mutable. Only promote it back into the
			// trusted live-dismiss index when the row also has the server-created durable
			// delegate task. A patched top-level or first-class child can gain delegateOf,
			// but cannot gain `instructions` through the public metadata PATCH route.
			if (typeof ps.instructions !== "string") return undefined;
			return { ownerSessionId: ps.delegateOf, childKind: (ps.childKind as ChildKind) ?? "delegate" };
		}
		if (ps.parentSessionId && ps.childKind) {
			return { ownerSessionId: ps.parentSessionId, childKind: ps.childKind as ChildKind };
		}
		return undefined;
	}

	private resolveOwnerCwd(ownerId: string): string | undefined {
		return this.deps.sessionManager.getSession(ownerId)?.cwd;
	}

	private resolveOwnerAuthor(ownerId: string): MessageAuthor | undefined {
		if (this.deps.sessionManager.resolveSessionAgentAuthor) {
			return this.deps.sessionManager.resolveSessionAgentAuthor(ownerId);
		}
		// Structural test/extension views predating the resolver retain the legacy
		// live-session fallback. Production SessionManager always takes the branch above.
		const owner = this.deps.sessionManager.getSession(ownerId);
		return owner ? agentAuthorForSession(owner) : undefined;
	}

	async spawn(opts: SpawnOpts): Promise<ChildHandle> {
		this.assertCanSpawn(opts.ownerSessionId);

		const childKind: ChildKind = opts.childKind ?? "delegate";
		const model = opts.model ?? this.deps.resolveSessionModel(opts.ownerSessionId);
		const thinkingLevel = opts.thinkingLevel ?? this.deps.resolveSessionThinking?.(opts.ownerSessionId);
		const childAllowed = this.childAllowedTools(opts.ownerSessionId, opts.readOnly, opts.role);
		// `opts.lifecycle` wins when set; otherwise default "bare" (a read-only child
		// with no explicit lifecycle still goes bare — no regression). An explicit
		// `lifecycle:"full"` is honored even under readOnly (Decision A.1).
		const lifecycle: SpawnLifecycle = opts.lifecycle ?? (opts.readOnly ? "bare" : "bare");

		const sharedMode = !opts.worktree || opts.worktree.mode === "shared";
		const ownerAuthor = this.resolveOwnerAuthor(opts.ownerSessionId);

		let childId: string;
		if (lifecycle === "bare" && sharedMode) {
			const cwd = opts.worktree?.mode === "shared"
				? opts.worktree.cwd
				: (this.resolveOwnerCwd(opts.ownerSessionId) ?? process.cwd());
			const child = await this.deps.sessionManager.createDelegateSession(opts.ownerSessionId, {
				instructions: opts.instructions,
				cwd,
				title: opts.title,
				context: opts.context,
				allowedTools: childAllowed,
				initialModel: model,
				initialThinkingLevel: thinkingLevel,
				// NON-SECRET tool-scoping env (additive; never widens sandbox/project scope).
				env: opts.toolEnv,
				// Persist the source discriminator + read-only marker so they survive
				// restart (§3): rebuildIndexFromPersisted reads childKind to reconstruct
				// e.g. host-agents children instead of mislabelling them "delegate".
				childKind,
				role: opts.role,
				readOnly: opts.readOnly,
				source: "agent",
				author: ownerAuthor,
			});
			childId = child.id;
		} else {
			// Full lifecycle and/or sub-branch worktree → createSession path.
			//
			// SANDBOX / CREDENTIAL INHERITANCE (the one hard invariant, §8.3).
			// Unlike `createDelegateSession` (the bare path, which reads the parent
			// record and propagates sandbox + project scope itself), `createSession`
			// derives `projectId` only from its own opts/goalId and `sandboxed` only
			// from `opts.sandboxed` — it does NOT infer either from `parentSessionId`.
			// So we MUST thread the OWNER's persisted sandbox + project scope here, or
			// a `lifecycle:"full"` child (host.agents or team_delegate) from a
			// sandboxed / project-scoped owner could be created OUTSIDE that scope — a
			// privilege escalation. This inherits the owner's scope verbatim and never
			// widens it (there is no per-call option that could).
			const ownerPs = this.deps.sessionManager.getPersistedSession(opts.ownerSessionId);
			const ownerSandboxed = ownerPs?.sandboxed === true;
			const worktreeOpts = opts.worktree?.mode === "sub-branch"
				? { repoPath: opts.worktree.repoPath }
				: undefined;
			const goalId = opts.worktree?.mode === "sub-branch" ? opts.worktree.goalId : undefined;
			const cwd = opts.worktree?.mode === "sub-branch"
				? opts.worktree.cwd
				// Shared-cwd: when the owner is sandboxed prefer its VALIDATED persisted
				// host-side cwd (mirrors createDelegateSession — never trust a
				// container-internal cwd); otherwise the live owner cwd.
				: (ownerSandboxed ? ownerPs?.cwd : undefined)
					?? this.resolveOwnerCwd(opts.ownerSessionId)
					?? process.cwd();
			const createOpts: Record<string, unknown> = {
				parentSessionId: opts.ownerSessionId,
				childKind,
				// Visible session title (Decision A.5 / launch-ux §5.3). createSession
				// otherwise defaults to "New session"; thread it so a launcher-supplied
				// title (e.g. "PR Walkthrough") names the sidebar entry.
				title: opts.title,
				readOnly: opts.readOnly,
				allowedTools: childAllowed,
				initialModel: model,
				initialThinkingLevel: thinkingLevel,
				roleName: opts.role,
				// NON-SECRET tool-scoping env (additive; never widens sandbox/project scope —
				// sandboxed/projectId below are derived from the OWNER and are not affected).
				env: opts.toolEnv,
				worktreeOpts,
				// Inherit the owner's sandbox + project scope (never exceed it). For the
				// sub-branch (goal) path `projectId` may be undefined here — createSession
				// then falls back to deriving it from `goalId`.
				sandboxed: ownerSandboxed || undefined,
				projectId: ownerPs?.projectId,
			};
			if (opts.worktree?.mode === "sub-branch") {
				createOpts.sandboxBranch = opts.worktree.branch;
			}
			const child = await this.deps.sessionManager.createSession(cwd, undefined, goalId, undefined, createOpts);
			childId = child.id;
			// Full createSession children still need the spawn prompt delivered — UNLESS
			// the caller defers it (Decision A.5): a deferred launch creates the visible
			// child but does NOT enqueue the kickoff, so the caller can write its binding
			// before starting the child via an explicit follow-up `prompt`.
			if (!opts.deferInitialPrompt) {
				await this.deps.sessionManager.enqueuePrompt(childId, opts.instructions, {
					source: "agent",
					author: ownerAuthor,
				});
			}
		}

		const title = opts.title ?? this.deps.sessionManager.getSession(childId)?.title;
		const handle: ChildHandle = {
			sessionId: childId,
			ownerSessionId: opts.ownerSessionId,
			childKind,
			spawnedAt: Date.now(),
			title,
			blocking: false,
		};
		this.addHandle(handle);
		this.audit({ event: "spawn", ownerSessionId: opts.ownerSessionId, childSessionId: childId, childKind });
		return handle;
	}

	/** Register an externally-created child (e.g. team worker) in the runtime index. */
	registerChild(handle: Omit<ChildHandle, "spawnedAt" | "blocking"> & { spawnedAt?: number; blocking?: boolean }): void {
		this.addHandle({
			sessionId: handle.sessionId,
			ownerSessionId: handle.ownerSessionId,
			childKind: handle.childKind,
			title: handle.title,
			spawnedAt: handle.spawnedAt ?? Date.now(),
			blocking: handle.blocking ?? false,
		});
	}

	/** Owner recorded by a previous successful/idempotent dismiss, if any. */
	dismissedOwnerOf(sessionId: string): string | undefined {
		return this.dismissedChildren.get(sessionId)?.ownerSessionId;
	}

	/** Trusted child kind for a child owned (currently or previously) by this owner. */
	ownedChildKind(ownerId: string, sessionId: string): ChildKind | undefined {
		const handle = (this.index.get(ownerId) ?? []).find(h => h.sessionId === sessionId);
		if (handle) return handle.childKind;
		const persisted = this.deps.sessionManager.getPersistedSession(sessionId);
		const remembered = this.dismissedChildren.get(sessionId);
		if (remembered?.ownerSessionId === ownerId) {
			return remembered.childKind ?? this.persistedChildKind(ownerId, persisted);
		}
		const persistedOwned = persisted?.delegateOf === ownerId || persisted?.parentSessionId === ownerId || persisted?.teamLeadSessionId === ownerId;
		return persistedOwned ? this.persistedChildKind(ownerId, persisted) : undefined;
	}

	private persistedChildKind(ownerId: string, persisted: PersistedSessionLike | undefined): ChildKind | undefined {
		if (!persisted) return undefined;
		if (persisted.childKind) return persisted.childKind as ChildKind;
		const owned = persisted.delegateOf === ownerId || persisted.parentSessionId === ownerId || persisted.teamLeadSessionId === ownerId;
		// Old records without a source discriminator are never host.agents children.
		return owned ? "delegate" : undefined;
	}

	private rememberDismissed(childId: string, ownerId: string, childKind: ChildKind | undefined): void {
		this.dismissedChildren.set(childId, { ownerSessionId: ownerId, childKind });
	}

	/** Forget a child from the runtime index (cleanup after dismiss/terminate). */
	forgetChild(sessionId: string): void {
		for (const [owner, list] of this.index) {
			const next = list.filter(h => h.sessionId !== sessionId);
			if (next.length !== list.length) {
				if (next.length === 0) this.index.delete(owner);
				else this.index.set(owner, next);
			}
		}
	}

	/** Forget all children of an owner from the runtime index (owner terminated). */
	forgetOwner(ownerId: string): void {
		this.index.delete(ownerId);
	}

	list(ownerId: string): ChildHandle[] {
		return [...(this.index.get(ownerId) ?? [])];
	}

	/** Resolve a tracked child handle, enforcing own-children scoping. */
	private requireOwnChild(ownerId: string, childId: string): ChildHandle {
		const handle = (this.index.get(ownerId) ?? []).find(h => h.sessionId === childId);
		if (!handle) {
			throw new OrchestrationCoreError(
				`Child session ${childId} is not owned by ${ownerId}.`,
				"NOT_OWN_CHILD",
			);
		}
		return handle;
	}

	async prompt(ownerId: string, childId: string, message: string): Promise<{ status: "dispatched" | "queued" }>;
	async prompt(
		ownerId: string,
		childId: string,
		message: string,
		opts: { mode?: SessionPromptMode; defaultMode?: SessionPromptMode },
	): Promise<DeliverSessionPromptResult>;
	async prompt(
		ownerId: string,
		childId: string,
		message: string,
		opts?: { mode?: SessionPromptMode; defaultMode?: SessionPromptMode },
	): Promise<DeliverSessionPromptResult | { status: "dispatched" | "queued" }> {
		this.requireOwnChild(ownerId, childId);
		const ownerAuthor = this.resolveOwnerAuthor(ownerId);
		const result = await deliverSessionPrompt({
			getSession: (id) => this.deps.sessionManager.getSession(id),
			enqueuePrompt: async (id, text, promptOpts) => {
				const queued = await this.deps.sessionManager.enqueuePrompt(id, text, promptOpts);
				return { status: queued?.status === "queued" ? "queued" : "dispatched" };
			},
			deliverLiveSteer: (id, text, steerOpts) => this.deps.sessionManager.deliverLiveSteer(id, text, steerOpts),
			getErroredPromptRecoveryDecision: this.deps.sessionManager.getErroredPromptRecoveryDecision
				? (id) => this.deps.sessionManager.getErroredPromptRecoveryDecision!(id)
				: undefined,
			enqueuePromptForRetryRecovery: this.deps.sessionManager.enqueuePromptForRetryRecovery
				? async (id, text, promptOpts) => this.deps.sessionManager.enqueuePromptForRetryRecovery!(id, text, promptOpts)
				: undefined,
			retryLastPrompt: this.deps.sessionManager.retryLastPrompt
				? (id, retryOpts) => this.deps.sessionManager.retryLastPrompt!(id, retryOpts)
				: undefined,
		}, childId, message, {
			mode: opts?.mode,
			defaultMode: opts ? (opts.defaultMode ?? "steer") : "prompt",
			source: "agent",
			author: ownerAuthor,
		});
		this.audit({ event: result.mode === "steer" ? "steer" : "prompt", ownerSessionId: ownerId, childSessionId: childId });
		return opts ? result : { status: "status" in result && result.status === "queued" ? "queued" : "dispatched" };
	}

	async steer(ownerId: string, childId: string, message: string): Promise<unknown> {
		this.requireOwnChild(ownerId, childId);
		const session = this.deps.sessionManager.getSession(childId);
		if (!session || session.status !== "streaming") {
			throw new OrchestrationCoreError(
				"Agent is not currently streaming — use prompt instead.",
				"NOT_STREAMING",
			);
		}
		const result = await this.deps.sessionManager.deliverLiveSteer(childId, message, {
			source: "agent",
			author: this.resolveOwnerAuthor(ownerId),
		});
		this.audit({ event: "steer", ownerSessionId: ownerId, childSessionId: childId });
		return result;
	}

	async abort(ownerId: string, childId: string): Promise<void> {
		this.requireOwnChild(ownerId, childId);
		await this.deps.sessionManager.forceAbort(childId);
		this.audit({ event: "abort", ownerSessionId: ownerId, childSessionId: childId });
	}

	async dismiss(ownerId: string, childId: string): Promise<DismissResult> {
		const handle = (this.index.get(ownerId) ?? []).find(h => h.sessionId === childId);
		const live = this.deps.sessionManager.getSession(childId);
		const persisted = this.deps.sessionManager.getPersistedSession(childId);
		const remembered = this.dismissedChildren.get(childId);
		const rememberedOwner = remembered?.ownerSessionId;
		const persistedOwned = persisted?.delegateOf === ownerId || persisted?.parentSessionId === ownerId || persisted?.teamLeadSessionId === ownerId;
		const rememberedOwned = rememberedOwner === ownerId;
		const exists = !!live || !!persisted || !!rememberedOwner;
		const isLive = this.deps.sessionManager.isSessionLive?.call(this.deps.sessionManager, childId);
		const isCurrentlyLive = !!live && live.status !== "terminated" && persisted?.archived !== true && isLive !== false;

		if (isCurrentlyLive && !handle) {
			// Live termination is authorized only by the server-owned runtime child index.
			// Persisted ownership fields are API-mutable, so they are used solely for
			// already-dismissed idempotency once the target is no longer live.
			return { ok: false, status: "not-owned", sessionId: childId, message: `Child session ${childId} is not owned by ${ownerId}.`, retryable: false };
		}

		if (!handle && !persistedOwned && !rememberedOwned) {
			return exists
				? { ok: false, status: "not-owned", sessionId: childId, message: `Child session ${childId} is not owned by ${ownerId}.`, retryable: false }
				: { ok: false, status: "not-found", sessionId: childId, message: `Child session ${childId} was not found.`, retryable: false };
		}

		if (!isCurrentlyLive) {
			this.rememberDismissed(childId, ownerId, handle?.childKind ?? this.persistedChildKind(ownerId, persisted) ?? remembered?.childKind);
			this.forgetChild(childId);
			return { ok: true, status: "already-dismissed", sessionId: childId, message: `Child session ${childId} is already dismissed.`, retryable: false };
		}

		// Stamp the GENERIC persisted terminal marker BEFORE terminating, so a restart
		// between here and the terminate still lets the generic boot-reap remove the
		// child (Decision E / Findings 3–4). Best-effort: never let it break dismiss.
		try {
			this.deps.sessionManager.markChildTerminal?.(childId);
		} catch (err) {
			console.error(`[orchestration] markChildTerminal failed for ${childId}:`, err);
		}
		try {
			const ok = await this.deps.sessionManager.terminateSession(childId);
			this.rememberDismissed(childId, ownerId, handle?.childKind ?? this.persistedChildKind(ownerId, persisted) ?? remembered?.childKind);
			this.forgetChild(childId);
			this.audit({ event: "dismiss", ownerSessionId: ownerId, childSessionId: childId });
			return ok
				? { ok: true, status: "dismissed", sessionId: childId, message: `Child session ${childId} dismissed.`, retryable: false }
				: { ok: true, status: "already-dismissed", sessionId: childId, message: `Child session ${childId} is already dismissed.`, retryable: false };
		} catch (err) {
			return { ok: false, status: "failed", sessionId: childId, message: `Failed to dismiss child session ${childId}: ${err instanceof Error ? err.message : String(err)}`, retryable: true };
		}
	}

	async read(ownerId: string, childId: string, opts?: ReadTranscriptLike): Promise<unknown> {
		this.requireOwnChild(ownerId, childId);
		if (this.deps.readTranscript) return this.deps.readTranscript(childId, opts);
		return { output: await this.deps.sessionManager.getSessionOutput(childId) };
	}

	/**
	 * Per-child settle: never rejects — always resolves to a settled `ChildStatus`
	 * (idle or terminal, §2.3).
	 *
	 * H1 — dormant/restored children: a child re-added DORMANT on restart
	 * (`addDormantSession`: status "terminated" + placeholder RpcBridge) has no
	 * live process, so `waitForIdle` would subscribe to a dead client and block
	 * until `timeoutMs`. Instead, when the session is NOT live we resolve
	 * IMMEDIATELY from persisted state: a child that completed before the restart
	 * has persisted transcript output → treated as `idle` (collectable); one with
	 * no persisted result → `terminated`. Either way there is no full-timeout block,
	 * so the restart flow (reminder → team_wait → collect) actually collects.
	 */
	private async settle(childId: string, timeoutMs: number): Promise<{ id: string; status: ChildStatus }> {
		const isLive = this.deps.sessionManager.isSessionLive;
		if (isLive && isLive.call(this.deps.sessionManager, childId) === false) {
			const out = await this.deps.sessionManager.getSessionOutput(childId).catch(() => "");
			return { id: childId, status: out.trim().length > 0 ? "idle" : "terminated" };
		}
		return this.deps.sessionManager.waitForIdle(childId, timeoutMs)
			.then(() => ({ id: childId, status: "idle" as ChildStatus }))
			.catch((err) => ({ id: childId, status: classifyTerminal(err) as ChildStatus }));
	}

	private childTitle(childId: string): string | undefined {
		return this.deps.sessionManager.getSession(childId)?.title
			?? this.deps.sessionManager.getPersistedSession(childId)?.title;
	}

	/**
	 * Live (non-settled) status for a child, including the `queued` mapping (M3):
	 * a non-streaming child with pending prompt-queue rows is reported `queued`.
	 */
	private liveChildStatus(childId: string): ChildStatus {
		const status = this.deps.sessionManager.getSession(childId)?.status;
		const queuedPromptCount = this.deps.sessionManager.getQueuedPromptCount?.(childId)
			?? this.deps.sessionManager.getSession(childId)?.queuedPromptCount;
		return liveStatusToChildStatus(status, { queuedPromptCount });
	}

	/**
	 * The single `wait` primitive (§2.3). `policy:"all"` resolves when EVERY
	 * awaited child is settled (idle or terminal) and never rejects on one
	 * crash. `policy:"first"` resolves on the FIRST settled child. Both share
	 * the catch-wrapped `settle`.
	 */
	async wait(
		ownerId: string,
		childIds: string[],
		opts: { policy: "first" | "all"; timeoutMs: number },
	): Promise<WaitResult> {
		for (const id of childIds) this.requireOwnChild(ownerId, id);
		this.audit({ event: "wait", ownerSessionId: ownerId, detail: `policy=${opts.policy} n=${childIds.length}` });

		const settledStatus = new Map<string, ChildStatus>();

		if (opts.policy === "all") {
			const settled = await Promise.all(childIds.map(id => this.settle(id, opts.timeoutMs)));
			for (const s of settled) settledStatus.set(s.id, s.status);
		} else {
			// Race: first settled wins. Other settle promises keep running with a
			// no-op catch already attached (no unhandled rejection).
			const first = await Promise.race(childIds.map(id => this.settle(id, opts.timeoutMs)));
			settledStatus.set(first.id, first.status);
		}

		const statuses = childIds.map(id => {
			// A settled child carries its resolved (idle/terminal) status; the rest are
			// reported with their LIVE status (incl. the M3 `queued` mapping).
			const status: ChildStatus = settledStatus.get(id) ?? this.liveChildStatus(id);
			return { sessionId: id, status, title: this.childTitle(id) };
		});

		const firstSettled = statuses.find(s => isSettledStatus(s.status));
		let outputTail: string | undefined;
		if (firstSettled) {
			const full = await this.deps.sessionManager.getSessionOutput(firstSettled.sessionId).catch(() => "");
			outputTail = full.length > OUTPUT_TAIL_CHARS ? full.slice(-OUTPUT_TAIL_CHARS) : full;
		}
		const remaining = statuses.filter(s => !isSettledStatus(s.status)).length;

		return {
			firstIdle: firstSettled?.sessionId,
			firstIsTerminal: firstSettled ? isTerminalStatus(firstSettled.status) : undefined,
			statuses,
			outputTail,
			remaining,
		};
	}

	/**
	 * Rebuild the in-memory index on boot from persisted session fields (§3).
	 * A child is a non-archived persisted session whose ownership fields match a
	 * server-created child shape. Blocking-ness is never persisted, so every
	 * restored child is `blocking:false`.
	 */
	rebuildIndexFromPersisted(persisted: PersistedSessionLike[]): void {
		this.index.clear();
		for (const ps of persisted) {
			const restored = this.trustedRestorableChild(ps);
			if (!restored) continue;
			this.addHandle({
				sessionId: ps.id,
				ownerSessionId: restored.ownerSessionId,
				childKind: restored.childKind,
				title: ps.title,
				spawnedAt: Date.now(),
				blocking: false,
			});
		}
	}

	/**
	 * After boot, inject a system reminder into every owner that has ≥1 live
	 * restored child (restart survival, §4). The owner re-collects through the
	 * shared `team_wait` path — no transparent tool-call resumption.
	 *
	 * `filterOwner` lets callers skip child kinds handled elsewhere; the boot path
	 * uses `shouldSendRestartCollectionReminder` for that policy.
	 */
	async remindOwnersWithLiveChildren(filter?: (handle: ChildHandle) => boolean): Promise<number> {
		let reminded = 0;
		for (const [ownerId, handlesAll] of this.index) {
			const handles = filter ? handlesAll.filter(filter) : handlesAll;
			if (handles.length === 0) continue;
			// Only remind owners that are themselves restorable (exist, not a child).
			const ownerPs = this.deps.sessionManager.getPersistedSession(ownerId);
			if (!ownerPs || ownerPs.archived) continue;
			const enumerated = handles
				.map(h => `${h.sessionId}${h.title ? ` "${h.title}"` : ""}`)
				.join(", ");
			const msg =
				`[ORCHESTRATION] The gateway restarted. You have ${handles.length} live child agent(s) ` +
				`from before the restart: ${enumerated}. Their results were not collected. Call ` +
				`team_wait to collect them (it returns on the first child idle and tells you who remains).`;
			try {
				await this.deps.sessionManager.enqueuePrompt(ownerId, msg, { source: "system", isSteered: true });
				this.audit({ event: "reminder", ownerSessionId: ownerId, detail: `${handles.length} children` });
				reminded++;
			} catch (err) {
				console.error(`[orchestration] Failed to remind owner ${ownerId} of live children:`, err);
			}
		}
		return reminded;
	}

	/** Reap-on-boot decision (generalized §5). Exposed as a method for parity/testing. */
	shouldReapChildOnBoot(input: ReapInput): ReapDecision {
		return shouldReapChildOnBoot(input);
	}
}
