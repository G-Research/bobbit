/**
 * v2 integration — `team_wait` semantics (Orchestration Core sub-goal A §9).
 *
 * Ported faithfully from tests/e2e/team-wait-semantics.spec.ts (source of truth)
 * onto the Test Suite v2 fork-scoped gateway fixture + in-process mock bridge.
 * Preserves the sub-behaviours the triage flagged as lost:
 *   • returns on the FIRST settled child + the all-children status-line wording,
 *   • the chunked-wait post-headers error surfaces in the body (finding #5),
 *   • a non-streaming child with a queued prompt is reported `queued`,
 *   • already-idle returns immediately with All-settled wording,
 *   • a streaming child never satisfies the wait and times out terminally,
 *   • timeout-terminal aggregate never rejects (200, no throw).
 *
 * Drives `POST /api/sessions/:id/orchestrate/wait` (policy "first") against the
 * deterministic mock agent. A child is made to stay streaming by sending it a
 * `STAY_BUSY:<ms>` follow-up prompt via `/orchestrate/prompt` (the delegate's
 * spawn prompt is a fixed string, so STAY_BUSY must arrive as an explicit
 * follow-up). A plain child finishes ("OK") immediately.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createSession, deleteSession } from "./_e2e/e2e-setup.js";

/** Poll a predicate until it returns a truthy value, or throw on timeout. */
async function pollUntil<T>(
	predicate: () => T | Promise<T>,
	opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const intervalMs = opts.intervalMs ?? 50;
	const label = opts.label ?? "predicate";
	const start = Date.now();
	let lastErr: unknown;
	while (Date.now() - start < timeoutMs) {
		try { const v = await predicate(); if (v) return v; } catch (err) { lastErr = err; }
		await new Promise(r => setTimeout(r, intervalMs));
	}
	const errSuffix = lastErr ? ` (last error: ${(lastErr as Error)?.message ?? lastErr})` : "";
	throw new Error(`pollUntil("${label}") timed out after ${Date.now() - start}ms${errSuffix}`);
}

async function spawnChild(ownerId: string, instructions: string): Promise<string> {
	const resp = await apiFetch(`/api/sessions/${ownerId}/orchestrate/spawn`, {
		method: "POST",
		body: JSON.stringify({ instructions }),
	});
	expect(resp.status).toBe(201);
	return (await resp.json()).childSessionId as string;
}

async function sessionStatus(id: string): Promise<string | undefined> {
	const resp = await apiFetch(`/api/sessions/${id}`);
	if (!resp.ok) return undefined;
	return (await resp.json()).status;
}

/** Make a child stay streaming for `ms` via a STAY_BUSY follow-up prompt. */
async function makeBusy(ownerId: string, childId: string, ms: number): Promise<void> {
	// Wait for the spawn prompt to settle so STAY_BUSY runs immediately (not queued).
	await pollUntil(async () => (await sessionStatus(childId)) === "idle" ? true : null,
		{ timeoutMs: 15_000, intervalMs: 50, label: `child ${childId} idle before STAY_BUSY` });
	const resp = await apiFetch(`/api/sessions/${ownerId}/orchestrate/prompt`, {
		method: "POST",
		body: JSON.stringify({ childSessionId: childId, message: `STAY_BUSY:${ms} long-running follow-up` }),
	});
	expect(resp.status).toBe(200);
	// Confirm it actually entered streaming before we rely on it being busy.
	await pollUntil(async () => (await sessionStatus(childId)) === "streaming" ? true : null,
		{ timeoutMs: 15_000, intervalMs: 25, label: `child ${childId} streaming` });
}

async function waitFirst(ownerId: string, childSessionIds: string[], timeoutMs: number): Promise<any> {
	const resp = await apiFetch(`/api/sessions/${ownerId}/orchestrate/wait`, {
		method: "POST",
		body: JSON.stringify({ childSessionIds, timeout_ms: timeoutMs }),
	});
	expect(resp.status).toBe(200);
	return resp.json();
}

/**
 * Like `waitFirst`, but drives the server-side `waitForIdle` timeout to fire.
 *
 * v2 difference from the legacy real-timer harness: the gateway is booted with
 * an injected MANUAL clock (deterministic timers), and SessionManager.waitForIdle
 * schedules its `timeout_ms` deadline on that clock (clock.setTimeout). With a
 * manual clock the deadline never elapses in wall time, so a wait against a
 * still-streaming child would hang forever. We therefore fire the wait request
 * WITHOUT awaiting it, then advance the manual clock past `timeout_ms` in a poll
 * loop until the response settles. The mock agent's STAY_BUSY window uses a REAL
 * setTimeout (mock-agent-core `tick`), so advancing VIRTUAL time never ends the
 * busy window early — the child stays streaming and the wait terminates via the
 * timeout branch exactly as the legacy real-timer run did.
 */
async function waitFirstAdvancing(gateway: any, ownerId: string, childSessionIds: string[], timeoutMs: number): Promise<any> {
	const respP = apiFetch(`/api/sessions/${ownerId}/orchestrate/wait`, {
		method: "POST",
		body: JSON.stringify({ childSessionIds, timeout_ms: timeoutMs }),
	});
	let done = false;
	const settled = respP.then(r => { done = true; return r; }, e => { done = true; throw e; });
	while (!done) {
		// Real yield so the request reaches the server and registers its
		// clock.setTimeout deadline before we advance past it.
		await new Promise(r => setTimeout(r, 25));
		gateway.clock.advance(timeoutMs + 1_000);
	}
	const resp = await settled;
	expect(resp.status).toBe(200);
	return resp.json();
}

async function dismiss(ownerId: string, childSessionId: string): Promise<void> {
	await apiFetch(`/api/sessions/${ownerId}/orchestrate/dismiss`, {
		method: "POST",
		body: JSON.stringify({ childSessionId }),
	}).catch(() => {});
}

test.describe("team_wait — first-settled + status line", () => {
	test("returns on the first idle child, lists the rest, and instructs to call again", async () => {
		const parent = await createSession();
		const busy = await spawnChild(parent, "long-running helper");
		const quick = await spawnChild(parent, "quick helper");
		try {
			await makeBusy(parent, busy, 60_000);
			const result = await waitFirst(parent, [busy, quick], 15_000);
			// First settled is the quick child (busy is still streaming).
			expect(result.firstIdle).toBe(quick);
			expect(result.firstIsTerminal).toBeFalsy();
			// All-children status line.
			const byId = new Map(result.statuses.map((s: any) => [s.sessionId, s.status]));
			expect(byId.get(quick)).toBe("idle");
			expect(["streaming", "queued", "not-started"]).toContain(byId.get(busy));
			expect(result.remaining).toBeGreaterThanOrEqual(1);
			// Await-the-rest instruction + status header in the rendered text.
			expect(result.text).toContain("First idle child");
			expect(result.text).toContain("Awaited children");
			expect(result.text).toContain("call team_wait again");
			// Finding #4: the await-the-rest instruction must enumerate the REMAINING
			// (non-settled) child ids so a literal re-call awaits only them — not the
			// already-idle child again (which an omitted child_session_ids would re-return).
			expect(result.text).toMatch(/child_session_ids: \[[^\]]+\]/);
			expect(result.text).toContain(busy);
			expect(result.text).not.toContain(quick + "\""); // quick is settled → not in remaining list ids
		} finally {
			await dismiss(parent, busy);
			await dismiss(parent, quick);
			await deleteSession(parent);
		}
	});

	test("the chunked wait route surfaces a post-headers error in the body (finding #5)", async () => {
		// The chunked /orchestrate/wait route has ALREADY written 200 headers when an
		// own-child check fails (NOT_OWN_CHILD), so the failure rides in the body as
		// `{error}` rather than an HTTP status. The tool wrapper must surface it; here
		// we pin the server contract that the error field IS present (not an empty wait).
		const owner = await createSession();
		const stranger = await createSession();
		try {
			const resp = await apiFetch(`/api/sessions/${owner}/orchestrate/wait`, {
				method: "POST",
				body: JSON.stringify({ childSessionIds: [stranger], timeout_ms: 5_000 }),
			});
			expect(resp.status).toBe(200);
			const json = await resp.json();
			expect(typeof json.error).toBe("string");
			expect(json.error).toMatch(/not owned/i);
			// And it is NOT a misleading empty "all settled" wait.
			expect(json.statuses ?? []).toHaveLength(0);
		} finally {
			await deleteSession(owner);
			await deleteSession(stranger);
		}
	});

	// M3: a non-streaming child with pending prompt-queue rows must be reported
	// `queued` (not `idle`) in the all-children status line. We construct that
	// state deterministically: an idle child with a row pushed DIRECTLY onto its
	// prompt queue (no enqueuePrompt → no drain), so it stays idle-with-queue.
	test("a non-streaming child with a queued prompt is reported `queued`", async ({ gateway }) => {
		const parent = await createSession();
		const quick = await spawnChild(parent, "settles first");
		const queued = await spawnChild(parent, "has queued work");
		try {
			// Both children reach idle (mock agent → "OK").
			for (const c of [quick, queued]) {
				await pollUntil(async () => (await sessionStatus(c)) === "idle" ? true : null,
					{ timeoutMs: 15_000, intervalMs: 50, label: `${c} idle` });
			}
			// Push a row straight onto `queued`'s prompt queue — does NOT trigger a
			// drain, so the session stays idle with a non-empty queue.
			gateway.sessionManager.getSession(queued)!.promptQueue.enqueue("pending follow-up");
			expect(gateway.sessionManager.getQueuedPromptCount(queued)).toBeGreaterThan(0);

			// policy:first → `quick` (listed first, idle) settles; `queued` is reported
			// via its LIVE status, which must now be `queued`, not `idle`.
			const result = await waitFirst(parent, [quick, queued], 15_000);
			const byId = new Map(result.statuses.map((s: any) => [s.sessionId, s.status]));
			expect(byId.get(quick)).toBe("idle");
			expect(byId.get(queued)).toBe("queued");
		} finally {
			await dismiss(parent, quick);
			await dismiss(parent, queued);
			await deleteSession(parent);
		}
	});

	test("already-idle child returns immediately with All-settled wording", async () => {
		const parent = await createSession();
		const quick = await spawnChild(parent, "quick helper");
		try {
			// Let the spawn prompt settle, then wait — it is already idle.
			await pollUntil(async () => (await sessionStatus(quick)) === "idle" ? true : null,
				{ timeoutMs: 15_000, intervalMs: 50, label: "quick idle" });
			const result = await waitFirst(parent, [quick], 15_000);
			expect(result.firstIdle).toBe(quick);
			expect(result.remaining).toBe(0);
			expect(result.text).toContain("All awaited children are settled.");
			expect(result.text).not.toContain("call team_wait again");
		} finally {
			await dismiss(parent, quick);
			await deleteSession(parent);
		}
	});
});

test.describe("team_wait — timeout + terminal handling", () => {
	test("a streaming child does not satisfy the wait and times out as a terminal status (no rejection)", async ({ gateway }) => {
		const parent = await createSession();
		const busy = await spawnChild(parent, "never settles in time");
		try {
			await makeBusy(parent, busy, 60_000);
			const result = await waitFirstAdvancing(gateway, parent, [busy], 400);
			// Terminal `timeout` — the wait returned 200 and did not reject.
			expect(result.statuses).toHaveLength(1);
			expect(result.statuses[0].status).toBe("timeout");
			expect(result.firstIdle).toBe(busy);
			expect(result.firstIsTerminal).toBe(true);
			expect(result.text).toContain("First settled child");
		} finally {
			await dismiss(parent, busy);
			await deleteSession(parent);
		}
	});

	test("one child times out while another is already idle — aggregate never rejects", async ({ gateway }) => {
		const parent = await createSession();
		const busy = await spawnChild(parent, "slow child");
		const quick = await spawnChild(parent, "quick child");
		try {
			await makeBusy(parent, busy, 60_000);
			// First call returns on the idle quick child while busy keeps running.
			const first = await waitFirst(parent, [busy, quick], 15_000);
			expect(first.firstIdle).toBe(quick);
			expect(first.remaining).toBeGreaterThanOrEqual(1);

			// Second call awaits only the busy child with a tiny timeout → it
			// settles as `timeout`; the call still returns 200 (never rejects).
			const second = await waitFirstAdvancing(gateway, parent, [busy], 400);
			expect(second.statuses[0].status).toBe("timeout");
			expect(second.firstIsTerminal).toBe(true);
		} finally {
			await dismiss(parent, busy);
			await dismiss(parent, quick);
			await deleteSession(parent);
		}
	});
});
