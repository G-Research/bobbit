/**
 * Hierarchical goal metadata — API + filesystem E2E.
 *
 * Covers the goal-metadata feature end-to-end against the real in-process
 * gateway (mock agent — no LLM):
 *
 *  1. API / data model: per-goal `metadata` persists in the 201 response, the
 *     GET detail, and authoritative `goals.sqlite` storage. Empty metadata is
 *     ignored (absent ⇒ current behaviour); array metadata is rejected.
 *  2. Hierarchical resolver (the anti-asymmetry core): `getEffectiveGoalMetadata`
 *     deep-merges ancestors → self (descendant wins; arrays replace, objects
 *     recurse). A nested sub-goal inherits its parent's metadata; a metadata-less
 *     child still resolves the parent's; a metadata-less ROOT resolves to `{}`
 *     (sibling isolation).
 *  3. Anti-asymmetry invariant: a metadata-disabled tool is absent from the
 *     effective allow-list of EVERY session representation in the subtree — the
 *     team lead (`session.goalId`), a `team_delegate` sub-agent (stamped
 *     `teamGoalId` — proves `createDelegateSession` stamping), and a nested
 *     sub-goal session — while a sibling goal without metadata is unaffected.
 *     `team_spawn` members and `llm-review` reviewers carry the SAME
 *     `teamGoalId`, so the resolver assertion covers them deterministically
 *     without paying for a real team spin-up.
 *  4. Filesystem treatment: a fixture provider declaring the `goalProvisioned`
 *     lifecycle hook writes a content-addressed marker (encoding the RESOLVED
 *     metadata) into EVERY worktree it is dispatched for — the goal worktree and
 *     a nested sub-goal worktree (proving the hook is per-worktree, not
 *     once-per-root, and that the marker reflects inherited metadata). The
 *     `bobbit.disabledProviders` convention filters the provider out so a
 *     treated goal gets NO marker while a sibling does.
 *
 * The in-process harness exposes `gateway.projectContextManager` /
 * `gateway.sessionManager`, so the resolver + per-session allow-list are read
 * deterministically in-process rather than through expensive real agents.
 */
import { test, expect } from "../in-process-harness.js";
import { apiFetch, createSession, defaultProjectStateDir, nonGitCwd } from "../e2e-setup.js";
import { awaitableRm } from "../test-utils/cleanup.js";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE_PACK_DIR = path.resolve(__dirname, "..", "fixtures", "packs", "goal-provisioned-demo");
const PACK_NAME = "goal-provisioned-demo";
const MARKER_FILE = ".goal-provisioned-marker.json";
const COUNT_FILE = ".goal-provisioned-count";

const DISABLED_TOOL = "browser_navigate"; // in the default `general` allow-set
const CONTROL_TOOL = "read";               // always allowed — never disabled here

// ── helpers ──────────────────────────────────────────────────────────────────

function gitInit(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--initial-branch=master"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@bobbit.local"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "README.md"), "# repo\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: dir });
}

const SPEC = "E2E goal-metadata spec — non-placeholder spec text so the goal route accepts it for tests.";

/** Create a goal via REST (apiFetch auto-injects the default projectId). */
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

/** Effective (ancestry-merged) metadata as the SERVER resolves it for a goal. */
function effectiveMetadata(gateway: any, goalId: string): Record<string, unknown> {
	const ctx = gateway.projectContextManager.getContextForGoal(goalId);
	if (!ctx) throw new Error(`no project context owns goal ${goalId}`);
	return ctx.goalManager.getEffectiveGoalMetadata(goalId);
}

/** The session's effective allow-list, read in-process (set from effectiveAllowedTools). */
function sessionAllowedTools(gateway: any, sessionId: string): string[] | undefined {
	const s = gateway.sessionManager.getSession(sessionId) ?? gateway.sessionManager.getPersistedSession?.(sessionId);
	return s?.allowedTools as string[] | undefined;
}

async function waitForSetup(goalId: string, timeoutMs = 30_000): Promise<Record<string, any>> {
	let detail: Record<string, any> = {};
	await expect.poll(async () => {
		const r = await apiFetch(`/api/goals/${goalId}`);
		if (r.status !== 200) return undefined;
		detail = await r.json();
		return detail.setupStatus;
	}, { timeout: timeoutMs }).toMatch(/^(ready|error)$/);
	return detail;
}

function readMarker(worktreeDir: string): Record<string, any> | undefined {
	const p = path.join(worktreeDir, MARKER_FILE);
	if (!fs.existsSync(p)) return undefined;
	return JSON.parse(fs.readFileSync(p, "utf-8"));
}

async function purgeSession(id: string): Promise<void> {
	const response = await apiFetch(`/api/sessions/${encodeURIComponent(id)}?purge=true`, { method: "DELETE" });
	const text = await response.text();
	expect(response.status, `purge session ${id}: ${text}`).toBe(200);
}

async function deleteGoalStrict(id: string): Promise<void> {
	const response = await apiFetch(`/api/goals/${encodeURIComponent(id)}?cascade=true`, { method: "DELETE" });
	const text = await response.text();
	expect(response.status, `delete goal ${id}: ${text}`).toBe(200);
}

// ════════════════════════════════════════════════════════════════════════════
// 1 + 2. API persistence + hierarchical resolver (data-only, non-git, fast)
// ════════════════════════════════════════════════════════════════════════════

test.describe.serial("Hierarchical goal metadata — persistence & resolver", () => {
	const created: string[] = [];

	test.afterAll(async () => {
		for (const id of created.splice(0).reverse()) await deleteGoalStrict(id);
	});

	test("metadata persists in the 201 response, GET detail, and authoritative goals.sqlite", async ({ gateway }) => {
		const metadata = { "bobbit.disabledTools": ["browser_navigate"], "experiment": { arm: "A", seed: 1 } };
		const goal = await createGoalRaw({ title: "meta-persist", cwd: nonGitCwd(), metadata });
		created.push(goal.id);

		// 1) echoed in the 201 response.
		expect(goal.metadata).toEqual(metadata);

		// 2) survives reload — GET detail returns it.
		const detail = await (await apiFetch(`/api/goals/${goal.id}`)).json();
		expect(detail.metadata).toEqual(metadata);

		// 3) persisted to the authoritative SQLite store. Cross the store's flush
		// barrier before opening an independent read-only connection.
		const context = gateway.projectContextManager.getContextForGoal(goal.id);
		expect(context, "project context must own the goal").toBeTruthy();
		await context.goalStore.flush();
		const goalsDb = path.join(await defaultProjectStateDir(), "goals.sqlite");
		const db = new Database(goalsDb, { readonly: true, fileMustExist: true });
		try {
			const row = db.prepare("SELECT payload FROM goal_records WHERE id = ?").get(goal.id) as { payload: string } | undefined;
			expect(row, "goal must be persisted to goals.sqlite").toBeTruthy();
			expect(JSON.parse(row!.payload).metadata).toEqual(metadata);
		} finally {
			db.close();
		}
	});

	test("empty {} metadata is ignored while array metadata is rejected", async ({ gateway }) => {
		const emptyGoal = await createGoalRaw({ title: "meta-empty", cwd: nonGitCwd(), metadata: {} });
		created.push(emptyGoal.id);
		expect(emptyGoal.metadata).toBeUndefined();
		expect(effectiveMetadata(gateway, emptyGoal.id)).toEqual({});

		const arrayResponse = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "meta-array",
				cwd: nonGitCwd(),
				spec: SPEC,
				autoStartTeam: false,
				workflowId: "general",
				metadata: ["nope"],
			}),
		});
		expect(arrayResponse.status).toBe(400);
		expect((await arrayResponse.json()).code).toBe("METADATA_INVALID");
	});

	test("resolver deep-merges ancestry: descendant wins, arrays replace, objects recurse", async ({ gateway }) => {
		const rootMeta = { "bobbit.disabledTools": ["browser_navigate"], "experiment": { arm: "A", seed: 1 } };
		const root = await createGoalRaw({ title: "meta-root", cwd: nonGitCwd(), metadata: rootMeta });
		created.push(root.id);

		// Nested sub-goal overrides the array wholesale + one nested scalar; keeps `arm`.
		const nestedMeta = { "bobbit.disabledTools": ["web_search"], "experiment": { seed: 2 } };
		const nested = await createGoalRaw({ title: "meta-nested", cwd: nonGitCwd(), parentGoalId: root.id, metadata: nestedMeta });
		created.push(nested.id);

		// Metadata-less child inherits the parent's metadata verbatim.
		const inheritChild = await createGoalRaw({ title: "meta-inherit", cwd: nonGitCwd(), parentGoalId: root.id });
		created.push(inheritChild.id);

		// Root resolves to its own metadata.
		expect(effectiveMetadata(gateway, root.id)).toEqual(rootMeta);

		// Nested: array REPLACED, nested object DEEP-MERGED (arm kept, seed overridden).
		expect(effectiveMetadata(gateway, nested.id)).toEqual({
			"bobbit.disabledTools": ["web_search"],
			"experiment": { arm: "A", seed: 2 },
		});

		// Metadata-less child === parent's resolved metadata (no leak, full inheritance).
		expect(effectiveMetadata(gateway, inheritChild.id)).toEqual(rootMeta);
	});

	test("a metadata-less ROOT resolves to {} — sibling isolation", async ({ gateway }) => {
		const sibling = await createGoalRaw({ title: "meta-sibling", cwd: nonGitCwd() });
		created.push(sibling.id);
		expect(effectiveMetadata(gateway, sibling.id)).toEqual({});
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Anti-asymmetry: disabled tool applies across every session of the subtree
// ════════════════════════════════════════════════════════════════════════════

test.describe.serial("Anti-asymmetry — disabled tool across the goal subtree", () => {
	let root: Record<string, any>;
	let nested: Record<string, any>;
	let sibling: Record<string, any>;
	const sessions: string[] = [];
	const goals: string[] = [];

	test.beforeAll(async () => {
		root = await createGoalRaw({
			title: "asym-root",
			cwd: nonGitCwd(),
			metadata: { "bobbit.disabledTools": [DISABLED_TOOL], "bobbit.disabledProviders": ["memory"] },
		});
		goals.push(root.id);
		nested = await createGoalRaw({
			title: "asym-nested",
			cwd: nonGitCwd(),
			parentGoalId: root.id,
			metadata: { "bobbit.disabledTools": ["web_search"] },
		});
		goals.push(nested.id);
		sibling = await createGoalRaw({ title: "asym-sibling", cwd: nonGitCwd() });
		goals.push(sibling.id);
	});

	test.afterAll(async () => {
		for (const id of sessions.splice(0).reverse()) await purgeSession(id);
		// Children first so teardown does not rely on a parent's cascade side effect.
		for (const id of goals.splice(0).reverse()) await deleteGoalStrict(id);
	});

	test("resolver: lead/member/reviewer/delegate (teamGoalId) and nested all resolve the disabled set", ({ gateway }) => {
		// Team lead resolves via session.goalId === root; team_spawn members,
		// llm-review reviewers, and team_delegate sub-agents all carry
		// teamGoalId === root (or a descendant), so they resolve the SAME value.
		expect(effectiveMetadata(gateway, root.id)["bobbit.disabledTools"]).toEqual([DISABLED_TOOL]);
		// Nested sub-goal inherits the parent's disabledProviders, overrides disabledTools.
		const nestedEff = effectiveMetadata(gateway, nested.id);
		expect(nestedEff["bobbit.disabledTools"]).toEqual(["web_search"]);
		expect(nestedEff["bobbit.disabledProviders"]).toEqual(["memory"]);
		// Sibling root without metadata is untouched.
		expect(effectiveMetadata(gateway, sibling.id)).toEqual({});
	});

	test("team-lead session: disabled tool absent, control tool present; sibling unaffected", async ({ gateway }) => {
		const lead = await createSession({ goalId: root.id });
		sessions.push(lead);
		const leadTools = sessionAllowedTools(gateway, lead);
		expect(Array.isArray(leadTools) && leadTools.length > 0, "lead must have a populated allow-list").toBeTruthy();
		expect(leadTools).toContain(CONTROL_TOOL);
		expect(leadTools).not.toContain(DISABLED_TOOL);

		const sib = await createSession({ goalId: sibling.id });
		sessions.push(sib);
		const sibTools = sessionAllowedTools(gateway, sib);
		expect(sibTools).toContain(CONTROL_TOOL);
		expect(sibTools, "sibling goal without metadata keeps the tool").toContain(DISABLED_TOOL);
	});

	test("team_delegate sub-agent: createDelegateSession stamps teamGoalId and the tool stays disabled", async ({ gateway }) => {
		const lead = await createSession({ goalId: root.id });
		sessions.push(lead);

		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ delegateOf: lead, instructions: "do a thing", cwd: nonGitCwd() }),
		});
		expect(resp.status).toBe(201);
		const delegate = await resp.json();
		sessions.push(delegate.id);

		// Stamped with the parent's EFFECTIVE goal as teamGoalId (not goalId).
		const detail = await (await apiFetch(`/api/sessions/${delegate.id}`)).json();
		expect(detail.teamGoalId).toBe(root.id);

		// And the disabled tool does NOT leak back to the sub-agent.
		const delTools = sessionAllowedTools(gateway, delegate.id);
		expect(Array.isArray(delTools) && delTools.length > 0).toBeTruthy();
		expect(delTools).toContain(CONTROL_TOOL);
		expect(delTools, "delegate must not re-acquire the disabled tool").not.toContain(DISABLED_TOOL);
	});

	test("nested sub-goal session: inherited + own disabled tools both absent", async ({ gateway }) => {
		const sess = await createSession({ goalId: nested.id });
		sessions.push(sess);
		const tools = sessionAllowedTools(gateway, sess);
		expect(Array.isArray(tools) && tools.length > 0).toBeTruthy();
		expect(tools).toContain(CONTROL_TOOL);
		// Own metadata disables web_search; the nested goal overrode disabledTools,
		// so browser_navigate is allowed again here (array replace) — but web_search
		// is gone.
		expect(tools).not.toContain("web_search");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Filesystem treatment via the goalProvisioned lifecycle hook (git worktrees)
// ════════════════════════════════════════════════════════════════════════════

async function installPack(): Promise<string> {
	const sourceRoot = path.dirname(FIXTURE_PACK_DIR);
	const add = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: sourceRoot }),
	});
	const addText = await add.text();
	let sourceId: string;
	if (add.status === 409) {
		const sources = await apiFetch("/api/marketplace/sources");
		expect(sources.status).toBe(200);
		const existing = ((await sources.json()).sources ?? []).find((source: any) => source.url === sourceRoot);
		expect(existing, addText).toBeTruthy();
		sourceId = existing.id;
	} else {
		expect(add.status, addText).toBe(201);
		sourceId = (JSON.parse(addText) as { source: { id: string } }).source.id;
	}

	const install = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK_NAME, scope: "server" }),
	});
	const installText = await install.text();
	expect(install.status, installText).toBe(201);
	return sourceId;
}

async function uninstallPack(): Promise<void> {
	const response = await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME }),
	});
	const text = await response.text();
	expect(response.status, text).toBe(204);
}

async function removeSource(sourceId: string): Promise<void> {
	const response = await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" });
	const text = await response.text();
	expect(response.status, text).toBe(204);
}

/** PUT pack-activation to (re)set disabled providers AND bust the registry cache. */
async function setMarkerDisabled(providers: string[]): Promise<void> {
	const resp = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled: { providers } }),
	});
	expect(resp.status).toBe(200);
}

test.describe.serial("goalProvisioned filesystem treatment across worktrees", () => {
	let fixtureRoot: string;
	let repoPath: string;
	let projectId: string;
	let sourceId: string;
	const goals: string[] = [];

	test.beforeAll(async () => {
		fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goal-meta-fs-"));
		const requestedRepoPath = path.join(fixtureRoot, "repo");
		gitInit(requestedRepoPath);
		// On Windows os.tmpdir() can use an 8.3 alias while Git and project
		// preflight publish the long path. Anchor the fixture to the existing
		// repository's native identity before GoalManager derives cwd offsets.
		repoPath = fs.realpathSync.native(requestedRepoPath);
		fixtureRoot = path.dirname(repoPath);

		// Install through the marketplace lifecycle so the resolver observes the
		// pack deterministically; activation refreshes the registry after install.
		sourceId = await installPack();
		await setMarkerDisabled([]);

		const reg = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `goal-meta-fs-${Date.now()}`, rootPath: repoPath }),
		});
		expect(reg.status).toBe(201);
		const registered = await reg.json();
		expect(fs.realpathSync.native(registered.rootPath)).toBe(repoPath);
		projectId = registered.id;
		// All goal requests must use the registry's exact authoritative spelling.
		repoPath = registered.rootPath;
	});

	test.afterAll(async () => {
		for (const id of goals.splice(0).reverse()) await deleteGoalStrict(id);
		await setMarkerDisabled([]);
		await uninstallPack();
		await removeSource(sourceId);
		const projectDelete = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
		const projectDeleteText = await projectDelete.text();
		expect(projectDelete.status, projectDeleteText).toBe(200);
		const cleanup = await awaitableRm(fixtureRoot);
		expect(cleanup.removed, `fixture cleanup failed: ${String(cleanup.lastError ?? "unknown error")}`).toBe(true);
	});

	test("marker lands on the goal worktree with the resolved metadata", async () => {
		const metadata = { "experiment": { arm: "A" }, "feature.flag": true };
		const goal = await createGoalRaw({ title: "fs-root", cwd: repoPath, projectId, worktree: true, metadata });
		goals.push(goal.id);

		const detail = await waitForSetup(goal.id);
		expect(detail.setupStatus).toBe("ready");

		const worktree = detail.cwd ?? detail.worktreePath;
		const marker = readMarker(worktree);
		expect(marker, `marker must exist on goal worktree ${worktree}`).toBeTruthy();
		expect(marker!.goalId).toBe(goal.id);
		expect(marker!.metadata).toEqual(metadata);

		// Hook fired exactly once for this (single) worktree provisioning — proves
		// it is per-worktree, not duplicated, and is safe (no crash) to read again.
		const countPath = path.join(worktree, COUNT_FILE);
		expect(fs.existsSync(countPath)).toBe(true);
		const count = fs.readFileSync(countPath, "utf-8").trim().split("\n").filter(Boolean).length;
		expect(count).toBe(1);
	});

	test("nested sub-goal worktree gets its OWN marker reflecting INHERITED metadata", async () => {
		const rootMeta = { "experiment": { arm: "A", seed: 1 }, "bobbit.disabledTools": ["browser_navigate"] };
		const root = await createGoalRaw({ title: "fs-parent", cwd: repoPath, projectId, worktree: true, metadata: rootMeta });
		goals.push(root.id);
		await waitForSetup(root.id);

		const childMeta = { "experiment": { seed: 2 } };
		const child = await createGoalRaw({
			title: "fs-child", cwd: repoPath, projectId, worktree: true, parentGoalId: root.id, metadata: childMeta,
		});
		goals.push(child.id);
		const childDetail = await waitForSetup(child.id);
		expect(childDetail.setupStatus).toBe("ready");

		const childWorktree = childDetail.cwd ?? childDetail.worktreePath;
		const marker = readMarker(childWorktree);
		expect(marker, `nested sub-goal worktree must carry a marker (${childWorktree})`).toBeTruthy();
		expect(marker!.goalId).toBe(child.id);
		// Deep-merged: array kept from child? child only set experiment.seed, so
		// disabledTools is inherited; experiment.arm inherited, seed overridden.
		expect(marker!.metadata).toEqual({
			"experiment": { arm: "A", seed: 2 },
			"bobbit.disabledTools": ["browser_navigate"],
		});
	});

	test("bobbit.disabledProviders filters the provider out — treated goal gets NO marker, sibling does", async () => {
		const treated = await createGoalRaw({
			title: "fs-disabled", cwd: repoPath, projectId, worktree: true,
			metadata: { "bobbit.disabledProviders": ["marker"] },
		});
		goals.push(treated.id);
		const treatedDetail = await waitForSetup(treated.id);
		expect(treatedDetail.setupStatus).toBe("ready");
		const treatedWorktree = treatedDetail.cwd ?? treatedDetail.worktreePath;
		expect(readMarker(treatedWorktree), "disabled provider must NOT write a marker").toBeUndefined();

		// Control sibling (no disabledProviders) still gets the marker.
		const control = await createGoalRaw({ title: "fs-control", cwd: repoPath, projectId, worktree: true });
		goals.push(control.id);
		const controlDetail = await waitForSetup(control.id);
		const controlWorktree = controlDetail.cwd ?? controlDetail.worktreePath;
		expect(readMarker(controlWorktree), "enabled provider must write a marker on the sibling").toBeTruthy();
	});
});
