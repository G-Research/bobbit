/**
 * Poly-repo project — manual integration test.
 *
 * Pins the contract for the multi-repo case where the project root is a
 * CONTAINER directory holding N sibling git repos as components, and the
 * container itself is NOT a git repo:
 *
 *   <rootPath>/                  ← project root, not a git repo
 *     repo1/.git ...             ← component "repo1"
 *     repo2/.git ...             ← component "repo2"
 *
 * Expected on-disk worktree layout:
 *
 *   <rootPath>-wt/                       ← shared worktree root (default)
 *     <branchSlug>/                      ← per-branch container = session/goal cwd
 *       repo1/                           ← component worktree (its own .git)
 *       repo2/                           ← component worktree (its own .git)
 *
 * Production code under test: `src/server/skills/worktree-paths.ts`,
 * `createWorktreeSet` in `src/server/skills/git.ts`, and the multi-repo paths
 * through `src/server/agent/session-setup.ts` + `goal-manager.ts`.
 *
 * Run:
 *   npm run build
 *   npx playwright test --config=playwright-manual.config.ts -g "Poly Repo"
 */
import { test, expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
	existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDefaultWorkflows } from "../../src/server/state-migration/seed-default-workflows.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const SERVER_CLI = join(PROJECT_ROOT, "dist", "server", "cli.js");

// ---------------------------------------------------------------------------
// Gateway helpers (mirror nested-project-root.spec.ts)
// ---------------------------------------------------------------------------
interface GW {
	proc: ChildProcess; port: number; dir: string; token: string; base: string;
}

async function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => res(p)); });
		s.on("error", rej);
	});
}

async function startGW(dir: string, port: number): Promise<GW> {
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	const proc = spawn(process.execPath, [
		SERVER_CLI, "--host", "127.0.0.1", "--port", String(port),
		"--no-tls", "--auth", "--cwd", dir,
	], {
		env: {
			...process.env,
			BOBBIT_DIR: join(dir, ".bobbit"),
			BOBBIT_TEST_NO_PUSH: "1",
			BOBBIT_LLM_REVIEW_SKIP: "1",
			NODE_ENV: "test",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	proc.stderr!.on("data", (c: Buffer) => { stderr += c; });
	proc.stdout!.on("data", () => {});
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) throw new Error(`Gateway exited (${proc.exitCode}):\n${stderr}`);
		try {
			const tp = join(dir, ".bobbit", "state", "token");
			if (existsSync(tp)) {
				const t = readFileSync(tp, "utf-8").trim();
				const r = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${t}` } });
				if (r.ok) break;
			}
		} catch { /* still booting */ }
		await new Promise(r => setTimeout(r, 300));
	}
	if (Date.now() >= deadline) { proc.kill(); throw new Error(`Gateway not healthy:\n${stderr}`); }
	const token = readFileSync(join(dir, ".bobbit", "state", "token"), "utf-8").trim();
	return { proc, port, dir, token, base: `http://127.0.0.1:${port}` };
}

async function stopGW(gw: GW): Promise<void> {
	if (gw.proc.exitCode === null) {
		if (process.platform === "win32") {
			try { execFileSync("taskkill", ["/PID", String(gw.proc.pid), "/T", "/F"], { stdio: "ignore", timeout: 10_000 }); } catch {}
		} else { gw.proc.kill(); }
	}
	await new Promise<void>(res => {
		if (gw.proc.exitCode !== null) return res();
		gw.proc.on("exit", () => res());
		setTimeout(() => { try { gw.proc.kill("SIGKILL"); } catch {} res(); }, 5_000);
	});
}

function api(gw: GW, path: string, opts: RequestInit = {}) {
	return fetch(`${gw.base}${path}`, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${gw.token}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

async function pollIdle(gw: GW, id: string, ms = 120_000): Promise<any> {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let res: Response;
		try { res = await api(gw, `/api/sessions/${id}`); } catch { await new Promise(r => setTimeout(r, 1_000)); continue; }
		if (res.status === 404) { await new Promise(r => setTimeout(r, 1_000)); continue; }
		const s = await res.json();
		if (s.status === "idle") return s;
		if (s.status === "archived") throw new Error(`Session ${id} archived`);
		if (s.status === "error" || s.status === "terminated") {
			const extra = s.restoreError ? `\n  restoreError: ${s.restoreError}` : "";
			throw new Error(`Session ${id} ${s.status}${extra}`);
		}
		await new Promise(r => setTimeout(r, 1_000));
	}
	throw new Error(`Session ${id} not idle in ${ms}ms`);
}

async function pollGoalReady(gw: GW, goalId: string, ms = 60_000): Promise<any> {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const res = await api(gw, `/api/goals/${goalId}`);
		const goal = await res.json();
		if (goal.setupStatus === "ready") return goal;
		if (goal.setupStatus === "error") throw new Error(`Goal setup failed: ${goal.setupError ?? JSON.stringify(goal)}`);
		await new Promise(r => setTimeout(r, 500));
	}
	throw new Error(`Goal ${goalId} setup not ready in ${ms}ms`);
}

// Path equality — Windows-safe.
function eq(a: string, b: string): boolean {
	return normalize(a) === normalize(b);
}

// `git rev-parse --show-toplevel` returns forward slashes even on Windows.
function gitToplevel(cwd: string): string | null {
	try {
		const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		return out || null;
	} catch {
		return null;
	}
}

function gitBranch(cwd: string): string {
	return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
		cwd, encoding: "utf-8",
	}).trim();
}

function initFixtureRepo(dir: string, idx: number): void {
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "master"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["config", "user.email", "test@bobbit.local"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["config", "user.name", "Bobbit Test"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "pipe" });
	writeFileSync(join(dir, "README.md"), `# poly-repo fixture ${idx}\n`);
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({
			name: `poly-repo-${idx}`,
			version: "0.0.0",
			scripts: {
				build: `echo build-${idx}`,
				check: "echo ok",
				"test:unit": "echo ok",
			},
		}, null, 2) + "\n",
	);
	execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, stdio: "pipe" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test.describe("Poly Repo — integration", () => {
	let gw: GW;
	let port: number;
	let gwDir: string;
	let fixtureRoot: string;
	let rootPath: string;          // project container — NOT a git repo
	let projectId = "";

	const components = [
		{
			name: "repo1", repo: "repo1",
			commands: { build: "echo build-1", check: "echo ok", unit: "echo ok", e2e: "echo ok" },
		},
		{
			name: "repo2", repo: "repo2",
			commands: { build: "echo build-2", check: "echo ok", unit: "echo ok", e2e: "echo ok" },
		},
	];

	test.beforeAll(async ({}, ti) => {
		ti.setTimeout(180_000);
		port = await freePort();

		const tmp = process.platform === "win32" ? (process.env.TEMP || "C:\\Temp") : "/tmp";
		fixtureRoot = join(tmp, `bobbit-poly-${port}`);
		rmSync(fixtureRoot, { recursive: true, force: true });
		mkdirSync(fixtureRoot, { recursive: true });

		// 1.  Project container (NOT a git repo).
		rootPath = join(fixtureRoot, "project");
		mkdirSync(rootPath, { recursive: true });

		// 2.  Two sibling git repos under the container.
		initFixtureRepo(join(rootPath, "repo1"), 1);
		initFixtureRepo(join(rootPath, "repo2"), 2);

		// 3.  Project YAML — pool size 0 to pin the cold path (createWorktreeSet).
		mkdirSync(join(rootPath, ".bobbit", "config"), { recursive: true });
		writeFileSync(
			join(rootPath, ".bobbit", "config", "project.yaml"),
			"worktree_pool_size: \"0\"\n",
		);

		// 4.  Gateway under its own dir.
		gwDir = join(fixtureRoot, "gw");
		mkdirSync(join(gwDir, ".bobbit", "state"), { recursive: true });
		writeFileSync(join(gwDir, ".bobbit", "state", "projects.json"), "[]");
		gw = await startGW(gwDir, port);
		console.log(`  Gateway :${port}  rootPath=${rootPath}`);

		// 5.  Register the multi-repo project.
		// Default workflows reference one component name; pin them to repo1 (must
		// match an entry in components[] or the project-config validator rejects).
		const workflows = buildDefaultWorkflows("repo1");
		const body = {
			name: "Poly Repo",
			rootPath,
			components,
			workflows,
		};
		const res = await api(gw, "/api/projects", { method: "POST", body: JSON.stringify(body) });
		const txt = await res.text();
		expect(res.status, `register failed: ${res.status} ${txt}`).toBe(201);
		projectId = JSON.parse(txt).id;

		// 6.  PUT /config so the inline workflows block actually lands on disk.
		const putRes = await api(gw, `/api/projects/${projectId}/config`, {
			method: "PUT",
			body: JSON.stringify({ components, workflows }),
		});
		expect(putRes.status, `PUT /config failed: ${putRes.status} ${await putRes.clone().text()}`).toBe(200);
	});

	test.afterAll(async ({}, ti) => {
		ti.setTimeout(60_000);
		if (gw) await stopGW(gw);
		try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch {}
		// Best-effort: also nuke the worktree root if it lingers.
		try { rmSync(`${rootPath}-wt`, { recursive: true, force: true }); } catch {}
	});

	// 1.  Project registration is poly-repo with two component repos.
	test("registers a poly-repo project (container + 2 sibling git repos)", async () => {
		expect(projectId).toBeTruthy();

		const projRes = await api(gw, `/api/projects/${projectId}`);
		expect(projRes.status).toBe(200);
		const proj = await projRes.json();
		expect(eq(proj.rootPath, rootPath)).toBe(true);

		const cfgRes = await api(gw, `/api/projects/${projectId}/structured`);
		expect(cfgRes.status).toBe(200);
		const cfg = await cfgRes.json();
		expect(Array.isArray(cfg.components)).toBe(true);
		expect(cfg.components).toHaveLength(2);
		expect(cfg.components.map((c: any) => c.name).sort()).toEqual(["repo1", "repo2"]);

		const yaml = readFileSync(join(rootPath, ".bobbit", "config", "project.yaml"), "utf-8");
		expect(yaml).toContain("name: repo1");
		expect(yaml).toContain("name: repo2");
		expect(yaml).toContain("workflows:");
	});

	// 2.  A session creates worktrees for BOTH repos at the branch-container level.
	//
	// EXPECTED: identical to goal #3 — `worktreePath` set, `cwd` = container,
	// per-repo siblings on disk. The current production behaviour is a known
	// gap (see comment at the bottom of this test) — until that's fixed, this
	// assertion fails by design and pins the contract for the eventual fix.
	test("session: container = cwd, sibling worktrees for repo1 + repo2", async ({}, ti) => {
		ti.setTimeout(120_000);

		const sessRes = await api(gw, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId }),
		});
		expect(sessRes.status, `session create failed: ${sessRes.status}`).toBe(201);
		const { id: sessionId } = await sessRes.json();

		await pollIdle(gw, sessionId, 120_000);

		const detail = await (await api(gw, `/api/sessions/${sessionId}`)).json();
		const cwd: string = detail.cwd;
		const worktreePath: string = detail.worktreePath;
		// Production bug: poly-repo session creation skips the worktree because
		// `server.ts` POST /api/sessions does `isGitRepo(cwd)` against the
		// container — which is not a git repo — and falls through to
		// `worktreeOpts = undefined`. Goals don't have this bug because
		// `goal-manager.ts` has explicit `isMulti && projectRoot` detection that
		// overrides repoPath to the project container. Until the session path
		// gets the same multi-repo branch (e.g. via a project-config-store check
		// before isGitRepo), poly-repo sessions run in the un-worktree'd
		// container directly. See task spec — "If the test reveals a real bug,
		// fail the test against the bug and document."
		expect(worktreePath, `session has no worktreePath: ${JSON.stringify(detail)}`).toBeTruthy();

		// (a)  Multi-repo + container rootPath: cwd === worktreePath (no offset).
		expect(eq(cwd, worktreePath),
			`cwd ${cwd} should equal worktreePath ${worktreePath} for poly-repo (rootPath is container itself)`).toBe(true);

		// (b)  Worktree root sits at <rootPath>-wt/.
		expect(eq(dirname(cwd), `${rootPath}-wt`),
			`worktree parent ${dirname(cwd)} should be ${rootPath}-wt`).toBe(true);

		// (c)  Both per-repo worktrees exist as siblings inside the container.
		for (const repo of ["repo1", "repo2"] as const) {
			const wt = join(cwd, repo);
			expect(existsSync(wt), `${repo} worktree missing: ${wt}`).toBe(true);
			expect(existsSync(join(wt, ".git")), `${repo}/.git missing`).toBe(true);
			expect(existsSync(join(wt, "package.json")), `${repo}/package.json missing — content not checked out`).toBe(true);

			// Each per-repo worktree IS its own git tree.
			const top = gitToplevel(wt);
			expect(top, `git rev-parse --show-toplevel from ${wt} returned null`).toBeTruthy();
			expect(normalize(top!)).toBe(normalize(wt));

			// HEAD on the same NON-master branch (multi-repo invariant: shared branch).
			const branch = gitBranch(wt);
			expect(branch).not.toBe("master");
			expect(branch.length).toBeGreaterThan(0);
		}

		// (d)  The two repos share the same branch name.
		const b1 = gitBranch(join(cwd, "repo1"));
		const b2 = gitBranch(join(cwd, "repo2"));
		expect(b1).toBe(b2);

		// (e)  The branch container itself is NOT its own git tree. git may walk
		//      up the parent chain and pick up some unrelated repo (rare on
		//      ephemeral fixtures); the only contract we need is "container !=
		//      its own toplevel".
		const containerTop = gitToplevel(cwd);
		if (containerTop !== null) {
			expect(normalize(containerTop)).not.toBe(normalize(cwd));
		}
	});

	// 3.  A goal provisions both repo worktrees the same way.
	let goalId = "";
	let goalRepoWorktrees: Record<string, string> = {};
	test("goal: repoWorktrees has both repos as siblings under <rootPath>-wt/<branch>/", async ({}, ti) => {
		ti.setTimeout(120_000);

		const res = await api(gw, "/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "poly-smoke",
				cwd: rootPath,
				projectId,
				workflowId: "feature",
				spec: "test",
				autoStartTeam: false,
			}),
		});
		expect(res.status, `goal create failed: ${res.status} ${await res.clone().text()}`).toBe(201);
		const goal0 = await res.json();
		goalId = goal0.id;

		await pollGoalReady(gw, goalId, 60_000);
		const goal = await (await api(gw, `/api/goals/${goalId}`)).json();

		// (a)  In poly-repo, goal.repoPath is set to the project container
		//      (the goal-manager override; see goal-manager.ts ~L124).
		expect(goal.repoPath, "goal.repoPath missing").toBeTruthy();
		expect(eq(goal.repoPath, rootPath),
			`goal.repoPath ${goal.repoPath} should equal rootPath ${rootPath} (poly-repo container)`).toBe(true);

		// (b)  goal.cwd is the branch container under <rootPath>-wt/.
		expect(goal.cwd, "goal.cwd missing").toBeTruthy();
		expect(eq(dirname(goal.cwd), `${rootPath}-wt`),
			`goal.cwd parent ${dirname(goal.cwd)} should be ${rootPath}-wt`).toBe(true);

		// (c)  In poly-repo, goal.cwd === worktreePath (container, no offset).
		expect(goal.worktreePath, "goal.worktreePath missing").toBeTruthy();
		expect(eq(goal.cwd, goal.worktreePath)).toBe(true);

		// (d)  repoWorktrees: { repo1, repo2 } — sibling layout.
		expect(goal.repoWorktrees, "goal.repoWorktrees missing").toBeTruthy();
		goalRepoWorktrees = goal.repoWorktrees as Record<string, string>;
		expect(Object.keys(goalRepoWorktrees).sort()).toEqual(["repo1", "repo2"]);

		for (const repo of ["repo1", "repo2"] as const) {
			const wt = goalRepoWorktrees[repo];
			expect(existsSync(wt), `goal worktree for ${repo} missing: ${wt}`).toBe(true);
			expect(existsSync(join(wt, ".git")), `goal ${repo}/.git missing`).toBe(true);
			expect(eq(dirname(wt), goal.cwd),
				`goal ${repo} worktree parent ${dirname(wt)} should be goal.cwd ${goal.cwd}`).toBe(true);

			const branch = gitBranch(wt);
			expect(branch).not.toBe("master");
			expect(branch.length).toBeGreaterThan(0);
		}
		// Both goal-side worktrees share the same branch name.
		expect(gitBranch(goalRepoWorktrees.repo1)).toBe(gitBranch(goalRepoWorktrees.repo2));
	});

	// 4.  Archive marks the goal archived AND tears down per-repo worktrees.
	test("archive tears down per-repo worktrees and marks the goal archived", async ({}, ti) => {
		ti.setTimeout(60_000);
		expect(goalId).toBeTruthy();
		expect(Object.keys(goalRepoWorktrees)).toHaveLength(2);

		const archiveRes = await api(gw, `/api/goals/${goalId}`, { method: "DELETE" });
		expect([200, 204]).toContain(archiveRes.status);

		// Per-repo cleanup is fire-and-forget; poll up to 30s.
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const allGone = Object.values(goalRepoWorktrees).every(p => !existsSync(p));
			if (allGone) break;
			await new Promise(r => setTimeout(r, 250));
		}
		for (const [repo, wt] of Object.entries(goalRepoWorktrees)) {
			expect(existsSync(wt), `worktree for ${repo} still on disk: ${wt}`).toBe(false);
		}

		const after = await (await api(gw, `/api/goals/${goalId}`)).json();
		expect(after.archived).toBe(true);
	});
});
