/**
 * v2 integration — parity port of tests/e2e/market-pack-team-roles.spec.ts.
 *
 * Pins the two role-plumbing behaviours for "Market-Pack Roles in Teams":
 *   Gap 1 — a team lead can `team_spawn` a market-pack role (resolved through
 *           the config cascade, not the bare RoleStore) and the worker carries
 *           the pack role prompt + accessory; the team-lead {{AVAILABLE_ROLES}}
 *           injection lists the installed pack role.
 *   Gap 2 — `team_delegate(role)` (POST /orchestrate/spawn with a `role`)
 *           threads the role promptTemplate + accessory to the child.
 *
 * Plus three regression guards (spawn verbs stripped on delegate children,
 * read_only strips mutating tools, team_spawn stays goal/team-only).
 *
 * Runs against the fork-scoped in-process gateway; helpers/harness are the
 * v2-integration equivalents of the legacy in-process-harness surface.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createGoal, startTeam, deleteGoal, teardownTeam, createSession, deleteSession } from "./_e2e/e2e-setup.js";
import { fileURLToPath } from "node:url";

const SOURCE_DIR = fileURLToPath(new URL("../../tests/fixtures/market-sources/market-role-fixture-src", import.meta.url));
const PACK_NAME = "market-role-fixture";
const ROLE_ID = "fixture-pack-nurse";
const ROLE_ACCESSORY = "stethoscope";
const ROLE_PROMPT_MARKER = "FIXTURE_PACK_ROLE_PROMPT";
const REPRO = "MARKET_PACK_TEAM_ROLE_REGRESSION";

let sourceId: string | undefined;

async function readJson(resp: Response): Promise<any> {
	const text = await resp.text();
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		return { raw: text };
	}
}

/** Poll `probe` until it returns a truthy value or the timeout elapses. */
async function pollValue<T>(probe: () => T | Promise<T>, timeoutMs = 5_000, intervalMs = 50): Promise<T | undefined> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = await probe();
		if (value) return value;
		await new Promise(r => setTimeout(r, intervalMs));
	}
	return undefined;
}

async function addSource(): Promise<string> {
	const add = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: SOURCE_DIR }),
	});
	const text = await add.text();
	if (add.status === 409) {
		const list = await apiFetch("/api/marketplace/sources");
		expect(list.status, `${REPRO}: failed to list existing marketplace sources after source conflict`).toBe(200);
		const source = ((await list.json()).sources ?? []).find((item: any) => item.url === SOURCE_DIR);
		expect(source, `${REPRO}: existing marketplace source for fixture pack should be discoverable`).toBeTruthy();
		return source.id;
	}
	expect(add.status, `${REPRO}: failed to register fixture marketplace source; body=${text}`).toBe(201);
	return JSON.parse(text).source.id;
}

async function installPack(): Promise<void> {
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME }),
	}).catch(() => {});

	sourceId = await addSource();
	const install = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK_NAME, scope: "server" }),
	});
	const installText = await install.text();
	expect(install.status, `${REPRO}: fixture marketplace pack install failed; body=${installText}`).toBe(201);

	const activation = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled: {} }),
	});
	const activationText = await activation.text();
	expect(activation.status, `${REPRO}: fixture role pack activation refresh failed; body=${activationText}`).toBe(200);
}

async function uninstallPack(): Promise<void> {
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME }),
	}).catch(() => {});
	if (sourceId) {
		await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }).catch(() => {});
	}
}

/** Sanity: the fixture role must be visible through GET /api/roles before we
 *  exercise the team/delegate spawn paths — the whole point is that it lives in
 *  the config cascade, not the bare RoleStore. */
async function assertFixtureRoleVisible(): Promise<void> {
	const res = await apiFetch("/api/roles");
	const body = await readJson(res);
	expect(res.status, `${REPRO}: GET /api/roles failed; body=${JSON.stringify(body)}`).toBe(200);
	const role = (body.roles ?? []).find((item: any) => item.name === ROLE_ID);
	expect(role, `${REPRO}: fixture market-pack role must be installed + cascade-visible before team/delegate tests`).toBeTruthy();
	expect(role.accessory).toBe(ROLE_ACCESSORY);
	expect(String(role.promptTemplate ?? "")).toContain(ROLE_PROMPT_MARKER);
}

test.describe("market-pack roles in teams", () => {
	test.beforeAll(async () => {
		await installPack();
	});

	test.afterAll(async () => {
		await uninstallPack();
	});

	// ────────────────────────────────────────────────────────────────────────
	// Gap 1 — team lead can team_spawn a market-pack role
	// ────────────────────────────────────────────────────────────────────────
	test("Gap 1: a team lead can team_spawn a market-pack role and the agent carries its prompt + accessory", async ({ gateway }) => {
		await assertFixtureRoleVisible();
		const goal = await createGoal({ title: "Team spawns a market-pack role", team: true });
		let leadId: string | undefined;
		let workerId: string | undefined;
		try {
			leadId = await startTeam(goal.id as string);
			expect(leadId, `${REPRO}: team lead must start for the goal`).toBeTruthy();

			const spawn = await apiFetch(`/api/goals/${goal.id}/team/spawn`, {
				method: "POST",
				body: JSON.stringify({ role: ROLE_ID, task: "Market-pack role worker — verify prompt + accessory." }),
			});
			const spawnBody = await readJson(spawn);
			expect(
				spawn.status,
				`${REPRO}: team_spawn must accept market-pack role ${ROLE_ID} resolved through the config cascade; body=${JSON.stringify(spawnBody)}`,
			).toBe(201);
			workerId = spawnBody.sessionId as string;
			expect(workerId, `${REPRO}: team_spawn of a market-pack role must return a worker session id`).toBeTruthy();

			const accessory = await pollValue(() => gateway.sessionManager.getPersistedSession(workerId!)?.accessory ?? null);
			expect(
				accessory,
				`${REPRO}: team_spawn'd market-pack worker must use the pack role accessory`,
			).toBe(ROLE_ACCESSORY);

			const rolePrompt = String(gateway.sessionManager.getPromptParts(workerId!)?.rolePrompt ?? "");
			expect(
				rolePrompt,
				`${REPRO}: team_spawn'd market-pack worker's system prompt must contain the pack role promptTemplate`,
			).toContain(ROLE_PROMPT_MARKER);
		} finally {
			if (workerId) await apiFetch(`/api/goals/${goal.id}/team/dismiss`, { method: "POST", body: JSON.stringify({ sessionId: workerId }) }).catch(() => {});
			await teardownTeam(goal.id as string).catch(() => {});
			await deleteGoal(goal.id as string).catch(() => {});
		}
	});

	test("Gap 1: the team lead's {{AVAILABLE_ROLES}} lists the installed market-pack role", async ({ gateway }) => {
		await assertFixtureRoleVisible();
		const goal = await createGoal({ title: "Team lead sees market-pack role", team: true });
		let leadId: string | undefined;
		try {
			leadId = await startTeam(goal.id as string);
			expect(leadId, `${REPRO}: team lead must start for the goal`).toBeTruthy();

			const leadPrompt = String(gateway.sessionManager.getPromptParts(leadId!)?.rolePrompt ?? "");
			expect(
				leadPrompt,
				`${REPRO}: team-lead {{AVAILABLE_ROLES}} must include the installed market-pack role so the lead can spawn it`,
			).toContain(ROLE_ID);
		} finally {
			await teardownTeam(goal.id as string).catch(() => {});
			await deleteGoal(goal.id as string).catch(() => {});
		}
	});

	// ────────────────────────────────────────────────────────────────────────
	// Gap 2 — team_delegate(role) threads prompt + accessory
	// ────────────────────────────────────────────────────────────────────────
	test("Gap 2: team_delegate(role) child carries the role promptTemplate and accessory", async ({ gateway }) => {
		await assertFixtureRoleVisible();
		const parent = await createSession();
		let childId: string | undefined;
		try {
			const spawn = await apiFetch(`/api/sessions/${parent}/orchestrate/spawn`, {
				method: "POST",
				body: JSON.stringify({ instructions: "market-pack role delegate", role: ROLE_ID }),
			});
			const spawnBody = await readJson(spawn);
			expect(
				spawn.status,
				`${REPRO}: team_delegate(role) spawn should succeed; body=${JSON.stringify(spawnBody)}`,
			).toBe(201);
			childId = spawnBody.childSessionId as string;
			expect(childId, `${REPRO}: team_delegate(role) must return a child session id`).toBeTruthy();

			const rolePrompt = String(gateway.sessionManager.getPromptParts(childId!)?.rolePrompt ?? "");
			expect(
				rolePrompt,
				`${REPRO}: team_delegate(role) child's system prompt must contain the role promptTemplate`,
			).toContain(ROLE_PROMPT_MARKER);

			const accessory = await pollValue(() => gateway.sessionManager.getPersistedSession(childId!)?.accessory ?? null);
			expect(
				accessory,
				`${REPRO}: team_delegate(role) child must persist the role accessory`,
			).toBe(ROLE_ACCESSORY);
		} finally {
			if (childId) await apiFetch(`/api/sessions/${parent}/orchestrate/dismiss`, { method: "POST", body: JSON.stringify({ childSessionId: childId }) }).catch(() => {});
			await deleteSession(parent);
		}
	});

	// ────────────────────────────────────────────────────────────────────────
	// Regression guards — intentional differences the fix must NOT regress.
	// ────────────────────────────────────────────────────────────────────────
	test("Regression: a role-carrying team_delegate child still has spawn verbs stripped (recursion guard)", async ({ gateway }) => {
		await assertFixtureRoleVisible();
		const parent = await createSession();
		let childId: string | undefined;
		try {
			const spawn = await apiFetch(`/api/sessions/${parent}/orchestrate/spawn`, {
				method: "POST",
				body: JSON.stringify({ instructions: "recursion-guard role delegate", role: ROLE_ID }),
			});
			const spawnBody = await readJson(spawn);
			expect(spawn.status, `team_delegate(role) spawn should succeed; body=${JSON.stringify(spawnBody)}`).toBe(201);
			childId = spawnBody.childSessionId as string;

			const persistedTools = gateway.sessionManager.getPersistedSession(childId!)?.allowedTools ?? [];
			expect(persistedTools.length, "child must have an explicit persisted allow-list").toBeGreaterThan(0);
			for (const verb of ["team_spawn", "team_delegate"]) {
				expect(persistedTools, `role injection must NOT re-add spawn verb ${verb} to a delegate child`).not.toContain(verb);
			}
		} finally {
			if (childId) await apiFetch(`/api/sessions/${parent}/orchestrate/dismiss`, { method: "POST", body: JSON.stringify({ childSessionId: childId }) }).catch(() => {});
			await deleteSession(parent);
		}
	});

	test("Regression: a read_only role delegate still has all mutating tools stripped", async ({ gateway }) => {
		await assertFixtureRoleVisible();
		const parent = await createSession();
		let childId: string | undefined;
		try {
			const spawn = await apiFetch(`/api/sessions/${parent}/orchestrate/spawn`, {
				method: "POST",
				body: JSON.stringify({ instructions: "read-only role delegate", role: ROLE_ID, read_only: true }),
			});
			const spawnBody = await readJson(spawn);
			expect(spawn.status, `read_only team_delegate(role) spawn should succeed; body=${JSON.stringify(spawnBody)}`).toBe(201);
			childId = spawnBody.childSessionId as string;

			const persistedTools = gateway.sessionManager.getPersistedSession(childId!)?.allowedTools ?? [];
			expect(Boolean(gateway.sessionManager.getPersistedSession(childId!)?.readOnly), "read_only marker persisted").toBe(true);
			for (const tool of ["write", "edit", "bash", "bash_bg"]) {
				expect(persistedTools, `read_only role delegate must not regain mutating tool ${tool} via role injection`).not.toContain(tool);
			}
			expect(persistedTools, "read_only delegate still keeps read").toContain("read");
		} finally {
			if (childId) await apiFetch(`/api/sessions/${parent}/orchestrate/dismiss`, { method: "POST", body: JSON.stringify({ childSessionId: childId }) }).catch(() => {});
			await deleteSession(parent);
		}
	});

	test("Regression: team_spawn stays goal/team-only — it fails without an active goal team", async () => {
		const goal = await createGoal({ title: "team_spawn requires an active team", team: true });
		try {
			const spawn = await apiFetch(`/api/goals/${goal.id}/team/spawn`, {
				method: "POST",
				body: JSON.stringify({ role: "coder", task: "should be rejected — no active team" }),
			});
			const body = await readJson(spawn);
			expect(spawn.status, `team_spawn without an active team must be rejected; body=${JSON.stringify(body)}`).not.toBe(201);
			expect(String(body.error ?? body.message ?? ""), "rejection should mention the missing active team").toMatch(/no active team/i);
		} finally {
			await teardownTeam(goal.id as string).catch(() => {});
			await deleteGoal(goal.id as string).catch(() => {});
		}
	});
});
