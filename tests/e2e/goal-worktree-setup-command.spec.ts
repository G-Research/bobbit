/**
 * Per-goal worktree setup command — API E2E (freshly-created worktree path).
 *
 * Covers the runtime hook added by the per-goal worktree setup goal:
 *   - direct REST creation with `worktreeSetupCommand` / `worktreeSetupTimeoutMs`
 *     persists in the 201 response, the GET detail, and `goals.json` on disk
 *     (i.e. survives a reload), and
 *   - the command is actually invoked during provisioning (asserted via the
 *     `BOBBIT_TEST_RECORD_SETUP` per-goal audit line), and
 *   - a failing per-goal command makes setup FATAL: `setupStatus:"error"`,
 *     a descriptive `setupError`, and the goal never reaches "ready" (so a
 *     team can never auto-start mis-configured).
 *
 * The in-process harness runs the gateway in THIS process, so a
 * `process.env.BOBBIT_TEST_RECORD_SETUP` set here is read by `runGoalSetup`
 * at provisioning time. We filter audit lines by goalId to stay robust under
 * worker reuse.
 *
 * Pool-claim coverage lives in goal-worktree-setup-pool.spec.ts (the worker
 * pool option is file-scoped).
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, bobbitDir } from "./e2e-setup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function gitInit(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--initial-branch=master"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@bobbit.local"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "README.md"), "# repo\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: dir });
}

/**
 * Poll the goal detail until setup settles (ready|error). Uses Playwright's
 * `expect.poll` (event-loop-driven retry) rather than an inline sleep so the
 * no-new-sleeps guard stays green. Returns the final goal detail.
 */
async function waitForSetup(goalId: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
	let detail: Record<string, unknown> = {};
	await expect.poll(async () => {
		const r = await apiFetch(`/api/goals/${goalId}`);
		if (r.status !== 200) return undefined;
		detail = await r.json();
		return detail.setupStatus;
	}, { timeout: timeoutMs }).toMatch(/^(ready|error)$/);
	return detail;
}

function goalsJsonAuditPath(repoPath: string): string {
	return path.join(repoPath, ".bobbit", "state", "goals.json");
}

function readAuditLines(recordFile: string, goalId: string): string[] {
	if (!fs.existsSync(recordFile)) return [];
	return fs.readFileSync(recordFile, "utf-8")
		.split("\n")
		.filter((l) => l.startsWith("goal\t") && l.includes(goalId));
}

test.describe.serial("Per-goal worktree setup command (fresh-create)", () => {
	let repoPath: string;
	let projectId: string;
	let recordFile: string;

	test.beforeAll(async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-goal-setup-"));
		repoPath = path.join(root, "repo");
		gitInit(repoPath);

		recordFile = path.join(root, "setup-record.tsv");
		process.env.BOBBIT_TEST_RECORD_SETUP = recordFile;

		const reg = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `goal-setup-${Date.now()}`, rootPath: repoPath }),
		});
		expect(reg.status).toBe(201);
		projectId = (await reg.json()).id;
	});

	test.afterAll(() => {
		delete process.env.BOBBIT_TEST_RECORD_SETUP;
	});

	test("persists fields, survives reload, and invokes the per-goal command", async () => {
		const command = "echo per-goal-hook-ran";
		const createRes = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "Per-goal setup happy path",
				cwd: repoPath,
				projectId,
				worktree: true,
				team: false,
				autoStartTeam: false,
				workflowId: "general",
				worktreeSetupCommand: command,
				worktreeSetupTimeoutMs: 45000,
			}),
		});
		expect(createRes.status).toBe(201);
		const created = await createRes.json();

		// 1) Fields echoed in the 201 response.
		expect(created.worktreeSetupCommand).toBe(command);
		expect(created.worktreeSetupTimeoutMs).toBe(45000);

		// 2) Survives reload — GET detail returns them.
		const detail = await waitForSetup(created.id);
		expect(detail.setupStatus).toBe("ready");
		expect(detail.worktreeSetupCommand).toBe(command);
		expect(detail.worktreeSetupTimeoutMs).toBe(45000);

		// 3) Persisted in goals.json on disk (project-scoped state).
		const goals = JSON.parse(fs.readFileSync(goalsJsonAuditPath(repoPath), "utf-8")) as Array<Record<string, unknown>>;
		const persisted = goals.find((g) => g.id === created.id);
		expect(persisted, "goal must be persisted to goals.json").toBeTruthy();
		expect(persisted!.worktreeSetupCommand).toBe(command);
		expect(persisted!.worktreeSetupTimeoutMs).toBe(45000);

		// 4) Per-goal audit line written during provisioning.
		const lines = readAuditLines(recordFile, created.id);
		expect(lines.length).toBe(1);
		// Format: goal\t<goalId>\t<cwd>\t<SOURCE_REPO>\t<command>
		const cols = lines[0].split("\t");
		expect(cols[0]).toBe("goal");
		expect(cols[1]).toBe(created.id);
		expect(cols[4]).toBe(command);
	});

	test("omitting the fields persists no hook (optional, backward-compatible)", async () => {
		const createRes = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "No per-goal setup",
				cwd: repoPath,
				projectId,
				worktree: true,
				team: false,
				autoStartTeam: false,
				workflowId: "general",
			}),
		});
		expect(createRes.status).toBe(201);
		const created = await createRes.json();
		expect(created.worktreeSetupCommand).toBeUndefined();
		expect(created.worktreeSetupTimeoutMs).toBeUndefined();

		const detail = await waitForSetup(created.id);
		expect(detail.setupStatus).toBe("ready");

		// No per-goal audit line for this goal.
		expect(readAuditLines(recordFile, created.id).length).toBe(0);
	});

	test("a failing per-goal command is fatal: setupStatus=error, descriptive setupError, never ready", async () => {
		const createRes = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "Per-goal setup failure",
				cwd: repoPath,
				projectId,
				worktree: true,
				team: false,
				// autoStartTeam:true so we also prove the team never starts when
				// the fatal hook throws (setup must resolve before a team starts).
				autoStartTeam: true,
				workflowId: "general",
				worktreeSetupCommand: "exit 7",
			}),
		});
		expect(createRes.status).toBe(201);
		const created = await createRes.json();

		const detail = await waitForSetup(created.id);
		expect(detail.setupStatus).toBe("error");
		expect(String(detail.setupError)).toContain("Per-goal worktree setup failed");

		// Never auto-started: a failed (fatal) setup leaves no team lead session.
		expect(detail.teamLeadSessionId).toBeFalsy();
	});
});
