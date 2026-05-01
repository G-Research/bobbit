/**
 * API E2E for delegate restart resilience.
 *
 * Drives the DelegateHarness through its three internal HTTP endpoints
 * (`/api/internal/delegate/{wait,submit,cancel}`) plus direct in-process
 * harness access to simulate a server restart by re-loading the harness's
 * persisted state from `<stateDir>/active-delegates.json`.
 *
 * Why this style:
 *   The in-process gateway fixture is worker-scoped and shares Node's module
 *   cache, so spawning a second gateway in the same worker is fragile. Instead
 *   we model "restart" as: dispose the live in-memory harness's pending Map,
 *   then construct a fresh DelegateHarness instance against the same
 *   `stateDir`. The fresh harness `_loadFromDisk`'s the persisted entries
 *   into "shells" with no live resolvers (per `delegate-harness.ts` doc-string
 *   §"persisted-but-no-pending-resolver shells") \u2014 which is exactly the
 *   post-restart state that production faces. Submits arriving against shells
 *   latch; the parent's next /wait POST drains the latch.
 *
 * Cases (D-RST-01..06) match docs/design/delegate-restart-resilience.md \u00a710.2.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	createSession,
	defaultProjectId,
	readE2EToken,
	waitForCondition,
} from "./e2e-setup.js";
import path from "node:path";
import fs from "node:fs";

interface DelegateResult { status: string; output: string; error?: string }

/** POST /api/internal/delegate/wait \u2014 returns the parked DelegateResultPayload. */
async function postWait(args: {
	parentSessionId: string;
	toolUseId: string;
	delegateSessionId: string;
	timeoutMs?: number;
}): Promise<DelegateResult> {
	// Use a per-call undici Agent with pipelining=0 + keepAliveTimeout=1ms
	// so each long-poll runs on its own TCP socket. The default global
	// dispatcher pools connections and serialises chunked responses on the
	// same origin; a prior dangling /wait would block fresh registrations
	// until it drains, which is exactly what we want to avoid.
	const { Agent, request: undiciRequest } = await import("undici");
	const dispatcher = new Agent({ pipelining: 0, keepAliveTimeout: 1, keepAliveMaxTimeout: 1, connections: 1 });
	const token = readE2EToken();
	const port = process.env.E2E_PORT;
	try {
		const { statusCode, body } = await undiciRequest(`http://127.0.0.1:${port}/api/internal/delegate/wait`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				parentSessionId: args.parentSessionId,
				toolUseId: args.toolUseId,
				delegateSessionId: args.delegateSessionId,
				cwd: "",
				instructions: "",
				timeoutMs: args.timeoutMs ?? 30_000,
			}),
			dispatcher,
		});
		expect(statusCode).toBe(200);
		const text = (await body.text()).trim();
		return JSON.parse(text);
	} finally {
		await dispatcher.close().catch(() => {});
	}
}

async function postSubmit(args: {
	parentSessionId: string;
	toolUseId: string;
	status: string;
	output?: string;
	error?: string;
}): Promise<{ ok: boolean; drained: boolean }> {
	const resp = await apiFetch("/api/internal/delegate/submit", {
		method: "POST",
		body: JSON.stringify({
			parentSessionId: args.parentSessionId,
			toolUseId: args.toolUseId,
			status: args.status,
			output: args.output ?? "",
			error: args.error,
		}),
	});
	expect(resp.status).toBe(200);
	return resp.json() as Promise<{ ok: boolean; drained: boolean }>;
}

async function postCancel(parentSessionId: string, toolUseId: string, reason?: string): Promise<{ ok: boolean; drained: boolean }> {
	const resp = await apiFetch("/api/internal/delegate/cancel", {
		method: "POST",
		body: JSON.stringify({ parentSessionId, toolUseId, reason }),
	});
	expect(resp.status).toBe(200);
	return resp.json() as Promise<{ ok: boolean; drained: boolean }>;
}

async function simulateHarnessRestart(gateway: any): Promise<void> {
	// "Restart" the in-process delegate harness: reject every parked Promise
	// on the live instance (modelling the v8-heap-gone state of a real
	// restart) then re-load persisted state from disk via
	// resumeInterruptedDelegates(). We deliberately do NOT replace the
	// harness instance — the server's handleApiRoute closure captured the
	// original reference, so a swap would leave HTTP submit/cancel/wait
	// calls hitting a stale harness while test code talks to the new one.
	const sm = gateway.sessionManager;
	const stateDir = path.join(gateway.bobbitDir, "state");
	const harness = sm.getDelegateHarness();
	if (!harness) return;
	const persistPath = path.join(stateDir, "active-delegates.json");
	const persisted = fs.existsSync(persistPath)
		? JSON.parse(fs.readFileSync(persistPath, "utf-8"))
		: { pending: [], latched: [] };
	const parents = new Set<string>();
	for (const p of persisted.pending || []) parents.add(p.parentSessionId);
	for (const p of parents) harness.rejectAllForSession(p, "simulated restart");
	// rejectAllForSession also wiped persisted entries; restore them so the
	// reload below sees the pre-restart on-disk state.
	fs.writeFileSync(persistPath, JSON.stringify(persisted, null, 2));
	harness.resumeInterruptedDelegates();
}

test.describe("delegate restart resilience (API)", () => {
	test.describe.configure({ mode: "serial" });
	test.setTimeout(30_000);

	test("D-RST-01: register + submit \u2192 wait resolves with completed result (baseline)", async ({ gateway }) => {
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		const parentId = await createSession({ projectId });
		const childId = await createSession({ projectId });
		const toolUseId = `tu_${Date.now()}_01`;

		const waitPromise = postWait({ parentSessionId: parentId, toolUseId, delegateSessionId: childId });

		// Give the registration a moment to land.
		await waitForCondition(() => {
			const harness = gateway.sessionManager.getDelegateHarness();
			return harness.getActiveDelegateSessionIds().has(childId);
		}, { timeoutMs: 8000, message: "harness register" });

		const submitResp = await postSubmit({
			parentSessionId: parentId,
			toolUseId,
			status: "completed",
			output: "hello world",
		});
		expect(submitResp).toEqual({ ok: true, drained: true });

		const result = await waitPromise;
		expect(result.status).toBe("completed");
		expect(result.output).toBe("hello world");
	});

	test("D-RST-02: restart while running \u2192 submit latches \u2192 re-register drains", async ({ gateway }) => {
		const projectId = await defaultProjectId();
		const parentId = await createSession({ projectId });
		const childId = await createSession({ projectId });
		const toolUseId = `tu_${Date.now()}_02`;

		// Initial register \u2014 let the wait promise dangle, we'll abort it via simulated restart.
		const initialWait = postWait({ parentSessionId: parentId, toolUseId, delegateSessionId: childId });
		// Swallow the rejection from simulateHarnessRestart's rejectAllForSession.
		initialWait.catch(() => { /* expected to reject when old harness is torn down */ });

		await waitForCondition(() => {
			return gateway.sessionManager.getDelegateHarness().getActiveDelegateSessionIds().has(childId);
		}, { timeoutMs: 8000, message: "D-RST-02 register" });

		// Simulate restart: build a fresh harness against the same stateDir.
		// rejectAllForSession on the old harness rejects the parked Promise,
		// which causes the /wait handler to end the response — drain that here
		// so undici doesn't keep the chunked connection open into the next test.
		await simulateHarnessRestart(gateway);
		await initialWait.then(() => {}, () => {});

		// Submit before re-register \u2014 should latch.
		const submit1 = await postSubmit({
			parentSessionId: parentId,
			toolUseId,
			status: "completed",
			output: "post-restart output",
		});
		expect(submit1.drained).toBe(false);

		// Re-register \u2014 the latch drains immediately.
		const result = await postWait({ parentSessionId: parentId, toolUseId, delegateSessionId: childId });
		expect(result.status).toBe("completed");
		expect(result.output).toBe("post-restart output");
	});

	test("D-RST-03: child completed during downtime \u2192 latched result drains on restart resume", async ({ gateway }) => {
		const projectId = await defaultProjectId();
		const parentId = await createSession({ projectId });
		const childId = await createSession({ projectId });
		const toolUseId = `tu_${Date.now()}_03`;

		// Persist a pending entry directly to disk to simulate "registered before crash, never resumed".
		const stateDir = path.join(gateway.bobbitDir, "state");
		const persistPath = path.join(stateDir, "active-delegates.json");
		const existing = fs.existsSync(persistPath)
			? JSON.parse(fs.readFileSync(persistPath, "utf-8"))
			: { pending: [], latched: [] };
		existing.pending = existing.pending || [];
		existing.latched = existing.latched || [];
		existing.pending.push({
			parentSessionId: parentId,
			toolUseId,
			delegateSessionId: childId,
			cwd: "",
			instructions: "",
			timeoutMs: 30_000,
			createdAt: Date.now(),
		});
		fs.writeFileSync(persistPath, JSON.stringify(existing, null, 2));

		// Restart: fresh harness loads the entry as a shell.
		await simulateHarnessRestart(gateway);

		// Child terminated during downtime \u2192 submit lands while no live resolver exists \u2192 latched.
		const submit = await postSubmit({
			parentSessionId: parentId,
			toolUseId,
			status: "terminated",
			output: "child finished while server was down",
			error: "Delegate terminated",
		});
		expect(submit.drained).toBe(false);

		// Parent re-POSTs /wait \u2192 latch drains immediately.
		const result = await postWait({ parentSessionId: parentId, toolUseId, delegateSessionId: childId });
		expect(result.status).toBe("terminated");
		expect(result.output).toBe("child finished while server was down");
	});

	test("D-RST-04: parallel (N=3) delegates \u2014 each (parent, toolUseId#i) survives independently", async ({ gateway }) => {
		const projectId = await defaultProjectId();
		const parentId = await createSession({ projectId });
		const baseToolUseId = `tu_${Date.now()}_04`;
		const childIds: string[] = [];
		for (let i = 0; i < 3; i++) childIds.push(await createSession({ projectId }));

		// Seed 3 persisted entries directly on disk (one per slot) to model
		// the post-restart state — entries exist, no live resolvers. We do this
		// instead of issuing 3 simultaneous /wait long-polls because undici's
		// connection pool serialises chunked responses on the same origin
		// (a single in-flight long-poll blocks subsequent requests). The
		// per-slot keying contract is still exercised end-to-end through
		// the HTTP submit + wait endpoints below.
		const stateDir = path.join(gateway.bobbitDir, "state");
		const persistPath = path.join(stateDir, "active-delegates.json");
		const existing = fs.existsSync(persistPath)
			? JSON.parse(fs.readFileSync(persistPath, "utf-8"))
			: { pending: [], latched: [] };
		existing.pending = existing.pending || [];
		existing.latched = existing.latched || [];
		for (let i = 0; i < 3; i++) {
			existing.pending.push({
				parentSessionId: parentId,
				toolUseId: `${baseToolUseId}#${i}`,
				delegateSessionId: childIds[i],
				cwd: "",
				instructions: "",
				timeoutMs: 30_000,
				createdAt: Date.now(),
			});
		}
		fs.writeFileSync(persistPath, JSON.stringify(existing, null, 2));

		// Restart — fresh harness loads all 3 entries as shells.
		await simulateHarnessRestart(gateway);

		const harness = gateway.sessionManager.getDelegateHarness();
		const activeIds = harness.getActiveDelegateSessionIds();
		expect(childIds.every(cid => activeIds.has(cid))).toBe(true);

		// Submit per-slot in mixed order.
		await postSubmit({ parentSessionId: parentId, toolUseId: `${baseToolUseId}#1`, status: "completed", output: "slot-1" });
		await postSubmit({ parentSessionId: parentId, toolUseId: `${baseToolUseId}#0`, status: "completed", output: "slot-0" });
		await postSubmit({ parentSessionId: parentId, toolUseId: `${baseToolUseId}#2`, status: "failed", output: "", error: "slot-2-error" });

		// Re-register each \u2014 latches drain in any order.
		const r0 = await postWait({ parentSessionId: parentId, toolUseId: `${baseToolUseId}#0`, delegateSessionId: childIds[0] });
		const r1 = await postWait({ parentSessionId: parentId, toolUseId: `${baseToolUseId}#1`, delegateSessionId: childIds[1] });
		const r2 = await postWait({ parentSessionId: parentId, toolUseId: `${baseToolUseId}#2`, delegateSessionId: childIds[2] });
		expect(r0).toMatchObject({ status: "completed", output: "slot-0" });
		expect(r1).toMatchObject({ status: "completed", output: "slot-1" });
		expect(r2).toMatchObject({ status: "failed", error: "slot-2-error" });
	});

	test("D-RST-05: parent termination \u2192 rejectAllForSession rejects every keyed wait", async ({ gateway }) => {
		const projectId = await defaultProjectId();
		const parentId = await createSession({ projectId });
		const childId = await createSession({ projectId });
		const toolUseId = `tu_${Date.now()}_05`;

		// Test the cascade rejection through the harness directly. Issuing a
		// fresh /wait long-poll here is unreliable when prior tests in the
		// suite have accumulated dangling chunked connections (undici's
		// dispatcher pool serialises them on the same origin even with
		// per-call Agents). Drive the contract through the harness and the
		// REST DELETE termination path — we still exercise:
		//   - delegateHarness.register() parking the Promise
		//   - SessionManager.addTerminationListener firing on parent DELETE
		//   - DelegateHarness.rejectAllForSession draining matching keys
		//   - cascade-terminate of the child session id
		const harness = gateway.sessionManager.getDelegateHarness();
		const registerPromise = harness.register({
			parentSessionId: parentId,
			toolUseId,
			delegateSessionId: childId,
			cwd: "",
			instructions: "",
			timeoutMs: 30_000,
			createdAt: Date.now(),
		});
		let rejectionMessage: string | null = null;
		registerPromise.catch((err: Error) => { rejectionMessage = err.message; });
		expect(harness.getActiveDelegateSessionIds().has(childId)).toBe(true);

		// Terminate parent via DELETE; the addTerminationListener in server.ts
		// calls harness.rejectAllForSession.
		const token = readE2EToken();
		const delResp = await fetch(`${gateway.baseURL}/api/sessions/${parentId}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(delResp.status).toBe(200);

		// The harness Promise rejects synchronously inside the addTerminationListener
		// callback. Wait briefly for it to land.
		await waitForCondition(() => rejectionMessage !== null, { timeoutMs: 3_000, message: "register Promise to reject on parent terminate" });
		expect(rejectionMessage).toMatch(/parent session/i);

		// Verify the harness state is clean for that parent.
		const ids = gateway.sessionManager.getDelegateHarness().getActiveDelegateSessionIds();
		expect(ids.has(childId)).toBe(false);

		// CRITICAL: assert the child session was actually cascade-terminated by
		// the server's addTerminationListener (server.ts), not just removed from
		// the harness map. A previous regression had the harness's own listener
		// consume `pending` first, leaving the server-side listener with an empty
		// kill-list — children stayed alive. The fix removed the harness's auto
		// subscription so server.ts is the sole owner of the cascade.
		await waitForCondition(
			() => {
				const child = gateway.sessionManager.getSession(childId);
				return !child || child.status === "terminated";
			},
			{ timeoutMs: 3_000, message: "child delegate session to be cascade-terminated" },
		);
	});

	test("D-RST-08: live-path race — child completes BEFORE parent registers /wait, result is latched", async ({ gateway }) => {
		// Regression test for the pre-registration race: createDelegateSession
		// must NOT pre-register a parked Promise on the harness, because the
		// live-path completion listener would then resolve that fire-and-forget
		// Promise instead of latching the result for the parent's later /wait
		// POST. The fix uses harness.recordActive() (metadata-only shell) so
		// submit-before-register correctly latches.
		const harness = gateway.sessionManager.getDelegateHarness();
		const parentSessionId = `parent-rst-08`;
		const toolUseId = `tu_rst_08_${Date.now()}`;
		const delegateSessionId = `child-rst-08`;

		// Step 1: live path records active metadata (no parked Promise).
		harness.recordActive({
			parentSessionId,
			toolUseId,
			delegateSessionId,
			cwd: "",
			instructions: "",
			timeoutMs: 30_000,
			createdAt: Date.now(),
		});
		expect(harness.getActiveDelegateSessionIds().has(delegateSessionId)).toBe(true);

		// Step 2: child finishes very fast — completion listener calls submit.
		// With the bug: this would resolve a pre-registered fire-and-forget Promise
		// and the result would be lost. With the fix: it latches.
		const drained = harness.submit(parentSessionId, toolUseId, {
			status: "completed",
			output: "fast-output",
		});
		expect(drained).toBe(false); // No pending awaiter — result was latched.

		// Step 3: parent now registers (the /wait POST arrives). It must drain
		// the latch immediately rather than parking and timing out.
		const result = await harness.register({
			parentSessionId,
			toolUseId,
			delegateSessionId,
			cwd: "",
			instructions: "",
			timeoutMs: 30_000,
			createdAt: Date.now(),
		});
		expect(result).toEqual({ status: "completed", output: "fast-output" });

		// Step 4: harness state cleared after drain.
		expect(harness.getActiveDelegateSessionIds().has(delegateSessionId)).toBe(false);
	});

	test("D-RST-06: idempotent submit — second arrival is a no-op", async ({ gateway }) => {
		// Drive the harness directly to avoid /wait long-poll connection-pool
		// flakes when run after the other suite tests; the contract under
		// test (idempotency of POST /api/internal/delegate/submit) is fully
		// covered by the HTTP layer below.
		const projectId = await defaultProjectId();
		const parentId = await createSession({ projectId });
		const childId = await createSession({ projectId });
		const toolUseId = `tu_${Date.now()}_06`;

		const harness = gateway.sessionManager.getDelegateHarness();
		const registerPromise = harness.register({
			parentSessionId: parentId,
			toolUseId,
			delegateSessionId: childId,
			cwd: "",
			instructions: "",
			timeoutMs: 30_000,
			createdAt: Date.now(),
		});

		const first = await postSubmit({ parentSessionId: parentId, toolUseId, status: "completed", output: "first" });
		expect(first).toEqual({ ok: true, drained: true });

		const result = await registerPromise;
		expect(result).toMatchObject({ status: "completed", output: "first" });

		// Second submit — the parked Promise already drained on the first
		// call. Per the harness contract, the second submit lands on an
		// empty pending Map and either latches (no prior latch) or no-ops
		// (prior latch). Either way drained=false.
		const second = await postSubmit({ parentSessionId: parentId, toolUseId, status: "failed", output: "second" });
		expect(second.drained).toBe(false);
	});

	test("D-RST-07: cancel → wait resolves with terminated, latched cleared", async ({ gateway }) => {
		// Drive register through the harness directly (see D-RST-06 rationale)
		// and exercise the cancel HTTP endpoint.
		const projectId = await defaultProjectId();
		const parentId = await createSession({ projectId });
		const childId = await createSession({ projectId });
		const toolUseId = `tu_${Date.now()}_07`;

		const harness = gateway.sessionManager.getDelegateHarness();
		const registerPromise = harness.register({
			parentSessionId: parentId,
			toolUseId,
			delegateSessionId: childId,
			cwd: "",
			instructions: "",
			timeoutMs: 30_000,
			createdAt: Date.now(),
		});

		const cancel = await postCancel(parentId, toolUseId, "Aborted by user");
		expect(cancel.ok).toBe(true);
		expect(cancel.drained).toBe(true);

		const result = await registerPromise;
		expect(result.status).toBe("terminated");
		expect(result.error).toBe("Aborted by user");
	});
});
