/**
 * API E2E — Orchestration Core sub-goal A, the agent-facing `team_*` surface.
 *
 * Drives the real `/api/sessions/:id/orchestrate/*` routes (which invoke the
 * in-process OrchestrationCore) end to end against the deterministic mock
 * agent. No real LLM — a delegate child auto-runs its instructions prompt and
 * the mock responds "OK", so blocking delegate / wait flows settle in
 * milliseconds and stay in the e2e phase (never test:manual).
 *
 * Covers the sub-goal A acceptance criteria:
 *   • blocking one-shot `team_delegate` reproduces the old `delegate` (incl.
 *     `parallel`, which waits for ALL children),
 *   • a spawned child inherits the parent's CURRENT model (regression vs the
 *     old system-default drop) + per-call `model` override,
 *   • the non-blocking interactive flow spawn → prompt → wait → read → dismiss,
 *   • a team-lead can ALSO `team_delegate` (the Agent-group reclassification
 *     does not regress its goal `team_*` tools).
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, createGoal, startTeam, deleteSession, deleteGoal, teardownTeam, connectWs } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

const OPUS = { provider: "anthropic", modelId: "claude-opus-4-8" };

async function orchestrate(ownerId: string, verb: string, body?: unknown): Promise<{ status: number; json: any }> {
	const resp = await apiFetch(`/api/sessions/${ownerId}/orchestrate/${verb}`, {
		method: "POST",
		body: JSON.stringify(body ?? {}),
	});
	let json: any = undefined;
	try { json = await resp.json(); } catch { /* chunked / empty */ }
	return { status: resp.status, json };
}

async function listChildren(ownerId: string): Promise<any[]> {
	const resp = await apiFetch(`/api/sessions/${ownerId}/orchestrate/children`);
	expect(resp.status).toBe(200);
	return (await resp.json()).children ?? [];
}

/** Set a session's model via WS and wait until it persists. */
async function setSessionModel(sessionId: string, provider: string, modelId: string): Promise<void> {
	const ws = await connectWs(sessionId);
	try {
		ws.send({ type: "set_model", provider, modelId });
		await pollUntil(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			if (!resp.ok) return false;
			const data = await resp.json();
			return data.modelProvider === provider && data.modelId === modelId ? true : null;
		}, { timeoutMs: 5_000, intervalMs: 50, label: `model ${provider}/${modelId} persisted` });
	} finally {
		ws.close();
	}
}

test.describe("team_delegate — blocking one-shot (delegate parity)", () => {
	test("single blocking delegate spawns, waits, returns output, and auto-dismisses", async () => {
		const parent = await createSession();
		try {
			const { status, json } = await orchestrate(parent, "delegate", { instructions: "do a small task" });
			expect(status).toBe(200);
			expect(Array.isArray(json.delegates)).toBe(true);
			expect(json.delegates.length).toBe(1);
			expect(json.delegates[0].status).toBe("completed");
			// Mock agent's default reply is "OK" → that is the collected output.
			expect(json.delegates[0].output).toContain("OK");
			// Auto-dismiss: no tracked children remain after a blocking delegate.
			expect(await listChildren(parent)).toHaveLength(0);
		} finally {
			await deleteSession(parent);
		}
	});

	test("parallel blocking delegate waits for ALL children", async () => {
		const parent = await createSession();
		try {
			const { status, json } = await orchestrate(parent, "delegate", {
				parallel: [{ instructions: "task one" }, { instructions: "task two" }, { instructions: "task three" }],
			});
			expect(status).toBe(200);
			expect(json.delegates.length).toBe(3);
			expect(json.delegates.every((d: any) => d.status === "completed")).toBe(true);
			expect(await listChildren(parent)).toHaveLength(0);
		} finally {
			await deleteSession(parent);
		}
	});

	// NOTE: blocking-delegate terminal/timeout handling (policy:"all" never
	// rejecting on one crash) is pinned at the unit level
	// (tests/orchestration-core.test.ts) and via the team_wait route's terminal
	// tests (tests/e2e/team-wait-semantics.spec.ts). It is NOT reproducible
	// through the blocking `/orchestrate/delegate` route with the mock agent
	// because a delegate's spawn prompt is a FIXED string (see
	// session-setup.ts::sendDelegatePrompt) — the child always completes the
	// canned turn quickly, so it cannot be forced into a timeout mid-delegate.
});

test.describe("team_delegate — model inheritance", () => {
	test("a spawned child inherits the parent's CURRENT model (not the system default)", async ({ gateway }) => {
		const parent = await createSession();
		try {
			await setSessionModel(parent, OPUS.provider, OPUS.modelId);
			const { status, json } = await orchestrate(parent, "spawn", { instructions: "inherit-model child" });
			expect(status).toBe(201);
			const childId = json.childSessionId as string;
			expect(childId).toBeTruthy();
			// The child session is pinned to the owner's CURRENT model end-to-end
			// (REST route → OrchestrationCore.spawn → createDelegateSession →
			// session-setup), NOT dropped to the system default.
			const childModel = await pollUntil(async () => {
				const s = gateway.sessionManager.getSession(childId);
				return s?.spawnPinnedModel ?? null;
			}, { timeoutMs: 5_000, intervalMs: 25, label: "child spawnPinnedModel" });
			expect(childModel).toBe(`${OPUS.provider}/${OPUS.modelId}`);
			await orchestrate(parent, "dismiss", { childSessionId: childId });
		} finally {
			await deleteSession(parent);
		}
	});

	test("per-call model override wins over inheritance", async ({ gateway }) => {
		const parent = await createSession();
		try {
			await setSessionModel(parent, OPUS.provider, OPUS.modelId);
			const { status, json } = await orchestrate(parent, "spawn", {
				instructions: "override-model child",
				model: "openai/gpt-override",
			});
			expect(status).toBe(201);
			const childId = json.childSessionId as string;
			const childModel = await pollUntil(async () => {
				const s = gateway.sessionManager.getSession(childId);
				return s?.spawnPinnedModel ?? null;
			}, { timeoutMs: 5_000, intervalMs: 25, label: "child override model" });
			expect(childModel).toBe("openai/gpt-override");
			await orchestrate(parent, "dismiss", { childSessionId: childId });
		} finally {
			await deleteSession(parent);
		}
	});
});

test.describe("team_delegate — non-blocking interactive flow", () => {
	test("spawn → prompt → wait → read → dismiss against own children", async () => {
		const parent = await createSession();
		try {
			// 1. Non-blocking spawn — returns immediately with the child id.
			const spawn = await orchestrate(parent, "spawn", { instructions: "first task" });
			expect(spawn.status).toBe(201);
			const childId = spawn.json.childSessionId as string;
			expect(childId).toBeTruthy();
			expect((await listChildren(parent)).map((c) => c.sessionId)).toContain(childId);

			// 2. The child runs its spawn instructions and goes idle; wait collects it.
			const wait1 = await apiFetch(`/api/sessions/${parent}/orchestrate/wait`, {
				method: "POST",
				body: JSON.stringify({ childSessionIds: [childId], timeout_ms: 15_000 }),
			});
			expect(wait1.status).toBe(200);
			const wait1Json = await wait1.json();
			expect(wait1Json.firstIdle).toBe(childId);

			// 3. Follow-up prompt (run-if-idle).
			const prompt = await orchestrate(parent, "prompt", { childSessionId: childId, message: "another task" });
			expect(prompt.status).toBe(200);
			expect(["dispatched", "queued"]).toContain(prompt.json.status);

			// 4. Wait again for the follow-up turn to settle.
			await apiFetch(`/api/sessions/${parent}/orchestrate/wait`, {
				method: "POST",
				body: JSON.stringify({ childSessionIds: [childId], timeout_ms: 15_000 }),
			});

			// 5. read_session reads the child transcript.
			const read = await apiFetch(`/api/sessions/${childId}/transcript?offset=-20&limit=20`);
			expect(read.status).toBe(200);
			const transcript = await read.json();
			expect(Array.isArray(transcript.messages)).toBe(true);

			// 6. Dismiss — terminate + archive; the child leaves the tracked set.
			const dismiss = await orchestrate(parent, "dismiss", { childSessionId: childId });
			expect(dismiss.status).toBe(200);
			expect(dismiss.json.ok).toBe(true);
			expect((await listChildren(parent)).map((c) => c.sessionId)).not.toContain(childId);
		} finally {
			await deleteSession(parent);
		}
	});

	test("orchestration verbs reject a child the caller does not own (server-side scoping)", async () => {
		const owner = await createSession();
		const stranger = await createSession();
		try {
			// `stranger` is a foreign session, not a child of `owner`.
			const resp = await orchestrate(owner, "prompt", { childSessionId: stranger, message: "hi" });
			expect(resp.status).toBe(403);
		} finally {
			await deleteSession(owner);
			await deleteSession(stranger);
		}
	});

	test("a DIFFERENT caller is denied (403) when targeting a FOREIGN owner's children (caller→owner authz)", async ({ gateway }) => {
		// HIGH finding: the shared gateway bearer is not enough — the orchestrate
		// routes must bind the request to the per-session secret and require the
		// AUTHENTIC caller to BE the owner. Otherwise any token-holder could
		// enumerate / dismiss / abort a foreign owner's children (incl. team
		// workers). Here `attacker` authenticates as ITSELF but targets `owner`'s
		// orchestrate path — every verb must 403.
		const owner = await createSession();
		const attacker = await createSession();
		try {
			// owner spawns a real child (apiFetch auto-injects owner's secret).
			const spawn = await orchestrate(owner, "spawn", { instructions: "owner's child" });
			expect(spawn.status).toBe(201);
			const childId = spawn.json.childSessionId as string;
			expect(childId).toBeTruthy();

			// attacker's own secret — supplying it suppresses owner-secret auto-injection.
			const attackerSecret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(attacker);
			const attackerHeaders = { "X-Bobbit-Session-Secret": attackerSecret };

			// Enumerating a foreign owner's children is denied.
			const listResp = await apiFetch(`/api/sessions/${owner}/orchestrate/children`, { headers: attackerHeaders });
			expect(listResp.status).toBe(403);

			// Dismissing a foreign owner's child is denied (would otherwise terminate it).
			const dismissResp = await apiFetch(`/api/sessions/${owner}/orchestrate/dismiss`, {
				method: "POST",
				headers: attackerHeaders,
				body: JSON.stringify({ childSessionId: childId }),
			});
			expect(dismissResp.status).toBe(403);

			// A request with NO secret at all is also denied (bearer alone is insufficient).
			const noSecret = await fetch(`${gateway.baseURL}/api/sessions/${owner}/orchestrate/children`, {
				headers: { Authorization: `Bearer ${process.env.BOBBIT_TOKEN}` },
			});
			expect(noSecret.status).toBe(403);

			// The legitimate owner (auto-injected secret) can still see + dismiss its child.
			expect((await listChildren(owner)).map((c) => c.sessionId)).toContain(childId);
			const ownerDismiss = await orchestrate(owner, "dismiss", { childSessionId: childId });
			expect(ownerDismiss.status).toBe(200);
		} finally {
			await deleteSession(owner);
			await deleteSession(attacker);
		}
	});
});

test.describe("team_delegate — team-lead parity", () => {
	test("a team-lead can ALSO team_delegate (no regression to its goal team tools)", async ({ gateway }) => {
		const goal = await createGoal({ title: "Orchestration delegate parity", team: true });
		let leadId: string | undefined;
		try {
			leadId = await startTeam(goal.id as string);
			expect(leadId).toBeTruthy();
			const { status, json } = await orchestrate(leadId!, "delegate", { instructions: "lead helper task" });
			expect(status).toBe(200);
			expect(json.delegates.length).toBe(1);
			expect(json.delegates[0].status).toBe("completed");
		} finally {
			await teardownTeam(goal.id as string).catch(() => {});
			await deleteGoal(goal.id as string).catch(() => {});
		}
	});
});
