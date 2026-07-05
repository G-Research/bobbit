// Narrow interfaces for what SessionManager actually calls on its
// setter-injected, class-typed collaborators (STR-03). Each interface lists
// ONLY the methods session-manager.ts calls today — verified by direct grep,
// re-check before extending (see docs/design/session-manager-setter-interfaces.md §1.3).
//
// This does not change any runtime behavior: OrchestrationCore, InboxNudger,
// and the staff-record source continue to be the same concrete classes;
// SessionManager's setters and fields simply get typed against these narrower
// shapes instead of the full class type, so a test double no longer needs to
// implement (or `as any`-cast around) the other 10-15 methods it never calls.

import type { PersistedStaff } from "./staff-store.js";
import type { PersistedSessionLike, ChildHandle } from "./orchestration-core.js";

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
