/**
 * Hierarchical goal metadata — API + filesystem E2E.
 *
 * Covers the goal-metadata feature end-to-end against the real in-process
 * gateway (mock agent — no LLM):
 *
 *  1. API / data model: per-goal `metadata` persists in the 201 response, the
 *     GET detail, and `goals.sqlite` on disk (survives reload). Empty/array
 *     metadata is ignored (absent ⇒ current behaviour).
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
import { test, expect } from "../_helpers/in-process-harness.js";
import { apiFetch, createSession, defaultProjectStateDir, deleteSession, deleteGoal, nonGitCwd } from "../_helpers/e2e-setup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const BetterSqlite = require("better-sqlite3") as new (file: string, options?: Record<string, unknown>) => {
	prepare(sql: string): { all(): Array<{ payload: string }> };
	close(): void;
};
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PACK_SOURCE = path.resolve(__dirname, "..", "..", "support", "fixtures", "shared", "packs");
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

function canonicalExistingPath(
	value: string,
	nativeRealpath: typeof fs.realpathSync.native = fs.realpathSync.native,
): string {
	return nativeRealpath(path.resolve(value));
}

function filesystemPathIdentity(
	value: string,
	nativeRealpath: typeof fs.realpathSync.native = fs.realpathSync.native,
): string {
	const canonical = canonicalExistingPath(value, nativeRealpath);
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/**
 * This fixture registers the repository root itself, so its provisioned cwd and
 * worktree root must be the same exact coordinate. Keeping this strict catches a
 * short/long Windows spelling being misread as a project subdirectory offset.
 */
function strictGoalWorktree(detail: Record<string, any>): string {
	expect(detail.worktreePath, "goal detail must publish its worktree root").toEqual(expect.any(String));
	expect(detail.cwd, "project-root goal cwd must equal its worktree root exactly").toBe(detail.worktreePath);
	expect(
		filesystemPathIdentity(detail.cwd),
		"goal cwd and worktree root must resolve to one filesystem identity",
	).toBe(filesystemPathIdentity(detail.worktreePath));
	return detail.cwd;
}

function readMarker(worktreeDir: string): Record<string, any> | undefined {
	const p = path.join(worktreeDir, MARKER_FILE);
	if (!fs.existsSync(p)) return undefined;
	return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function persistedGoals(stateDir: string): Array<Record<string, any>> {
	const db = new BetterSqlite(path.join(stateDir, "goals.sqlite"), { readonly: true });
	try {
		return db.prepare("SELECT payload FROM goal_records ORDER BY id").all().map(({ payload }) => JSON.parse(payload));
	} finally {
		db.close();
	}
}

// ════════════════════════════════════════════════════════════════════════════
// 1 + 2. API persistence + hierarchical resolver (data-only, non-git, fast)
// ════════════════════════════════════════════════════════════════════════════

test.describe.serial("Hierarchical goal metadata — persistence & resolver", () => {
	const created: string[] = [];

	test.afterAll(async () => {
		for (const id of created.splice(0)) await deleteGoal(id).catch(() => {});
	});

	test("metadata persists in the 201 response, GET detail, and goals.sqlite", async () => {
		const metadata = { "bobbit.disabledTools": ["browser_navigate"], "experiment": { arm: "A", seed: 1 } };
		const goal = await createGoalRaw({ title: "meta-persist", cwd: nonGitCwd(), metadata });
		created.push(goal.id);

		// 1) echoed in the 201 response.
		expect(goal.metadata).toEqual(metadata);

		// 2) survives reload — GET detail returns it.
		const detail = await (await apiFetch(`/api/goals/${goal.id}`)).json();
		expect(detail.metadata).toEqual(metadata);

		// 3) persisted to goals.sqlite on disk (project-scoped state for the normal
		// harness default project, not Headquarters/server state).
		const goals = persistedGoals(await defaultProjectStateDir());
		const persisted = goals.find((g) => g.id === goal.id);
		expect(persisted, "goal must be persisted to goals.sqlite").toBeTruthy();
		expect(persisted!.metadata).toEqual(metadata);
	});

	test("empty metadata is omitted and array metadata is rejected", async ({ gateway }) => {
		const emptyGoal = await createGoalRaw({ title: "meta-empty", cwd: nonGitCwd(), metadata: {} });
		created.push(emptyGoal.id);
		expect(emptyGoal.metadata).toBeUndefined();
		expect(effectiveMetadata(gateway, emptyGoal.id)).toEqual({});

		const arrResponse = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "meta-array", cwd: nonGitCwd(), spec: SPEC, workflowId: "general", metadata: ["nope"] }),
		});
		const arrBody = await arrResponse.json();
		expect(arrResponse.status).toBe(400);
		expect(arrBody.code).toBe("METADATA_INVALID");
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
		for (const id of sessions.splice(0)) await deleteSession(id).catch(() => {});
		// Children first (cascade handles it, but be explicit/best-effort).
		for (const id of goals.splice(0)) await deleteGoal(id).catch(() => {});
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
	const add = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: FIXTURE_PACK_SOURCE }),
	});
	const addText = await add.text();
	let sourceId: string;
	if (add.status === 409) {
		const sources = await (await apiFetch("/api/marketplace/sources")).json();
		const source = (sources.sources ?? []).find((row: any) => row.url === FIXTURE_PACK_SOURCE);
		if (!source?.id) throw new Error(`fixture marketplace source conflict without matching source: ${addText}`);
		sourceId = source.id;
	} else {
		if (add.status !== 201) throw new Error(`fixture marketplace source registration failed: ${add.status} ${addText}`);
		sourceId = JSON.parse(addText).source.id;
	}
	const install = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK_NAME, scope: "server" }),
	});
	if (install.status !== 201) throw new Error(`fixture marketplace install failed: ${install.status} ${await install.text()}`);
	return sourceId;
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
	let repoPath: string;
	let projectId: string;
	let sourceId: string;
	const goals: string[] = [];

	test.beforeAll(async () => {
		const requestedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goal-meta-fs-"));
		const requestedRepoPath = path.join(requestedRoot, "repo");
		gitInit(requestedRepoPath);
		// `os.tmpdir()` can carry an 8.3 spelling on Windows (RUNNER~1), while
		// Git and project preflight return the long spelling (runneradmin). Anchor
		// every subsequent cwd to the existing repository's native identity before
		// GoalManager derives a worktree subdirectory offset.
		repoPath = canonicalExistingPath(requestedRepoPath);

		sourceId = await installPack();
		// Enable the provider + invalidate the worker's registry cache.
		await setMarkerDisabled([]);

		const reg = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `goal-meta-fs-${Date.now()}`, rootPath: repoPath }),
		});
		expect(reg.status).toBe(201);
		const registered = await reg.json();
		expect(registered.rootPath, "registered project must publish its authoritative root").toEqual(expect.any(String));
		expect(
			filesystemPathIdentity(registered.rootPath),
			"registered project root must retain the requested repository identity",
		).toBe(filesystemPathIdentity(repoPath));
		projectId = registered.id;
		// Use the registry's exact spelling for every goal request. This prevents
		// mixing an accepted alias with the canonical repoPath returned by Git.
		repoPath = registered.rootPath;
	});

	test.afterAll(async () => {
		for (const id of goals.splice(0)) await deleteGoal(id).catch(() => {});
		await setMarkerDisabled([]).catch(() => {});
		await apiFetch("/api/marketplace/installed", {
			method: "DELETE",
			body: JSON.stringify({ scope: "server", packName: PACK_NAME }),
		}).catch(() => {});
		if (sourceId) await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }).catch(() => {});
	});

	test("filesystem identity expands a Windows short root without inventing a subdirectory offset", () => {
		let shortRoot = repoPath;
		let longRoot = repoPath;
		let nativeRealpath: typeof fs.realpathSync.native = fs.realpathSync.native;

		if (process.platform === "win32") {
			const drive = path.parse(repoPath).root;
			shortRoot = path.join(drive, "Users", "RUNNER~1", "AppData", "Local", "Temp", "goal-meta", "repo");
			longRoot = path.join(drive, "Users", "runneradmin", "AppData", "Local", "Temp", "goal-meta", "repo");
			nativeRealpath = ((candidate: fs.PathLike) => {
				const resolved = path.resolve(String(candidate)).toLowerCase();
				if (resolved === path.resolve(shortRoot).toLowerCase() || resolved === path.resolve(longRoot).toLowerCase()) {
					return longRoot;
				}
				throw Object.assign(new Error(`missing path: ${candidate}`), { code: "ENOENT" });
			}) as typeof fs.realpathSync.native;
		}

		const canonical = canonicalExistingPath(shortRoot, nativeRealpath);
		expect(
			filesystemPathIdentity(shortRoot, nativeRealpath),
			"short and long spellings must resolve to one filesystem identity",
		).toBe(filesystemPathIdentity(longRoot, nativeRealpath));
		expect(
			path.relative(longRoot, canonical),
			"canonical repository coordinate must stay at the strict project root",
		).toBe("");
	});

	test("marker lands on the goal worktree with the resolved metadata", async () => {
		const metadata = { "experiment": { arm: "A" }, "feature.flag": true };
		const goal = await createGoalRaw({ title: "fs-root", cwd: repoPath, projectId, worktree: true, metadata });
		goals.push(goal.id);

		const detail = await waitForSetup(goal.id);
		expect(detail.setupStatus).toBe("ready");

		const worktree = strictGoalWorktree(detail);
		const marker = readMarker(worktree);
		expect(marker, `marker must exist on goal worktree ${worktree}`).toBeTruthy();
		expect(marker!.goalId).toBe(goal.id);
		expect(marker!.worktreePath).toBe(detail.worktreePath);
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

		const childWorktree = strictGoalWorktree(childDetail);
		const marker = readMarker(childWorktree);
		expect(marker, `nested sub-goal worktree must carry a marker (${childWorktree})`).toBeTruthy();
		expect(marker!.goalId).toBe(child.id);
		expect(marker!.worktreePath).toBe(childDetail.worktreePath);
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
		const treatedWorktree = strictGoalWorktree(treatedDetail);
		expect(readMarker(treatedWorktree), "disabled provider must NOT write a marker").toBeUndefined();

		// Control sibling (no disabledProviders) still gets the marker.
		const control = await createGoalRaw({ title: "fs-control", cwd: repoPath, projectId, worktree: true });
		goals.push(control.id);
		const controlDetail = await waitForSetup(control.id);
		const controlWorktree = strictGoalWorktree(controlDetail);
		const controlMarker = readMarker(controlWorktree);
		expect(controlMarker, "enabled provider must write a marker on the sibling").toBeTruthy();
		expect(controlMarker!.goalId).toBe(control.id);
		expect(controlMarker!.worktreePath).toBe(controlDetail.worktreePath);
		expect(controlMarker!.metadata).toEqual({});
	});
});
