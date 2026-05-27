// Polling helpers for the human-signoff REST E2E.
//
// Lives under tests/e2e/test-utils/ which is excluded from the no-new-sleeps
// lint (see no-new-sleeps.mjs::walk). Test specs should import from here
// rather than inlining their own setTimeout polling loops.
//
// Imported by:
//   - tests/e2e/human-signoff.spec.ts
import { apiFetch } from "../e2e-setup.js";

/**
 * Poll `GET /api/goals/:goalId/verifications/active` until the named
 * `human-signoff` step on the given signal exposes `awaitingHuman: true`,
 * or until `timeoutMs` elapses (default 5s).
 *
 * @param {string} goalId
 * @param {string} signalId
 * @param {string} stepName
 * @param {number} [timeoutMs]
 * @returns {Promise<{ goalId: string; gateId: string; signalId: string; steps: any[] }>}
 */
export async function waitForAwaitingHuman(goalId, signalId, stepName, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < deadline) {
		const res = await apiFetch(`/api/goals/${goalId}/verifications/active`);
		if (res.ok) {
			const body = await res.json();
			const match = (body.verifications || []).find((v) => v.signalId === signalId);
			if (match) {
				last = match;
				const step = match.steps.find((s) => s.name === stepName);
				if (step?.awaitingHuman === true) return match;
			}
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Timed out waiting for awaitingHuman; last active=${JSON.stringify(last)}`);
}

/**
 * Poll `GET /api/goals/:goalId/gates/:gateId` until `status === expected`
 * or `timeoutMs` elapses (default 5s).
 *
 * @param {string} goalId
 * @param {string} gateId
 * @param {"passed" | "failed"} expected
 * @param {number} [timeoutMs]
 */
export async function waitForGateStatus(goalId, gateId, expected, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < deadline) {
		const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
		if (res.ok) {
			last = await res.json();
			if (last?.status === expected) return last;
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Timed out waiting for gate ${gateId} to reach ${expected}; last=${JSON.stringify(last)}`);
}
