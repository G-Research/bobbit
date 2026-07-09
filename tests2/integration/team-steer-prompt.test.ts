/**
 * E2E tests for team_steer and team_prompt REST endpoints.
 *
 * Verifies: validation (400), membership enforcement (403),
 * steer status check (409), prompt dispatch behavior.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	createGoal,
	deleteGoal,
	startTeam,
	teardownTeam,
	waitForSessionStatus,
	connectWs,
	signalAndWaitForGate,
} from "./_e2e/e2e-setup.js";
import { pollUntil } from "../../tests/e2e/test-utils/cleanup.js";

test.setTimeout(45_000);

function seedTeamAgent(gateway: any, goalId: string, sessionId: string): void {
	const entry = gateway.teamManager.teams.get(goalId) ?? {
		goalId,
		teamLeadSessionId: `e2e-teamlead-${goalId}`,
		agents: [],
		maxConcurrent: 12,
	};
	entry.agents = [
		...entry.agents.filter((agent: any) => agent.sessionId !== sessionId),
		{ sessionId, role: "coder", kind: "worker", task: "E2E seeded team agent", createdAt: Date.now() },
	];
	gateway.teamManager.teams.set(goalId, entry);
	gateway.teamManager.sessionToGoal?.set?.(sessionId, goalId);
}

function unseedTeamAgent(gateway: any, goalId: string, sessionId: string): void {
	const entry = gateway.teamManager.teams.get(goalId);
	if (!entry) return;
	entry.agents = entry.agents.filter((agent: any) => agent.sessionId !== sessionId);
	gateway.teamManager.sessionToGoal?.delete?.(sessionId);
}

function messageIncludesContext(message: string, marker: string, prompt: string): boolean {
	return message.includes(marker) && message.includes(prompt) && message.indexOf(marker) < message.indexOf(prompt);
}

// ── Validation tests ─────────────────────────────────────────────────

test.describe("team steer/prompt — validation", () => {
	let goalId: string;

	test.beforeAll(async () => {
		const goal = await createGoal({ title: "steer-prompt-validation", team: true });
		goalId = goal.id;
	});

	test.afterAll(async () => {
		await deleteGoal(goalId);
	});

	test("POST /team/steer returns 400 without sessionId", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/steer`, {
			method: "POST",
			body: JSON.stringify({ message: "hello" }),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("Missing");
	});

	test("POST /team/steer returns 400 without message", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/steer`, {
			method: "POST",
			body: JSON.stringify({ sessionId: "fake-id" }),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("Missing");
	});

	test("POST /team/prompt returns 400 without sessionId", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/prompt`, {
			method: "POST",
			body: JSON.stringify({ message: "hello" }),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("Missing");
	});

	test("POST /team/prompt returns 400 without message", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/prompt`, {
			method: "POST",
			body: JSON.stringify({ sessionId: "fake-id" }),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("Missing");
	});
});

// ── Team membership tests ────────────────────────────────────────────

test.describe("team steer/prompt — membership enforcement", () => {
	let goalId: string;
	let nonTeamSessionId: string;

	test.beforeAll(async () => {
		const goal = await createGoal({ title: "steer-prompt-membership", team: true });
		goalId = goal.id;
		nonTeamSessionId = await createSession();
	});

	test.afterAll(async () => {
		await deleteSession(nonTeamSessionId);
		await deleteGoal(goalId);
	});

	test("POST /team/steer returns 403 for non-team session", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/steer`, {
			method: "POST",
			body: JSON.stringify({ sessionId: nonTeamSessionId, message: "redirect" }),
		});
		expect(resp.status).toBe(403);
		const data = await resp.json();
		expect(data.error).toContain("not a member");
	});

	test("POST /team/prompt returns 403 for non-team session", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/prompt`, {
			method: "POST",
			body: JSON.stringify({ sessionId: nonTeamSessionId, message: "do something" }),
		});
		expect(resp.status).toBe(403);
		const data = await resp.json();
		expect(data.error).toContain("not a member");
	});

	test("POST /team/steer returns 403 for nonexistent session", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/steer`, {
			method: "POST",
			body: JSON.stringify({ sessionId: "nonexistent-id", message: "redirect" }),
		});
		expect(resp.status).toBe(403);
	});
});

// ── Steer status check ──────────────────────────────────────────────

test.describe("team steer — agent must be streaming", () => {
	let goalId: string;

	test.beforeAll(async () => {
		const goal = await createGoal({ title: "steer-status-check", team: true });
		goalId = goal.id;
		await startTeam(goalId);
	});

	test.afterAll(async () => {
		await teardownTeam(goalId);
		await deleteGoal(goalId);
	});

	test("POST /team/steer returns 409 when agent is idle", async () => {
		const spawnResp = await apiFetch(`/api/goals/${goalId}/team/spawn`, {
			method: "POST",
			body: JSON.stringify({ role: "coder", task: "placeholder" }),
		});

		if (spawnResp.status === 201) {
			const { sessionId: agentId } = await spawnResp.json();

			// The spawn flow sends TWO prompts back-to-back (delegate's initial
			// "Execute the task" + the team-manager's enriched task). We need
			// the session to be stably idle — i.e. past both prompts — before
			// steering. Waiting for idle once, then verifying it stays idle
			// for a short debounce window, avoids catching the brief idle gap
			// between prompts.
			await waitForSessionStatus(agentId, "idle");
			// Stable-idle debounce: require N consecutive idle reads (re-arms on any
			// non-idle observation) so we don't catch the brief gap between the two
			// back-to-back prompts the spawn flow dispatches.
			let consecutive = 0;
			await pollUntil(async () => {
				const resp = await apiFetch(`/api/sessions/${agentId}`);
				const data = await resp.json();
				if (data.status === "idle") {
					consecutive++;
					return consecutive >= 5;
				}
				consecutive = 0;
				return false;
			}, { timeoutMs: 15_000, intervalMs: 100, label: "agent stably idle" });

			const steerResp = await apiFetch(`/api/goals/${goalId}/team/steer`, {
				method: "POST",
				body: JSON.stringify({ sessionId: agentId, message: "change direction" }),
			});
			expect(steerResp.status).toBe(409);
			const data = await steerResp.json();
			expect(data.error).toContain("not currently streaming");

			await apiFetch(`/api/goals/${goalId}/team/dismiss`, {
				method: "POST",
				body: JSON.stringify({ sessionId: agentId }),
			});
		}
	});
});

// ── Prompt dispatch ─────────────────────────────────────────────────

test.describe("team prompt — dispatch behavior", () => {
	let goalId: string;

	test.beforeAll(async () => {
		const goal = await createGoal({ title: "prompt-dispatch", team: true });
		goalId = goal.id;
		await startTeam(goalId);
	});

	test.afterAll(async () => {
		await teardownTeam(goalId);
		await deleteGoal(goalId);
	});

	test("POST /team/prompt defaults to steer mode for an idle team agent", async ({ gateway }) => {
		const agentId = await createSession();
		try {
			seedTeamAgent(gateway, goalId, agentId);
			await waitForSessionStatus(agentId, "idle");

			const sm = gateway.sessionManager;
			const origEnqueue = sm.enqueuePrompt.bind(sm);
			let captured: { message: string; opts?: any } | undefined;
			sm.enqueuePrompt = async (sessionId: string, message: string, opts?: any) => {
				if (sessionId === agentId && message.includes("DEFAULT_STEER_IDLE")) {
					captured = { message, opts };
				}
				return { status: "queued" };
			};

			try {
				const promptResp = await apiFetch(`/api/goals/${goalId}/team/prompt`, {
					method: "POST",
					body: JSON.stringify({ sessionId: agentId, message: "DEFAULT_STEER_IDLE" }),
				});
				const data = await promptResp.json();
				expect(promptResp.status, JSON.stringify(data)).toBe(200);
				expect(data).toMatchObject({ ok: true, mode: "steer", status: "queued" });
				expect(captured?.opts?.isSteered, "default team_prompt must enqueue idle targets as steered").toBe(true);
			} finally {
				sm.enqueuePrompt = origEnqueue;
			}
		} finally {
			unseedTeamAgent(gateway, goalId, agentId);
			await deleteSession(agentId);
		}
	});

	test("POST /team/prompt mode=prompt preserves normal enqueue semantics", async ({ gateway }) => {
		const agentId = await createSession();
		try {
			seedTeamAgent(gateway, goalId, agentId);
			await waitForSessionStatus(agentId, "idle");

			const sm = gateway.sessionManager;
			const origEnqueue = sm.enqueuePrompt.bind(sm);
			let captured: { message: string; opts?: any } | undefined;
			sm.enqueuePrompt = async (sessionId: string, message: string, opts?: any) => {
				if (sessionId === agentId && message.includes("NORMAL_PROMPT_MODE")) {
					captured = { message, opts };
				}
				return { status: "dispatched" };
			};

			try {
				const promptResp = await apiFetch(`/api/goals/${goalId}/team/prompt`, {
					method: "POST",
					body: JSON.stringify({ sessionId: agentId, message: "NORMAL_PROMPT_MODE", mode: "prompt" }),
				});
				const data = await promptResp.json();
				expect(promptResp.status, JSON.stringify(data)).toBe(200);
				expect(data).toMatchObject({ ok: true, mode: "prompt", status: "dispatched" });
				expect(captured?.opts?.isSteered, "mode=prompt must not mark queue rows as steered").not.toBe(true);
			} finally {
				sm.enqueuePrompt = origEnqueue;
			}
		} finally {
			unseedTeamAgent(gateway, goalId, agentId);
			await deleteSession(agentId);
		}
	});

	test("POST /team/prompt injects workflow gate context in prompt and steer modes", async ({ gateway }) => {
		const workflowGoal = await createGoal({ title: "prompt-context-injection", team: true, workflowId: "general" });
		const contextSessionId = await createSession({ goalId: workflowGoal.id });
		const agentId = await createSession({ goalId: workflowGoal.id });
		try {
			seedTeamAgent(gateway, workflowGoal.id, agentId);
			const conn = await connectWs(contextSessionId);
			try {
				const marker = `DESIGN_CONTEXT_MARKER_${Date.now()}`;
				await signalAndWaitForGate(
					conn,
					workflowGoal.id,
					"design-doc",
					{ content: `Design content ${marker}` },
					"passed",
					20_000,
				);

				const sm = gateway.sessionManager;
				const origEnqueue = sm.enqueuePrompt.bind(sm);
				const captured: Array<{ mode: string; message: string; opts?: any }> = [];
				sm.enqueuePrompt = async (sessionId: string, message: string, opts?: any) => {
					if (sessionId === agentId) {
						const mode = message.includes("CONTEXT_PROMPT_MODE") ? "prompt" : "steer";
						captured.push({ mode, message, opts });
					}
					return { status: "queued" };
				};

				try {
					for (const mode of ["prompt", "steer"] as const) {
						const userPrompt = mode === "prompt" ? "CONTEXT_PROMPT_MODE" : "CONTEXT_STEER_MODE";
						const promptResp = await apiFetch(`/api/goals/${workflowGoal.id}/team/prompt`, {
							method: "POST",
							body: JSON.stringify({
								sessionId: agentId,
								message: userPrompt,
								mode,
								workflowGateId: "implementation",
								inputGateIds: ["design-doc"],
							}),
						});
						const data = await promptResp.json();
						expect(promptResp.status, JSON.stringify(data)).toBe(200);
						expect(data).toMatchObject({ ok: true, mode, status: "queued" });
					}

					const promptCapture = captured.find((entry) => entry.mode === "prompt");
					const steerCapture = captured.find((entry) => entry.mode === "steer");
					expect(promptCapture, "prompt mode capture").toBeTruthy();
					expect(steerCapture, "steer mode capture").toBeTruthy();
					expect(messageIncludesContext(promptCapture!.message, marker, "CONTEXT_PROMPT_MODE")).toBe(true);
					expect(messageIncludesContext(steerCapture!.message, marker, "CONTEXT_STEER_MODE")).toBe(true);
					expect(promptCapture!.opts?.isSteered).not.toBe(true);
					expect(steerCapture!.opts?.isSteered).toBe(true);
				} finally {
					sm.enqueuePrompt = origEnqueue;
				}
			} finally {
				conn.close();
			}
		} finally {
			unseedTeamAgent(gateway, workflowGoal.id, agentId);
			await deleteSession(agentId).catch(() => {});
			await deleteSession(contextSessionId).catch(() => {});
			await deleteGoal(workflowGoal.id).catch(() => {});
		}
	});

	test("POST /team/prompt succeeds for team agent", async () => {
		const spawnResp = await apiFetch(`/api/goals/${goalId}/team/spawn`, {
			method: "POST",
			body: JSON.stringify({ role: "coder", task: "placeholder task" }),
		});

		if (spawnResp.status === 201) {
			const { sessionId: agentId } = await spawnResp.json();

			const promptResp = await apiFetch(`/api/goals/${goalId}/team/prompt`, {
				method: "POST",
				body: JSON.stringify({ sessionId: agentId, message: "also fix the tests" }),
			});
			const data = await promptResp.json();
			expect(promptResp.status, JSON.stringify(data)).toBe(200);
			expect(data.ok).toBe(true);
			expect(data.mode).toBe("steer");
			expect(data.dispatched === true || ["dispatched", "queued"].includes(data.status)).toBe(true);

			await apiFetch(`/api/goals/${goalId}/team/dismiss`, {
				method: "POST",
				body: JSON.stringify({ sessionId: agentId }),
			});
		}
	});
});
