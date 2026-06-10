/**
 * API E2E — `team_wait` semantics (Orchestration Core sub-goal A §9).
 *
 * Drives `POST /api/sessions/:id/orchestrate/wait` (policy "first") against the
 * deterministic mock agent. A child is made to stay streaming by sending it a
 * `STAY_BUSY:<ms>` follow-up prompt via `/orchestrate/prompt` (the delegate's
 * spawn prompt is a fixed string, so STAY_BUSY must arrive as an explicit
 * follow-up). A plain child finishes ("OK") immediately — so first-settled /
 * remaining / timeout behaviour is fully deterministic without a real LLM
 * (stays in the e2e phase, never test:manual).
 *
 * Pins:
 *   • returns on the FIRST settled child,
 *   • emits the all-children status line + the await-the-rest instruction,
 *   • already-idle returns immediately,
 *   • a streaming child never satisfies the wait (idle ≠ streaming),
 *   • timeout is honoured (busy child → terminal `timeout`, no rejection),
 *   • terminal-child handling: one child times out while another is idle —
 *     the wait still returns 200 and never rejects the aggregate.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, deleteSession } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

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
	test("a streaming child does not satisfy the wait and times out as a terminal status (no rejection)", async () => {
		const parent = await createSession();
		const busy = await spawnChild(parent, "never settles in time");
		try {
			await makeBusy(parent, busy, 60_000);
			const result = await waitFirst(parent, [busy], 400);
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

	test("one child times out while another is already idle — aggregate never rejects", async () => {
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
			const second = await waitFirst(parent, [busy], 400);
			expect(second.statuses[0].status).toBe("timeout");
			expect(second.firstIsTerminal).toBe(true);
		} finally {
			await dismiss(parent, busy);
			await dismiss(parent, quick);
			await deleteSession(parent);
		}
	});
});
