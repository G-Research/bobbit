/**
 * One-shot backfill migration for sessions that lost their `staffId`
 * association before the staffId-persistence fix landed. For sessions
 * created AFTER the fix this migration is a no-op — `staffId` already
 * round-trips through `createSession` opts → plan → `persistOnce`. See
 * `session-manager.ts::createSession` (both plan builders) and
 * `staff-manager.ts` (both `createSession` call sites) for the spawn-path
 * wires; `tests/unit/core/staff-session-staffid-persistence.unit.test.ts` pins them.
 *
 * Background: prior to the fix, `StaffManager` set `session.staffId = id`
 * purely in memory — `SessionManager.createSession()` never accepted `staffId`
 * in its opts, so `plan.staffId` stayed undefined and `persistOnce` wrote
 * `staffId: undefined` to disk. On the next respawn, `restoreSession` read
 * `ps.staffId = undefined`, never set `BOBBIT_STAFF_ID`, and
 * `defaults/tools/inbox/extension.ts` silently refused to register the three
 * inbox tools.
 *
 * Match algorithm: walk every project context's `SessionStore` and skip every
 * session that already has a `staffId`. Prefer an exact `currentSessionId`
 * owner. For legacy records without that pointer, require title plus worktree /
 * cwd agreement and heal only when exactly one staff record matches. Ambiguous
 * fork names and shared cwd values are deliberately left untouched. Healed via
 * `store.update(id, { staffId })`.
 *
 * Behaviour contract:
 *   - **Runs once at server boot**, from `createGateway` in `server.ts`
 *     after `StaffManager` is wired and all project contexts are loaded.
 *   - **Idempotent**: sessions that already carry `staffId` are skipped.
 *     Running the migration twice is a no-op.
 *   - **Loud logging**: warn-level log per backfilled session so the
 *     underlying bug doesn't get masked next time.
 *
 * Lives in a dedicated module (not on `SessionManager`) so the unit test
 * can exercise the real implementation without dragging in
 * `session-manager.ts`'s transitive flexsearch import.
 */

import type { SessionStore } from "./session-store.js";

/** Subset of `PersistedStaff` the backfill consults. */
export interface BackfillStaff {
	id: string;
	name: string;
	worktreePath?: string;
	cwd: string;
	currentSessionId?: string;
	projectId?: string;
}

/** Subset of `ProjectContextManager` the backfill consults. */
export interface BackfillPcm {
	all(): IterableIterator<{ sessionStore: SessionStore; project?: { id: string } }>;
}

/** Subset of `StaffManager` the backfill consults. */
export interface BackfillStaffManager {
	listStaff(): BackfillStaff[];
}

/**
 * Run the backfill across all project contexts. Returns the number of
 * sessions that were healed. Caller is responsible for logging the summary
 * at the call site if desired; per-session warn logs are emitted here.
 */
export function backfillStaffIds(pcm: BackfillPcm, staffManager: BackfillStaffManager): number {
	const allStaff = staffManager.listStaff();
	if (allStaff.length === 0) return 0;
	let backfilled = 0;
	for (const ctx of pcm.all()) {
		const projectStaff = ctx.project?.id
			? allStaff.filter(staff => !staff.projectId || staff.projectId === ctx.project!.id)
			: allStaff;
		for (const ps of ctx.sessionStore.getAll()) {
			if (ps.staffId) continue;
			const exactOwners = projectStaff.filter(s => s.currentSessionId === ps.id);
			const legacyMatches = exactOwners.length === 0
				? projectStaff.filter(s =>
					s.name === ps.title &&
					(
						(!!s.worktreePath && (s.worktreePath === ps.worktreePath || s.worktreePath === ps.cwd))
						|| (!!ps.cwd && s.cwd === ps.cwd)
					),
				)
				: [];
			const candidates = exactOwners.length > 0 ? exactOwners : legacyMatches;
			if (candidates.length !== 1) continue;
			const match = candidates[0];
			console.warn(
				`[staff-backfill] backfilling staffId="${match.id}" for session=${ps.id} ` +
				`(title="${ps.title}", cwd="${ps.cwd}", worktreePath="${ps.worktreePath ?? ""}"); ` +
				`session predates the staffId-persistence fix — inbox tools would otherwise ` +
				`be missing on next respawn`,
			);
			ctx.sessionStore.update(ps.id, { staffId: match.id });
			backfilled++;
		}
	}
	if (backfilled > 0) {
		console.warn(`[staff-backfill] healed ${backfilled} session(s)`);
	}
	return backfilled;
}
