/**
 * Nested project root — manual integration test.
 *
 * Pins the contract that a project registered at a SUBDIRECTORY inside a git
 * repo (rootPath = <repo>/x/project-root, .git lives at <repo>) creates
 * worktrees rooted at the git repo level — and that the session/goal CWD is
 * offset to the same subdirectory inside the worktree.
 *
 * Production code under test: the "subdirectory offset" block in
 * src/server/agent/session-setup.ts (~line 624) and the matching block in
 * src/server/agent/goal-manager.ts (~line 130 + ~line 240).
 *
 * Run:
 *   npm run build
 *   npx playwright test --config=playwright-manual.config.ts -g "Nested project root"
 */
import { test, expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
	existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDefaultWorkflows } from "../../src/server/state-migration/seed-default-workflows.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const SERVER_CLI = join(PROJECT_ROOT, "dist", "server", "cli.js");

// ---------------------------------------------------------------------------
// Gateway helpers (mirror multi-repo-docker.spec.ts)
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

// Path helpers — Windows-safe.
function eq(a: string, b: string): boolean {
	return normalize(a) === normalize(b);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test.describe("Nested project root — integration", () => {
	let gw: GW;
	let port: number;
	let gwDir: string;
	let repoRoot: string;       // <tmp>/repo  — the git repo root
	let projectDir: string;     // <repo>/x/project-root  — the registered project
	let projectId = "";

	test.beforeAll(async ({}, ti) => {
		ti.setTimeout(180_000);
		port = await freePort();

		const tmp = process.platform === "win32" ? (process.env.TEMP || "C:\\Temp") : "/tmp";
		const fixtureRoot = join(tmp, `bobbit-nested-${port}`);
		rmSync(fixtureRoot, { recursive: true, force: true });
		mkdirSync(fixtureRoot, { recursive: true });
		repoRoot = join(fixtureRoot, "repo");
		mkdirSync(repoRoot, { recursive: true });

		// 1. Init git repo at <repo>/.
		execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repoRoot, stdio: "pipe" });
		execFileSync("git", ["config", "user.email", "test@bobbit.local"], { cwd: repoRoot, stdio: "pipe" });
		execFileSync("git", ["config", "user.name", "Bobbit Test"], { cwd: repoRoot, stdio: "pipe" });
		execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoRoot, stdio: "pipe" });
		writeFileSync(join(repoRoot, "README.md"), "# nested-project-root fixture\n");

		// 2. Create the nested project subdirectory.
		projectDir = join(repoRoot, "x", "project-root");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(projectDir, "package.json"),
			JSON.stringify({
				name: "nested-project-root",
				version: "0.0.0",
				scripts: { check: "echo ok", "test:unit": "echo ok" },
			}, null, 2) + "\n",
		);
		mkdirSync(join(projectDir, ".bobbit", "config"), { recursive: true });
		writeFileSync(
			join(projectDir, ".bobbit", "config", "project.yaml"),
			"worktree_pool_size: \"1\"\n",
		);

		// 3. Commit.
		execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "pipe" });
		execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });

		// 4. Start gateway with cwd = repo root (NOT project root — gateway
		//    manages worktrees off the repo).
		gwDir = join(fixtureRoot, "gw");
		mkdirSync(join(gwDir, ".bobbit", "state"), { recursive: true });
		writeFileSync(join(gwDir, ".bobbit", "state", "projects.json"), "[]");
		gw = await startGW(gwDir, port);
		console.log(`  Gateway :${port}  repo=${repoRoot}  projectDir=${projectDir}`);

		// 5. Register the project at the NESTED rootPath.
		const body = {
			name: "Nested Project",
			rootPath: projectDir,
			components: [{
				name: "Nested Project",
				repo: ".",
				commands: {
					build: "echo build ok",
					check: "echo check ok",
					unit: "echo unit ok",
					e2e: "echo e2e ok",
				},
			}],
			workflows: buildDefaultWorkflows("Nested Project"),
		};
		const res = await api(gw, "/api/projects", { method: "POST", body: JSON.stringify(body) });
		const txt = await res.text();
		expect(res.status, `register failed: ${res.status} ${txt}`).toBe(201);
		projectId = JSON.parse(txt).id;
	});

	test.afterAll(async ({}, ti) => {
		ti.setTimeout(60_000);
		if (gw) await stopGW(gw);
		const tmp = process.platform === "win32" ? (process.env.TEMP || "C:\\Temp") : "/tmp";
		try { rmSync(join(tmp, `bobbit-nested-${port}`), { recursive: true, force: true }); } catch {}
	});

	// 1.  Project registers at the nested folder (not normalized to repo root).
	test("project registers with rootPath = nested subdirectory", async () => {
		expect(projectId).toBeTruthy();

		const res = await api(gw, `/api/projects/${projectId}`);
		expect(res.status).toBe(200);
		const proj = await res.json();
		// Compare normalized full paths — the project's rootPath must be the nested dir,
		// NOT canonicalised up to the repo root.
		expect(eq(proj.rootPath, projectDir)).toBe(true);
		expect(normalize(proj.rootPath).endsWith(`x${sep}project-root`)).toBe(true);

		const cfgRes = await api(gw, `/api/projects/${projectId}/structured`);
		expect(cfgRes.status).toBe(200);
		const cfg = await cfgRes.json();
		expect(Array.isArray(cfg.components)).toBe(true);
		expect(cfg.components).toHaveLength(1);
		expect(cfg.components[0].name).toBe("Nested Project");
	});

	// 2.  A session creates a worktree at the GIT-REPO level and offsets cwd correctly.
	test("session worktree is at the repo level; cwd is offset into x/project-root", async ({}, ti) => {
		ti.setTimeout(120_000);

		const sessRes = await api(gw, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId }),
		});
		expect(sessRes.status).toBe(201);
		const { id: sessionId } = await sessRes.json();

		await pollIdle(gw, sessionId, 120_000);

		const detail = await (await api(gw, `/api/sessions/${sessionId}`)).json();
		const cwd: string = detail.cwd;
		const worktreePath: string = detail.worktreePath;
		expect(worktreePath, `session ${sessionId} has no worktreePath: ${JSON.stringify(detail)}`).toBeTruthy();

		// (a) worktreePath contains .git (file or dir — both are valid for a worktree).
		expect(existsSync(worktreePath)).toBe(true);
		expect(existsSync(join(worktreePath, ".git"))).toBe(true);

		// (b) worktreePath sits under <repo>-wt/ (i.e. created at the repo level, NOT the project subdir level).
		//     Default convention: <rootPath>-wt/<branch> where rootPath = the git repo (`<repo>`).
		const expectedWtParent = `${repoRoot}-wt`;
		expect(eq(dirname(worktreePath), expectedWtParent),
			`worktree parent ${dirname(worktreePath)} is not ${expectedWtParent}`).toBe(true);

		// (c) cwd is the subdir offset inside the worktree — and is NOT the worktree root itself.
		const expectedCwd = join(worktreePath, "x", "project-root");
		expect(eq(cwd, expectedCwd)).toBe(true);
		expect(eq(cwd, worktreePath)).toBe(false);

		// (d) The relative path from worktreePath to cwd is exactly "x/project-root".
		expect(normalize(relative(worktreePath, cwd))).toBe(normalize("x/project-root"));

		// (e) The offset directory was actually checked out into the worktree.
		expect(existsSync(cwd)).toBe(true);
		expect(existsSync(join(cwd, "package.json"))).toBe(true);

		// (f) `git rev-parse --show-toplevel` from cwd returns the worktreePath
		//     (proves session is inside the new worktree's git tree).
		const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd, encoding: "utf-8",
		}).trim();
		// On Windows, git returns forward-slash paths; normalize both.
		expect(normalize(toplevel)).toBe(normalize(worktreePath));

		// (g) HEAD is on a session branch, not master.
		const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd, encoding: "utf-8",
		}).trim();
		expect(branch).not.toBe("master");
		expect(branch.length).toBeGreaterThan(0);
	});

	// 3.  A goal on this project provisions its worktree the same way.
	let goalId = "";
	let goalWorktreePath = "";
	test("goal worktree is at the repo level; goal.cwd is offset into x/project-root", async ({}, ti) => {
		ti.setTimeout(120_000);

		const res = await api(gw, "/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "nested-smoke",
				cwd: projectDir,
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

		// repoPath is the GIT root (ends in "repo"), not the nested project dir.
		expect(goal.repoPath, "goal.repoPath missing").toBeTruthy();
		expect(eq(goal.repoPath, repoRoot)).toBe(true);
		expect(normalize(goal.repoPath).endsWith(`${sep}repo`)).toBe(true);

		// goal.cwd is the offset inside the worktree.
		expect(goal.cwd, "goal.cwd missing").toBeTruthy();
		expect(normalize(goal.cwd).endsWith(`x${sep}project-root`)).toBe(true);

		// The goal's worktree is under <repo>-wt/.
		goalWorktreePath = goal.worktreePath;
		expect(goalWorktreePath, "goal.worktreePath missing").toBeTruthy();
		expect(existsSync(goalWorktreePath)).toBe(true);
		expect(eq(dirname(goalWorktreePath), `${repoRoot}-wt`)).toBe(true);

		// goal.cwd lives under the goal's worktree, exactly at the offset.
		expect(eq(goal.cwd, join(goalWorktreePath, "x", "project-root"))).toBe(true);
		expect(existsSync(goal.cwd)).toBe(true);
	});

	// 4.  Archive marks the goal as archived (single-repo + autoStartTeam=false:
	//     worktree cleanup is owned by session purge, not goal archive — see
	//     archiveGoal() in goal-manager.ts).
	test("archiving the goal succeeds and marks it archived", async ({}, ti) => {
		ti.setTimeout(30_000);
		expect(goalId).toBeTruthy();

		const archiveRes = await api(gw, `/api/goals/${goalId}`, { method: "DELETE" });
		expect([200, 204]).toContain(archiveRes.status);

		const after = await (await api(gw, `/api/goals/${goalId}`)).json();
		expect(after.archived).toBe(true);
	});
});
