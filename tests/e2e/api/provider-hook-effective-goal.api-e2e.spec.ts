/**
 * API E2E — provider hook endpoints honour the EFFECTIVE goal (teamGoalId).
 *
 * Regression (code-quality finding): `server.ts::resolveHookCtx()` resolved the
 * dispatch context's `goalId` as `live?.goalId ?? persisted?.goalId`, dropping
 * `teamGoalId`. Team members, `team_delegate` sub-agents, and `llm-review`
 * reviewers carry their effective goal ONLY in `teamGoalId` (no `goalId`), so
 * goal-metadata `bobbit.disabledProviders` filtering never applied at the
 * `before-prompt` / `before-compact` provider hook endpoints for those sessions
 * — a treatment leak across the goal/agent tree.
 *
 * This pins the fix: a delegate session (teamGoalId only, no goalId) under a
 * goal whose metadata disables the `demo` provider gets EMPTY before-prompt
 * content (provider filtered via teamGoalId), while an otherwise-identical
 * delegate under a metadata-less goal still receives the demo block. The
 * provider is enabled globally in both cases, so the only differentiator is the
 * teamGoalId-resolved metadata.
 */
import { test, expect } from "../in-process-harness.js";
import { apiFetch, createSession, deleteSession, deleteGoal, nonGitCwd } from "../e2e-setup.js";
import {
	installProviderDemoFixture,
	type ProviderDemoFixture,
} from "../test-utils/provider-demo-marketplace.js";

const SPEC = "E2E provider-hook effective-goal spec — non-placeholder spec text so the goal route accepts it.";

async function createGoalRaw(body: Record<string, unknown>): Promise<Record<string, any>> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({ spec: SPEC, autoStartTeam: false, workflowId: "general", ...body }),
	});
	if (resp.status !== 201) {
		throw new Error(`createGoalRaw expected 201, got ${resp.status}: ${await resp.text()}`);
	}
	return resp.json();
}

/** Create a delegate of `parentId` — stamped with the parent's effective goal as teamGoalId. */
async function createDelegate(parentId: string): Promise<Record<string, any>> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ delegateOf: parentId, instructions: "do a thing", cwd: nonGitCwd() }),
	});
	expect(resp.status).toBe(201);
	return resp.json();
}

async function callBeforePrompt(sessionId: string, prompt: string, sessionSecret: string): Promise<{ status: number; content: string; tail: string }> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/provider-hooks/before-prompt`, {
		method: "POST",
		headers: { "X-Bobbit-Session-Secret": sessionSecret },
		body: JSON.stringify({ prompt }),
	});
	const body = resp.status === 200 ? await resp.json() : {};
	return {
		status: resp.status,
		content: typeof body.content === "string" ? body.content : "",
		tail: typeof body.tail === "string" ? body.tail : "",
	};
}

test.describe.serial("provider hook endpoints resolve the effective goal (teamGoalId)", () => {
	let providerFixture: ProviderDemoFixture | undefined;
	const sessions: string[] = [];
	const goals: string[] = [];

	test.beforeAll(async () => {
		// demo enabled globally; the throwing/hanging siblings disabled so the
		// happy path stays deterministic and fast.
		providerFixture = await installProviderDemoFixture(["boom", "slow"]);
	});

	test.afterAll(async () => {
		const cleanupErrors: unknown[] = [];
		const fixture = providerFixture;
		const stages: Array<() => Promise<void>> = [
			// Keep every provider quiet while sessionShutdown runs.
			...(fixture ? [() => fixture.setDisabled(["demo", "boom", "slow"])] : []),
			...sessions.splice(0).map((id) => () => deleteSession(id)),
			...goals.splice(0).map((id) => () => deleteGoal(id)),
			...(fixture ? [() => fixture.dispose()] : []),
		];
		for (const stage of stages) {
			try { await stage(); } catch (error) { cleanupErrors.push(error); }
		}
		if (cleanupErrors.length === 1) throw cleanupErrors[0];
		if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "provider effective-goal fixture cleanup failed");
	});

	test("delegate (teamGoalId only) under a metadata-disabled goal gets EMPTY content; metadata-less control still fires", async ({ gateway }) => {
		// Goal whose metadata disables the demo provider for the whole subtree.
		const disabledGoal = await createGoalRaw({
			title: "hook-disabled",
			cwd: nonGitCwd(),
			metadata: { "bobbit.disabledProviders": ["demo"] },
		});
		goals.push(disabledGoal.id);

		// Control goal with NO metadata.
		const controlGoal = await createGoalRaw({ title: "hook-control", cwd: nonGitCwd() });
		goals.push(controlGoal.id);

		// Lead sessions carry goalId; their delegates carry ONLY teamGoalId.
		const disabledLead = await createSession({ goalId: disabledGoal.id });
		sessions.push(disabledLead);
		const disabledDelegate = await createDelegate(disabledLead);
		sessions.push(disabledDelegate.id);

		const controlLead = await createSession({ goalId: controlGoal.id });
		sessions.push(controlLead);
		const controlDelegate = await createDelegate(controlLead);
		sessions.push(controlDelegate.id);

		// Sanity: the delegate carries the effective goal in teamGoalId, NOT goalId.
		const disDetail = await (await apiFetch(`/api/sessions/${disabledDelegate.id}`)).json();
		expect(disDetail.teamGoalId).toBe(disabledGoal.id);
		expect(disDetail.goalId ?? undefined).toBeUndefined();

		const prompt = "Summarize the quarterly metrics";

		// FIX: the endpoint resolves teamGoalId → goal metadata → demo filtered out.
		const disabled = await callBeforePrompt(
			disabledDelegate.id,
			prompt,
			gateway.sessionManager.sessionSecretStore.getOrCreateSecret(disabledDelegate.id),
		);
		expect(disabled.status).toBe(200);
		expect(disabled.content, "demo must be filtered for a delegate whose teamGoalId-goal disables it").toBe("");
		expect(disabled.tail).toBe("");

		// Control delegate (metadata-less goal) still receives the demo block —
		// proves the endpoint itself works and the filtering is goal-metadata-driven
		// via teamGoalId, not a global outage.
		const control = await callBeforePrompt(
			controlDelegate.id,
			prompt,
			gateway.sessionManager.sessionSecretStore.getOrCreateSecret(controlDelegate.id),
		);
		expect(control.status).toBe(200);
		expect(control.content).toContain(`DEMO_BEFORE_PROMPT ${prompt}`);
		expect(control.tail).toContain(control.content);
	});
});
