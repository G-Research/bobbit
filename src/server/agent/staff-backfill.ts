/**
 * One-shot backfill migration for sessions that lost their `staffId`
 * association before the staffId-persistence fix landed. For sessions
 * created AFTER the fix this migration is a no-op — `staffId` already
 * round-trips through `createSession` opts → plan → `persistOnce`. See
 * `session-manager.ts::createSession` (both plan builders) and
 * `staff-manager.ts` (both `createSession` call sites) for the spawn-path
 * wires; `tests/staff-session-staffid-persistence.test.ts` pins them.
 *
 * Background: prior to the fix, `StaffManager` set `session.staffId = id`
 * purely in memory — `SessionManager.createSession()` never accepted `staffId`
 * in its opts, so `plan.staffId` stayed undefined and `persistOnce` wrote
 * `staffId: undefined` to disk. On the next respawn, `restoreSession` read
 * `ps.staffId = undefined`, never set `BOBBIT_STAFF_ID`, and
 * `defaults/tools/inbox/extension.ts` silently refused to register the three
 * inbox tools.
 *
 * Match algorithm: walk every project context's `SessionStore`, find
 * sessions with no `staffId` whose `title` matches a known staff `name`
 * AND whose `worktreePath` / `cwd` matches the staff's `worktreePath`
 * (with a `cwd === cwd` fallback for staff that lack `worktreePath`).
 * Title alone is too weak — a bare title match WITHOUT the path agreement
 * is NOT enough to trigger a backfill. Healed via `store.update(id, { staffId })`.
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
}

/** Subset of `ProjectContextManager` the backfill consults. */
export interface BackfillPcm {
	all(): IterableIterator<{ sessionStore: SessionStore }>;
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
		for (const ps of ctx.sessionStore.getAll()) {
			if (ps.staffId) continue;
			const match = allStaff.find(s =>
				s.name === ps.title &&
				(
					(!!s.worktreePath && (s.worktreePath === ps.worktreePath || s.worktreePath === ps.cwd))
					|| (!!ps.cwd && s.cwd === ps.cwd)
				),
			);
			if (!match) continue;
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
