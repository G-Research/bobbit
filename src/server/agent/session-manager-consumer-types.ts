// Narrow interfaces for what SessionManager actually calls on its
// setter-injected, class-typed collaborators (STR-03), plus the swarm
// turn-budget governor seam (S3, extension-seam audit item). Each interface
// lists ONLY the methods session-manager.ts calls today — verified by direct
// grep, re-check before extending (see
// docs/design/session-manager-setter-interfaces.md §1.3 for OrchestrationCore/
// InboxNudger/StaffRecordSource; ~/Documents/dev/bobbit-fable-refactor/
// EXTENSION-SEAM-AUDIT.md's "S3" entry for TurnBudgetGovernor).
//
// This does not change any runtime behavior: OrchestrationCore, InboxNudger,
// the staff-record source, and VerificationHarness continue to be the same
// concrete classes; SessionManager's setters/fields/call sites simply get
// typed against these narrower shapes instead of the full class type, so a
// test double no longer needs to implement (or `as any`-cast around) the
// rest of each collaborator's surface.

import type { PersistedStaff } from "./staff-store.js";
import type { PersistedSessionLike, ChildHandle } from "./orchestration-core.js";
import type { SwarmGovernorAction } from "./swarm-governor.js";

/** What SessionManager calls on OrchestrationCore: 2 call sites in
 *  restoreSessions() (rebuildIndexFromPersisted, remindOwnersWithLiveChildren)
 *  plus a 3rd via optional-chaining in the terminate path (forgetOwner) that
 *  the design doc's `\.orchestrationCore\.` grep pattern missed — re-verified
 *  directly against session-manager.ts (`grep -n "\.orchestrationCore\b"`)
 *  while implementing this interface. All param/return types below are
 *  `orchestration-core.ts`'s own exports — no new types needed. */
export interface OrchestrationCoreView {
	rebuildIndexFromPersisted(persisted: PersistedSessionLike[]): void;
	remindOwnersWithLiveChildren(filter?: (handle: ChildHandle) => boolean): Promise<number>;
	forgetOwner(ownerId: string): void;
}

/** What SessionManager calls on InboxNudger. 1 call site today
 *  (handleAgentLifecycle). */
export interface InboxNudgerView {
	onAgentStart(sessionId: string): void;
}

/** Already the de facto interface on SessionManager's `staffRecordSource` field
 *  — this just gives it a shared, importable name so InboxNudger.ts,
 *  staff-manager.ts, and session-manager.ts don't each restate the same inline
 *  shape. */
export interface StaffRecordSource {
	getStaff(id: string): PersistedStaff | undefined;
}

/**
 * S3 (extension-seam audit, P1) — narrow seam for the swarm turn-budget
 * governor. Before this interface, `trackCostFromEvent`'s per-message hot
 * path reached two levels into `VerificationHarness` directly
 * (`_verificationHarness?.swarmGovernor.checkTokenBudget(...)` and
 * `_verificationHarness?.hardKillSwarmNode(...)`), bypassing every seam. This
 * interface names exactly what that hot path needs: a sync, Map-lookup-cheap
 * decision (`check`) plus an async executor for the rare hard-kill side
 * effect (`hardKill`). `VerificationHarness.turnBudgetGovernor` is the sole
 * production implementation (adapts `swarmGovernor` + `hardKillSwarmNode`
 * once at construction — see verification-harness.ts).
 *
 * Hot-path constraint (pinned by
 * tests/session-manager-turn-budget-governor.test.ts): the common case (no
 * harness, or a goal never `registerNode`-d) must stay a cheap sync
 * property-read + Map-miss — no added awaits or allocations per message.
 */
export interface TurnBudgetGovernor {
	/** Turn-boundary check with the CUMULATIVE token total for the node's
	 *  session. Unregistered goals always return `{kind:"ok"}` — zero
	 *  overhead for every non-swarm session. See swarm-governor.ts's
	 *  `checkTokenBudget` doc. */
	check(goalId: string, totalTokens: number): SwarmGovernorAction;
	/** Executes the (rare) hard-kill side effect for a goal that breached its
	 *  hard-kill margin. Best-effort — never throws (see
	 *  `VerificationHarness.hardKillSwarmNode`'s doc); callers still wrap in
	 *  `.catch()` since this returns a Promise. */
	hardKill(goalId: string, reason: string): Promise<void>;
}
