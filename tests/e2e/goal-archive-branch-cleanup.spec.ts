/**
 * E2E test for Bug 1 of docs/design/orphan-remote-branch-cleanup.md:
 * archiving a team goal must leave every per-role agent branch absent from
 * `origin`, push-deleting any per-role refs that were published. The bug was
 * a mutated-array read in the DELETE /api/goals/:id handler — see
 * server.ts ~L2755.
 *
 * Strategy: stand up a real local bare-repo origin, register the clone as
 * a project, create a team goal, spawn 2 role agents (each gets its own
 * `goal/<id8>/<role>-<short4>` local branch; current policy keeps scoped
 * sub-agent branches local-only unless explicitly published — legacy
 * `goal-goal-<slug>-<id>-<role>-<short>` branches from before the
 * `pithier-te` rename are recognised by the same cleanup path), capture
 * remote heads before archive, archive the goal, then poll
 * `git ls-remote --heads <bare>` until every expected per-role branch is
 * absent remotely (≤55s). Branches present before archive prove cleanup;
 * branches already absent before archive satisfy the local-only policy.
 *
 * Uses the `realpush` harness variant so BOBBIT_TEST_NO_PUSH is NOT set —
 * push-delete actually executes for any published branches. Registered as
 * the `api-realpush` project in playwright-e2e.config.ts for env isolation
 * from other workers.
 */
import { test, expect } from "./in-process-harness-realpush.js";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareGitTemplate, copyGitTemplate } from "../../tests2/harness/git-template.js";
import { runFixtureCommand } from "../../tests2/harness/spawn-with-retry.js";
import { apiFetch } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

const execFileAsync = promisify(execFileCb);

test.setTimeout(120_000);

test.describe("orphan remote branch cleanup — Bug 1 (team goal archive)", () => {
	let tmpRoot: string;
	let bareRepo: string;
	let workRepo: string;
	let projectId: string;

	test.beforeAll(async () => {
		// 1. Local bare-repo "origin" + a working repo with an initial master
		//    commit. The working repo comes from the immutable committed template
		//    (master + README.md + .gitattributes + one commit, identity already
		//    configured); wiring it to the bare origin stays real git.
		tmpRoot = mkdtempSync(join(tmpdir(), "bobbit-bare-"));
		bareRepo = join(tmpRoot, "origin.git");
		workRepo = join(tmpRoot, "work");
		await runFixtureCommand("git", ["init", "--bare", "-b", "master", bareRepo]);
		await prepareGitTemplate();
		copyGitTemplate(workRepo);
		await runFixtureCommand("git", ["remote", "add", "origin", bareRepo], { cwd: workRepo });
		await runFixtureCommand("git", ["push", "-u", "origin", "master"], { cwd: workRepo });

		// 2. Register the clone as a project via REST. We talk to the
		//    realpush harness's gateway via the standard apiFetch helper.
		const projResp = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({
				name: "bare-origin-test",
				rootPath: workRepo,
				upsert: true,
				acceptCanonical: true,
			}),
		});
		if (!projResp.ok) throw new Error(`project register failed: ${projResp.status} ${await projResp.text()}`);
		const proj = await projResp.json();
		projectId = proj.id;
	});

	test.afterAll(() => {
		if (tmpRoot) {
			try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});

	function formatWarnArgs(args: unknown[]): string {
		return args.map(arg => {
			if (arg instanceof Error) return arg.stack || arg.message;
			if (typeof arg === "string") return arg;
			try { return JSON.stringify(arg); } catch { return String(arg); }
		}).join(" ");
	}

	function remoteHeadBranches(stdout: string): Set<string> {
		const branches = new Set<string>();
		for (const line of stdout.split(/\r?\n/)) {
			const marker = "\trefs/heads/";
			const markerIndex = line.indexOf(marker);
			if (markerIndex >= 0) branches.add(line.slice(markerIndex + marker.length));
		}
		return branches;
	}

	test("archiving a goal whose remote branch is already absent succeeds without a missing-ref warning", async () => {
		const goalResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "missing-remote-ref-cleanup-test",
				cwd: workRepo,
				projectId,
				team: true,
				worktree: true,
			}),
		});
		expect(goalResp.status).toBe(201);
		const created = await goalResp.json();
		const goalId: string = created.id;

		const readyGoal = await pollUntil(async () => {
			const r = await apiFetch(`/api/goals/${goalId}`);
			if (!r.ok) return null;
			const g = await r.json();
			if (g.setupStatus === "error") {
				throw new Error(`Goal setup errored: ${JSON.stringify(g)}`);
			}
			return g.setupStatus === "ready" && g.branch ? g : null;
		}, { timeoutMs: 60_000, intervalMs: 250, label: `goal ${goalId} setup ready with branch` });

		const branch: string = readyGoal.branch;

		const lsBefore = await pollUntil(async () => {
			const { stdout } = await execFileAsync(
				"git", ["ls-remote", "--heads", bareRepo, branch],
				{ encoding: "utf-8" },
			);
			return stdout.includes(branch) ? stdout : null;
		}, { timeoutMs: 30_000, intervalMs: 500, label: `goal branch ${branch} pushed to origin` });
		expect(lsBefore, `branch ${branch} should have been pushed`).toContain(branch);

		await runFixtureCommand("git", ["push", "origin", "--delete", branch], { cwd: workRepo });
		const { stdout: lsAfterPredelete } = await execFileAsync(
			"git", ["ls-remote", "--heads", bareRepo, branch],
			{ encoding: "utf-8" },
		);
		expect(lsAfterPredelete, `branch ${branch} should have been pre-deleted from origin`).not.toContain(branch);

		const originalWarn = console.warn;
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(formatWarnArgs(args));
			originalWarn(...args);
		};
		try {
			const del = await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" });
			expect(del.status).toBe(200);

			let missingRefWarning: string | undefined;
			try {
				missingRefWarning = await pollUntil(() => warnings.find(w =>
					w.includes(`[api] Failed to delete remote branch ${branch}`)
					&& /remote ref does not exist/i.test(w),
				), { timeoutMs: 5_000, intervalMs: 100, label: "missing remote-ref delete warning" });
			} catch {
				// Expected after the fix: the missing remote ref is treated as an idempotent no-op.
			}

			expect(
				missingRefWarning,
				`Missing remote-ref delete should be treated as a no-op without console.warn. Warnings:\n${warnings.join("\n")}`,
			).toBeUndefined();
		} finally {
			console.warn = originalWarn;
		}
	});

	test("archiving a team goal deletes all per-role remote branches", async () => {
		// Create a team goal in the cloned project (cwd = workRepo).
		const goalResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "branch-cleanup-test",
				cwd: workRepo,
				projectId,
				team: true,
				worktree: true,
			}),
		});
		expect(goalResp.status).toBe(201);
		const goal = await goalResp.json();
		const goalId: string = goal.id;

		// Wait for goal setup (worktree creation) to complete.
		await pollUntil(async () => {
			const r = await apiFetch(`/api/goals/${goalId}`);
			if (!r.ok) return null;
			const g = await r.json();
			if (g.setupStatus === "error") {
				throw new Error(`Goal setup errored: ${JSON.stringify(g)}`);
			}
			return g.setupStatus === "ready" ? g : null;
		}, { timeoutMs: 60_000, intervalMs: 250, label: `goal ${goalId} setup ready` });

		// Spawn two role agents.
		for (const role of ["coder", "reviewer"]) {
			const r = await apiFetch(`/api/goals/${goalId}/team/spawn`, {
				method: "POST",
				body: JSON.stringify({ role, task: "no-op" }),
			});
			if (r.status !== 201) throw new Error(`spawn ${role} failed: ${r.status} ${await r.text()}`);
		}

		// Capture the expected per-role branch list from the team store.
		// /api/goals/:id/team returns { agents: [{ branch, ... }, ...] }.
		const stateResp = await apiFetch(`/api/goals/${goalId}/team`);
		expect(stateResp.ok).toBe(true);
		const state = await stateResp.json();
		const expectedBranches: string[] = (state.agents ?? [])
			.map((a: any) => a.branch)
			.filter((b: string | undefined): b is string => Boolean(b));
		expect(expectedBranches.length).toBeGreaterThanOrEqual(2);

		// Capture remote heads before archive without requiring scoped
		// team-member branches to have been published. Local-only per-role
		// branches are expected under the current sub-agent branch policy.
		const { stdout: lsBefore } = await execFileAsync(
			"git", ["ls-remote", "--heads", bareRepo],
			{ encoding: "utf-8" },
		);
		const branchesBefore = remoteHeadBranches(lsBefore);

		// Archive the goal — DELETE /api/goals/:id triggers
		// deleteRemoteGoalBranches() fire-and-forget. Any per-role remote branch
		// present in lsBefore must be push-deleted; any branch absent in lsBefore
		// is accepted as a local-only sub-agent branch.
		const del = await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" });
		expect(del.status).toBe(200);

		// Poll ls-remote until every expected per-role branch is absent (≤55s).
		let branchesAfter = new Set<string>();
		try {
			branchesAfter = await pollUntil(async () => {
				const { stdout } = await execFileAsync(
					"git", ["ls-remote", "--heads", bareRepo],
					{ encoding: "utf-8" },
				);
				const remoteBranches = remoteHeadBranches(stdout);
				return expectedBranches.every(b => !remoteBranches.has(b)) ? remoteBranches : null;
			}, { timeoutMs: 55_000, intervalMs: 500, label: "all per-role branches absent from origin after archive" });
		} catch {
			// Fall through to the per-branch expect() below for a clearer diff.
			const { stdout } = await execFileAsync(
				"git", ["ls-remote", "--heads", bareRepo],
				{ encoding: "utf-8" },
			);
			branchesAfter = remoteHeadBranches(stdout);
		}
		for (const b of expectedBranches) {
			const beforeState = branchesBefore.has(b)
				? "was present before archive"
				: "was already absent before archive under local-only policy";
			expect(
				branchesAfter.has(b),
				`branch ${b} should be absent remotely after archive (${beforeState})`,
			).toBe(false);
		}
	});
});
