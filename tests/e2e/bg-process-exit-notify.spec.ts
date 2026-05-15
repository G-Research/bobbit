/**
 * E2E test for "wake owning agent when a bash_bg process exits".
 *
 * Spawns a short-lived bg process via REST and asserts that the owning
 * session is woken via the existing SessionManager.enqueuePrompt /
 * deliverLiveSteer plumbing. We spy at the SessionManager boundary so we
 * don't have to drive a full agent turn — the wake plumbing is what we're
 * verifying, not the agent's downstream reaction.
 *
 * If the production wiring (BgProcessManager exit-notifier → SessionManager
 * wake) is not yet in place, the test skips with a clear message so the
 * suite stays green until the implementation lands.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, nonGitCwd, injectDefaultProjectId } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

async function adminFetch(baseURL: string, path: string, opts: RequestInit = {}) {
	const method = (opts.method || "GET").toUpperCase();
	let body = opts.body;
	if (method === "POST" && /^\/api\/(sessions|goals|staff)(\?|$|\/)/.test(path)) {
		body = await injectDefaultProjectId(body) as BodyInit;
	}
	return fetch(`${baseURL}${path}`, {
		...opts,
		body,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${readE2EToken()}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

// Short, deterministic, cross-platform "instantly exits 0" command.
const QUICK_CMD = process.platform === "win32"
	? `node -e "console.log('bg done')"`
	: `node -e "console.log('bg done')"`;
const FAIL_CMD = process.platform === "win32"
	? `node -e "console.error('Error: boom'); process.exit(2)"`
	: `node -e "console.error('Error: boom'); process.exit(2)"`;

interface WakeEvent {
	kind: "enqueue" | "steer";
	sessionId: string;
	message: string;
	opts?: unknown;
}

/** Wrap sessionManager.enqueuePrompt and deliverLiveSteer to capture wake events. */
function installWakeSpy(sessionManager: any): { events: WakeEvent[]; restore: () => void } {
	const events: WakeEvent[] = [];
	const origEnqueue = sessionManager.enqueuePrompt.bind(sessionManager);
	const origSteer = sessionManager.deliverLiveSteer.bind(sessionManager);
	sessionManager.enqueuePrompt = async (sessionId: string, text: string, opts?: unknown) => {
		events.push({ kind: "enqueue", sessionId, message: text, opts });
		return origEnqueue(sessionId, text, opts);
	};
	sessionManager.deliverLiveSteer = (sessionId: string, message: string) => {
		events.push({ kind: "steer", sessionId, message });
		return origSteer(sessionId, message);
	};
	return {
		events,
		restore: () => {
			sessionManager.enqueuePrompt = origEnqueue;
			sessionManager.deliverLiveSteer = origSteer;
		},
	};
}

test.describe("bash_bg — wake owning agent on bg process exit", () => {
	test("idle session receives a wake message describing the exited bg process", async ({ gateway }) => {
		const spy = installWakeSpy(gateway.sessionManager);
		let sessionId: string | undefined;
		try {
			// Create session.
			const res = await adminFetch(gateway.baseURL, "/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: nonGitCwd(), worktree: false, assistantType: "role" }),
			});
			expect(res.status).toBe(201);
			({ id: sessionId } = await res.json());

			// Drain any wake events triggered by session creation so we only see
			// the bg-exit one below.
			spy.events.length = 0;

			// Start a short bg process that exits ~immediately.
			const bgRes = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`, {
				method: "POST",
				body: JSON.stringify({ command: QUICK_CMD, name: "quick" }),
			});
			expect(bgRes.status).toBe(201);
			const bg = await bgRes.json();

			// Poll until the bg process is reported as exited.
			await pollUntil(async () => {
				const r = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`);
				const list = await r.json();
				const proc = list.processes?.find((p: any) => p.id === bg.id);
				return proc?.status === "exited";
			}, { timeoutMs: 10_000, intervalMs: 50, label: "bg process exited" });

			// Now poll for a wake event matching the bg exit.
			const wake: WakeEvent = await pollUntil(
				() => spy.events.find((e) =>
					e.sessionId === sessionId
					&& /background process .* exited/i.test(e.message),
				),
				{ timeoutMs: 3_000, intervalMs: 50, label: "bg exit wake" },
			);

			expect(wake).toBeTruthy();
			// Payload sanity: id, name, command (or truncation), exit code, success
			// hint, and a pointer to fetch logs should all be discoverable.
			expect(wake!.message).toMatch(/bg-\d+/);
			expect(wake!.message).toMatch(/quick/);
			expect(wake!.message).toMatch(/exit code 0|success/i);
			// Either an explicit log pointer or an inline output tail must be present.
			expect(
				/bash_bg|logs|output/i.test(wake!.message),
				`wake message should reference logs or output, got: ${wake!.message}`,
			).toBeTruthy();
		} finally {
			spy.restore();
			if (sessionId) {
				await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}`, { method: "DELETE" });
			}
		}
	});

	test("failed bg process surfaces as failure in the wake message", async ({ gateway }) => {
		const spy = installWakeSpy(gateway.sessionManager);
		let sessionId: string | undefined;
		try {
			const res = await adminFetch(gateway.baseURL, "/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: nonGitCwd(), worktree: false, assistantType: "role" }),
			});
			expect(res.status).toBe(201);
			({ id: sessionId } = await res.json());
			spy.events.length = 0;

			const bgRes = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`, {
				method: "POST",
				body: JSON.stringify({ command: FAIL_CMD, name: "broken" }),
			});
			expect(bgRes.status).toBe(201);
			const bg = await bgRes.json();

			await pollUntil(async () => {
				const r = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`);
				const list = await r.json();
				const proc = list.processes?.find((p: any) => p.id === bg.id);
				return proc?.status === "exited";
			}, { timeoutMs: 10_000, intervalMs: 50, label: "bg failure exited" });

			const wake: WakeEvent = await pollUntil(
				() => spy.events.find((e) =>
					e.sessionId === sessionId
					&& /background process .* exited/i.test(e.message),
				),
				{ timeoutMs: 3_000, intervalMs: 50, label: "bg failure wake" },
			);

			expect(wake.message).toMatch(/broken/);
			expect(wake.message).toMatch(/fail|exit code 2/i);
		} finally {
			spy.restore();
			if (sessionId) {
				await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}`, { method: "DELETE" });
			}
		}
	});

	test("streaming session enqueues the wake (does not live-steer / abort waits)", async ({ gateway }) => {
		const spy = installWakeSpy(gateway.sessionManager);
		let sessionId: string | undefined;
		let originalStatus: string | undefined;
		let session: any;
		try {
			const res = await adminFetch(gateway.baseURL, "/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: nonGitCwd(), worktree: false, assistantType: "role" }),
			});
			expect(res.status).toBe(201);
			({ id: sessionId } = await res.json());

			// Force the session into "streaming" so notifySessionOfBgExit hits the
			// busy branch. We only need the status flag flipped — no real turn is
			// running. Restore in finally so session teardown is clean.
			session = (gateway.sessionManager as any).getSession(sessionId);
			expect(session).toBeTruthy();
			originalStatus = session.status;
			session.status = "streaming";

			// Track whether abortAllWaits is called — it must NOT be, because that
			// would disrupt an active bash_bg wait on a sibling process.
			const origAbort = gateway.bgProcessManager.abortAllWaits.bind(gateway.bgProcessManager);
			let abortCalls = 0;
			(gateway.bgProcessManager as any).abortAllWaits = (sid: string) => {
				abortCalls++;
				return origAbort(sid);
			};

			spy.events.length = 0;

			try {
				const bgRes = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`, {
					method: "POST",
					body: JSON.stringify({ command: QUICK_CMD, name: "quick-stream" }),
				});
				expect(bgRes.status).toBe(201);
				const bg = await bgRes.json();

				await pollUntil(async () => {
					const r = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`);
					const list = await r.json();
					const proc = list.processes?.find((p: any) => p.id === bg.id);
					return proc?.status === "exited";
				}, { timeoutMs: 10_000, intervalMs: 50, label: "streaming bg exited" });

				const wake = await pollUntil(
					() => spy.events.find((e) =>
						e.sessionId === sessionId
						&& /background process .* exited/i.test(e.message),
					),
					{ timeoutMs: 3_000, intervalMs: 50, label: "streaming wake event" },
				);

				// Must be an enqueue — NOT a live steer. Live-steer aborts in-flight
				// bg waits, which breaks legitimate STREAM_BURST / mock turns that use
				// bash_bg create+wait in the same turn.
				expect(wake.kind).toBe("enqueue");
				expect(wake.message).toMatch(/quick-stream/);
				// Streaming notifications must NOT be marked steered — a steered queued
				// row is live-steered by the next tool_execution_end handler, which is
				// exactly the disruption we are avoiding. Non-steered queued prompts
				// drain only on agent_end, after the current turn finishes.
				expect((wake.opts as any)?.isSteered).toBe(false);

				const steers = spy.events.filter((e) =>
					e.kind === "steer"
					&& e.sessionId === sessionId
					&& /background process .* exited/i.test(e.message),
				);
				expect(steers).toEqual([]);
				expect(abortCalls).toBe(0);
			} finally {
				(gateway.bgProcessManager as any).abortAllWaits = origAbort;
			}
		} finally {
			spy.restore();
			if (session && originalStatus !== undefined) session.status = originalStatus;
			if (sessionId) {
				await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}`, { method: "DELETE" });
			}
		}
	});

	test("agent-initiated kill does not produce a wake message", async ({ gateway }) => {
		const spy = installWakeSpy(gateway.sessionManager);
		let sessionId: string | undefined;
		try {
			const res = await adminFetch(gateway.baseURL, "/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: nonGitCwd(), worktree: false, assistantType: "role" }),
			});
			expect(res.status).toBe(201);
			({ id: sessionId } = await res.json());

			// Use a long-running cmd so we can kill it while still running.
			const longCmd = process.platform === "win32"
				? `ping -n 60 127.0.0.1 >NUL`
				: `sleep 60`;

			const bgRes = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`, {
				method: "POST",
				body: JSON.stringify({ command: longCmd, name: "longrun" }),
			});
			expect(bgRes.status).toBe(201);
			const bg = await bgRes.json();

			// Drain creation-time wake events.
			spy.events.length = 0;

			// Kill via REST (DELETE) — mirrors agent-initiated bash_bg kill.
			const killRes = await adminFetch(
				gateway.baseURL,
				`/api/sessions/${sessionId}/bg-processes/${bg.id}`,
				{ method: "DELETE" },
			);
			expect([200, 204]).toContain(killRes.status);

			// Wait until the killed process is no longer running; the exit notifier
			// would have fired by then if kill suppression were broken.
			await pollUntil(async () => {
				const r = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`);
				const list = await r.json();
				const proc = list.processes?.find((p: any) => p.id === bg.id);
				return !proc || proc.status === "exited";
			}, { timeoutMs: 5_000, intervalMs: 50, label: "killed bg process settled" });

			const bgWakes = spy.events.filter((e) =>
				e.sessionId === sessionId
				&& /background process .* exited/i.test(e.message),
			);
			expect(bgWakes).toEqual([]);
		} finally {
			spy.restore();
			if (sessionId) {
				await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}`, { method: "DELETE" });
			}
		}
	});
});
