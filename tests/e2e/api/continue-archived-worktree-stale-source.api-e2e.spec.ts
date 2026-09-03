/**
 * Regression: Continue-Archived from a worktree-backed source must not depend
 * on the archived source worktree path or source branch still existing.
 */
import { test, expect } from "../in-process-harness.js";
import { apiFetch, connectWs, agentEndPredicate, registerProject } from "../e2e-setup.js";
import { awaitableRm, pollUntil } from "../test-utils/cleanup.js";
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareGitTemplate, copyGitTemplate } from "../../../tests/support/harnesses/shared/git-template.js";
import { runFixtureCommand } from "../../../tests/support/harnesses/shared/spawn-with-retry.js";

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
		// Best-effort cleanup; assertions verify the stale state.
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

async function liveProjectSessionIds(projectId: string): Promise<string[]> {
	const response = await apiFetch(`/api/sessions?projectId=${encodeURIComponent(projectId)}`);
	const text = await response.text();
	expect(response.status, text).toBe(200);
	return (JSON.parse(text).sessions as Array<{ id: string }>).map((session) => session.id).sort();
}

async function gitTopology(repoPath: string): Promise<{ branches: string; worktrees: string }> {
	const branches = await runFixtureCommand("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
		cwd: repoPath,
		attempts: 1,
	});
	const worktrees = await runFixtureCommand("git", ["worktree", "list", "--porcelain"], {
		cwd: repoPath,
		attempts: 1,
	});
	return {
		branches: branches.stdout.replace(/\r\n/g, "\n").trim(),
		worktrees: worktrees.stdout.replace(/\r\n/g, "\n").trim(),
	};
}

function directoryEntries(path: string): string[] {
	return existsSync(path) ? readdirSync(path).sort() : [];
}

/** Slugify the way `formatAgentSessionFilePath` does (no collapse, just non-alnum→`-`). */
function slugifyCwd(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function globalAgentSessionsDir(): string {
	const env = process.env.BOBBIT_AGENT_DIR;
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
		let srcId = "";
		let newId = "";
		let unexpectedContinuedId = "";
		let baseRefConfigured = false;

		try {
			await initRepo(repoPath);
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
			expect(await branchExists(repoPath, srcRec.branch), "source branch should exist before staling it").toBe(true);

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
				headers: {
					"X-Bobbit-Session-Secret": gateway.sessionManager.sessionSecretStore.getOrCreateSecret(srcId),
				},
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

			await removeWorktreeIfPresent(repoPath, srcRec.worktreePath);
			await deleteBranchIfPresent(repoPath, srcRec.branch);
			expect(existsSync(srcRec.worktreePath), "source worktree must be stale before continue").toBe(false);
			expect(await branchExists(repoPath, srcRec.branch), "source branch must be stale before continue").toBe(false);

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
			expect(await branchExists(repoPath, newRec.branch), "continued session branch should exist").toBe(true);

			// The deleted archived source must remain stale; continue must not revive it.
			expect(existsSync(srcRec.worktreePath), "continue must not recreate the deleted source worktree").toBe(false);
			expect(await branchExists(repoPath, srcRec.branch), "continue must not recreate the deleted source branch").toBe(false);

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

			// Reuse the proven destination as the archived source for the distinct
			// single-repo createWorktree failure boundary. The harness pool is disabled,
			// so the second Continue must synchronously create and roll back a worktree.
			const archiveContinued = await apiFetch(`/api/sessions/${newId}`, { method: "DELETE" });
			expect(archiveContinued.ok, await archiveContinued.clone().text()).toBe(true);

			const staleBaseRef = `stale-continue-base-${Date.now()}`;
			await runFixtureCommand("git", ["branch", staleBaseRef, "master"], { cwd: repoPath });
			const putBaseRef = await apiFetch(`/api/projects/${projectId}/config`, {
				method: "PUT",
				body: JSON.stringify({ base_ref: staleBaseRef }),
			});
			expect(putBaseRef.status, await putBaseRef.text()).toBe(200);
			baseRefConfigured = true;

			await removeWorktreeIfPresent(repoPath, newRec.worktreePath);
			await deleteBranchIfPresent(repoPath, newRec.branch);
			await deleteBranchIfPresent(repoPath, staleBaseRef);

			expect(existsSync(newRec.worktreePath), "continued worktree must be stale before the second continue").toBe(false);
			expect(await branchExists(repoPath, newRec.branch), "continued branch must be stale before the second continue").toBe(false);
			expect(await branchExists(repoPath, staleBaseRef), "configured base_ref must be stale before the second continue").toBe(false);

			const liveIdsBeforeFailure = await liveProjectSessionIds(projectId);
			const topologyBeforeFailure = await gitTopology(repoPath);
			const worktreeRoot = dirname(newRec.worktreePath);
			const worktreeEntriesBeforeFailure = directoryEntries(worktreeRoot);

			const failedContinue = await apiFetch(`/api/sessions/${newId}/continue`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			const failedBody = await failedContinue.text();
			try {
				unexpectedContinuedId = JSON.parse(failedBody)?.id ?? "";
			} catch {
				// Non-JSON error bodies are covered by the assertions below.
			}

			expect(
				failedContinue.status,
				`continue unexpectedly returned 201 before fresh worktree/base_ref setup failure was surfaced; body=${failedBody}`,
			).not.toBe(201);
			expect(failedBody, "error should identify the stale current project base_ref").toContain(staleBaseRef);
			expect(failedBody, "error should map the current base_ref/worktree failure").toMatch(/base[_ -]?ref|worktree|ref .*not found|does not exist/i);
			const unescapedBody = failedBody.replace(/\\\\/g, "\\");
			expect(unescapedBody, "error must not blame the archived continued worktree").not.toContain(newRec.worktreePath);
			expect(failedBody, "error must not blame the archived continued branch").not.toContain(newRec.branch);
			expect(await liveProjectSessionIds(projectId), "failed continue must not leave a live destination session").toEqual(liveIdsBeforeFailure);
			if (unexpectedContinuedId) {
				expect(gateway.sessionManager.getSession(unexpectedContinuedId), "failed continue response must not identify a live destination").toBeUndefined();
				expect(gateway.sessionManager.getPersistedSession(unexpectedContinuedId), "failed continue response must not identify a persisted destination").toBeUndefined();
			}
			expect(await gitTopology(repoPath), "failed continue must not leak a worktree registration or branch").toEqual(topologyBeforeFailure);
			expect(directoryEntries(worktreeRoot), "failed continue must not leak a worktree directory").toEqual(worktreeEntriesBeforeFailure);
			expect(existsSync(newRec.worktreePath), "failed continue must not recreate the archived worktree").toBe(false);
			expect(await branchExists(repoPath, newRec.branch), "failed continue must not recreate the archived branch").toBe(false);
			expect(await branchExists(repoPath, staleBaseRef), "failed continue must not recreate the stale base_ref").toBe(false);

			const resetBaseRef = await apiFetch(`/api/projects/${projectId}/config`, {
				method: "PUT",
				body: JSON.stringify({ base_ref: "" }),
			});
			expect(resetBaseRef.status, await resetBaseRef.text()).toBe(200);
			baseRefConfigured = false;
		} finally {
			if (unexpectedContinuedId) await apiFetch(`/api/sessions/${unexpectedContinuedId}`, { method: "DELETE" }).catch(() => {});
			if (newId) await apiFetch(`/api/sessions/${newId}`, { method: "DELETE" }).catch(() => {});
			if (srcId) await apiFetch(`/api/sessions/${srcId}`, { method: "DELETE" }).catch(() => {});
			if (projectId && baseRefConfigured) {
				await apiFetch(`/api/projects/${projectId}/config`, {
					method: "PUT",
					body: JSON.stringify({ base_ref: "" }),
				}).catch(() => {});
			}
			if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
			// Windows may retain worktree handles briefly after rollback. Keep cleanup
			// bounded so a transient EPERM cannot replace the assertion failure.
			await awaitableRm(baseDir, {
				maxAttempts: 8,
				backoffMs: 250,
				onFinalFailure: (err) => {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(`[continue-archived-worktree-stale-source] cleanup deferred for ${baseDir}: ${msg}`);
				},
			});
		}
	});
});
