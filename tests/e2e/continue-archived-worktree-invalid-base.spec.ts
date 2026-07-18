/**
 * Repro: Continue-Archived from a worktree-backed source must surface fresh
 * worktree/base-ref creation failures synchronously.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, connectWs, agentEndPredicate, defaultProjectId, registerProject } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareGitTemplate, copyGitTemplate } from "../../tests2/harness/git-template.js";
import { runFixtureCommand } from "../../tests2/harness/spawn-with-retry.js";

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

// Repo comes from the immutable committed template (master + README.md +
// .gitattributes + one commit); nothing here asserts on tree contents.
async function initRepo(repoPath: string): Promise<void> {
	await prepareGitTemplate();
	copyGitTemplate(repoPath);
}

// attempts: 1 for probes/best-effort helpers whose failure is an accepted
// outcome — retrying would only change timing, not semantics.
async function branchExists(repoPath: string, branch: string): Promise<boolean> {
	try {
		await runFixtureCommand("git", ["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: repoPath, attempts: 1 });
		return true;
	} catch {
		return false;
	}
}

async function deleteBranchIfPresent(repoPath: string, branch: string): Promise<void> {
	try {
		await runFixtureCommand("git", ["branch", "-D", branch], { cwd: repoPath, attempts: 1 });
	} catch {
		// Best-effort cleanup; assertions below verify the intended stale state.
	}
}

async function removeWorktreeIfPresent(repoPath: string, worktreePath: string): Promise<void> {
	try {
		await runFixtureCommand("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath, attempts: 1 });
	} catch {
		// It may already have been removed by archive cleanup.
	}
	rmSync(worktreePath, { recursive: true, force: true });
	try {
		await runFixtureCommand("git", ["worktree", "prune"], { cwd: repoPath, attempts: 1 });
	} catch {
		// Best-effort cleanup.
	}
}

test.describe("Continue-Archived worktree base-ref failure", () => {
	test("returns an actionable error when the current project base_ref is stale (api)", async () => {
		const baseDir = realpathSync(tmpdir()) + `/bobbit-e2e-cont-wt-invalid-base-${process.pid}-${Date.now()}`;
		const repoPath = join(baseDir, "repo");
		let projectId: string | undefined;
		let defaultId: string | undefined;
		let srcId: string | undefined;
		let unexpectedContinuedId: string | undefined;

		try {
			await initRepo(repoPath);
			defaultId = await defaultProjectId();
			const project = await registerProject({ name: `cont-wt-invalid-base-${Date.now()}`, rootPath: repoPath });
			projectId = project.id;
			expect(projectId, "stale-base test project must not reuse the harness default project").not.toBe(defaultId);

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
			await runFixtureCommand("git", ["branch", staleBaseRef, "master"], { cwd: repoPath });
			const putBaseRef = await apiFetch(`/api/projects/${projectId}/config`, {
				method: "PUT",
				body: JSON.stringify({ base_ref: staleBaseRef }),
			});
			expect(putBaseRef.status, await putBaseRef.text()).toBe(200);
			if (defaultId) {
				const defaultCfgResp = await apiFetch(`/api/projects/${defaultId}/config`);
				expect(defaultCfgResp.status, await defaultCfgResp.clone().text()).toBe(200);
				const defaultCfg = await defaultCfgResp.json();
				expect(defaultCfg.base_ref, "stale-base setup must not poison the harness default project").not.toBe(staleBaseRef);
			}

			await removeWorktreeIfPresent(repoPath, srcRec.worktreePath);
			await deleteBranchIfPresent(repoPath, srcRec.branch);
			await deleteBranchIfPresent(repoPath, staleBaseRef);

			expect(existsSync(srcRec.worktreePath), "source worktree must be stale before continue").toBe(false);
			expect(await branchExists(repoPath, srcRec.branch), "source branch must be stale before continue").toBe(false);
			expect(await branchExists(repoPath, staleBaseRef), "configured base_ref must be stale before continue").toBe(false);

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
			if (defaultId) {
				await apiFetch(`/api/projects/${defaultId}/config`, {
					method: "PUT",
					body: JSON.stringify({ base_ref: "" }),
				}).catch(() => {});
			}
			if (projectId) {
				await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
			}
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
