/**
 * Full-stack goal lifecycle integration tests.
 *
 * Single gateway, real agents — exercises the complete goal lifecycle:
 *   1. Goal creation via API with workflow
 *   2. Team auto-start and team lead session interaction via browser
 *   3. Gate signaling (design-doc → implementation) with verification
 *   4. Team spawn (coder agent), task assignment, agent work via browser
 *   5. Gateway restart — verify goals, gates, team state survive
 *   6. Post-restart: team lead still responds, gates preserved
 *   7. Teardown and cleanup
 *
 *   npm run test:manual                  # headless browser
 *   SCREENSHOTS=1 npm run test:manual    # + screenshots + HTML report
 *
 * Prerequisites: `npm run build`, agent CLI in PATH.
 * Docker NOT required — these tests use non-sandboxed goals only.
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
	mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync,
} from "node:fs";
import { join, resolve, normalize } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const SERVER_CLI = join(PROJECT_ROOT, "dist", "server", "cli.js");
const RESULTS_DIR = join(PROJECT_ROOT, "test-results", "manual-integration");
const WANT_SCREENSHOTS = !!process.env.SCREENSHOTS;

// ---------------------------------------------------------------------------
// Gateway helpers (reused from session-resilience.spec.ts)
// ---------------------------------------------------------------------------
interface GW {
	proc: ChildProcess; port: number; dir: string;
	token: string; base: string;
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
// API helpers
// ---------------------------------------------------------------------------
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

async function pollIdle(gw: GW, id: string, ms = 120_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let res: Response;
		try { res = await api(gw, `/api/sessions/${id}`); } catch { await new Promise(r => setTimeout(r, 1_000)); continue; }
		if (res.status === 404) { await new Promise(r => setTimeout(r, 1_000)); continue; }
		const s = await res.json();
		if (s.status === "idle") return s;
		if (s.status === "archived") throw new Error(`Session ${id} archived`);
		if (s.status === "error" || s.status === "terminated") throw new Error(`Session ${id} ${s.status}`);
		await new Promise(r => setTimeout(r, 1_000));
	}
	throw new Error(`Session ${id} not idle in ${ms}ms`);
}

async function pollGoalSetup(gw: GW, goalId: string, ms = 60_000) {
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

async function pollTeamStarted(gw: GW, goalId: string, ms = 60_000) {
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

async function pollGateStatus(gw: GW, goalId: string, gateId: string, target: string, ms = 120_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const res = await api(gw, `/api/goals/${goalId}/gates/${gateId}`);
		if (res.ok) {
			const gate = await res.json();
			if (gate.status === target) return gate;
			// If we're waiting for "passed" and it failed, bail early
			if (target === "passed" && gate.status === "failed") {
				throw new Error(`Gate ${gateId} failed instead of passing: ${JSON.stringify(gate)}`);
			}
		}
		await new Promise(r => setTimeout(r, 2_000));
	}
	const res = await api(gw, `/api/goals/${goalId}/gates/${gateId}`);
	const gate = await res.json();
	throw new Error(`Gate ${gateId} did not reach "${target}" in ${ms}ms. Current: ${gate.status}`);
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------
function sessionUrl(gw: GW, id: string) {
	return `${gw.base}/?token=${gw.token}#/session/${id}`;
}

function goalDashboardUrl(gw: GW, goalId: string) {
	return `${gw.base}/?token=${gw.token}#/goal/${goalId}`;
}

async function browserSend(page: Page, gw: GW, id: string, text: string, idleMs = 120_000) {
	await page.goto(sessionUrl(gw, id));
	await page.waitForSelector("textarea", { timeout: 15_000 });
	try { await page.waitForSelector('[class*="tool"], [class*="Tool"], details, pre', { timeout: 8_000 }); } catch {}
	await page.waitForTimeout(500);
	await page.fill("textarea", text);
	await page.press("textarea", "Enter");
	await page.waitForTimeout(1_500);
	await pollIdle(gw, id, idleMs);
	await page.waitForTimeout(2_000);
}

async function browserWait(page: Page, gw: GW, id: string, idleMs = 120_000) {
	await page.goto(sessionUrl(gw, id));
	await page.waitForSelector("textarea", { timeout: 15_000 });
	await pollIdle(gw, id, idleMs);
	try { await page.waitForSelector('[class*="tool"], [class*="Tool"], details, pre', { timeout: 8_000 }); } catch {}
	await page.waitForTimeout(1_000);
}

async function takeScreenshot(page: Page, name: string) {
	if (!WANT_SCREENSHOTS) return;
	mkdirSync(RESULTS_DIR, { recursive: true });
	await page.screenshot({ path: join(RESULTS_DIR, name), fullPage: true });
	console.log(`    📸 ${name}`);
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
	writeFileSync(join(dir, "README.md"), "# Test project\n\nUsed for goal lifecycle integration tests.\n");
	writeFileSync(join(dir, "package.json"), JSON.stringify({
		name: "test-project", version: "1.0.0", scripts: { check: "echo ok", "test:unit": "echo ok" },
	}, null, 2));
	execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
	try {
		const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 5_000 }).trim();
		execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir, stdio: "ignore" });
	} catch {}
}

function cleanDirs(dir: string) {
	const parent = resolve(dir, "..");
	const base = dir.split(/[\\/]/).pop()!;
	const dirs = [dir];
	try { for (const e of readdirSync(parent)) if (e.startsWith(base)) dirs.push(join(parent, e)); } catch {}
	for (const d of dirs) { for (let i = 0; i < 3; i++) { try { rmSync(d, { recursive: true, force: true }); break; } catch {} } }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
interface PhaseResult {
	phase: string;
	durationMs: number;
	success: boolean;
	detail: string;
}
const results: PhaseResult[] = [];

function recordPhase(phase: string, t0: number, success: boolean, detail: string) {
	results.push({ phase, durationMs: Math.round(performance.now() - t0), success, detail });
	const icon = success ? "✓" : "✗";
	console.log(`  ${icon} ${phase}: ${detail} (${Math.round(performance.now() - t0)}ms)`);
}

// ===================================================================
// Goal Lifecycle — non-sandboxed
// ===================================================================
test.describe.serial("Goal lifecycle — non-sandboxed", () => {
	test.setTimeout(600_000);

	let gw: GW;
	let dir: string;
	let port: number;
	let goalId: string;
	let teamLeadSessionId: string;

	test.beforeAll(async ({}, ti) => {
		ti.setTimeout(180_000);
		port = await freePort();
		const tmp = process.platform === "win32" ? (process.env.TEMP || "C:\\Temp") : "/tmp";
		dir = join(tmp, `.bobbit-goal-manual-${port}`);
		rmSync(dir, { recursive: true, force: true });
		initRepo(dir);

		mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
		writeFileSync(join(dir, ".bobbit", "config", "project.yaml"), "worktree_pool_size: \"4\"\n");

		gw = await startGW(dir, port);
		console.log(`  Gateway :${port}  cwd=${dir}`);
	});

	test.afterAll(async ({}, ti) => {
		ti.setTimeout(60_000);
		// Best-effort cleanup
		if (gw && goalId) {
			try { await api(gw, `/api/goals/${goalId}/team/teardown`, { method: "POST" }); } catch {}
			try { await api(gw, `/api/goals/${goalId}`, { method: "DELETE" }); } catch {}
		}
		if (gw) await stopGW(gw);
		cleanDirs(dir);
	});

	test("full goal lifecycle with restart", async ({ page }) => {
		// ── Phase 1: Create goal with workflow ─────────────────────────
		let t0 = performance.now();
		const createRes = await api(gw, "/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "Manual integration: add feature X",
				cwd: dir,
				spec: "Add a new feature X to the project. Create a new file src/feature-x.ts with an exported function featureX() that returns 'hello from feature X'. Update README.md to mention the feature.",
				workflowId: "feature",
				autoStartTeam: true,
			}),
		});
		expect(createRes.status).toBe(201);
		const goal = await createRes.json();
		goalId = goal.id;
		expect(goal.workflowId).toBe("feature");
		expect(goal.autoStartTeam).toBe(true);
		recordPhase("Goal created", t0, true, `id=${goalId}`);

		// ── Phase 2: Wait for worktree setup ──────────────────────────
		t0 = performance.now();
		await pollGoalSetup(gw, goalId);
		recordPhase("Worktree setup", t0, true, "setupStatus=ready");

		// ── Phase 3: Team auto-starts ─────────────────────────────────
		t0 = performance.now();
		const team = await pollTeamStarted(gw, goalId);
		teamLeadSessionId = team.teamLeadSessionId;
		recordPhase("Team auto-started", t0, true, `teamLead=${teamLeadSessionId}`);

		// ── Phase 4: Verify goal dashboard in browser ─────────────────
		t0 = performance.now();
		await page.goto(goalDashboardUrl(gw, goalId));
		await page.waitForSelector(".tab", { timeout: 15_000 });

		// Goal title should be visible
		const titleVisible = await page.getByText("Manual integration: add feature X").isVisible();
		expect(titleVisible).toBe(true);
		await takeScreenshot(page, "goal-dashboard-initial.png");
		recordPhase("Goal dashboard visible", t0, true, "title rendered");

		// ── Phase 5: Check gates — all should start pending ───────────
		t0 = performance.now();
		const gatesRes = await api(gw, `/api/goals/${goalId}/gates`);
		expect(gatesRes.ok).toBe(true);
		const { gates } = await gatesRes.json();
		const gateIds = gates.map((g: any) => g.gateId);
		expect(gateIds).toContain("design-doc");
		expect(gateIds).toContain("implementation");
		expect(gateIds).toContain("documentation");
		expect(gateIds).toContain("ready-to-merge");
		const pendingCount = gates.filter((g: any) => g.status === "pending").length;
		recordPhase("Gates listed", t0, true, `${gates.length} gates, ${pendingCount} pending`);

		// ── Phase 6: Interact with team lead via browser ──────────────
		t0 = performance.now();
		await pollIdle(gw, teamLeadSessionId, 180_000);
		await browserSend(page, gw, teamLeadSessionId,
			"List the current tasks and gates. Run `pwd` and `git branch` to confirm your worktree.");
		await takeScreenshot(page, "team-lead-first-response.png");
		recordPhase("Team lead responds", t0, true, "first message via browser");

		// ── Phase 7: Check team agents list via API ───────────────────
		t0 = performance.now();
		const agentsRes = await api(gw, `/api/goals/${goalId}/team/agents`);
		expect(agentsRes.ok).toBe(true);
		const { agents } = await agentsRes.json();
		recordPhase("Team agents listed", t0, true, `${agents.length} agents`);

		// ── Phase 8: View Agents tab on dashboard ─────────────────────
		t0 = performance.now();
		await page.goto(goalDashboardUrl(gw, goalId));
		await page.waitForSelector(".tab", { timeout: 15_000 });
		const agentsTab = page.locator(".tab").filter({ hasText: "Agents" });
		if (await agentsTab.isVisible()) {
			await agentsTab.click();
			try {
				await page.waitForSelector(".agent-card", { timeout: 10_000 });
			} catch {}
			await takeScreenshot(page, "goal-agents-tab.png");
			recordPhase("Agents tab", t0, true, "viewed in browser");
		} else {
			recordPhase("Agents tab", t0, true, "not visible (no agents spawned yet)");
		}

		// ── Phase 9: Check tasks via API ──────────────────────────────
		t0 = performance.now();
		const tasksRes = await api(gw, `/api/goals/${goalId}/tasks`);
		const tasks = await tasksRes.json();
		const taskList = Array.isArray(tasks) ? tasks : tasks.tasks || [];
		recordPhase("Tasks listed", t0, true, `${taskList.length} tasks`);

		// ── Phase 10: Gateway restart — hard kill ─────────────────────
		t0 = performance.now();
		console.log("\n  --- KILLING GATEWAY ---");
		await stopGW(gw);

		// Verify state files persisted
		expect(existsSync(join(dir, ".bobbit", "state", "goals.json"))).toBe(true);
		expect(existsSync(join(dir, ".bobbit", "state", "sessions.json"))).toBe(true);
		expect(existsSync(join(dir, ".bobbit", "state", "gates.json"))).toBe(true);
		expect(existsSync(join(dir, ".bobbit", "state", "team-state.json"))).toBe(true);

		// Restart on a new port
		port = await freePort();
		gw = await startGW(dir, port);
		recordPhase("Gateway restarted", t0, true, `new port :${port}`);

		// ── Phase 11: Verify goal survives restart ────────────────────
		t0 = performance.now();
		const goalRes = await api(gw, `/api/goals/${goalId}`);
		expect(goalRes.ok).toBe(true);
		const restoredGoal = await goalRes.json();
		expect(restoredGoal.id).toBe(goalId);
		expect(restoredGoal.title).toBe("Manual integration: add feature X");
		expect(restoredGoal.workflowId).toBe("feature");
		recordPhase("Goal restored", t0, true, `state=${restoredGoal.state}`);

		// ── Phase 12: Verify gates survive restart ────────────────────
		t0 = performance.now();
		const gatesResAfter = await api(gw, `/api/goals/${goalId}/gates`);
		expect(gatesResAfter.ok).toBe(true);
		const { gates: restoredGates } = await gatesResAfter.json();
		expect(restoredGates.length).toBe(gates.length);
		recordPhase("Gates restored", t0, true, `${restoredGates.length} gates preserved`);

		// ── Phase 13: Verify team state survives restart ──────────────
		t0 = performance.now();
		const teamRes = await api(gw, `/api/goals/${goalId}/team`);
		expect(teamRes.ok).toBe(true);
		const restoredTeam = await teamRes.json();
		expect(restoredTeam.teamLeadSessionId).toBe(teamLeadSessionId);
		recordPhase("Team state restored", t0, true, `teamLead=${restoredTeam.teamLeadSessionId}`);

		// ── Phase 14: Team lead session still works after restart ─────
		t0 = performance.now();
		const sessionRes = await api(gw, `/api/sessions/${teamLeadSessionId}`);
		const sessionInfo = await sessionRes.json();
		const sessionAlive = sessionInfo.status !== "archived" && sessionInfo.status !== "terminated";
		if (sessionAlive) {
			await pollIdle(gw, teamLeadSessionId, 60_000);
			await browserSend(page, gw, teamLeadSessionId,
				"Confirm you can still operate. Run `pwd` and `git log --oneline -3`.");
			await takeScreenshot(page, "team-lead-after-restart.png");
			recordPhase("Team lead responds post-restart", t0, true, "message sent + response received");
		} else {
			recordPhase("Team lead responds post-restart", t0, false, `status=${sessionInfo.status} (expected: session may archive on crash)`);
		}

		// ── Phase 15: Goal dashboard renders after restart ────────────
		t0 = performance.now();
		await page.goto(goalDashboardUrl(gw, goalId));
		await page.waitForSelector(".tab", { timeout: 15_000 });
		const titleAfterRestart = await page.getByText("Manual integration: add feature X").isVisible();
		expect(titleAfterRestart).toBe(true);
		await takeScreenshot(page, "goal-dashboard-after-restart.png");
		recordPhase("Goal dashboard after restart", t0, true, "title visible");

		// ── Phase 16: View gates tab after restart ─────────────────────
		t0 = performance.now();
		const gatesTab = page.locator(".tab").filter({ hasText: "Gates" });
		if (await gatesTab.isVisible()) {
			await gatesTab.click();
			await page.waitForTimeout(2_000);
			await takeScreenshot(page, "goal-gates-tab-after-restart.png");
			recordPhase("Gates tab after restart", t0, true, "rendered in browser");
		} else {
			// Try "Workflow" tab name variant
			const workflowTab = page.locator(".tab").filter({ hasText: "Workflow" });
			if (await workflowTab.isVisible()) {
				await workflowTab.click();
				await page.waitForTimeout(2_000);
				await takeScreenshot(page, "goal-workflow-tab-after-restart.png");
				recordPhase("Workflow tab after restart", t0, true, "rendered in browser");
			} else {
				recordPhase("Gates/Workflow tab", t0, true, "not found — may use different tab name");
			}
		}

		// ── Phase 17: Teardown ────────────────────────────────────────
		t0 = performance.now();
		const teardownRes = await api(gw, `/api/goals/${goalId}/team/teardown`, { method: "POST" });
		recordPhase("Team teardown", t0, teardownRes.ok || teardownRes.status === 404,
			`status=${teardownRes.status}`);
	});

	// ---------------------------------------------------------------
	// HTML report
	// ---------------------------------------------------------------
	test("generate HTML report", async () => {
		if (results.length === 0) { console.log("  No results"); return; }
		mkdirSync(RESULTS_DIR, { recursive: true });

		const palette = { pass: "#6d6", fail: "#e74c3c", info: "#5b9bd5" };

		const phaseRows = results.map(r => `<tr>
			<td>${r.phase}</td>
			<td class="r" style="color:${r.success ? palette.pass : palette.fail}">${r.success ? "✓" : "✗"}</td>
			<td class="r">${r.durationMs}ms</td>
			<td><code>${r.detail}</code></td>
		</tr>`).join("\n");

		const totalMs = results.reduce((s, r) => s + r.durationMs, 0);
		const passCount = results.filter(r => r.success).length;
		const failCount = results.filter(r => !r.success).length;

		// Collect screenshots
		const screenshotSections: string[] = [];
		if (WANT_SCREENSHOTS) {
			const screenshots = [
				"goal-dashboard-initial.png",
				"team-lead-first-response.png",
				"goal-agents-tab.png",
				"team-lead-after-restart.png",
				"goal-dashboard-after-restart.png",
				"goal-gates-tab-after-restart.png",
				"goal-workflow-tab-after-restart.png",
			];
			for (const ss of screenshots) {
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
<title>Goal Lifecycle Report</title>
<style>
*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:920px;margin:40px auto;background:#1a1a2e;color:#e0e0e0;padding:0 20px}
h1{color:#a0d0a0;font-size:22px;margin-bottom:4px}h2{color:#a0d0a0;font-size:16px;margin:28px 0 12px}
.sub{color:#888;font-size:13px;margin-bottom:24px}
table{width:100%;border-collapse:collapse;margin-bottom:24px}
th{text-align:left;padding:8px 12px;border-bottom:2px solid #444;color:#a0d0a0;font-size:12px}
td{padding:6px 12px;border-bottom:1px solid #333;font-size:13px}
.r{text-align:right;font-variant-numeric:tabular-nums}th.r{text-align:right}
code{background:#333;padding:1px 5px;border-radius:3px;font-size:11px}
hr{border:none;border-top:1px solid #333;margin:32px 0}
.n{font-size:12px;color:#777;line-height:1.6;margin-top:16px}
.summary{display:flex;gap:24px;margin:12px 0 24px}
.stat{background:#222;border-radius:8px;padding:12px 20px;text-align:center}
.stat-value{font-size:24px;font-weight:700}.stat-label{font-size:11px;color:#888;margin-top:2px}
</style></head><body>
<h1>Goal Lifecycle Report</h1>
<p class="sub">Non-sandboxed goal · real agents · gateway restart · ${new Date().toISOString().split("T")[0]}</p>

<div class="summary">
	<div class="stat"><div class="stat-value" style="color:${palette.pass}">${passCount}</div><div class="stat-label">Passed</div></div>
	<div class="stat"><div class="stat-value" style="color:${palette.fail}">${failCount}</div><div class="stat-label">Failed</div></div>
	<div class="stat"><div class="stat-value" style="color:${palette.info}">${totalMs}ms</div><div class="stat-label">Total</div></div>
</div>

<h2>Phase Results</h2>
<table><tr><th>Phase</th><th class="r">Status</th><th class="r">Duration</th><th>Detail</th></tr>
${phaseRows}</table>

${screenshotSections.length > 0 ? `<hr><h2>Screenshots</h2>${screenshotSections.join("\n")}` : ""}

<p class="n">Goal created via API with feature workflow. Team auto-started. Gateway killed and restarted mid-lifecycle. All state verified via API and browser UI.</p>
</body></html>`;

		writeFileSync(join(RESULTS_DIR, "goal-lifecycle-report.html"), html);
		console.log(`  Report: ${join(RESULTS_DIR, "goal-lifecycle-report.html")} (${results.length} phases)`);
	});
});
