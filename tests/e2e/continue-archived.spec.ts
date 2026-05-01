/**
 * API E2E tests for Continue-Archived (POST /api/sessions/:archivedId/continue).
 *
 * Lossless flow:
 *   - Source `.jsonl` is cloned into a fresh slot under <globalAgentDir()>/sessions/.
 *   - The new session's `agentSessionFile` field points at the clone.
 *   - The agent CLI rehydrates from the clone via `switch_session`.
 *   - There is no seed-mode parameter, no system-prompt seeding, no byte cap.
 */

import { test, expect } from "./in-process-harness.js";
import { apiFetch, connectWs, agentEndPredicate, nonGitCwd, createSession as createSessionFromHarness } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";
import fs from "node:fs";

// ── Helpers ───────────────────────────────────────────────────────────────

async function sendPromptAndWait(id: string, text: string): Promise<void> {
	const ws = await connectWs(id);
	try {
		ws.send({ type: "prompt", text });
		await ws.waitFor(agentEndPredicate(), 10_000);
	} finally {
		ws.close();
	}
}

async function archive(id: string): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${id}`, { method: "DELETE" });
	expect(resp.ok, `archive ${id}: ${resp.status}`).toBe(true);
}

async function getPersisted(id: string): Promise<any> {
	const r = await apiFetch(`/api/sessions/${id}?include=archived`);
	if (!r.ok) return null;
	return r.json();
}

async function getArchivedRec(id: string): Promise<any> {
	const arch = await (await apiFetch("/api/sessions?include=archived")).json();
	return (arch.sessions as any[]).find(s => s.id === id) || null;
}

async function makeArchivedSourceSession(opts?: {
	promptText?: string;
	roleId?: string;
}): Promise<string> {
	const body: any = { cwd: nonGitCwd() };
	if (opts?.roleId) body.roleId = opts.roleId;
	const resp = await apiFetch("/api/sessions", { method: "POST", body: JSON.stringify(body) });
	expect(resp.status).toBe(201);
	const id = (await resp.json()).id;
	await sendPromptAndWait(id, opts?.promptText || "Hello from the original session, please acknowledge.");
	await archive(id);
	return id;
}

// ── Tests ────────────────────────────────────────────────────────────────

test.describe("Continue-Archived API (lossless)", () => {
	test("happy path: returns 201 with Continued: title and a fresh session id", async () => {
		const archivedId = await makeArchivedSourceSession({
			promptText: "UNIQUE_MARKER_ALPHA hello world",
		});

		const resp = await apiFetch(`/api/sessions/${archivedId}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();
		expect(data.id).toBeTruthy();
		expect(data.id).not.toBe(archivedId);
		expect(data.title).toMatch(/^Continued: /);

		// New session should reach idle (i.e. switch_session against the cloned
		// `.jsonl` succeeded). pollUntil retries the GET until status flips.
		const rec = await pollUntil(async () => {
			const r = await getPersisted(data.id);
			return r && r.status !== "preparing" && r.status !== "starting" ? r : null;
		}, { timeoutMs: 15_000, intervalMs: 100, label: "new session reached non-preparing status" });
		expect(rec).toBeTruthy();
		expect(["idle", "streaming"]).toContain(rec.status);
	});

	test("body fields are ignored — legacy {mode:'summary'} no longer 400s", async () => {
		const archivedId = await makeArchivedSourceSession();

		const resp = await apiFetch(`/api/sessions/${archivedId}/continue`, {
			method: "POST",
			body: JSON.stringify({ mode: "summary" }),
		});
		expect(resp.status).toBe(201);
	});

	test("empty body returns 201", async () => {
		const archivedId = await makeArchivedSourceSession();
		const resp = await apiFetch(`/api/sessions/${archivedId}/continue`, {
			method: "POST",
			body: "",
		});
		expect(resp.status).toBe(201);
	});

	test("title format: 'Continued: <original title>' and survives first prompt", async () => {
		const archivedId = await makeArchivedSourceSession();
		const resp = await apiFetch(`/api/sessions/${archivedId}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();

		const info = await pollUntil(async () => {
			const rec = await getPersisted(data.id);
			return rec?.title?.startsWith("Continued: ") ? rec : null;
		}, { timeoutMs: 5_000, intervalMs: 50, label: "continued title persisted" });
		expect(info?.title?.startsWith("Continued: ")).toBe(true);

		// markGenerated:true protects the title from the first-prompt auto-titler.
		await apiFetch(`/api/sessions/${data.id}/prompt`, {
			method: "POST",
			body: JSON.stringify({ text: "hi" }),
		}).catch(() => {});

		let titleChanged = false;
		try {
			await pollUntil(async () => {
				const rec = await getPersisted(data.id);
				if (rec?.title && !rec.title.startsWith("Continued: ")) {
					titleChanged = true;
					return true;
				}
				return false;
			}, { timeoutMs: 500, intervalMs: 100, label: "title overwritten (expected to time out)" });
		} catch { /* expected */ }
		expect(titleChanged).toBe(false);
	});

	test("unknown session returns 404", async () => {
		const resp = await apiFetch(`/api/sessions/does-not-exist-abc123/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(404);
	});

	test("not-archived (live) session returns 409", async () => {
		const liveId = await createSessionFromHarness();
		try {
			await sendPromptAndWait(liveId, "hello");
			const resp = await apiFetch(`/api/sessions/${liveId}/continue`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			expect(resp.status).toBe(409);
		} finally {
			await archive(liveId).catch(() => {});
		}
	});

	test("goal-linked session returns 422", async () => {
		const goalResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "Archived goal test", cwd: nonGitCwd(), team: false, worktree: false, workflowId: "general" }),
		});
		expect(goalResp.status).toBe(201);
		const goal = await goalResp.json();
		const sessionResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd(), goalId: goal.id }),
		});
		expect(sessionResp.status).toBe(201);
		const sid = (await sessionResp.json()).id;
		await sendPromptAndWait(sid, "goal session message");
		await archive(sid);

		const resp = await apiFetch(`/api/sessions/${sid}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(422);
	});

	test("delegate session returns 422", async () => {
		const parentId = await createSessionFromHarness();
		await sendPromptAndWait(parentId, "parent");
		const delegateId = await createSessionFromHarness();
		const patch = await apiFetch(`/api/sessions/${delegateId}`, {
			method: "PATCH",
			body: JSON.stringify({ delegateOf: parentId }),
		});
		expect(patch.ok).toBe(true);
		await sendPromptAndWait(delegateId, "delegate msg");
		await archive(delegateId);

		const resp = await apiFetch(`/api/sessions/${delegateId}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(422);
		await archive(parentId).catch(() => {});
	});

	test("assistant session (assistantType) returns 422", async () => {
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd(), goalAssistant: true }),
		});
		expect(resp.status).toBe(201);
		const sid = (await resp.json()).id;
		await sendPromptAndWait(sid, "assistant init");
		await archive(sid);

		const cont = await apiFetch(`/api/sessions/${sid}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(cont.status).toBe(422);
	});

	test("role copied to new session", async () => {
		const archivedId = await makeArchivedSourceSession({ roleId: "coder" });
		const resp = await apiFetch(`/api/sessions/${archivedId}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();
		await pollUntil(async () => {
			const info = await getPersisted(data.id);
			return info?.role === "coder";
		}, { timeoutMs: 5_000, intervalMs: 50, label: "role copied" });
	});

	test("archived session with empty .jsonl returns 404", async () => {
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd() }),
		});
		expect(resp.status).toBe(201);
		const id = (await resp.json()).id;
		await archive(id);

		const rec = await getArchivedRec(id);
		if (rec?.agentSessionFile && fs.existsSync(rec.agentSessionFile)) {
			fs.writeFileSync(rec.agentSessionFile, "");
		}

		const cont = await apiFetch(`/api/sessions/${id}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(cont.status).toBe(404);
	});
});
