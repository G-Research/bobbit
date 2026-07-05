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
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createSession, deleteSession, deleteGoal, nonGitCwd } from "./_e2e/e2e-setup.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const fixturePackDir = path.resolve(__dirname, "..", "..", "tests", "fixtures", "packs", "provider-demo");
const PACK_NAME = "provider-demo";
const SPEC = "E2E provider-hook effective-goal spec — non-placeholder spec text so the goal route accepts it.";

function installPack(headquartersDir: string): string {
	const packDir = path.join(headquartersDir, "config", "market-packs", PACK_NAME);
	fs.rmSync(packDir, { recursive: true, force: true });
	fs.cpSync(fixturePackDir, packDir, { recursive: true });
	fs.writeFileSync(path.join(packDir, ".pack-meta.yaml"), [
		"sourceUrl: e2e",
		"sourceRef: local",
		"commit: test",
		`packName: ${PACK_NAME}`,
		"version: 1.0.0",
		"installedAt: '2026-01-01T00:00:00.000Z'",
		"updatedAt: '2026-01-01T00:00:00.000Z'",
		"scope: server",
	].join("\n") + "\n", "utf-8");
	return packDir;
}

/** Disable the named providers pack-wide (server scope) + bust the registry cache. */
async function setProviderDisabled(providers: string[]): Promise<void> {
	const resp = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled: { providers } }),
	});
	expect(resp.status).toBe(200);
}

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

async function callBeforePrompt(sessionId: string, prompt: string): Promise<{ status: number; content: string; tail: string }> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/provider-hooks/before-prompt`, {
		method: "POST",
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
	let packDir: string;
	const sessions: string[] = [];
	const goals: string[] = [];

	test.beforeAll(async ({ gateway }) => {
		packDir = installPack(gateway.bobbitDir);
		// demo enabled globally; the throwing/hanging siblings disabled so the
		// happy path stays deterministic and fast.
		await setProviderDisabled(["boom", "slow"]);
	});

	test.afterAll(async () => {
		for (const id of sessions.splice(0)) await deleteSession(id).catch(() => {});
		for (const id of goals.splice(0)) await deleteGoal(id).catch(() => {});
		await setProviderDisabled([]).catch(() => {});
		if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
	});

	test("delegate (teamGoalId only) under a metadata-disabled goal gets EMPTY content; metadata-less control still fires", async () => {
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
		const disabled = await callBeforePrompt(disabledDelegate.id, prompt);
		expect(disabled.status).toBe(200);
		expect(disabled.content, "demo must be filtered for a delegate whose teamGoalId-goal disables it").toBe("");
		expect(disabled.tail).toBe("");

		// Control delegate (metadata-less goal) still receives the demo block —
		// proves the endpoint itself works and the filtering is goal-metadata-driven
		// via teamGoalId, not a global outage.
		const control = await callBeforePrompt(controlDelegate.id, prompt);
		expect(control.status).toBe(200);
		expect(control.content).toContain(`DEMO_BEFORE_PROMPT ${prompt}`);
		expect(control.tail).toContain(control.content);
	});
});
