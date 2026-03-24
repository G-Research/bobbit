import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
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
		.slice(0, 40) || "goal";
}

/** Check if a directory is inside a git repository. */
function isGitRepo(cwd: string): boolean {
	try {
		execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

/** Get the git repo root for a directory. */
function getRepoRoot(cwd: string): string {
	return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: "pipe" }).toString().trim();
}

export class GoalManager {
	private store = new GoalStore();
	private workflowStore?: WorkflowStore;

	constructor(workflowStore?: WorkflowStore) {
		this.workflowStore = workflowStore;
	}

	createGoal(title: string, cwd: string, opts?: { spec?: string; team?: boolean; worktree?: boolean; workflowId?: string; workflowStore?: WorkflowStore }): PersistedGoal {
		const { spec = "", team = true, worktree = true, workflowId, workflowStore = this.workflowStore } = opts ?? {};
		const now = Date.now();
		const id = randomUUID();

		let worktreePath: string | undefined;
		let branch: string | undefined;
		let repoPath: string | undefined;
		let goalCwd = cwd;

		// Detect git repo root — needed for team operations even without a worktree
		if (isGitRepo(cwd)) {
			repoPath = getRepoRoot(cwd);
		}

		// Create a git worktree if the cwd is a git repo (explicit worktree flag, defaults to true for team goals)
		if (worktree && repoPath) {
			branch = `goal/${toBranchName(title)}-${id.slice(0, 8)}`;
			try {
				const result = createWorktree(repoPath, branch);
				worktreePath = result.worktreePath;
				goalCwd = worktreePath;
				console.log(`[goal-manager] Created worktree for goal "${title}": ${worktreePath} (branch: ${branch})`);
			} catch (err) {
				// Worktree creation failed — fall back to shared cwd
				console.error(`[goal-manager] Failed to create worktree for goal "${title}":`, err);
				worktreePath = undefined;
				branch = undefined;
			}
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

	getGoal(id: string): PersistedGoal | undefined {
		return this.store.get(id);
	}

	listGoals(): PersistedGoal[] {
		return this.store.getAll();
	}

	updateGoal(id: string, updates: { title?: string; cwd?: string; state?: GoalState; spec?: string; team?: boolean; repoPath?: string; branch?: string }): boolean {
		const existing = this.store.get(id);
		if (!existing) return false;

		// If toggling team mode ON for a non-team goal, auto-create worktree
		if (updates.team === true && !existing.team && !existing.worktreePath) {
			const cwd = updates.cwd ?? existing.cwd;
			if (isGitRepo(cwd)) {
				const repoRoot = getRepoRoot(cwd);
				const title = updates.title ?? existing.title;
				const branch = `goal/${toBranchName(title)}-${id.slice(0, 8)}`;
				try {
					const result = createWorktree(repoRoot, branch);
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

	deleteGoal(id: string): boolean {
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
								agentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
									cwd: agentWtPath,
									stdio: "pipe",
								}).toString().trim();
								if (agentBranch === "HEAD") agentBranch = undefined; // detached
							} catch {
								// worktree may already be broken
							}
							try {
								cleanupWorktree(goal.repoPath, agentWtPath, agentBranch, true);
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
				cleanupWorktree(goal.repoPath, goal.worktreePath, goal.branch, true);
				console.log(`[goal-manager] Cleaned up worktree for goal "${goal.title}": ${goal.worktreePath}`);
			} catch (err) {
				console.error(`[goal-manager] Failed to clean up worktree for goal "${goal.title}":`, err);
			}

			// Prune stale worktree references
			try {
				execFileSync("git", ["worktree", "prune"], { cwd: goal.repoPath, stdio: "pipe" });
			} catch {
				// ignore
			}
		}
		this.store.remove(id);
		return true;
	}
}
