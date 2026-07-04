/**
 * Regression: Continue-Archived must resolve worktree support like normal
 * session creation for multi-repo projects whose rootPath is a non-git
 * container with git sub-repo components.
 */
import { test, expect } from "./in-process-harness.js";
import { agentEndPredicate, apiFetch, connectWs, registerProject } from "./e2e-setup.js";
import { awaitableRm, pollUntil } from "./test-utils/cleanup.js";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, normalize } from "node:path";

// Exercise the same host-side pool path normal worktree sessions use, while
// still accepting the cold createWorktreeSet fallback if the pool is empty.
test.use({ enableWorktreePool: true });

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
	const env = process.env.BOBBIT_AGENT_DIR;
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
			id: `pi-style-${sessionId}-${slugifyCwd(cwd).slice(0, 12)}`,
			timestamp: "2026-06-18T12:20:31.770Z",
			cwd,
		})}\n`);
	}
}

async function persistedJsonl(gateway: any, sessionId: string): Promise<string> {
	return pollUntil<string>(() => {
		const file = gateway.sessionManager.getPersistedSession(sessionId)?.agentSessionFile;
		return file && existsSync(file) ? file : "";
	}, { timeoutMs: 10_000, intervalMs: 100, label: `session ${sessionId} jsonl exists` });
}

test.describe("Continue-Archived multi-repo worktree support", () => {
	test("continues a worktree-backed archived session when project root is a non-git multi-repo container", async ({ gateway }) => {
		test.setTimeout(90_000);
		const baseDir = mkdtempSync(join(realpathSync(tmpdir()), `bobbit-e2e-cont-mr-${process.pid}-`));
		const rootPath = join(baseDir, "project");
		const apiRepo = join(rootPath, "api");
		const webRepo = join(rootPath, "web");
		let projectId: string | undefined;
		let srcId: string | undefined;
		let newId: string | undefined;

		try {
			mkdirSync(rootPath, { recursive: true });
			initRepo(apiRepo);
			initRepo(webRepo);
			expect(existsSync(join(rootPath, ".git")), "project root must be a non-git multi-repo container").toBe(false);

			const project = await registerProject({
				name: `cont-mr-${Date.now()}`,
				rootPath,
				components: [
					{ name: "api", repo: "api" },
					{ name: "web", repo: "web" },
				],
			});
			projectId = project.id;

			const sourceResp = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: apiRepo, worktree: true, projectId }),
			});
			const sourceBody = await sourceResp.text();
			expect(sourceResp.status, sourceBody).toBe(201);
			srcId = JSON.parse(sourceBody).id;

			const srcRec = await pollUntil(async () => {
				const recResp = await apiFetch(`/api/sessions/${srcId}`);
				if (!recResp.ok) return null;
				const rec = await recResp.json();
				return (rec.status === "idle" || rec.status === "streaming") && rec.worktreePath && rec.branch ? rec : null;
			}, { timeoutMs: 30_000, intervalMs: 200, label: "source multi-repo worktree session reached idle" });

			expect(srcRec.branch).toBe(`session/${srcId.slice(0, 8)}`);
			expect(normalize(srcRec.worktreePath)).not.toBe(normalize(rootPath));
			expect(normalize(srcRec.cwd)).not.toBe(normalize(rootPath));
			expect(normalize(srcRec.cwd)).not.toBe(normalize(apiRepo));
			expect(existsSync(srcRec.worktreePath), "source worktree container should exist before archive").toBe(true);
			expect(existsSync(join(srcRec.worktreePath, "api")), "source api worktree should exist before archive").toBe(true);
			expect(existsSync(join(srcRec.worktreePath, "web")), "source web worktree should exist before archive").toBe(true);
			expect(branchExists(apiRepo, srcRec.branch), "source branch should exist in api repo").toBe(true);
			expect(branchExists(webRepo, srcRec.branch), "source branch should exist in web repo").toBe(true);

			const transcriptMarker = `MULTI_REPO_CONTINUE_ARCHIVED_MARKER_${Date.now()}`;
			await sendPromptAndWait(srcId, `${transcriptMarker} hello from multi-repo source`);

			const sourceJsonl = await persistedJsonl(gateway, srcId);
			ensureRuntimeCwdMetadata(sourceJsonl, srcRec.cwd, srcId);
			ensureRuntimeCwdMetadata(sourceJsonl, srcRec.worktreePath, srcId);

			const archiveResp = await apiFetch(`/api/sessions/${srcId}`, { method: "DELETE" });
			expect(archiveResp.ok).toBe(true);

			const archivedSourceJsonl = await persistedJsonl(gateway, srcId);
			ensureRuntimeCwdMetadata(archivedSourceJsonl, srcRec.cwd, srcId);
			ensureRuntimeCwdMetadata(archivedSourceJsonl, srcRec.worktreePath, srcId);

			const continueResp = await apiFetch(`/api/sessions/${srcId}/continue`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			const continueBody = await continueResp.text();
			expect(continueResp.status, continueBody).toBe(201);
			newId = JSON.parse(continueBody).id;
			expect(newId).toBeTruthy();
			expect(newId).not.toBe(srcId);

			const newRec = await pollUntil(async () => {
				const recResp = await apiFetch(`/api/sessions/${newId}?include=archived`);
				if (!recResp.ok) return null;
				const rec = await recResp.json();
				return rec.status !== "preparing" && rec.status !== "starting" ? rec : null;
			}, { timeoutMs: 30_000, intervalMs: 200, label: "continued multi-repo session left preparing" });

			expect(["idle", "streaming"]).toContain(newRec.status);
			expect(newRec.archived).toBeFalsy();
			expect(newRec.branch).toBe(`session/${newId.slice(0, 8)}`);
			expect(newRec.branch).not.toBe(srcRec.branch);
			expect(newRec.worktreePath).toBeTruthy();
			expect(normalize(newRec.worktreePath)).not.toBe(normalize(rootPath));
			expect(normalize(newRec.worktreePath)).not.toBe(normalize(srcRec.worktreePath));
			expect(normalize(newRec.cwd)).not.toBe(normalize(rootPath));
			expect(normalize(newRec.cwd)).not.toBe(normalize(srcRec.cwd));
			expect(normalize(newRec.cwd)).not.toBe(normalize(srcRec.worktreePath));
			expect(existsSync(newRec.worktreePath), "continued worktree container should exist").toBe(true);
			expect(existsSync(join(newRec.worktreePath, "api")), "continued api worktree should exist").toBe(true);
			expect(existsSync(join(newRec.worktreePath, "web")), "continued web worktree should exist").toBe(true);
			expect(branchExists(apiRepo, newRec.branch), "continued branch should exist in api repo").toBe(true);
			expect(branchExists(webRepo, newRec.branch), "continued branch should exist in web repo").toBe(true);

			const sessionsDir = globalAgentSessionsDir();
			const projectSlugFile = findClonedJsonl(join(sessionsDir, `--${slugifyCwd(rootPath)}--`), newId);
			const continuedSlugFile = findClonedJsonl(join(sessionsDir, `--${slugifyCwd(newRec.cwd)}--`), newId);
			expect(projectSlugFile, "continued transcript must not be adopted under the non-git project-root slug").toBeNull();
			expect(continuedSlugFile, "continued transcript must be adopted under the new worktree cwd slug").toBeTruthy();

			const persistedContinued = gateway.sessionManager.getPersistedSession(newId);
			expect(normalize(persistedContinued?.agentSessionFile ?? ""), "persisted agentSessionFile should point at the adopted worktree-cwd transcript").toBe(normalize(continuedSlugFile!));

			const clonedText = readFileSync(continuedSlugFile!, "utf8");
			expect(clonedText, "cloned transcript should include source history").toContain(transcriptMarker);
			const clonedRuntimeCwdRecords = readRuntimeCwdRecords(continuedSlugFile!);
			expect(clonedRuntimeCwdRecords, "continued system cwd metadata should be rebased to the new worktree cwd").toContainEqual({ type: "system", cwd: newRec.cwd });
			expect(clonedRuntimeCwdRecords, "continued Pi-style session cwd metadata should be rebased to the new worktree cwd").toContainEqual({ type: "session", cwd: newRec.cwd });
			const clonedCwds = clonedRuntimeCwdRecords.map((record) => record.cwd);
			expect(clonedCwds, "continued runtime cwd metadata should not retain the archived source cwd").not.toContain(srcRec.cwd);
			expect(clonedCwds, "continued runtime cwd metadata should not retain the archived source worktree container").not.toContain(srcRec.worktreePath);
		} finally {
			if (newId) await apiFetch(`/api/sessions/${newId}`, { method: "DELETE" }).catch(() => {});
			if (srcId) await apiFetch(`/api/sessions/${srcId}`, { method: "DELETE" }).catch(() => {});
			if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
			// Windows can keep git/worktree files open briefly after session and project
			// deletion. Use bounded retries so cleanup does not replace the real test
			// failure with a transient EPERM/ENOTEMPTY from the temp directory removal.
			await awaitableRm(baseDir, {
				maxAttempts: 8,
				backoffMs: 250,
				onFinalFailure: (err) => {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(`[continue-archived-multi-repo] cleanup deferred for ${baseDir}: ${msg}`);
				},
			});
		}
	});
});
