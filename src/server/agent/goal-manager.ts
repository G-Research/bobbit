import { randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";

const execFile = promisify(execFileCb);
import path from "node:path";
import { GoalStore, type GoalState, type PersistedGoal } from "./goal-store.js";
import { createWorktree, cleanupWorktree } from "../skills/git.js";
import type { WorkflowStore } from "./workflow-store.js";

/**
 * Sanitize a goal title into a valid git branch name.
 * Lowercase, replace non-alphanumeric with hyphens, trim, truncate.
 */
function toBranchName(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 10) || "goal";
}

/** Check if a directory is inside a git repository. */
async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		await execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
		return true;
	} catch {
		return false;
	}
}

/** Get the git repo root for a directory. */
async function getRepoRoot(cwd: string): Promise<string> {
	const { stdout } = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd });
	return stdout.toString().trim();
}

export class GoalManager {
	private store = new GoalStore();
	private workflowStore?: WorkflowStore;
	/** Track in-flight worktree setups to prevent concurrent calls for the same goal. */
	private _setupsInFlight = new Set<string>();

	constructor(workflowStore?: WorkflowStore) {
		this.workflowStore = workflowStore;
		// Mark any goals stuck in "preparing" from a previous run as error
		this._recoverStuckSetups();
	}

	/**
	 * On startup, scan for goals stuck in setupStatus === "preparing"
	 * and mark them as "error" (setup was interrupted by server restart).
	 */
	private _recoverStuckSetups(): void {
		for (const goal of this.store.getAll()) {
			if (goal.setupStatus === "preparing") {
				this.store.update(goal.id, {
					setupStatus: "error",
					setupError: "Setup interrupted by server restart",
				});
				console.warn(`[goal-manager] Marked goal "${goal.title}" (${goal.id}) as error — setup was interrupted by server restart`);
			}
		}
	}

	/**
	 * Create a goal instantly — persists to disk and returns immediately.
	 * Does NOT create the worktree. Call setupWorktree() separately after responding.
	 */
	async createGoal(title: string, cwd: string, opts?: { spec?: string; team?: boolean; worktree?: boolean; workflowId?: string; workflowStore?: WorkflowStore }): Promise<PersistedGoal> {
		const { spec = "", team = true, worktree = true, workflowId, workflowStore = this.workflowStore } = opts ?? {};
		const now = Date.now();
		const id = randomUUID();

		let worktreePath: string | undefined;
		let branch: string | undefined;
		let repoPath: string | undefined;
		let goalCwd = cwd;
		let setupStatus: "ready" | "preparing" = "ready";

		// Detect git repo root — needed for team operations even without a worktree
		if (await isGitRepo(cwd)) {
			repoPath = await getRepoRoot(cwd);
		}

		// Compute worktree path and branch (but don't create yet)
		if (worktree && repoPath) {
			branch = `goal/${toBranchName(title)}-${id.slice(0, 8)}`;
			worktreePath = path.join(path.resolve(repoPath, "..", `${path.basename(repoPath)}-wt`), branch.replace(/\//g, "-"));
			goalCwd = worktreePath;
			setupStatus = "preparing";
		}

		const goal: PersistedGoal = {
			id,
			title,
			cwd: goalCwd,
			state: "todo",
			spec,
			createdAt: now,
			updatedAt: now,
			worktreePath,
			branch,
			repoPath,
			team,
			setupStatus,
		};

		// Snapshot workflow onto goal if workflowId is provided
		if (workflowId && workflowStore) {
			const wf = workflowStore.get(workflowId);
			if (!wf) {
				throw new Error(`Workflow not found: ${workflowId}`);
			}
			goal.workflowId = workflowId;
			goal.workflow = JSON.parse(JSON.stringify(wf));
		} else if (!workflowId && workflowStore) {
			// Default to "general" workflow when none specified
			const defaultWf = workflowStore.get("general");
			if (defaultWf) {
				goal.workflowId = "general";
				goal.workflow = JSON.parse(JSON.stringify(defaultWf));
			}
		}

		this.store.put(goal);
		return goal;
	}

	/**
	 * Async worktree setup — called after createGoal() returns.
	 * Retries once on failure. Updates setupStatus accordingly.
	 */
	async setupWorktree(goalId: string): Promise<void> {
		const goal = this.store.get(goalId);
		if (!goal || !goal.repoPath || !goal.branch) {
			throw new Error(`Goal ${goalId} not found or missing repo/branch info`);
		}

		// Prevent concurrent setup calls for the same goal
		if (this._setupsInFlight.has(goalId)) {
			return;
		}
		this._setupsInFlight.add(goalId);

		try {
			await this._doSetupWorktree(goal);
		} finally {
			this._setupsInFlight.delete(goalId);
		}
	}

	private async _doSetupWorktree(goal: PersistedGoal): Promise<void> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const result = await createWorktree(goal.repoPath!, goal.branch!);
				// Update goal with actual worktree path and mark as ready
				this.store.update(goal.id, {
					worktreePath: result.worktreePath,
					cwd: result.worktreePath,
					setupStatus: "ready",
					setupError: undefined,
				});
				console.log(`[goal-manager] Worktree ready for goal "${goal.title}": ${result.worktreePath} (branch: ${goal.branch})`);
				return;
			} catch (err) {
				lastError = err;
				console.error(`[goal-manager] Worktree setup attempt ${attempt + 1} failed for goal "${goal.title}":`, err);
				if (attempt === 0) {
					// Brief delay before retry
					await new Promise(resolve => setTimeout(resolve, 1000));
				}
			}
		}

		// Both attempts failed
		this.store.update(goal.id, {
			setupStatus: "error",
			setupError: String(lastError),
		});
		throw lastError;
	}

	/**
	 * Retry setup for a goal in error state.
	 * Returns true if retry was initiated, false if goal not found or not in error state.
	 */
	retrySetup(goalId: string): boolean {
		const goal = this.store.get(goalId);
		if (!goal || goal.setupStatus !== "error") {
			return false;
		}
		this.store.update(goalId, {
			setupStatus: "preparing",
			setupError: undefined,
		});
		return true;
	}

	getGoal(id: string): PersistedGoal | undefined {
		return this.store.get(id);
	}

	listGoals(): PersistedGoal[] {
		return this.store.getAll();
	}

	async updateGoal(id: string, updates: { title?: string; cwd?: string; state?: GoalState; spec?: string; team?: boolean; repoPath?: string; branch?: string; prUrl?: string }): Promise<boolean> {
		const existing = this.store.get(id);
		if (!existing) return false;

		// If toggling team mode ON for a non-team goal, auto-create worktree
		if (updates.team === true && !existing.team && !existing.worktreePath) {
			const cwd = updates.cwd ?? existing.cwd;
			if (await isGitRepo(cwd)) {
				const repoRoot = await getRepoRoot(cwd);
				const title = updates.title ?? existing.title;
				const branch = `goal/${toBranchName(title)}-${id.slice(0, 8)}`;
				try {
					const result = await createWorktree(repoRoot, branch);
					updates.repoPath = repoRoot;
					updates.branch = branch;
					// Also update cwd to the worktree
					updates.cwd = result.worktreePath;
					console.log(`[goal-manager] Created worktree for upgraded team goal "${title}": ${result.worktreePath} (branch: ${branch})`);
				} catch (err) {
					console.error(`[goal-manager] Failed to create worktree when upgrading to team goal:`, err);
				}
			}
		}

		return this.store.update(id, updates);
	}

	async deleteGoal(id: string): Promise<boolean> {
		const goal = this.store.get(id);
		if (goal?.team) {
			console.warn(`[goal-manager] Deleting team goal "${goal.title}" — ensure no active team sessions remain (cannot check from GoalManager)`);
		}
		if (goal?.worktreePath && goal?.repoPath) {
			// Clean up any leftover team agent worktrees in the sibling -wt-goal dir.
			// Team agents get worktrees like <goalWorktree>-wt-goal/<agentBranch>/
			// These may survive if dismissRole failed or the process crashed.
			const teamWorktreeParent = goal.worktreePath + "-wt-goal";
			if (fs.existsSync(teamWorktreeParent)) {
				try {
					const entries = fs.readdirSync(teamWorktreeParent, { withFileTypes: true });
					for (const entry of entries) {
						if (entry.isDirectory()) {
							const agentWtPath = path.join(teamWorktreeParent, entry.name);
							// Try to detect the branch name so we can delete it too
							let agentBranch: string | undefined;
							try {
								const { stdout } = await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
									cwd: agentWtPath,
								});
								agentBranch = stdout.toString().trim();
								if (agentBranch === "HEAD") agentBranch = undefined; // detached
							} catch {
								// worktree may already be broken
							}
							try {
								await cleanupWorktree(goal.repoPath, agentWtPath, agentBranch, true);
							} catch {
								// Best-effort — directory may already be cleaned
							}
						}
					}
					// Remove the parent dir itself
					fs.rmSync(teamWorktreeParent, { recursive: true, force: true });
					console.log(`[goal-manager] Cleaned up team worktree dir: ${teamWorktreeParent}`);
				} catch (err) {
					console.error(`[goal-manager] Failed to clean up team worktree dir ${teamWorktreeParent}:`, err);
				}
			}

			// Clean up the goal's own worktree and branch
			try {
				await cleanupWorktree(goal.repoPath, goal.worktreePath, goal.branch, true);
				console.log(`[goal-manager] Cleaned up worktree for goal "${goal.title}": ${goal.worktreePath}`);
			} catch (err) {
				console.error(`[goal-manager] Failed to clean up worktree for goal "${goal.title}":`, err);
			}

			// Prune stale worktree references
			try {
				await execFile("git", ["worktree", "prune"], { cwd: goal.repoPath });
			} catch {
				// ignore
			}
		}
		this.store.remove(id);
		return true;
	}
}
