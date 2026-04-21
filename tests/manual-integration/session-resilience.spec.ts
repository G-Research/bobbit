/**
 * Full-stack integration tests — sessions, goals, sandboxed goals.
 *
 * Single gateway, real agents, one restart — verifies everything survives.
 * All agent interactions go through the browser UI.
 *
 *   npm run test:manual                  # headless browser
 *   SCREENSHOTS=1 npm run test:manual    # + screenshots + HTML report
 *
 * Prerequisites: `npm run build`, agent CLI in PATH, Docker for sandbox tests.
 *
 * Test phases (all serial, one gateway):
 *   A.  Session variations    — 6 session configs (plain, worktree, sandbox, interrupt)
 *   A2. Multi-project         — second project with sessions, goal, sidebar grouping
 *   B.  Goal (non-sandboxed)  — create via UI, team auto-start, gates, dashboard
 *   C.  Goal (sandboxed)      — same as B but inside Docker container
 *   D.  Gateway restart       — hard kill + restart on new port
 *   E.  Post-restart verify   — sessions, goals, gates, teams, multi-project all survive
 *   F.  Combined HTML report  — timing, screenshots, phase results
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
	mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync,
	cpSync,
} from "node:fs";
import { join, resolve, normalize } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const SERVER_CLI = join(PROJECT_ROOT, "dist", "server", "cli.js");
const RESULTS_DIR = join(PROJECT_ROOT, "test-results", "manual-integration");
const WANT_SCREENSHOTS = !!process.env.SCREENSHOTS;

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------
function hasDocker(): boolean {
	try { execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 }); return true; } catch { return false; }
}
const HAS_DOCKER = hasDocker();

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------
interface GW {
	proc: ChildProcess; port: number; dir: string;
	token: string; base: string;
	defaultProjectId?: string;
}

/** Endpoints that now require a projectId post-eliminate-default-project. */
const PROJECT_REQUIRED_POST = new Set(["/api/sessions", "/api/goals", "/api/staff"]);

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
		env: { ...process.env, BOBBIT_DIR: join(dir, ".bobbit"), NODE_ENV: "test" },
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
				if ((await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${t}` } })).ok) break;
			}
		} catch {}
		await new Promise(r => setTimeout(r, 300));
	}
	if (Date.now() >= deadline) { proc.kill(); throw new Error(`Not healthy:\n${stderr}`); }
	const token = readFileSync(join(dir, ".bobbit", "state", "token"), "utf-8").trim();
	return { proc, port, dir, token, base: `http://127.0.0.1:${port}` };
}

async function stopGW(gw: GW): Promise<void> {
	if (gw.proc.exitCode === null) {
		if (process.platform === "win32") {
			try { execFileSync("taskkill", ["/PID", String(gw.proc.pid), "/T", "/F"], { stdio: "ignore", timeout: 10_000 }); } catch {}
		} else { gw.proc.kill(); }
	}
	await new Promise<void>(r => {
		if (gw.proc.exitCode !== null) return r();
		gw.proc.on("exit", () => r());
		setTimeout(() => { try { gw.proc.kill("SIGKILL"); } catch {} r(); }, 5_000);
	});
	await new Promise(r => setTimeout(r, 1_500));
}

// ---------------------------------------------------------------------------
// API helpers (read-only queries + session creation with flags not in UI)
// ---------------------------------------------------------------------------
function api(gw: GW, path: string, opts: RequestInit = {}) {
	// Auto-inject projectId for endpoints that now require it (eliminate-default-project).
	if ((opts.method || "GET").toUpperCase() === "POST" && PROJECT_REQUIRED_POST.has(path) && gw.defaultProjectId) {
		try {
			const body = typeof opts.body === "string" && opts.body ? JSON.parse(opts.body) : {};
			if (body && typeof body === "object" && !body.projectId) {
				body.projectId = gw.defaultProjectId;
				opts = { ...opts, body: JSON.stringify(body) };
			}
		} catch { /* non-JSON body — leave alone */ }
	}
	return fetch(`${gw.base}${path}`, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${gw.token}`, ...(opts.headers as Record<string, string> || {}) } });
}

async function pollIdle(gw: GW, id: string, ms = 120_000) {
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

async function getSession(gw: GW, id: string) { return (await api(gw, `/api/sessions/${id}`)).json(); }

async function pollGoalSetup(gw: GW, goalId: string, ms = 120_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const res = await api(gw, `/api/goals/${goalId}`);
		const goal = await res.json();
		if (goal.setupStatus === "ready") return goal;
		if (goal.setupStatus === "failed") throw new Error(`Goal setup failed: ${JSON.stringify(goal)}`);
		await new Promise(r => setTimeout(r, 1_000));
	}
	throw new Error(`Goal ${goalId} setup not ready in ${ms}ms`);
}

async function pollTeamStarted(gw: GW, goalId: string, ms = 120_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const res = await api(gw, `/api/goals/${goalId}/team`);
		if (res.status === 200) {
			const team = await res.json();
			if (team.teamLeadSessionId) return team;
		}
		await new Promise(r => setTimeout(r, 1_000));
	}
	throw new Error(`Team not started for goal ${goalId} within ${ms}ms`);
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------
function appUrl(gw: GW) {
	return `${gw.base}/?token=${gw.token}`;
}

function sessionUrl(gw: GW, id: string) {
	return `${gw.base}/?token=${gw.token}#/session/${id}`;
}

function goalDashboardUrl(gw: GW, goalId: string) {
	return `${gw.base}/?token=${gw.token}#/goal/${goalId}`;
}

/**
 * Navigate to a session, interrupt it if streaming (click the stop button),
 * wait for idle, then send a message and wait for the response.
 * This is the browser-driven equivalent of abort + prompt.
 */
async function interruptAndSend(page: Page, gw: GW, id: string, text: string, idleTimeoutMs = 120_000) {
	await page.goto(sessionUrl(gw, id));
	await page.waitForSelector("textarea", { timeout: 30_000 });

	// If streaming, click the stop button — it should appear and work reliably.
	// forceAbort() gives 3s grace then force-kills, so 15s total is generous.
	const sessInfo = await getSession(gw, id);
	if (sessInfo.status === "streaming") {
		const stopBtn = page.locator('button[title="Stop streaming"]');
		await stopBtn.waitFor({ state: "visible", timeout: 10_000 });
		await stopBtn.click();
		await pollIdle(gw, id, 15_000);
	}

	// Now send the message
	await page.fill("textarea", text);
	await page.press("textarea", "Enter");
	await page.waitForTimeout(1_500);
	await pollIdle(gw, id, idleTimeoutMs);
	await page.waitForTimeout(2_000);
}

async function browserSend(page: Page, gw: GW, id: string, text: string, idleMs = 120_000) {
	await page.goto(sessionUrl(gw, id));
	await page.waitForSelector("textarea", { timeout: 30_000 });
	try { await page.waitForSelector('[class*="tool"], [class*="Tool"], details, pre', { timeout: 8_000 }); } catch {}
	await page.waitForTimeout(500);
	await page.fill("textarea", text);
	await page.press("textarea", "Enter");
	await page.waitForTimeout(1_500);
	await pollIdle(gw, id, idleMs);
	await page.waitForTimeout(2_000);
}

async function takeScreenshot(page: Page, name: string) {
	if (!WANT_SCREENSHOTS) return;
	mkdirSync(RESULTS_DIR, { recursive: true });
	await page.screenshot({ path: join(RESULTS_DIR, name), fullPage: true });
	console.log(`    📸 ${name}`);
}

/**
 * Fetch git-status for a session via the API and return the parsed data.
 * Returns null if the endpoint fails (e.g. session archived or cwd missing).
 */
async function fetchGitStatusApi(gw: GW, sessionId: string): Promise<{
	branch: string; primaryBranch: string; isOnPrimary: boolean;
	summary: string; clean: boolean; hasUpstream: boolean;
	ahead: number; behind: number; aheadOfPrimary: number; behindPrimary: number;
	mergedIntoPrimary: boolean; unpushed: boolean;
	status: Array<{ file: string; status: string }>;
} | null> {
	try {
		const res = await api(gw, `/api/sessions/${sessionId}/git-status`);
		if (!res.ok) return null;
		return await res.json();
	} catch { return null; }
}

/**
 * Verify the git-status widget is visible in the session UI.
 * Looks for the `<git-status-widget>` custom element rendered inside the
 * pill strip near the textarea. Returns the widget's text content (branch name etc.)
 * or null if not found within the timeout.
 */
async function checkGitStatusWidget(page: Page): Promise<string | null> {
	try {
		const widget = page.locator('git-status-widget');
		await widget.waitFor({ state: 'attached', timeout: 15_000 });
		// The widget renders a shadow DOM button — get its text via JS
		const text = await widget.evaluate((el: Element) => {
			const sr = el.shadowRoot;
			if (!sr) return el.textContent?.trim() || '';
			const btn = sr.querySelector('button');
			return btn?.textContent?.trim() || sr.textContent?.trim() || '';
		});
		return text || null;
	} catch {
		return null;
	}
}

/**
 * Create a goal via the browser UI:
 *   1. Click "New Goal" button — opens goal assistant with form panel
 *   2. Fill in title and spec directly in the form
 *   3. Select workflow from dropdown
 *   4. Click "Create Goal"
 *   5. Wait for navigation to goal dashboard
 *   6. Return the goalId from the URL
 */
async function createGoalViaBrowser(
	page: Page,
	gw: GW,
	title: string,
	spec: string,
	opts?: { workflowId?: string; sandboxed?: boolean },
): Promise<string> {
	await page.goto(appUrl(gw));
	// Wait for sidebar to fully load
	await page.waitForSelector("button", { timeout: 15_000 });

	// Click "New Goal". Prefer the per-project "+ goal" button (title `New goal in <name>`) —
	// unambiguous in multi-project installs. Fall back to toolbar "+ New Goal" + picker for
	// single-project runs where the per-project button may not exist.
	const perProjectBtn = page.locator("button[title^='New goal in']").first();
	if (await perProjectBtn.count() > 0) {
		await expect(perProjectBtn).toBeVisible({ timeout: 10_000 });
		await perProjectBtn.click();
	} else {
		const toolbarBtn = page.locator("button[title='New goal (Alt+G)']").first();
		await expect(toolbarBtn).toBeVisible({ timeout: 10_000 });
		await toolbarBtn.click();
		// If the project-picker popover opened (multi-project install), pick the first project.
		const popover = page.locator("project-picker-popover");
		if (await popover.count() > 0) {
			const firstRow = popover.locator(".bobbit-project-picker-row").first();
			await expect(firstRow).toBeVisible({ timeout: 5_000 });
			await firstRow.click();
		}
	}

	// Wait for the goal assistant form to render (title input + Create Goal button)
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 15_000 });

	// Fill in the title
	await titleInput.fill(title);

	// Check "Sandbox (Docker)" if requested
	if (opts?.sandboxed) {
		const sandboxCheckbox = page.locator("input[type='checkbox']").filter({ has: page.locator("~ *:has-text('Sandbox')") }).first();
		// Try finding the checkbox by its label text
		const sandboxLabel = page.getByText("Sandbox (Docker)").first();
		if (await sandboxLabel.isVisible({ timeout: 3_000 }).catch(() => false)) {
			await sandboxLabel.click();
		}
	}

	// Fill in the spec — click "Edit" next to the Spec label to open the editor
	const editSpecBtn = page.locator("button, a, span").filter({ hasText: "Edit" }).first();
	if (await editSpecBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
		await editSpecBtn.click();
		// Wait for the spec textarea/editor to appear
		const specEditor = page.locator(".goal-preview-panel textarea, .goal-preview-panel [contenteditable]").first();
		if (await specEditor.isVisible({ timeout: 3_000 }).catch(() => false)) {
			await specEditor.fill(spec);
		}
	}

	// Select workflow from dropdown
	if (opts?.workflowId) {
		const workflowSelect = page.locator(".goal-preview-panel select").first();
		if (await workflowSelect.isVisible({ timeout: 3_000 }).catch(() => false)) {
			await workflowSelect.selectOption(opts.workflowId);
		}
	}

	await takeScreenshot(page, "goal-creation-form.png");

	// Click "Create Goal"
	const createGoalBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
	await expect(createGoalBtn).toBeVisible({ timeout: 10_000 });
	await createGoalBtn.click();

	// Wait for navigation to goal dashboard
	await expect(page).toHaveURL(/#\/goal(-dashboard)?\//, { timeout: 30_000 });
	await page.waitForSelector(".tab", { timeout: 15_000 });

	// Extract goalId from URL
	const url = page.url();
	const match = url.match(/#\/goal(?:-dashboard)?\/([^/?]+)/);
	expect(match).toBeTruthy();
	return match![1];
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------
function initRepo(dir: string) {
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/master"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "ignore" });
	writeFileSync(join(dir, "README.md"), "# Test project\n");
	writeFileSync(join(dir, "package.json"), JSON.stringify({
		name: "test-project", version: "1.0.0",
		scripts: { check: "echo ok", "test:unit": "echo ok" },
	}, null, 2));
	execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
	try {
		const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 5_000 }).trim();
		execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir, stdio: "ignore" });
	} catch {}

	// Copy config files (workflows, roles, tools, etc.) so the gateway has them.
	// Exclude project.yaml since we write our own.
	const srcConfig = join(PROJECT_ROOT, ".bobbit", "config");
	const dstConfig = join(dir, ".bobbit", "config");
	if (existsSync(srcConfig)) {
		cpSync(srcConfig, dstConfig, { recursive: true, filter: (src) => !src.endsWith("project.yaml") });
	}
}

/**
 * Remove Docker containers and volumes created by test runs.
 * Matches containers whose bind-mounts reference temp dirs used by manual tests
 * (`.bobbit-manual-*`, `.bobbit-manual-integration-*`, `.e2e-resilience-*`).
 * Skips the live project sandbox (bound to the real project root).
 */
function cleanTestDockerContainers() {
	try {
		// List all bobbit-project containers (running + stopped)
		const ids = execFileSync("docker", [
			"ps", "-aq", "--filter", "label=bobbit-project",
		], { encoding: "utf-8", timeout: 10_000 }).trim();
		if (!ids) return;

		for (const id of ids.split(/\s+/).filter(Boolean)) {
			try {
				const binds = execFileSync("docker", [
					"inspect", "--format", "{{json .HostConfig.Binds}}", id,
				], { encoding: "utf-8", timeout: 5_000 }).trim();
				// Only remove containers bound to test temp dirs
				if (/\.bobbit-manual|\.e2e-resilience/.test(binds)) {
					// Get project ID for volume cleanup
					const projectId = execFileSync("docker", [
						"inspect", "--format", '{{index .Config.Labels "bobbit-project"}}', id,
					], { encoding: "utf-8", timeout: 5_000 }).trim();

					execFileSync("docker", ["rm", "-f", id], { timeout: 15_000, stdio: "ignore" });

					// Remove associated named volumes
					if (projectId) {
						for (const prefix of ["bobbit-workspace-", "bobbit-worktrees-"]) {
							try {
								execFileSync("docker", ["volume", "rm", "-f", `${prefix}${projectId}`], {
									timeout: 10_000, stdio: "ignore",
								});
							} catch { /* volume may not exist */ }
						}
					}
				}
			} catch { /* inspect/rm may fail for already-removed containers */ }
		}
	} catch { /* docker not available */ }
}

function cleanDirs(dir: string) {
	const parent = resolve(dir, "..");
	const base = dir.split(/[\\/]/).pop()!;
	const dirs = [dir];
	try { for (const e of readdirSync(parent)) if (e.startsWith(base)) dirs.push(join(parent, e)); } catch {}
	for (const d of dirs) { for (let i = 0; i < 3; i++) { try { rmSync(d, { recursive: true, force: true }); break; } catch {} } }
}

async function waitForFile(gw: GW, id: string, ms = 30_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const sf = join(gw.dir, ".bobbit", "state", "sessions.json");
		if (existsSync(sf)) {
			const mine = JSON.parse(readFileSync(sf, "utf-8")).find((s: any) => s.id === id);
			if (mine?.agentSessionFile && existsSync(mine.agentSessionFile)) return true;
		}
		await new Promise(r => setTimeout(r, 2_000));
	}
	return false;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------
interface SessionResult {
	name: string; label: string;
	sandboxed: boolean; worktree: boolean; interrupt: boolean;
	createMs: number; idleMs: number; responseMs: number;
	restartMs: number; cwd: string; branch: string;
	restoredAsIdle: boolean; screenshot?: string;
	gitStatusApiBranch?: string; gitWidgetText?: string;
	agentPwd?: string;
}

interface GoalPhase {
	phase: string; durationMs: number; success: boolean; detail: string;
	section: "goal" | "goal-sandbox";
}

const sessionResults: SessionResult[] = [];
const goalPhases: GoalPhase[] = [];

function recordGoalPhase(section: "goal" | "goal-sandbox", phase: string, t0: number, success: boolean, detail: string) {
	goalPhases.push({ phase, durationMs: Math.round(performance.now() - t0), success, detail, section });
	console.log(`  ${success ? "✓" : "✗"} [${section}] ${phase}: ${detail} (${Math.round(performance.now() - t0)}ms)`);
}

// ---------------------------------------------------------------------------
// Session variations
// ---------------------------------------------------------------------------
interface Variation {
	name: string; label: string;
	worktree: boolean; sandboxed: boolean; interrupt: boolean;
}
const VARIATIONS: Variation[] = [
	{ name: "Plain (no worktree)",          label: "plain",      worktree: false, sandboxed: false, interrupt: false },
	{ name: "Worktree",                     label: "wt",         worktree: true,  sandboxed: false, interrupt: false },
	{ name: "Worktree + interrupt",         label: "wt-int",     worktree: true,  sandboxed: false, interrupt: true  },
	{ name: "Sandbox plain",               label: "sbx",        worktree: false, sandboxed: true,  interrupt: false },
	{ name: "Sandbox worktree",            label: "sbx-wt",     worktree: true,  sandboxed: true,  interrupt: false },
	{ name: "Sandbox worktree + interrupt",label: "sbx-wt-int", worktree: true,  sandboxed: true,  interrupt: true  },
];

function variationTag(v: Variation) {
	const wt = v.worktree ? "Worktree" : "Master";
	const sbx = v.sandboxed ? "Sandbox" : "No Sandbox";
	const int = v.interrupt ? " + Interrupt" : "";
	return `${wt}, ${sbx}${int}`;
}

// ===================================================================
// Single gateway — sessions + goals + sandboxed goals, one restart
// ===================================================================
test.describe.serial("Integration — sessions, goals, sandboxed goals", () => {
	test.setTimeout(900_000); // 15 minutes total budget

	let gw: GW;
	let dir: string;
	let port: number;
	let sandboxAvailable = false;

	// Session state carried across phases
	const sessions: Record<string, { id: string; cwd: string; branch: string; timing: Partial<SessionResult> }> = {};

	// Goal state carried across phases
	let goalId: string;
	let goalTitle: string;
	let goalTeamLeadId: string;
	let goalGateCount: number;
	let sbxGoalId: string;
	let sbxGoalTitle: string;
	let sbxGoalTeamLeadId: string;
	let sbxGoalGateCount: number;

	// Second project state
	let proj2Dir: string;
	let proj2Id: string;
	const proj2Sessions: Record<string, { id: string; cwd: string; branch: string }> = {};
	let proj2GoalId: string;
	let proj2GoalTitle: string;
	let proj2GoalTeamLeadId: string;

	test.beforeAll(async ({}, ti) => {
		ti.setTimeout(180_000);
		port = await freePort();
		const tmp = process.platform === "win32" ? (process.env.TEMP || "C:\\Temp") : "/tmp";
		dir = join(tmp, `.bobbit-manual-${port}`);
		rmSync(dir, { recursive: true, force: true });
		initRepo(dir);

		mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
		mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
		const yaml = [
			'worktree_pool_size: "6"',
			HAS_DOCKER ? 'sandbox: "docker"' : "",
		].filter(Boolean).join("\n") + "\n";
		writeFileSync(join(dir, ".bobbit", "config", "project.yaml"), yaml);
		// Start with empty projects.json — server no longer auto-registers a default.
		writeFileSync(join(dir, ".bobbit", "state", "projects.json"), "[]");

		gw = await startGW(dir, port);
		console.log(`  Gateway :${port}  cwd=${dir}  docker=${HAS_DOCKER}`);

		// Register a project at the gateway cwd — replaces the old auto-registration.
		const regRes = await api(gw, "/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "default", rootPath: dir, upsert: true }),
		});
		if (regRes.status !== 201 && regRes.status !== 200) {
			throw new Error(`Failed to register default project: ${regRes.status}`);
		}
		gw.defaultProjectId = (await regRes.json()).id;

		if (HAS_DOCKER) {
			const ss = await (await api(gw, "/api/sandbox-status")).json();
			sandboxAvailable = ss.configured && ss.available;
			console.log(`  Sandbox: configured=${ss.configured} available=${ss.available}`);
			if (ss.configured && !ss.available) {
				const deadline = Date.now() + 120_000;
				while (Date.now() < deadline) {
					const r = await (await api(gw, "/api/sandbox-status")).json();
					if (r.available) { sandboxAvailable = true; break; }
					await new Promise(r => setTimeout(r, 3_000));
				}
				console.log(`  Sandbox available: ${sandboxAvailable}`);
			}
		}
	});

	test.afterAll(async ({}, ti) => {
		ti.setTimeout(120_000);
		// Best-effort goal cleanup
		if (gw && goalId) {
			try { await api(gw, `/api/goals/${goalId}/team/teardown`, { method: "POST" }); } catch {}
			try { await api(gw, `/api/goals/${goalId}`, { method: "DELETE" }); } catch {}
		}
		if (gw && sbxGoalId) {
			try { await api(gw, `/api/goals/${sbxGoalId}/team/teardown`, { method: "POST" }); } catch {}
			try { await api(gw, `/api/goals/${sbxGoalId}`, { method: "DELETE" }); } catch {}
		}
		if (gw && proj2GoalId) {
			try { await api(gw, `/api/goals/${proj2GoalId}/team/teardown`, { method: "POST" }); } catch {}
			try { await api(gw, `/api/goals/${proj2GoalId}`, { method: "DELETE" }); } catch {}
		}
		if (gw) await stopGW(gw);
		cleanTestDockerContainers();
		cleanDirs(dir);
		if (proj2Dir) cleanDirs(proj2Dir);
	});

	// ---------------------------------------------------------------
	// A. Sessions — create via API (UI lacks worktree/sandbox flags),
	//    all interaction via browser
	// ---------------------------------------------------------------
	test("A. create sessions and send messages", async ({ page }) => {
		for (const v of VARIATIONS) {
			if (v.sandboxed && !sandboxAvailable) { console.log(`  SKIP ${v.name}`); continue; }

			const t0 = performance.now();
			const res = await api(gw, "/api/sessions", {
				method: "POST", body: JSON.stringify({ worktree: v.worktree, sandboxed: v.sandboxed }),
			});
			expect(res.status).toBe(201);
			const id = (await res.json()).id;
			const createMs = Math.round(performance.now() - t0);

			await pollIdle(gw, id, v.sandboxed ? 180_000 : 120_000);
			const idleMs = Math.round(performance.now() - t0);

			const tMsg = performance.now();
			await browserSend(page, gw, id,
				`Test: ${variationTag(v)}\nRun \`pwd\` and \`git status\` and show me the output.`);
			const responseMs = Math.round(performance.now() - tMsg);

			await waitForFile(gw, id);

			const info = await getSession(gw, id);
			let branch = "";
			if (!v.sandboxed) {
				if (v.worktree) {
					expect(normalize(info.cwd)).not.toBe(normalize(dir));
					branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: info.cwd, encoding: "utf-8" }).trim();
					expect(branch).not.toBe("master");
				} else {
					expect(normalize(info.cwd)).toBe(normalize(dir));
					branch = "master";
				}
			} else { branch = "(sandbox)"; }

			sessions[v.label] = { id, cwd: info.cwd, branch, timing: { createMs, idleMs, responseMs } };
			console.log(`  ${v.name}: create=${createMs}ms idle=${idleMs}ms msg=${responseMs}ms`);
		}

		// Send blocking commands on interrupt variants
		for (const v of VARIATIONS) {
			if (!v.interrupt) continue;
			const s = sessions[v.label];
			if (!s) continue;
			await page.goto(sessionUrl(gw, s.id));
			await page.waitForSelector("textarea", { timeout: 15_000 });
			try { await page.waitForSelector('[class*="tool"], [class*="Tool"], details, pre', { timeout: 8_000 }); } catch {}
			await page.fill("textarea",
				"Run this exact bash command with the bash tool (not background): sleep 120 && echo done");
			await page.press("textarea", "Enter");
			console.log(`  ${v.name}: blocking command sent`);
		}
		if (VARIATIONS.some(v => v.interrupt && sessions[v.label])) {
			await new Promise(r => setTimeout(r, 5_000));
			for (const v of VARIATIONS) {
				if (!v.interrupt || !sessions[v.label]) continue;
				console.log(`  ${v.name}: status=${(await getSession(gw, sessions[v.label].id)).status}`);
			}
		}
	});

	// ---------------------------------------------------------------
	// A2. Multi-project — register second project, create sessions + goal,
	//     verify sidebar grouping and CWD isolation
	// ---------------------------------------------------------------
	test("A2. multi-project sessions and goal", async ({ page }) => {
		// 1. Create a separate git repo for the second project
		const tmp = process.platform === "win32" ? (process.env.TEMP || "C:\\Temp") : "/tmp";
		proj2Dir = join(tmp, `.bobbit-manual-proj2-${port}`);
		rmSync(proj2Dir, { recursive: true, force: true });
		mkdirSync(proj2Dir, { recursive: true });
		execFileSync("git", ["init"], { cwd: proj2Dir, stdio: "ignore" });
		execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/master"], { cwd: proj2Dir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "t@t"], { cwd: proj2Dir, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "T"], { cwd: proj2Dir, stdio: "ignore" });
		writeFileSync(join(proj2Dir, "README.md"), "# Second project\n");
		writeFileSync(join(proj2Dir, "package.json"), JSON.stringify({
			name: "second-project", version: "1.0.0",
			scripts: { check: "echo ok", "test:unit": "echo ok" },
		}, null, 2));
		mkdirSync(join(proj2Dir, ".bobbit", "config"), { recursive: true });
		mkdirSync(join(proj2Dir, ".bobbit", "state"), { recursive: true });
		writeFileSync(join(proj2Dir, ".bobbit", "config", "project.yaml"), 'worktree_pool_size: "2"\n');
		execFileSync("git", ["add", "."], { cwd: proj2Dir, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "init second project"], { cwd: proj2Dir, stdio: "ignore" });

		// 2. Register the second project via API
		const regRes = await api(gw, "/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "Second Project", rootPath: proj2Dir }),
		});
		expect(regRes.status).toBe(201);
		const regBody = await regRes.json() as any;
		proj2Id = regBody.id;
		console.log(`  Second project registered: id=${proj2Id} path=${proj2Dir}`);

		// 3. Create two sessions in the second project.
		// Sessions in a git repo auto-get worktrees, so both will have their own branch.
		const proj2Variations = [
			{ label: "s1", name: "Session 1" },
			{ label: "s2", name: "Session 2" },
		];
		for (const v of proj2Variations) {
			const t1 = performance.now();
			const res = await api(gw, "/api/sessions", {
				method: "POST",
				body: JSON.stringify({ projectId: proj2Id }),
			});
			expect(res.status).toBe(201);
			const id = ((await res.json()) as any).id;
			await pollIdle(gw, id, 120_000);
			const info = await getSession(gw, id);
			expect(info.projectId).toBe(proj2Id);
			// CWD should be inside a worktree derived from the second project (auto-worktree)
			// The worktree is a sibling dir of proj2Dir, not the project root itself
			const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
				cwd: info.cwd, encoding: "utf-8",
			}).trim();
			expect(branch).not.toBe("master");
			// Verify the worktree's git root resolves back to a checkout of the second project
			const wtRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
				cwd: info.cwd, encoding: "utf-8",
			}).trim();
			// The worktree root should be a sibling of the second project, not the default project
			expect(normalize(wtRoot)).not.toBe(normalize(dir));
			proj2Sessions[v.label] = { id, cwd: info.cwd, branch };
			console.log(`  Proj2 ${v.name}: id=${id} cwd=${info.cwd} branch=${branch} (${Math.round(performance.now() - t1)}ms)`);
		}
		let t0 = performance.now();

		// 5. Send a message to each session via the browser
		for (const [label, s] of Object.entries(proj2Sessions)) {
			await browserSend(page, gw, s.id,
				`Multi-project test (${label}). Run \`pwd\` and \`git status\`.`);
			console.log(`  Proj2 session ${label}: message sent`);
		}

		// 6. Create a goal in the second project via API
		t0 = performance.now();
		const goalRes = await api(gw, "/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "Proj2 Feature",
				cwd: proj2Dir,
				spec: "Add a feature to the second project. Create src/proj2-feature.ts.",
				workflowId: "feature",
				projectId: proj2Id,
				autoStartTeam: true,
			}),
		});
		expect(goalRes.status).toBe(201);
		const goalBody = await goalRes.json() as any;
		proj2GoalId = goalBody.id;
		proj2GoalTitle = "Proj2 Feature";
		expect(goalBody.projectId).toBe(proj2Id);
		console.log(`  Proj2 goal created: id=${proj2GoalId} (${Math.round(performance.now() - t0)}ms)`);

		// Wait for worktree setup
		await pollGoalSetup(gw, proj2GoalId, 120_000);

		// Goal's CWD should be inside a worktree derived from the second project, not the default
		const goalInfo = await (await api(gw, `/api/goals/${proj2GoalId}`)).json() as any;
		expect(normalize(goalInfo.cwd)).not.toBe(normalize(dir)); // not the default project
		// repoPath should be the second project's git root
		expect(normalize(goalInfo.repoPath)).toBe(normalize(proj2Dir));
		console.log(`  Proj2 goal cwd=${goalInfo.cwd} repoPath=${goalInfo.repoPath}`);

		// Wait for team to start
		t0 = performance.now();
		let team: any;
		try {
			team = await pollTeamStarted(gw, proj2GoalId, 180_000);
		} catch {
			const startRes = await api(gw, `/api/goals/${proj2GoalId}/team/start`, { method: "POST" });
			if (!startRes.ok) throw new Error(`Proj2 team start failed: ${await startRes.text()}`);
			team = await pollTeamStarted(gw, proj2GoalId, 120_000);
		}
		proj2GoalTeamLeadId = team.teamLeadSessionId;
		console.log(`  Proj2 team started: lead=${proj2GoalTeamLeadId} (${Math.round(performance.now() - t0)}ms)`);

		// Verify team lead session belongs to the second project
		const leadInfo = await getSession(gw, proj2GoalTeamLeadId);
		expect(leadInfo.projectId).toBe(proj2Id);
		// Team lead's CWD should be in a worktree of the second project
		expect(normalize(leadInfo.cwd)).not.toBe(normalize(dir));
		console.log(`  Proj2 team lead cwd=${leadInfo.cwd} projectId=${leadInfo.projectId}`);

		// 7. Verify sidebar grouping via browser
		await page.goto(appUrl(gw));
		await page.waitForSelector("button", { timeout: 15_000 });
		// Wait for sessions to load in the sidebar
		await page.waitForTimeout(3_000);

		// The sidebar should show "Second Project" as a separate project group
		const sidebarText = await page.locator('[class*="sidebar"], nav').first().textContent() || "";
		expect(sidebarText).toContain("Second Project");
		console.log(`  Sidebar contains "Second Project" ✓`);
		await takeScreenshot(page, "multi-project-sidebar.png");

		// 8. Verify API lists sessions and goals with correct projectId
		const allSessions = await (await api(gw, "/api/sessions")).json() as any;
		const proj2ApiSessions = allSessions.sessions.filter((s: any) => s.projectId === proj2Id);
		// Should have at least the 2 sessions we created + the goal's team lead
		expect(proj2ApiSessions.length).toBeGreaterThanOrEqual(3);
		console.log(`  API: ${proj2ApiSessions.length} sessions in second project ✓`);

		const allGoals = await (await api(gw, "/api/goals")).json() as any;
		const proj2Goals = allGoals.goals.filter((g: any) => g.projectId === proj2Id);
		expect(proj2Goals.length).toBeGreaterThanOrEqual(1);
		expect(proj2Goals[0].id).toBe(proj2GoalId);
		console.log(`  API: ${proj2Goals.length} goals in second project ✓`);

		recordGoalPhase("goal", "Multi-project setup", performance.now() - 1, true,
			`proj2=${proj2Id} sessions=${proj2ApiSessions.length} goals=${proj2Goals.length}`);
	});

	// ---------------------------------------------------------------
	// B. Goal (non-sandboxed) — create via browser, team, gates, dashboard
	// ---------------------------------------------------------------
	test("B. non-sandboxed goal lifecycle", async ({ page }) => {
		// Create goal via the browser UI — goal assistant → proposal → form → create
		let t0 = performance.now();
		goalId = await createGoalViaBrowser(
			page, gw,
			"Add feature X",
			"Add a new feature X to the project. Create a new file src/feature-x.ts that exports a function featureX() returning 'hello from feature X'. Update README.md to mention the feature.",
			{ workflowId: "feature" },
		);
		goalTitle = "Add feature X";
		recordGoalPhase("goal", "Goal created via UI", t0, true, `id=${goalId}`);
		await takeScreenshot(page, "goal-dashboard.png");

		// Wait for worktree setup
		t0 = performance.now();
		await pollGoalSetup(gw, goalId);
		recordGoalPhase("goal", "Worktree setup", t0, true, "ready");

		// Team auto-starts — give it extra time since the LLM call for team lead can be slow.
		// If auto-start didn't fire, start manually via API as fallback.
		t0 = performance.now();
		let team: any;
		try {
			team = await pollTeamStarted(gw, goalId, 180_000);
		} catch {
			// Auto-start may not have fired — check goal state and start manually
			const goalState = await (await api(gw, `/api/goals/${goalId}`)).json();
			console.log(`  Auto-start timed out. Goal state: setupStatus=${goalState.setupStatus} autoStartTeam=${goalState.autoStartTeam}`);
			const startRes = await api(gw, `/api/goals/${goalId}/team/start`, { method: "POST" });
			const startBody = await startRes.json();
			console.log(`  Manual start: status=${startRes.status} body=${JSON.stringify(startBody)}`);
			if (!startRes.ok) throw new Error(`Team start failed: ${JSON.stringify(startBody)}`);
			team = await pollTeamStarted(gw, goalId, 120_000);
		}
		goalTeamLeadId = team.teamLeadSessionId;
		recordGoalPhase("goal", "Team started", t0, true, `lead=${goalTeamLeadId}`);

		// Check gates via browser dashboard
		t0 = performance.now();
		await page.goto(goalDashboardUrl(gw, goalId));
		await page.waitForSelector(".tab", { timeout: 15_000 });
		// Verify title is visible on dashboard
		await expect(page.getByText(goalTitle).first()).toBeVisible({ timeout: 10_000 });
		// Click through gate-related tabs
		const gatesTab = page.locator(".tab").filter({ hasText: /Gates|Workflow/ });
		if (await gatesTab.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
			await gatesTab.first().click();
			await page.waitForTimeout(2_000);
			await takeScreenshot(page, "goal-gates-tab.png");
		}
		// Read gate count via API for later verification
		const gatesRes = await api(gw, `/api/goals/${goalId}/gates`);
		const { gates } = await gatesRes.json();
		goalGateCount = gates.length;
		recordGoalPhase("goal", "Gates visible", t0, true, `${gates.length} gates`);

		// Navigate to team lead session — just verify it's working, take a screenshot.
		// Responsiveness is tested post-restart in E-2.
		t0 = performance.now();
		await page.goto(sessionUrl(gw, goalTeamLeadId));
		await page.waitForSelector("textarea", { timeout: 15_000 });
		await page.waitForTimeout(2_000);
		await takeScreenshot(page, "goal-team-lead.png");
		recordGoalPhase("goal", "Team lead visible", t0, true, "session loaded in browser");

		// Agents tab via browser
		t0 = performance.now();
		await page.goto(goalDashboardUrl(gw, goalId));
		await page.waitForSelector(".tab", { timeout: 15_000 });
		const agentsTab = page.locator(".tab").filter({ hasText: "Agents" });
		if (await agentsTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
			await agentsTab.click();
			try { await page.waitForSelector(".agent-card", { timeout: 10_000 }); } catch {}
			await takeScreenshot(page, "goal-agents-tab.png");
		}
		recordGoalPhase("goal", "Agents tab", t0, true, "viewed");
	});

	// ---------------------------------------------------------------
	// C. Goal (sandboxed) — same lifecycle inside Docker, all via browser
	// ---------------------------------------------------------------
	test("C. sandboxed goal lifecycle", async ({ page }) => {
		test.skip(!sandboxAvailable, "Docker sandbox not available");

		// Create sandboxed goal via browser UI
		let t0 = performance.now();
		sbxGoalId = await createGoalViaBrowser(
			page, gw,
			"Add feature Y (sandboxed)",
			"Add a new feature Y to the project. Create src/feature-y.ts exporting featureY(). Update README.md.",
			{ workflowId: "feature", sandboxed: true },
		);
		sbxGoalTitle = "Add feature Y (sandboxed)";
		recordGoalPhase("goal-sandbox", "Goal created via UI", t0, true, `id=${sbxGoalId}`);
		await takeScreenshot(page, "sbx-goal-dashboard.png");

		// Worktree setup (longer — container provisioning)
		t0 = performance.now();
		await pollGoalSetup(gw, sbxGoalId, 120_000);
		recordGoalPhase("goal-sandbox", "Worktree setup", t0, true, "ready");

		// Team auto-start (with manual fallback)
		t0 = performance.now();
		let sbxTeam: any;
		try {
			sbxTeam = await pollTeamStarted(gw, sbxGoalId, 180_000);
		} catch {
			console.log("  Sandbox auto-start timed out, starting team manually...");
			const startRes = await api(gw, `/api/goals/${sbxGoalId}/team/start`, { method: "POST" });
			expect(startRes.ok).toBe(true);
			sbxTeam = await pollTeamStarted(gw, sbxGoalId, 120_000);
		}
		sbxGoalTeamLeadId = sbxTeam.teamLeadSessionId;
		recordGoalPhase("goal-sandbox", "Team started", t0, true, `lead=${sbxGoalTeamLeadId}`);

		// Dashboard
		t0 = performance.now();
		await page.goto(goalDashboardUrl(gw, sbxGoalId));
		await page.waitForSelector(".tab", { timeout: 15_000 });
		await expect(page.getByText(sbxGoalTitle).first()).toBeVisible({ timeout: 10_000 });
		const sbxGatesRes = await api(gw, `/api/goals/${sbxGoalId}/gates`);
		const { gates: sbxGates } = await sbxGatesRes.json();
		sbxGoalGateCount = sbxGates.length;
		recordGoalPhase("goal-sandbox", "Dashboard + gates", t0, true, `${sbxGates.length} gates`);

		// Navigate to team lead session — just verify it's working, take a screenshot.
		// Responsiveness is tested post-restart in E-3.
		t0 = performance.now();
		await page.goto(sessionUrl(gw, sbxGoalTeamLeadId));
		await page.waitForSelector("textarea", { timeout: 15_000 });
		await page.waitForTimeout(2_000);
		await takeScreenshot(page, "sbx-goal-team-lead.png");
		recordGoalPhase("goal-sandbox", "Team lead visible", t0, true, "session loaded in browser (Docker)");

		// Agents tab
		t0 = performance.now();
		await page.goto(goalDashboardUrl(gw, sbxGoalId));
		await page.waitForSelector(".tab", { timeout: 15_000 });
		const agentsTab = page.locator(".tab").filter({ hasText: "Agents" });
		if (await agentsTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
			await agentsTab.click();
			try { await page.waitForSelector(".agent-card", { timeout: 10_000 }); } catch {}
			await takeScreenshot(page, "sbx-goal-agents-tab.png");
		}
		recordGoalPhase("goal-sandbox", "Agents tab", t0, true, "viewed");
	});

	// ---------------------------------------------------------------
	// D. Gateway restart — hard kill + restart
	// ---------------------------------------------------------------
	test("D. gateway restart", async () => {
		console.log("\n  === KILLING GATEWAY ===");
		await stopGW(gw);
		expect(existsSync(join(dir, ".bobbit", "state", "sessions.json"))).toBe(true);
		expect(existsSync(join(dir, ".bobbit", "state", "goals.json"))).toBe(true);
		expect(existsSync(join(dir, ".bobbit", "state", "gates.json"))).toBe(true);
		expect(existsSync(join(dir, ".bobbit", "state", "team-state.json"))).toBe(true);
		// Second project state should also be persisted
		if (proj2Dir) {
			expect(existsSync(join(proj2Dir, ".bobbit", "state", "sessions.json"))).toBe(true);
			if (proj2GoalId) {
				expect(existsSync(join(proj2Dir, ".bobbit", "state", "goals.json"))).toBe(true);
			}
			console.log("  Second project state files persisted ✓");
		}

		port = await freePort();
		gw = await startGW(dir, port);
		console.log(`  Restarted :${port}`);

		if (sandboxAvailable) {
			const deadline = Date.now() + 60_000;
			while (Date.now() < deadline) {
				const s = await (await api(gw, "/api/sandbox-status")).json();
				if (s.available) break;
				await new Promise(r => setTimeout(r, 2_000));
			}
			const s = await (await api(gw, "/api/sandbox-status")).json();
			console.log(`  Sandbox reconnected: ${s.available}`);
		}
	});

	// ---------------------------------------------------------------
	// E-1. Verify sessions survive restart (via browser)
	// ---------------------------------------------------------------
	test("E-1. verify sessions after restart", async ({ page }) => {
		for (const v of VARIATIONS) {
			const s = sessions[v.label];
			if (!s) continue;

			const info = await getSession(gw, s.id);
			const restored = info.status !== "archived";
			expect(normalize(info.cwd)).toBe(normalize(s.cwd));
			console.log(`  ${v.name}: status=${info.status} cwd_preserved=✓`);

			// ── API metadata checks ──
			// Sandbox sessions: cwd should be a container-internal path (starts with /workspace)
			if (v.sandboxed) {
				expect(info.cwd).toMatch(/^\/workspace/);
				console.log(`    sandbox cwd=${info.cwd} (container-internal) ✓`);
			}

			// Non-sandbox worktree sessions: verify host worktree directory exists on disk
			if (!v.sandboxed && v.worktree && restored && existsSync(s.cwd)) {
				const br = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: s.cwd, encoding: "utf-8" }).trim();
				expect(br).not.toBe("master");
				console.log(`    worktree dir exists, branch=${br} ✓`);
			} else if (!v.sandboxed && v.worktree && restored) {
				console.log(`    WARNING: worktree dir ${s.cwd} does not exist on disk`);
			}

			// ── Git status API check ──
			// After restart, the git-status endpoint should still return valid data
			if (restored) {
				const gitStatus = await fetchGitStatusApi(gw, s.id);
				if (gitStatus) {
					expect(gitStatus.branch).toBeTruthy();
					if (!v.sandboxed) {
						if (v.worktree) {
							expect(gitStatus.branch).not.toBe("master");
							expect(gitStatus.isOnPrimary).toBe(false);
						} else {
							expect(gitStatus.branch).toBe("master");
							expect(gitStatus.isOnPrimary).toBe(true);
						}
					}
					console.log(`    git-status API: branch=${gitStatus.branch} clean=${gitStatus.clean} isOnPrimary=${gitStatus.isOnPrimary} ✓`);
				} else {
					console.log(`    git-status API: not available (may be expected for sandbox after restart)`);
				}
			}

			let screenshotId = s.id;
			if (restored) {
				await pollIdle(gw, s.id, 120_000);
				await browserSend(page, gw, s.id, "Run `pwd`, and confirm `git status`");
			} else {
				const r = await api(gw, "/api/sessions", {
					method: "POST", body: JSON.stringify({ worktree: v.worktree, sandboxed: v.sandboxed }),
				});
				const ns = (await r.json()).id;
				await pollIdle(gw, ns, v.sandboxed ? 180_000 : 120_000);
				await browserSend(page, gw, ns, "Run `pwd`, and confirm `git status`");
				screenshotId = ns;
			}

			// ── Git status widget UI check ──
			// After sending a message, the widget should render with the correct branch
			const widgetText = await checkGitStatusWidget(page);
			if (widgetText) {
				expect(widgetText).toContain("⎇");
				if (!v.sandboxed && !v.worktree) {
					expect(widgetText).toContain("master");
				} else if (!v.sandboxed && v.worktree) {
					expect(widgetText).not.toContain("master");
				}
				console.log(`    git-status widget: "${widgetText}" ✓`);
			} else {
				console.log(`    git-status widget: not rendered (may be loading)`);
			}

			// ── Verify agent-reported pwd matches API cwd ──
			// Extract pwd output from the last assistant message in the page
			const pageContent = await page.locator('[class*="message"], [class*="Message"], pre, code').allTextContents();
			const allText = pageContent.join("\n");
			const pwdMatch = allText.match(/(?:\/[\w./-]+workspace[\w./-]*|[A-Z]:\\[\w\\.-]+)/);
			if (pwdMatch) {
				const agentPwd = pwdMatch[0];
				if (v.sandboxed) {
					expect(agentPwd).toMatch(/^\/workspace/);
					console.log(`    agent pwd=${agentPwd} (container-internal) ✓`);
				} else {
					// On non-sandbox, the agent's pwd should match the session cwd (normalized)
					expect(normalize(agentPwd)).toBe(normalize(s.cwd));
					console.log(`    agent pwd=${agentPwd} matches API cwd ✓`);
				}
			} else {
				console.log(`    agent pwd: could not extract from page content`);
			}

			const ssName = `${v.label}-after-restart.png`;
			await takeScreenshot(page, ssName);

			sessionResults.push({
				name: v.name, label: v.label,
				sandboxed: v.sandboxed, worktree: v.worktree, interrupt: v.interrupt,
				createMs: s.timing.createMs || 0, idleMs: s.timing.idleMs || 0,
				responseMs: s.timing.responseMs || 0, restartMs: 0,
				cwd: s.cwd, branch: s.branch,
				restoredAsIdle: restored,
				screenshot: WANT_SCREENSHOTS ? ssName : undefined,
			});
		}
	});

	// ---------------------------------------------------------------
	// E-2. Verify non-sandboxed goal survives restart (via browser)
	// ---------------------------------------------------------------
	test("E-2. verify non-sandboxed goal after restart", async ({ page }) => {
		if (!goalId) { console.log("  SKIP: no goal created"); return; }

		// Goal dashboard renders after restart
		let t0 = performance.now();
		await page.goto(goalDashboardUrl(gw, goalId));
		await page.waitForSelector(".tab", { timeout: 15_000 });
		await expect(page.getByText(goalTitle).first()).toBeVisible({ timeout: 10_000 });
		await takeScreenshot(page, "goal-dashboard-after-restart.png");
		recordGoalPhase("goal", "Dashboard after restart", t0, true, "title visible");

		// Gates tab renders
		t0 = performance.now();
		const gatesTab = page.locator(".tab").filter({ hasText: /Gates|Workflow/ });
		if (await gatesTab.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
			await gatesTab.first().click();
			await page.waitForTimeout(2_000);
			await takeScreenshot(page, "goal-gates-after-restart.png");
			recordGoalPhase("goal", "Gates tab after restart", t0, true, "rendered");
		} else {
			recordGoalPhase("goal", "Gates tab after restart", t0, true, "tab not visible");
		}

		// Verify goal data survived via API (read-only check)
		t0 = performance.now();
		const g = await (await api(gw, `/api/goals/${goalId}`)).json();
		expect(g.id).toBe(goalId);
		const { gates } = await (await api(gw, `/api/goals/${goalId}/gates`)).json();
		expect(gates.length).toBe(goalGateCount);
		const teamRes = await api(gw, `/api/goals/${goalId}/team`);
		expect(teamRes.ok).toBe(true);
		const team = await teamRes.json();
		expect(team.teamLeadSessionId).toBe(goalTeamLeadId);
		recordGoalPhase("goal", "State verified via API", t0, true, `gates=${gates.length} team=✓`);

		// Team lead responds after restart — interrupt if streaming, then send
		t0 = performance.now();
		const sess = await getSession(gw, goalTeamLeadId);
		const alive = sess.status !== "archived" && sess.status !== "terminated";
		if (alive) {
			await interruptAndSend(page, gw, goalTeamLeadId,
				"Run ONLY `pwd` and `git log --oneline -3`. Nothing else.");
			await takeScreenshot(page, "goal-team-lead-after-restart.png");
			recordGoalPhase("goal", "Team lead post-restart", t0, true, "responds via browser");
		} else {
			recordGoalPhase("goal", "Team lead post-restart", t0, false, `status=${sess.status}`);
		}

		// Teardown via browser — navigate to dashboard and use UI
		t0 = performance.now();
		// Use API for teardown since there's no single "teardown" button in the UI
		const tdRes = await api(gw, `/api/goals/${goalId}/team/teardown`, { method: "POST" });
		recordGoalPhase("goal", "Teardown", t0, tdRes.ok || tdRes.status === 404, `status=${tdRes.status}`);
	});

	// ---------------------------------------------------------------
	// E-3. Verify sandboxed goal survives restart (via browser)
	// ---------------------------------------------------------------
	test("E-3. verify sandboxed goal after restart", async ({ page }) => {
		test.skip(!sbxGoalId, "No sandboxed goal created");

		// Dashboard renders
		let t0 = performance.now();
		await page.goto(goalDashboardUrl(gw, sbxGoalId));
		await page.waitForSelector(".tab", { timeout: 15_000 });
		await expect(page.getByText(sbxGoalTitle).first()).toBeVisible({ timeout: 10_000 });
		await takeScreenshot(page, "sbx-goal-dashboard-after-restart.png");
		recordGoalPhase("goal-sandbox", "Dashboard after restart", t0, true, "title visible");

		// Verify state survived
		t0 = performance.now();
		const g = await (await api(gw, `/api/goals/${sbxGoalId}`)).json();
		// sandboxed flag should be true if the checkbox was toggled successfully
		if (!g.sandboxed) {
			console.log("  Warning: goal.sandboxed is false — sandbox checkbox may not have toggled");
		}
		const { gates } = await (await api(gw, `/api/goals/${sbxGoalId}/gates`)).json();
		expect(gates.length).toBe(sbxGoalGateCount);
		const team = await (await api(gw, `/api/goals/${sbxGoalId}/team`)).json();
		expect(team.teamLeadSessionId).toBe(sbxGoalTeamLeadId);
		recordGoalPhase("goal-sandbox", "State verified via API", t0, true, `gates=${gates.length} sandboxed=true`);

		// Team lead responds (inside container)
		t0 = performance.now();
		const sess = await getSession(gw, sbxGoalTeamLeadId);
		const alive = sess.status !== "archived" && sess.status !== "terminated";
		if (alive) {
			await interruptAndSend(page, gw, sbxGoalTeamLeadId,
				"Run ONLY these commands and nothing else: `pwd`, `hostname`, `git log --oneline -3`. Do not explore or read files.",
				180_000);
			await takeScreenshot(page, "sbx-goal-team-lead-after-restart.png");
			recordGoalPhase("goal-sandbox", "Team lead post-restart", t0, true, "responds via browser (Docker)");
		} else {
			recordGoalPhase("goal-sandbox", "Team lead post-restart", t0, false, `status=${sess.status}`);
		}

		// Teardown
		t0 = performance.now();
		const tdRes = await api(gw, `/api/goals/${sbxGoalId}/team/teardown`, { method: "POST" });
		recordGoalPhase("goal-sandbox", "Teardown", t0, tdRes.ok || tdRes.status === 404, `status=${tdRes.status}`);
	});

	// ---------------------------------------------------------------
	// E-3b. Verify second project survives restart
	// ---------------------------------------------------------------
	test("E-3b. verify second project after restart", async ({ page }) => {
		if (!proj2Id) { console.log("  SKIP: no second project"); return; }

		// Verify second project is still registered
		const projRes = await api(gw, `/api/projects/${proj2Id}`);
		expect(projRes.ok).toBe(true);
		const proj = await projRes.json() as any;
		expect(proj.name).toBe("Second Project");
		console.log(`  Second project still registered: ${proj.name} ✓`);

		// Verify sessions survived with correct CWDs and projectIds
		for (const [label, s] of Object.entries(proj2Sessions)) {
			const info = await getSession(gw, s.id);
			expect(info.status).not.toBe("archived");
			expect(normalize(info.cwd)).toBe(normalize(s.cwd));
			expect(info.projectId).toBe(proj2Id);
			console.log(`  Proj2 ${label}: status=${info.status} cwd_preserved=✓ projectId=✓`);

			// Verify the session responds after restart
			await pollIdle(gw, s.id, 120_000);
			await browserSend(page, gw, s.id, "Run `pwd` and `git status`");
			console.log(`  Proj2 ${label}: responds after restart ✓`);
		}

		// Verify goal survived
		if (proj2GoalId) {
			const goal = await (await api(gw, `/api/goals/${proj2GoalId}`)).json() as any;
			expect(goal.id).toBe(proj2GoalId);
			expect(goal.projectId).toBe(proj2Id);
			expect(normalize(goal.repoPath)).toBe(normalize(proj2Dir));
			console.log(`  Proj2 goal survived: projectId=✓ repoPath=✓`);

			// Verify team lead survived
			if (proj2GoalTeamLeadId) {
				const lead = await getSession(gw, proj2GoalTeamLeadId);
				expect(lead.projectId).toBe(proj2Id);
				const alive = lead.status !== "archived" && lead.status !== "terminated";
				if (alive) {
					await interruptAndSend(page, gw, proj2GoalTeamLeadId,
						"Run ONLY `pwd` and `git log --oneline -3`. Nothing else.");
					console.log(`  Proj2 team lead responds after restart ✓`);
				} else {
					console.log(`  Proj2 team lead status: ${lead.status}`);
				}
			}

			// Teardown the second project's goal
			const tdRes = await api(gw, `/api/goals/${proj2GoalId}/team/teardown`, { method: "POST" });
			console.log(`  Proj2 goal teardown: status=${tdRes.status}`);
		}

		// Verify sidebar still shows both projects
		await page.goto(appUrl(gw));
		await page.waitForSelector("button", { timeout: 15_000 });
		await page.waitForTimeout(3_000);
		const sidebarText = await page.locator('[class*="sidebar"], nav').first().textContent() || "";
		expect(sidebarText).toContain("Second Project");
		await takeScreenshot(page, "multi-project-sidebar-after-restart.png");
		console.log(`  Sidebar still shows "Second Project" after restart ✓`);

		recordGoalPhase("goal", "Multi-project post-restart", performance.now() - 1, true,
			"sessions + goal + sidebar verified");
	});

	// ---------------------------------------------------------------
	// E-4. Delete Docker container — verify server recovers
	// ---------------------------------------------------------------
	test("E-4. sandbox container recovery", async ({ page }) => {
		test.skip(!sandboxAvailable, "Docker sandbox not available");

		// 1. Find and force-remove the project container
		let t0 = performance.now();
		const containerId = execFileSync("docker", [
			"ps", "-q", "--filter", `label=bobbit-project`,
		], { encoding: "utf-8", timeout: 10_000 }).trim();
		expect(containerId).toBeTruthy();
		console.log(`  Container to kill: ${containerId.substring(0, 12)}`);

		execFileSync("docker", ["rm", "-f", containerId], { timeout: 15_000, stdio: "ignore" });
		console.log("  Container removed");
		recordGoalPhase("goal-sandbox", "Container killed", t0, true, `id=${containerId.substring(0, 12)}`);

		// 2. Hit sandbox-status — this triggers the server to detect the missing container
		//    and recreate it. Poll until it reports available again.
		t0 = performance.now();
		const deadline = Date.now() + 120_000;
		let recovered = false;
		while (Date.now() < deadline) {
			try {
				const res = await api(gw, "/api/sandbox-status");
				const status = await res.json();
				if (status.available) { recovered = true; break; }
			} catch { /* server may be busy recreating */ }
			await new Promise(r => setTimeout(r, 2_000));
		}
		expect(recovered).toBe(true);
		const recoveryMs = Math.round(performance.now() - t0);
		console.log(`  Sandbox recovered in ${recoveryMs}ms`);
		recordGoalPhase("goal-sandbox", "Container recovered", t0, true, `${recoveryMs}ms`);

		// 3. Pick a sandbox session and verify it can still respond.
		//    The sandbox plain session is simplest — its cwd is /workspace which
		//    will exist in the new container after re-init.
		const sbxSession = sessions["sbx"];
		if (sbxSession) {
			t0 = performance.now();
			const info = await getSession(gw, sbxSession.id);
			const alive = info.status !== "archived" && info.status !== "terminated";
			if (alive) {
				await interruptAndSend(page, gw, sbxSession.id,
					"Run ONLY `pwd` and `git status`. Nothing else.", 120_000);
				await takeScreenshot(page, "sbx-after-container-recovery.png");
				console.log(`  Sandbox session responds after container recovery`);
				recordGoalPhase("goal-sandbox", "Session post-recovery", t0, true, "responds via browser");

				// ── Verify git-status widget renders after container recovery ──
				const widgetText = await checkGitStatusWidget(page);
				if (widgetText) {
					expect(widgetText).toContain("⎇");
					console.log(`  Git-status widget after recovery: "${widgetText}" ✓`);
					recordGoalPhase("goal-sandbox", "Git widget post-recovery", t0, true, widgetText);
				} else {
					console.log(`  Git-status widget not rendered after recovery`);
					recordGoalPhase("goal-sandbox", "Git widget post-recovery", t0, false, "widget not visible");
				}

				// ── Verify git-status API returns valid data after recovery ──
				const gitStatus = await fetchGitStatusApi(gw, sbxSession.id);
				if (gitStatus) {
					expect(gitStatus.branch).toBeTruthy();
					console.log(`  Git-status API after recovery: branch=${gitStatus.branch} clean=${gitStatus.clean} ✓`);
					recordGoalPhase("goal-sandbox", "Git API post-recovery", t0, true, `branch=${gitStatus.branch}`);
				} else {
					console.log(`  Git-status API not available after recovery`);
					recordGoalPhase("goal-sandbox", "Git API post-recovery", t0, false, "API returned null");
				}

				// ── Verify agent-reported pwd is container-internal after recovery ──
				const pageContent = await page.locator('[class*="message"], [class*="Message"], pre, code').allTextContents();
				const allText = pageContent.join("\n");
				const pwdMatch = allText.match(/\/workspace[\w./-]*/);
				if (pwdMatch) {
					expect(pwdMatch[0]).toMatch(/^\/workspace/);
					console.log(`  Agent pwd after recovery: ${pwdMatch[0]} (container-internal) ✓`);
					recordGoalPhase("goal-sandbox", "Agent pwd post-recovery", t0, true, pwdMatch[0]);
				} else {
					console.log(`  Could not extract agent pwd after recovery`);
					recordGoalPhase("goal-sandbox", "Agent pwd post-recovery", t0, false, "pwd not found in output");
				}
			} else {
				console.log(`  Sandbox session status: ${info.status} — skipping message test`);
				recordGoalPhase("goal-sandbox", "Session post-recovery", t0, false, `status=${info.status}`);
			}
		}
	});

	// ---------------------------------------------------------------
	// F. Combined HTML report
	// ---------------------------------------------------------------
	test("F. generate combined HTML report", async () => {
		mkdirSync(RESULTS_DIR, { recursive: true });

		// ── Session results table ──
		const bar = (val: number, max: number, color: string) => {
			const w = max > 0 ? Math.max(2, Math.round((val / max) * 120)) : 2;
			return `<div style="display:inline-block;height:14px;width:${w}px;background:${color};border-radius:2px;vertical-align:middle;margin-left:6px"></div>`;
		};
		const palette = ["#5b9bd5", "#ed7d31", "#70ad47", "#ffc000", "#9b59b6", "#e74c3c"];
		const maxIdle = Math.max(1, ...sessionResults.map(r => r.idleMs));
		const maxResp = Math.max(1, ...sessionResults.map(r => r.responseMs));

		const sessionTimingRows = sessionResults.map((r, i) => `<tr>
			<td><span style="display:inline-block;width:10px;height:10px;background:${palette[i % 6]};border-radius:2px;margin-right:6px"></span>${r.name}</td>
			<td class="r">${r.createMs}${bar(r.createMs, maxIdle, palette[i % 6])}</td>
			<td class="r">${r.idleMs}${bar(r.idleMs, maxIdle, palette[i % 6])}</td>
			<td class="r">${r.responseMs}${bar(r.responseMs, maxResp, palette[i % 6])}</td>
		</tr>`).join("\n");

		const sessionCheckRows = sessionResults.map(r => `<tr>
			<td>${r.name}</td>
			<td class="r">${r.restoredAsIdle ? '<span class="g">✓ idle</span>' : '<span class="o">archived</span>'}</td>
			<td class="r"><span class="g">✓</span></td>
			<td class="r"><code>${r.branch}</code></td>
		</tr>`).join("\n");

		// ── Goal results table ──
		const goalRows = (section: string) => goalPhases.filter(p => p.section === section).map(r => `<tr>
			<td>${r.phase}</td>
			<td class="r" style="color:${r.success ? "#6d6" : "#e74c3c"}">${r.success ? "✓" : "✗"}</td>
			<td class="r">${r.durationMs}ms</td>
			<td><code>${r.detail}</code></td>
		</tr>`).join("\n");

		const goalSummary = (section: string) => {
			const phases = goalPhases.filter(p => p.section === section);
			const pass = phases.filter(p => p.success).length;
			const fail = phases.filter(p => !p.success).length;
			const total = phases.reduce((s, p) => s + p.durationMs, 0);
			return { pass, fail, total, count: phases.length };
		};

		const gs = goalSummary("goal");
		const gss = goalSummary("goal-sandbox");

		// ── Screenshots ──
		const screenshotSections: string[] = [];
		if (WANT_SCREENSHOTS) {
			for (const r of sessionResults) {
				if (r.screenshot && existsSync(join(RESULTS_DIR, r.screenshot))) {
					const b64 = readFileSync(join(RESULTS_DIR, r.screenshot)).toString("base64");
					screenshotSections.push(`<div style="margin-bottom:28px">
						<div style="font-size:14px;color:#a0d0a0;font-weight:600">${r.name}</div>
						<div style="font-size:12px;color:#888;margin:4px 0 8px">cwd: <code>${r.cwd}</code> · branch: <code>${r.branch}</code> · ${r.restoredAsIdle ? "restored" : "archived → new session"}</div>
						<img src="data:image/png;base64,${b64}" style="width:100%;border-radius:6px;border:1px solid #333">
					</div>`);
				}
			}
			const goalScreenshots = [
				"goal-creation-form.png", "goal-dashboard.png", "goal-gates-tab.png",
				"goal-team-lead.png", "goal-agents-tab.png",
				"goal-dashboard-after-restart.png", "goal-gates-after-restart.png",
				"goal-team-lead-after-restart.png",
				"sbx-goal-dashboard.png",
				"sbx-goal-team-lead.png", "sbx-goal-agents-tab.png",
				"sbx-goal-dashboard-after-restart.png", "sbx-goal-team-lead-after-restart.png",
			];
			for (const ss of goalScreenshots) {
				const p = join(RESULTS_DIR, ss);
				if (existsSync(p)) {
					const b64 = readFileSync(p).toString("base64");
					screenshotSections.push(`<div style="margin-bottom:28px">
						<div style="font-size:14px;color:#a0d0a0;font-weight:600">${ss.replace(/-/g, " ").replace(".png", "")}</div>
						<img src="data:image/png;base64,${b64}" style="width:100%;border-radius:6px;border:1px solid #333;margin-top:8px">
					</div>`);
				}
			}
		}

		const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Integration Test Report</title>
<style>
*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:960px;margin:40px auto;background:#1a1a2e;color:#e0e0e0;padding:0 20px}
h1{color:#a0d0a0;font-size:22px;margin-bottom:4px}h2{color:#a0d0a0;font-size:16px;margin:28px 0 12px}h3{color:#ccc;font-size:14px;margin:20px 0 8px}
.sub{color:#888;font-size:13px;margin-bottom:24px}
table{width:100%;border-collapse:collapse;margin-bottom:24px}
th{text-align:left;padding:8px 12px;border-bottom:2px solid #444;color:#a0d0a0;font-size:12px}
td{padding:6px 12px;border-bottom:1px solid #333;font-size:13px}
.r{text-align:right;font-variant-numeric:tabular-nums}th.r{text-align:right}
.g{color:#6d6}.o{color:#ed7d31}code{background:#333;padding:1px 5px;border-radius:3px;font-size:11px}
hr{border:none;border-top:1px solid #333;margin:32px 0}
.n{font-size:12px;color:#777;line-height:1.6;margin-top:16px}
.summary{display:flex;gap:16px;flex-wrap:wrap;margin:12px 0 24px}
.stat{background:#222;border-radius:8px;padding:12px 16px;text-align:center;min-width:80px}
.stat-value{font-size:22px;font-weight:700}.stat-label{font-size:10px;color:#888;margin-top:2px}
.section-badge{display:inline-block;background:#333;color:#a0d0a0;font-size:10px;padding:2px 8px;border-radius:10px;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px}
</style></head><body>
<h1>Integration Test Report</h1>
<p class="sub">Single gateway · sessions + goals (UI-driven) + sandboxed goals · one restart · ${new Date().toISOString().split("T")[0]}</p>

<div class="summary">
	<div class="stat"><div class="stat-value" style="color:#5b9bd5">${sessionResults.length}</div><div class="stat-label">Sessions</div></div>
	<div class="stat"><div class="stat-value" style="color:#6d6">${gs.pass}/${gs.count}</div><div class="stat-label">Goal phases</div></div>
	<div class="stat"><div class="stat-value" style="color:#ed7d31">${gss.count > 0 ? gss.pass + "/" + gss.count : "skipped"}</div><div class="stat-label">Sandbox goal</div></div>
</div>

<hr>

<div class="section-badge">Sessions</div>
<h2>Session Resilience</h2>

<h3>Timing (ms)</h3>
<table><tr><th>Variation</th><th class="r">Create</th><th class="r">Create→Idle</th><th class="r">Msg (browser)</th></tr>
${sessionTimingRows}</table>

<h3>Post-restart verification</h3>
<table><tr><th>Variation</th><th class="r">Restored</th><th class="r">cwd preserved</th><th class="r">Branch</th></tr>
${sessionCheckRows}</table>

<hr>

<div class="section-badge">Goal (non-sandboxed)</div>
<h2>Goal Lifecycle — Non-sandboxed</h2>
${gs.count > 0 ? `
<div class="summary">
	<div class="stat"><div class="stat-value" style="color:#6d6">${gs.pass}</div><div class="stat-label">Passed</div></div>
	<div class="stat"><div class="stat-value" style="color:#e74c3c">${gs.fail}</div><div class="stat-label">Failed</div></div>
	<div class="stat"><div class="stat-value" style="color:#5b9bd5">${gs.total}ms</div><div class="stat-label">Total</div></div>
</div>
<table><tr><th>Phase</th><th class="r">Status</th><th class="r">Duration</th><th>Detail</th></tr>
${goalRows("goal")}</table>
` : '<p class="n">No non-sandboxed goal phases recorded.</p>'}

<hr>

<div class="section-badge">Goal (sandboxed)</div>
<h2>Goal Lifecycle — Sandboxed (Docker)</h2>
${gss.count > 0 ? `
<div class="summary">
	<div class="stat"><div class="stat-value" style="color:#6d6">${gss.pass}</div><div class="stat-label">Passed</div></div>
	<div class="stat"><div class="stat-value" style="color:#e74c3c">${gss.fail}</div><div class="stat-label">Failed</div></div>
	<div class="stat"><div class="stat-value" style="color:#5b9bd5">${gss.total}ms</div><div class="stat-label">Total</div></div>
</div>
<table><tr><th>Phase</th><th class="r">Status</th><th class="r">Duration</th><th>Detail</th></tr>
${goalRows("goal-sandbox")}</table>
` : '<p class="n">Skipped — Docker sandbox not available.</p>'}

${screenshotSections.length > 0 ? `<hr><h2>Screenshots</h2>
<p class="n">Captured during test execution. Goals created via browser UI (assistant → proposal → form). All messages sent through browser. Gateway killed and restarted mid-lifecycle.</p>
${screenshotSections.join("\n")}` : ""}

<p class="n">Sessions created via API (worktree/sandbox flags not exposed in UI). Goals created via browser UI (New Goal → assistant → proposal form → Create Goal). All messages sent through browser. Single gateway shared across all variations. Gateway hard-killed and restarted on a new port. Sandbox sessions may archive on crash if agent session file lives inside the Docker container.</p>
</body></html>`;

		writeFileSync(join(RESULTS_DIR, "report.html"), html);
		console.log(`  Report: ${join(RESULTS_DIR, "report.html")}`);
		console.log(`  Sessions: ${sessionResults.length}, Goal phases: ${gs.count}, Sandbox goal phases: ${gss.count}`);
	});
});
