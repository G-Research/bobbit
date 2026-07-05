/**
 * Per-test entity scope for the shared tier-1 gateway.
 *
 * The gateway fixture is booted once per fork and shared across every test.
 * `createScope(gw)` gives each test a tracker that records the sessions, goals,
 * and projects it creates and deletes them in `afterEach`, restoring the default
 * project so the next test starts from a clean baseline. Cleanup is idempotent
 * and uses a bounded retry to survive Windows file locks (Defender-scanned NTFS
 * briefly holds handles after a delete).
 *
 * Pair with assertNoLeaks() (leak-detector.ts): scope removes owned entities,
 * the detector fails the file if anything survives.
 */
import type { GatewayFixture } from "./gateway.js";

const CLEANUP_RETRIES = 5;
const CLEANUP_RETRY_DELAY_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function withRetry(fn: () => Promise<void>, label: string): Promise<void> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < CLEANUP_RETRIES; attempt++) {
		try { await fn(); return; } catch (err) { lastErr = err; await sleep(CLEANUP_RETRY_DELAY_MS * (attempt + 1)); }
	}
	// Cleanup failures must not silently corrupt later tests — surface loudly.
	throw new Error(`[tests2/scope] cleanup failed for ${label} after ${CLEANUP_RETRIES} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

export interface TestScope {
	/** Track an already-created session id for teardown. */
	trackSession(id: string): string;
	/** Track an already-created goal id for teardown. */
	trackGoal(id: string): string;
	/** Track an already-created project id for teardown. */
	trackProject(id: string): string;
	/** Create a session via the API and track it. */
	createSession(body: Record<string, unknown>): Promise<any>;
	/** Create a goal via the API and track it. */
	createGoal(body: Record<string, unknown>): Promise<any>;
	/** Delete everything this scope created and restore the default project. */
	cleanup(): Promise<void>;
}

export function createScope(gw: GatewayFixture): TestScope {
	const sessions = new Set<string>();
	const goals = new Set<string>();
	const projects = new Set<string>();

	return {
		trackSession(id) { sessions.add(id); return id; },
		trackGoal(id) { goals.add(id); return id; },
		trackProject(id) { projects.add(id); return id; },

		async createSession(body) {
			const payload = { projectId: gw.defaultProjectId, ...body };
			const session = await gw.apiJson<any>("/api/sessions", { method: "POST", body: JSON.stringify(payload) });
			if (session?.id) sessions.add(session.id);
			return session;
		},

		async createGoal(body) {
			const payload = { projectId: gw.defaultProjectId, ...body };
			const goal = await gw.apiJson<any>("/api/goals", { method: "POST", body: JSON.stringify(payload) });
			const id = goal?.id ?? goal?.goalId ?? goal?.session?.goalId;
			if (id) goals.add(id);
			return goal;
		},

		async cleanup() {
			// Order: sessions → goals → projects (children before containers).
			for (const id of sessions) {
				await withRetry(async () => {
					const resp = await gw.api(`/api/sessions/${id}?purge=true`, { method: "DELETE" });
					if (!resp.ok && resp.status !== 404) throw new Error(`session DELETE ${resp.status}`);
				}, `session ${id}`);
			}
			sessions.clear();

			for (const id of goals) {
				await withRetry(async () => {
					const resp = await gw.api(`/api/goals/${id}`, { method: "DELETE" });
					if (!resp.ok && resp.status !== 404) throw new Error(`goal DELETE ${resp.status}`);
				}, `goal ${id}`);
			}
			goals.clear();

			for (const id of projects) {
				if (id === gw.defaultProjectId) continue; // never delete the default project
				await withRetry(async () => {
					const resp = await gw.api(`/api/projects/${id}`, { method: "DELETE" });
					if (!resp.ok && resp.status !== 404) throw new Error(`project DELETE ${resp.status}`);
				}, `project ${id}`);
			}
			projects.clear();

			// Self-heal the default project in case a test mutated or removed it.
			await gw.restoreDefaultProject();
		},
	};
}
