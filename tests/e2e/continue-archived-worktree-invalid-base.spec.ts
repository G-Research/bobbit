/**
 * Repro: Continue-Archived from a worktree-backed source must surface fresh
 * worktree/base-ref creation failures synchronously.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, connectWs, agentEndPredicate, registerProject } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.use({ enableWorktreePool: false });

async function sendPromptAndWait(id: string, text: string): Promise<void> {
	const ws = await connectWs(id);
	try {
		ws.send({ type: "prompt", text });
		await ws.waitFor(agentEndPredicate(), 10_000);
	} finally {
		ws.close();
	}
}

function initRepo(repoPath: string): void {
	mkdirSync(repoPath, { recursive: true });
	execFileSync("git", ["init", "--initial-branch=master"], { cwd: repoPath, stdio: "pipe" });
	execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoPath });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: repoPath });
	execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoPath });
	execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoPath, stdio: "pipe" });
}

function branchExists(repoPath: string, branch: string): boolean {
	try {
		execFileSync("git", ["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: repoPath, stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function deleteBranchIfPresent(repoPath: string, branch: string): void {
	try {
		execFileSync("git", ["branch", "-D", branch], { cwd: repoPath, stdio: "pipe" });
	} catch {
		// Best-effort cleanup; assertions below verify the intended stale state.
	}
}

function removeWorktreeIfPresent(repoPath: string, worktreePath: string): void {
	try {
		execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath, stdio: "pipe" });
	} catch {
		// It may already have been removed by archive cleanup.
	}
	rmSync(worktreePath, { recursive: true, force: true });
	try {
		execFileSync("git", ["worktree", "prune"], { cwd: repoPath, stdio: "pipe" });
	} catch {
		// Best-effort cleanup.
	}
}

test.describe("Continue-Archived worktree base-ref failure", () => {
	test("returns an actionable error when the current project base_ref is stale (api)", async () => {
		const baseDir = realpathSync(tmpdir()) + `/bobbit-e2e-cont-wt-invalid-base-${process.pid}-${Date.now()}`;
		const repoPath = join(baseDir, "repo");
		let projectId: string | undefined;
		let srcId: string | undefined;
		let unexpectedContinuedId: string | undefined;

		try {
			initRepo(repoPath);
			const project = await registerProject({ name: `cont-wt-invalid-base-${Date.now()}`, rootPath: repoPath });
			projectId = project.id;

			const sourceResp = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: repoPath, worktree: true, projectId }),
			});
			expect(sourceResp.status).toBe(201);
			srcId = (await sourceResp.json()).id;

			const srcRec = await pollUntil(async () => {
				const recResp = await apiFetch(`/api/sessions/${srcId}`);
				if (!recResp.ok) return null;
				const rec = await recResp.json();
				return (rec.status === "idle" || rec.status === "streaming") && rec.worktreePath && rec.branch ? rec : null;
			}, { timeoutMs: 30_000, intervalMs: 200, label: "source worktree session reached idle" });

			expect(srcRec.cwd).toBe(srcRec.worktreePath);
			await sendPromptAndWait(srcId, "INVALID_BASE_REF_CONTINUE_SOURCE_MARKER");

			const archiveResp = await apiFetch(`/api/sessions/${srcId}`, { method: "DELETE" });
			expect(archiveResp.ok).toBe(true);

			const staleBaseRef = `stale-continue-base-${Date.now()}`;
			execFileSync("git", ["branch", staleBaseRef, "master"], { cwd: repoPath, stdio: "pipe" });
			const putBaseRef = await apiFetch(`/api/projects/${projectId}/config`, {
				method: "PUT",
				body: JSON.stringify({ base_ref: staleBaseRef }),
			});
			expect(putBaseRef.status, await putBaseRef.text()).toBe(200);

			removeWorktreeIfPresent(repoPath, srcRec.worktreePath);
			deleteBranchIfPresent(repoPath, srcRec.branch);
			deleteBranchIfPresent(repoPath, staleBaseRef);

			expect(existsSync(srcRec.worktreePath), "source worktree must be stale before continue").toBe(false);
			expect(branchExists(repoPath, srcRec.branch), "source branch must be stale before continue").toBe(false);
			expect(branchExists(repoPath, staleBaseRef), "configured base_ref must be stale before continue").toBe(false);

			const cont = await apiFetch(`/api/sessions/${srcId}/continue`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			const bodyText = await cont.text();
			try {
				unexpectedContinuedId = JSON.parse(bodyText)?.id;
			} catch {
				// Non-JSON error bodies are fine for this assertion block.
			}

			expect(
				cont.status,
				`continue unexpectedly returned 201 before fresh worktree/base_ref setup failure was surfaced; body=${bodyText}`,
			).not.toBe(201);

			expect(bodyText, "error should mention the current project base_ref/worktree failure").toMatch(/base[_ -]?ref|worktree|ref .*not found|does not exist/i);
			const unescapedBody = bodyText.replace(/\\\\/g, "\\");
			expect(unescapedBody, "error must not blame the archived source worktree").not.toContain(srcRec.worktreePath);
			expect(bodyText, "error must not blame the archived source branch").not.toContain(srcRec.branch);
			expect(bodyText, "error should identify the stale current project base_ref").toContain(staleBaseRef);
		} finally {
			if (unexpectedContinuedId) {
				await apiFetch(`/api/sessions/${unexpectedContinuedId}`, { method: "DELETE" }).catch(() => {});
			}
			if (srcId) {
				await apiFetch(`/api/sessions/${srcId}`, { method: "DELETE" }).catch(() => {});
			}
			if (projectId) {
				await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
			}
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
