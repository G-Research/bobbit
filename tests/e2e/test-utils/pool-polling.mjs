// Polling helpers for worktree-pool / session-claim E2E specs.
//
// These helpers live under tests/e2e/test-utils/ which is excluded from the
// no-new-sleeps lint (see no-new-sleeps.mjs); inline polling sleeps here are
// the canonical pattern that test specs should reach for instead of rolling
// their own.
//
// Imported by:
//   - tests/e2e/pool-claim-restart-resume.spec.ts
//   - tests/e2e/multi-repo-pool.spec.ts
import { apiFetch } from "../e2e-setup.js";

/**
 * @param {string} projectId
 * @param {number} target
 * @param {number} [timeoutMs]
 * @returns {Promise<number>}
 */
export async function waitForPool(projectId, target, timeoutMs = 30_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const resp = await apiFetch("/api/worktree-pool");
		if (resp.status === 200) {
			const body = await resp.json();
			const entry = body?.pools?.[projectId];
			if (entry && entry.ready >= target) return entry.ready;
		}
		await new Promise(r => setTimeout(r, 200));
	}
	return 0;
}

/**
 * Poll a session until its branch settles to `session/<id8>`.
 * @param {string} sessionId
 * @param {number} [timeoutMs]
 * @returns {Promise<{ branch: string, worktreePath?: string }>}
 */
export async function pollSessionUntilSessionBranch(sessionId, timeoutMs = 15_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const resp = await apiFetch(`/api/sessions/${sessionId}`);
		if (resp.status === 200) {
			const body = await resp.json();
			if (typeof body.branch === "string" && body.branch.startsWith("session/")) {
				return { branch: body.branch, worktreePath: body.worktreePath };
			}
		}
		await new Promise(r => setTimeout(r, 150));
	}
	throw new Error(`session ${sessionId} did not reach session/<id8> branch within ${timeoutMs}ms`);
}

/**
 * Poll a session until it is archived (or returns 404).
 * @param {string} sessionId
 * @param {number} [timeoutMs]
 */
export async function pollSessionUntilArchived(sessionId, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const r = await apiFetch(`/api/sessions/${sessionId}`);
		if (r.status === 404) return;
		if (r.status === 200) {
			const body = await r.json();
			if (body.archived) return;
		}
		await new Promise(r => setTimeout(r, 200));
	}
}

/**
 * Re-fetch a session row until a predicate holds, or timeout. Used for
 * post-PATCH/post-restart settle checks where there's no externally
 * observable signal beyond "the API row reflects the change".
 * @param {string} sessionId
 * @param {(row: any) => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
export async function pollSessionUntil(sessionId, predicate, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		const resp = await apiFetch(`/api/sessions/${sessionId}`);
		if (resp.status === 200) {
			last = await resp.json();
			if (predicate(last)) return last;
		}
		await new Promise(r => setTimeout(r, 100));
	}
	return last;
}
