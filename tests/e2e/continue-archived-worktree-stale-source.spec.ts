/**
 * Regression: Continue-Archived from a worktree-backed source must not depend
 * on the archived source worktree path or source branch still existing.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, connectWs, agentEndPredicate, registerProject } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
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
	execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoPath, stdio: "pipe" });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: repoPath, stdio: "pipe" });
	execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoPath, stdio: "pipe" });
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
		// Best-effort cleanup; assertions verify the stale state.
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

/** Slugify the way `formatAgentSessionFilePath` does (no collapse, just non-alnum→`-`). */
function slugifyCwd(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function globalAgentSessionsDir(): string {
	const env = process.env.BOBBIT_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
	const base = env ?? join(homedir(), ".bobbit", "agent");
	return join(base, "sessions");
}

/** Find a `.jsonl` file in a sessions slug-dir whose name contains `sessionId`. */
function findClonedJsonl(slugDir: string, sessionId: string): string | null {
	if (!existsSync(slugDir)) return null;
	try {
		const entries = readdirSync(slugDir);
		const match = entries.find((f) => f.endsWith(`_${sessionId}.jsonl`));
		return match ? join(slugDir, match) : null;
	} catch {
		return null;
	}
}

type RuntimeCwdRecord = { type: "system" | "session"; cwd: string };

function readRuntimeCwdRecords(jsonlPath: string): RuntimeCwdRecord[] {
	const records: RuntimeCwdRecord[] = [];
	for (const line of readFileSync(jsonlPath, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if ((parsed?.type === "system" || parsed?.type === "session") && typeof parsed.cwd === "string") {
				records.push({ type: parsed.type, cwd: parsed.cwd });
			}
		} catch {
			// Ignore malformed transcript lines; the mock agent does the same.
		}
	}
	return records;
}

function readRuntimeCwds(jsonlPath: string): string[] {
	return readRuntimeCwdRecords(jsonlPath).map((record) => record.cwd);
}

function hasRuntimeCwdRecord(jsonlPath: string, type: RuntimeCwdRecord["type"], cwd: string): boolean {
	return readRuntimeCwdRecords(jsonlPath).some((record) => record.type === type && record.cwd === cwd);
}

function ensureStaleRuntimeCwdMetadata(jsonlPath: string, cwd: string, sessionId: string): void {
	if (!hasRuntimeCwdRecord(jsonlPath, "system", cwd)) {
		appendFileSync(jsonlPath, `${JSON.stringify({ type: "system", subtype: "init", cwd })}\n`);
	}
	if (!hasRuntimeCwdRecord(jsonlPath, "session", cwd)) {
		appendFileSync(jsonlPath, `${JSON.stringify({
			type: "session",
			version: 3,
			id: `pi-style-${sessionId}`,
			timestamp: "2026-06-17T12:20:31.770Z",
			cwd,
		})}\n`);
	}
}

test.describe("Continue-Archived stale worktree source", () => {
	test("succeeds with a fresh session branch/worktree after source path and branch are deleted (api)", async ({ gateway }) => {
		const baseDir = realpathSync(tmpdir()) + `/bobbit-e2e-cont-wt-stale-source-${process.pid}-${Date.now()}`;
		const repoPath = join(baseDir, "repo");
		let projectId: string | undefined;
		let srcId: string | undefined;
		let newId: string | undefined;

		try {
			initRepo(repoPath);
			const project = await registerProject({ name: `cont-wt-stale-source-${Date.now()}`, rootPath: repoPath });
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
			expect(srcRec.branch).toBe(`session/${srcId.slice(0, 8)}`);
			expect(existsSync(srcRec.worktreePath), "source worktree should exist before staling it").toBe(true);
			expect(branchExists(repoPath, srcRec.branch), "source branch should exist before staling it").toBe(true);

			const transcriptMarker = `STALE_SOURCE_CONTINUE_TRANSCRIPT_${Date.now()}`;
			const proposalMarker = `STALE_SOURCE_CONTINUE_PROPOSAL_${Date.now()}`;
			await sendPromptAndWait(srcId, `${transcriptMarker} hello from stale source`);

			const sessionsDir = globalAgentSessionsDir();
			const sourceJsonl = await pollUntil<string>(() => {
				const file = gateway.sessionManager.getPersistedSession(srcId!)?.agentSessionFile;
				return file && existsSync(file) ? file : "";
			}, {
				timeoutMs: 10_000,
				intervalMs: 100,
				label: "source session jsonl exists",
			});
			ensureStaleRuntimeCwdMetadata(sourceJsonl, srcRec.worktreePath, srcId);
			expect(readRuntimeCwdRecords(sourceJsonl), "source transcript should contain stale system cwd metadata before archive").toContainEqual({ type: "system", cwd: srcRec.worktreePath });
			expect(readRuntimeCwdRecords(sourceJsonl), "source transcript should contain stale Pi-style session cwd metadata before archive").toContainEqual({ type: "session", cwd: srcRec.worktreePath });

			const seedProposal = await apiFetch(`/api/sessions/${srcId}/proposal/role/seed`, {
				method: "POST",
				body: JSON.stringify({
					args: {
						name: `stale-source-role-${Date.now()}`,
						label: "Stale Source Role",
						prompt: `proposal marker ${proposalMarker}`,
					},
				}),
			});
			expect(seedProposal.status, await seedProposal.text()).toBe(200);

			const archiveResp = await apiFetch(`/api/sessions/${srcId}`, { method: "DELETE" });
			expect(archiveResp.ok).toBe(true);

			const archivedSourceJsonl = await pollUntil<string>(() => {
				const file = gateway.sessionManager.getPersistedSession(srcId!)?.agentSessionFile;
				return file && existsSync(file) ? file : "";
			}, {
				timeoutMs: 10_000,
				intervalMs: 100,
				label: "archived source session jsonl exists",
			});
			ensureStaleRuntimeCwdMetadata(archivedSourceJsonl, srcRec.worktreePath, srcId);
			expect(readRuntimeCwdRecords(archivedSourceJsonl), "archived source transcript should retain stale system cwd metadata").toContainEqual({ type: "system", cwd: srcRec.worktreePath });
			expect(readRuntimeCwdRecords(archivedSourceJsonl), "archived source transcript should retain stale Pi-style session cwd metadata").toContainEqual({ type: "session", cwd: srcRec.worktreePath });

			removeWorktreeIfPresent(repoPath, srcRec.worktreePath);
			deleteBranchIfPresent(repoPath, srcRec.branch);
			expect(existsSync(srcRec.worktreePath), "source worktree must be stale before continue").toBe(false);
			expect(branchExists(repoPath, srcRec.branch), "source branch must be stale before continue").toBe(false);

			const cont = await apiFetch(`/api/sessions/${srcId}/continue`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			const continueBody = await cont.text();
			expect(cont.status, continueBody).toBe(201);
			newId = JSON.parse(continueBody).id;
			expect(newId).toBeTruthy();
			expect(newId).not.toBe(srcId);

			const newRec = await pollUntil(async () => {
				const recResp = await apiFetch(`/api/sessions/${newId}?include=archived`);
				if (!recResp.ok) return null;
				const rec = await recResp.json();
				return rec.status !== "preparing" && rec.status !== "starting" ? rec : null;
			}, { timeoutMs: 30_000, intervalMs: 200, label: "continued session left preparing" });

			expect(["idle", "streaming"]).toContain(newRec.status);
			expect(newRec.archived).toBeFalsy();
			expect(newRec.branch).toBe(`session/${newId.slice(0, 8)}`);
			expect(newRec.branch).not.toBe(srcRec.branch);
			expect(newRec.worktreePath).toBeTruthy();
			expect(newRec.worktreePath).not.toBe(srcRec.worktreePath);
			expect(newRec.cwd).toBe(newRec.worktreePath);
			expect(existsSync(newRec.worktreePath), "continued session worktree should exist").toBe(true);
			expect(branchExists(repoPath, newRec.branch), "continued session branch should exist").toBe(true);

			// The deleted archived source must remain stale; continue must not revive it.
			expect(existsSync(srcRec.worktreePath), "continue must not recreate the deleted source worktree").toBe(false);
			expect(branchExists(repoPath, srcRec.branch), "continue must not recreate the deleted source branch").toBe(false);

			const projSlugDir = join(sessionsDir, `--${slugifyCwd(repoPath)}--`);
			const wtSlugDir = join(sessionsDir, `--${slugifyCwd(newRec.worktreePath)}--`);
			const clonedAtProj = findClonedJsonl(projSlugDir, newId);
			const clonedAtWt = findClonedJsonl(wtSlugDir, newId);

			expect(clonedAtProj, "cloned .jsonl must not live under the project-root slug").toBeNull();
			expect(clonedAtWt, "cloned .jsonl must live under the new worktree-cwd slug").toBeTruthy();
			expect(readFileSync(clonedAtWt!, "utf8"), "cloned transcript should include the source marker").toContain(transcriptMarker);
			const clonedRuntimeCwdRecords = readRuntimeCwdRecords(clonedAtWt!);
			expect(readRuntimeCwds(clonedAtWt!), "continued runtime cwd metadata should be rebased off the deleted source worktree").not.toContain(srcRec.worktreePath);
			expect(clonedRuntimeCwdRecords, "continued system cwd metadata should reference the fresh worktree cwd").toContainEqual({ type: "system", cwd: newRec.worktreePath });
			expect(clonedRuntimeCwdRecords, "continued Pi-style session cwd metadata should reference the fresh worktree cwd").toContainEqual({ type: "session", cwd: newRec.worktreePath });

			const proposalResp = await apiFetch(`/api/sessions/${newId}/proposal/role`);
			const proposalBody = await proposalResp.text();
			expect(proposalResp.status, proposalBody).toBe(200);
			expect(proposalBody).toContain(proposalMarker);
		} finally {
			if (newId) {
				await apiFetch(`/api/sessions/${newId}`, { method: "DELETE" }).catch(() => {});
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
