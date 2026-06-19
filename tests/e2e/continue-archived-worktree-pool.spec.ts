/**
 * Reproducing test: Continue-Archived from a non-sandboxed worktree-backed
 * source must claim a ready project worktree-pool entry instead of bypassing
 * the pool and taking the cold createWorktree path.
 */
import { test, expect } from "./in-process-harness.js";
import { agentEndPredicate, apiFetch, connectWs, registerProject } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";
import { waitForPool } from "./test-utils/pool-polling.mjs";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";

// This spec intentionally exercises the host-side worktree pool.
test.use({ enableWorktreePool: true });

type PoolEntrySnapshot = { branchName: string; worktreePath: string };
type RuntimeCwdRecord = { type: "system" | "session"; cwd: string };

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

function slugifyCwd(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function globalAgentSessionsDir(): string {
	const env = process.env.BOBBIT_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
	return join(env ?? join(homedir(), ".bobbit", "agent"), "sessions");
}

function findClonedJsonl(slugDir: string, sessionId: string): string | null {
	if (!existsSync(slugDir)) return null;
	const match = readdirSync(slugDir).find((f) => f.endsWith(`_${sessionId}.jsonl`));
	return match ? join(slugDir, match) : null;
}

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

function hasRuntimeCwdRecord(jsonlPath: string, type: RuntimeCwdRecord["type"], cwd: string): boolean {
	return readRuntimeCwdRecords(jsonlPath).some((record) => record.type === type && record.cwd === cwd);
}

function ensureRuntimeCwdMetadata(jsonlPath: string, cwd: string, sessionId: string): void {
	if (!hasRuntimeCwdRecord(jsonlPath, "system", cwd)) {
		appendFileSync(jsonlPath, `${JSON.stringify({ type: "system", subtype: "init", cwd })}\n`);
	}
	if (!hasRuntimeCwdRecord(jsonlPath, "session", cwd)) {
		appendFileSync(jsonlPath, `${JSON.stringify({
			type: "session",
			version: 3,
			id: `pi-style-${sessionId}`,
			timestamp: "2026-06-18T12:20:31.770Z",
			cwd,
		})}\n`);
	}
}

async function readyPoolEntry(gateway: any, projectId: string): Promise<PoolEntrySnapshot> {
	const ready = await waitForPool(projectId, 1, 45_000);
	expect(ready, "project worktree pool should expose a ready entry before continue").toBeGreaterThan(0);
	return pollUntil(() => {
		const pool = gateway.sessionManager.getWorktreePool(projectId) as any;
		const entry = pool?.pool?.[0];
		return typeof entry?.branchName === "string" && typeof entry?.worktreePath === "string"
			? { branchName: entry.branchName, worktreePath: entry.worktreePath }
			: null;
	}, { timeoutMs: 10_000, intervalMs: 100, label: "ready pool entry is observable" });
}

test.describe("Continue-Archived worktree pool", () => {
	test("non-sandboxed archived worktree sessions claim a ready pool entry and preserve cloned history", async ({ gateway }) => {
		const baseDir = realpathSync(tmpdir()) + `/bobbit-e2e-cont-wt-pool-${process.pid}-${Date.now()}`;
		const repoPath = join(baseDir, "repo");
		let projectId: string | undefined;
		let srcId: string | undefined;
		let newId: string | undefined;

		try {
			initRepo(repoPath);
			const project = await registerProject({ name: `cont-wt-pool-${Date.now()}`, rootPath: repoPath });
			projectId = project.id;

			// Prove the project pool is enabled and capable of preparing entries.
			await readyPoolEntry(gateway, projectId);

			const sourceResp = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: repoPath, worktree: true, projectId }),
			});
			const sourceBody = await sourceResp.text();
			expect(sourceResp.status, sourceBody).toBe(201);
			srcId = JSON.parse(sourceBody).id;

			const srcRec = await pollUntil(async () => {
				const recResp = await apiFetch(`/api/sessions/${srcId}`);
				if (!recResp.ok) return null;
				const rec = await recResp.json();
				return (rec.status === "idle" || rec.status === "streaming") && rec.worktreePath && rec.branch ? rec : null;
			}, { timeoutMs: 30_000, intervalMs: 200, label: "source worktree session reached idle" });

			expect(srcRec.cwd).toBe(srcRec.worktreePath);
			expect(srcRec.branch).toBe(`session/${srcId.slice(0, 8)}`);
			expect(existsSync(srcRec.worktreePath), "source worktree should exist before archive").toBe(true);

			const transcriptMarker = `CONTINUE_POOL_SOURCE_MARKER_${Date.now()}`;
			await sendPromptAndWait(srcId, `${transcriptMarker} hello from pooled continue source`);

			const sourceJsonl = await pollUntil<string>(() => {
				const file = gateway.sessionManager.getPersistedSession(srcId!)?.agentSessionFile;
				return file && existsSync(file) ? file : "";
			}, { timeoutMs: 10_000, intervalMs: 100, label: "source session jsonl exists" });
			ensureRuntimeCwdMetadata(sourceJsonl, srcRec.worktreePath, srcId);

			const archiveResp = await apiFetch(`/api/sessions/${srcId}`, { method: "DELETE" });
			expect(archiveResp.ok).toBe(true);

			const archivedSourceJsonl = await pollUntil<string>(() => {
				const file = gateway.sessionManager.getPersistedSession(srcId!)?.agentSessionFile;
				return file && existsSync(file) ? file : "";
			}, { timeoutMs: 10_000, intervalMs: 100, label: "archived source session jsonl exists" });
			ensureRuntimeCwdMetadata(archivedSourceJsonl, srcRec.worktreePath, srcId);

			// Capture the exact ready entry Continue-Archived must claim. The fixed
			// path shifts this entry and renames its branch/path to session/<newId8>.
			const readyBeforeContinue = await readyPoolEntry(gateway, projectId);
			expect(readyBeforeContinue.branchName).toMatch(/^pool\/_pool-/);
			expect(existsSync(readyBeforeContinue.worktreePath), "captured ready pool worktree should exist before continue").toBe(true);
			expect(branchExists(repoPath, readyBeforeContinue.branchName), "captured ready pool branch should exist before continue").toBe(true);

			const continueResp = await apiFetch(`/api/sessions/${srcId}/continue`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			const continueBody = await continueResp.text();
			expect(continueResp.status, continueBody).toBe(201);
			newId = JSON.parse(continueBody).id;
			expect(newId).toBeTruthy();
			expect(newId).not.toBe(srcId);

			const expectedBranch = `session/${newId.slice(0, 8)}`;
			const expectedClaimedPath = join(dirname(readyBeforeContinue.worktreePath), expectedBranch.replace(/\//g, "-"));

			const newRec = await pollUntil(async () => {
				const recResp = await apiFetch(`/api/sessions/${newId}?include=archived`);
				if (!recResp.ok) return null;
				const rec = await recResp.json();
				return rec.status !== "preparing" && rec.status !== "starting" ? rec : null;
			}, { timeoutMs: 30_000, intervalMs: 200, label: "continued session left preparing" });

			expect(["idle", "streaming"]).toContain(newRec.status);
			expect(newRec.archived).toBeFalsy();
			expect(newRec.branch).toBe(expectedBranch);
			expect(newRec.worktreePath).toBeTruthy();
			expect(normalize(newRec.worktreePath)).toBe(normalize(expectedClaimedPath));
			expect(newRec.cwd).toBe(newRec.worktreePath);
			expect(existsSync(newRec.worktreePath), "continued session worktree should exist at the claimed pool path").toBe(true);
			expect(branchExists(repoPath, expectedBranch), "continued session branch should exist").toBe(true);

			const sessionsDir = globalAgentSessionsDir();
			const projectSlugFile = findClonedJsonl(join(sessionsDir, `--${slugifyCwd(repoPath)}--`), newId);
			const worktreeSlugFile = findClonedJsonl(join(sessionsDir, `--${slugifyCwd(newRec.worktreePath)}--`), newId);
			expect(projectSlugFile, "continued transcript must not be adopted under the project-root slug").toBeNull();
			expect(worktreeSlugFile, "continued transcript must be adopted under the claimed worktree cwd slug").toBeTruthy();

			const persistedContinued = gateway.sessionManager.getPersistedSession(newId);
			expect(normalize(persistedContinued?.agentSessionFile ?? ""), "persisted agentSessionFile should point at the adopted worktree-slug transcript").toBe(normalize(worktreeSlugFile!));

			const clonedText = readFileSync(worktreeSlugFile!, "utf8");
			expect(clonedText, "cloned transcript should include source history").toContain(transcriptMarker);
			const clonedRuntimeCwdRecords = readRuntimeCwdRecords(worktreeSlugFile!);
			expect(clonedRuntimeCwdRecords, "continued system cwd metadata should be rebased to the claimed worktree cwd").toContainEqual({ type: "system", cwd: newRec.worktreePath });
			expect(clonedRuntimeCwdRecords, "continued Pi-style session cwd metadata should be rebased to the claimed worktree cwd").toContainEqual({ type: "session", cwd: newRec.worktreePath });
			expect(clonedRuntimeCwdRecords.map((record) => record.cwd), "continued runtime cwd metadata should not retain the archived source worktree cwd").not.toContain(srcRec.worktreePath);

			// Reproducer: with bypassWorktreePool still true, Continue-Archived takes
			// the cold createWorktree path and leaves this captured pool entry intact.
			expect(branchExists(repoPath, readyBeforeContinue.branchName), "continued session must claim the ready pool branch and rename it").toBe(false);
			expect(existsSync(readyBeforeContinue.worktreePath), "continued session must move the ready pool worktree to the session path").toBe(false);
		} finally {
			if (newId) await apiFetch(`/api/sessions/${newId}`, { method: "DELETE" }).catch(() => {});
			if (srcId) await apiFetch(`/api/sessions/${srcId}`, { method: "DELETE" }).catch(() => {});
			if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
