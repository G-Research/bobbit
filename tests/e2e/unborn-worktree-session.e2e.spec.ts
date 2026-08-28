/**
 * Regression: a regular session created in a freshly `git init`-ed repo with
 * no commits must not try `git worktree add ... HEAD` and then archive itself.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, deleteSession, registerProject } from "./e2e-setup.js";
import { pollUntil, awaitableRm } from "./test-utils/cleanup.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const RAW_INVALID_HEAD = /fatal:\s*invalid reference HEAD/i;

function comparablePath(p: string): string {
	const resolved = path.resolve(p);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertUnbornHead(repoPath: string): void {
	expect(() => execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
		cwd: repoPath,
		stdio: "pipe",
	})).toThrow();
}

async function readSession(id: string): Promise<any> {
	const resp = await apiFetch(`/api/sessions/${id}`);
	const text = await resp.text();
	expect(resp.status, text || "<empty>").toBe(200);
	return JSON.parse(text);
}

async function deleteProject(id: string | undefined): Promise<void> {
	if (!id) return;
	await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
}

test.describe("unborn git repo worktree fallback", () => {
	test("regular session creation in an unborn repo settles without raw HEAD worktree failure", async () => {
		test.setTimeout(90_000);

		const baseDir = mkdtempSync(path.join(tmpdir(), `bobbit-e2e-unborn-session-${process.pid}-`));
		const repoPath = path.join(baseDir, "repo");
		let projectId: string | undefined;
		let sessionId: string | undefined;

		try {
			mkdirSync(repoPath, { recursive: true });
			execFileSync("git", ["init", "--quiet"], { cwd: repoPath, stdio: "pipe" });
			expect(existsSync(path.join(repoPath, ".git"))).toBe(true);
			assertUnbornHead(repoPath);

			const project = await registerProject({
				name: `unborn-session-${Date.now()}`,
				rootPath: repoPath,
			});
			projectId = project.id;

			// Omit `worktree`: regular non-goal sessions request a worktree by default.
			const createResp = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: repoPath, projectId }),
			});
			const createText = await createResp.text();
			expect(createResp.status, createText).toBe(201);
			expect(createText, "create response should not surface raw git HEAD failure").not.toMatch(RAW_INVALID_HEAD);
			sessionId = JSON.parse(createText).id;

			const settled = await pollUntil(async () => {
				const rec = await readSession(sessionId!);
				return rec.status !== "preparing" ? rec : null;
			}, { timeoutMs: 40_000, intervalMs: 200, label: "unborn repo session leaves preparing" });

			expect(JSON.stringify(settled), "settled session should not expose raw invalid HEAD output").not.toMatch(RAW_INVALID_HEAD);
			expect(settled.status, "session should remain usable instead of being archived/terminated by worktree setup").not.toMatch(/^(archived|terminated)$/);
			expect(settled.worktreePath, "unborn repos should fall back to a no-worktree session until an initial commit exists").toBeFalsy();
			expect(comparablePath(settled.cwd), "no-worktree fallback should keep the original repo cwd").toBe(comparablePath(repoPath));

			const allResp = await apiFetch(`/api/sessions?include=archived&projectId=${encodeURIComponent(projectId)}`);
			expect(allResp.status).toBe(200);
			const allText = await allResp.text();
			expect(allText, "session list should not contain raw invalid HEAD output").not.toMatch(RAW_INVALID_HEAD);
		} finally {
			if (sessionId) await deleteSession(sessionId);
			await deleteProject(projectId);
			await awaitableRm(baseDir);
		}
	});
});
