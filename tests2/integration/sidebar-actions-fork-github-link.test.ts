// Ported from tests/e2e/sidebar-actions-server.spec.ts (v2-integration tier).
//
// core/sidebar-actions-server.test.ts covers only the pure GitHub remote
// helpers (buildGithubBranchUrl/parseGithubRemoteUrl). This file ports the
// uncovered REST behaviours the legacy e2e exercised:
//   - GET /api/goals/:id/github-link → PR / branch-fallback / unavailable states
//   - POST /api/sessions/:id/fork worktree choice (newWorktree true/false) and
//     the newWorktree=true rebase of cloned runtime-cwd metadata off a stale
//     (deleted) source worktree.
//
// Uses the fork-scoped gateway fixture. The gateway boots with skipWorktreePool
// (matching the legacy test.use({ enableWorktreePool: false }) intent), so
// fork worktree allocation is deterministic (no warm pool). Real git worktrees
// are allocated via the fenced CommandRunner (local git only — never a remote).
import { test, expect } from "./_e2e/in-process-harness.js";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
	apiFetch,
	createGoal,
	defaultProjectId,
	deleteGoal,
	deleteSession,
	gitCwd,
	nonGitCwd,
} from "./_e2e/e2e-setup.js";

async function pollUntil<T>(
	fn: () => Promise<T> | T,
	opts: { timeoutMs: number; intervalMs: number; label: string },
): Promise<T> {
	const start = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - start > opts.timeoutMs) throw new Error(`pollUntil timed out: ${opts.label}`);
		await new Promise((r) => setTimeout(r, opts.intervalMs));
	}
}

// Fork clones the source transcript, so seed the already-persisted mock-agent
// `.jsonl` directly instead of driving a prompt turn. The fork endpoint only
// needs a non-empty production-shaped transcript, and prompt/WS fidelity is
// covered in cheaper, dedicated suites.
async function seedSessionTranscript(gateway: any, sessionId: string, entries: unknown[]): Promise<string> {
	const jsonlPath = await pollUntil<string>(() => {
		const file = gateway.sessionManager.getPersistedSession(sessionId)?.agentSessionFile;
		return file || "";
	}, { timeoutMs: 10_000, intervalMs: 100, label: `session ${sessionId} jsonl path persisted` });
	mkdirSync(dirname(jsonlPath), { recursive: true });
	appendFileSync(jsonlPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return jsonlPath;
}

function transcriptMessage(id: string, text: string): unknown {
	return { type: "message", id, message: { role: "user", content: [{ type: "text", text }] } };
}

async function getPersisted(id: string): Promise<any> {
	const r = await apiFetch(`/api/sessions/${id}?include=archived`);
	if (!r.ok) return null;
	return r.json();
}

async function waitUntilReady(id: string): Promise<any> {
	return pollUntil(async () => {
		const rec = await getPersisted(id);
		return rec && rec.status !== "preparing" && rec.status !== "starting" ? rec : null;
	}, { timeoutMs: 30_000, intervalMs: 150, label: `session ${id} left preparing` });
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
	try { execFileSync("git", ["branch", "-D", branch], { cwd: repoPath, stdio: "pipe" }); } catch { /* best-effort */ }
}

function removeWorktreeIfPresent(repoPath: string, worktreePath: string): void {
	try { execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath, stdio: "pipe" }); } catch { /* */ }
	rmSync(worktreePath, { recursive: true, force: true });
	try { execFileSync("git", ["worktree", "prune"], { cwd: repoPath, stdio: "pipe" }); } catch { /* */ }
}

/** Slugify the way `formatAgentSessionFilePath` does (no collapse, just non-alnum→`-`). */
function slugifyCwd(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function globalAgentSessionsDir(): string {
	const base = process.env.BOBBIT_AGENT_DIR ?? join(process.env.HOME ?? "", ".bobbit", "agent");
	return join(base, "sessions");
}

/** Find a `.jsonl` file in a sessions slug-dir whose name contains `sessionId`. */
function findClonedJsonl(slugDir: string, sessionId: string): string | null {
	if (!existsSync(slugDir)) return null;
	try {
		const match = readdirSync(slugDir).find((f) => f.endsWith(`_${sessionId}.jsonl`));
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
		} catch { /* ignore malformed transcript lines */ }
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

function appendOldCwdMessageContentSentinels(jsonlPath: string, cwd: string, marker: string): { userLine: string; assistantLine: string } {
	const userLine = JSON.stringify({
		type: "message",
		id: `${marker}-user`,
		message: { role: "user", content: [{ type: "text", text: `${marker} user mentions old cwd ${cwd}` }] },
	});
	const assistantLine = JSON.stringify({
		type: "message",
		id: `${marker}-assistant`,
		message: { role: "assistant", content: [{ type: "text", text: `${marker} assistant mentions old cwd ${cwd}` }] },
	});
	appendFileSync(jsonlPath, `${userLine}\n${assistantLine}\n`);
	return { userLine, assistantLine };
}

test.describe.serial("sidebar actions server endpoints", () => {
	test("GET /api/goals/:id/github-link returns PR, branch fallback, and unavailable states", async ({ gateway }) => {
		const linkGoal = await createGoal({ title: `sidebar link ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		const noWorktreeGoal = await createGoal({ title: `sidebar no worktree ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		try {
			const repo = gitCwd();
			try { execFileSync("git", ["remote", "remove", "origin"], { cwd: repo, stdio: "ignore" }); } catch { /* ignore */ }
			execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widget.git"], { cwd: repo, stdio: "pipe" });
			gateway.sessionManager.getGoalStoreForProject(linkGoal.projectId).update(linkGoal.id, {
				branch: "feature/sidebar-pr-cache",
				repoPath: repo,
				cwd: repo,
				worktreePath: repo,
			});
			gateway.sessionManager.prStatusStore.set(linkGoal.id, { state: "OPEN", url: "https://github.com/acme/widget/pull/123" });
			const prResp = await apiFetch(`/api/goals/${linkGoal.id}/github-link`);
			expect(prResp.status).toBe(200);
			expect(await prResp.json()).toMatchObject({ available: true, kind: "pr", url: "https://github.com/acme/widget/pull/123" });

			const noWorktreeResp = await apiFetch(`/api/goals/${noWorktreeGoal.id}/github-link`);
			expect(noWorktreeResp.status).toBe(200);
			expect(await noWorktreeResp.json()).toMatchObject({ available: false, reason: "no-worktree" });

			const missingResp = await apiFetch(`/api/goals/does-not-exist/github-link`);
			expect(missingResp.status).toBe(200);
			expect(await missingResp.json()).toMatchObject({ available: false, reason: "goal-not-found" });

			const branch = "feature/sidebar-actions";
			gateway.sessionManager.prStatusStore.remove(linkGoal.id);
			gateway.sessionManager.getGoalStoreForProject(linkGoal.projectId).update(linkGoal.id, { branch, repoPath: repo, cwd: repo, worktreePath: repo });
			const branchResp = await apiFetch(`/api/goals/${linkGoal.id}/github-link`);
			expect(branchResp.status).toBe(200);
			expect(await branchResp.json()).toMatchObject({
				available: true,
				kind: "branch",
				url: "https://github.com/acme/widget/tree/feature%2Fsidebar-actions",
			});
		} finally {
			await deleteGoal(linkGoal.id);
			await deleteGoal(noWorktreeGoal.id);
		}
	});
});

// Fork's worktree choice needs a real git-repo-backed project so newWorktree=true
// can allocate a distinct worktree/branch and newWorktree=false can reuse the
// source session's worktree path.
test.describe.serial("fork worktree choice", () => {
	let baseDir: string;
	let repoPath: string;
	let projectId: string;

	test.beforeAll(async () => {
		baseDir = realpathSync(tmpdir()) + `/bobbit-v2-fork-wt-${process.pid}-${Date.now()}`;
		repoPath = join(baseDir, "repo");
		mkdirSync(repoPath, { recursive: true });
		execFileSync("git", ["init", "--initial-branch=master"], { cwd: repoPath });
		execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoPath });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: repoPath });
		execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoPath });

		const reg = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `fork-wt-project-${Date.now()}`, rootPath: repoPath }),
		});
		expect(reg.status).toBe(201);
		projectId = (await reg.json()).id;
	});

	test.afterAll(async () => {
		if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		if (baseDir) rmSync(baseDir, { recursive: true, force: true });
	});

	test("newWorktree=true allocates a distinct worktree/branch; newWorktree=false reuses the source worktree", async ({ gateway }) => {
		const created: string[] = [];
		const defaultId = await defaultProjectId();
		const staleBaseRef = `stale-continue-base-cross-project-${Date.now()}`;
		if (defaultId) {
			const poison = await apiFetch(`/api/projects/${defaultId}/config`, {
				method: "PUT",
				body: JSON.stringify({ base_ref: staleBaseRef }),
			});
			expect(poison.status, await poison.text()).toBe(200);
		}
		const repoBaseRef = await apiFetch(`/api/projects/${projectId}/config`, {
			method: "PUT",
			body: JSON.stringify({ base_ref: "master" }),
		});
		expect(repoBaseRef.status, await repoBaseRef.text()).toBe(200);

		const sresp = await apiFetch("/api/sessions", {
			method: "POST",
			// Deliberately omit projectId: the compat injector must select the project
			// containing cwd, not leak the default project's stale base_ref into this repo.
			body: JSON.stringify({ cwd: repoPath, worktree: true }),
		});
		expect(sresp.status, await sresp.clone().text()).toBe(201);
		const sourceId = (await sresp.json()).id;
		created.push(sourceId);
		try {
			const srcRec = await waitUntilReady(sourceId);
			expect(srcRec.projectId).toBe(projectId);
			expect(srcRec.worktreePath).toBeTruthy();
			expect(srcRec.cwd).toBe(srcRec.worktreePath);
			await seedSessionTranscript(gateway, sourceId, [
				transcriptMessage(`fork-wt-${sourceId}`, "FORK_WT_MARKER hello from worktree"),
			]);

			// newWorktree=true → fresh worktree + branch, distinct from the source.
			const trueResp = await apiFetch(`/api/sessions/${sourceId}/fork`, {
				method: "POST",
				body: JSON.stringify({ newWorktree: true }),
			});
			expect(trueResp.status).toBe(201);
			const trueBody = await trueResp.json();
			created.push(trueBody.id);
			expect(trueBody.title).toMatch(/^Fork: /);
			expect(trueBody.projectId).toBe(projectId);

			const freshRec = await waitUntilReady(trueBody.id);
			expect(freshRec.projectId).toBe(projectId);
			expect(freshRec.archived).toBeFalsy();
			expect(freshRec.worktreePath).toBeTruthy();
			expect(freshRec.worktreePath).not.toBe(srcRec.worktreePath);
			expect(freshRec.cwd).toBe(freshRec.worktreePath);
			expect(freshRec.branch).toMatch(/^session\//);
			expect(freshRec.branch).not.toBe(srcRec.branch);
			const freshPs = gateway.sessionManager.getPersistedSession(trueBody.id);
			expect(freshPs?.agentSessionFile).toBeTruthy();
			expect(existsSync(freshPs!.agentSessionFile!)).toBe(true);

			// newWorktree=false → reuse the source session's existing worktree path,
			// with no new worktree registered on the fork (shared tree).
			const reuseResp = await apiFetch(`/api/sessions/${sourceId}/fork`, {
				method: "POST",
				body: JSON.stringify({ newWorktree: false }),
			});
			expect(reuseResp.status).toBe(201);
			const reuseBody = await reuseResp.json();
			created.push(reuseBody.id);
			expect(reuseBody.projectId).toBe(projectId);
			expect(reuseBody.cwd).toBe(srcRec.worktreePath);

			const reuseRec = await waitUntilReady(reuseBody.id);
			expect(reuseRec.projectId).toBe(projectId);
			expect(reuseRec.cwd).toBe(srcRec.worktreePath);
			expect(reuseRec.worktreePath).toBeFalsy();
			const reusePs = gateway.sessionManager.getPersistedSession(reuseBody.id);
			expect(reusePs?.agentSessionFile).toBeTruthy();
			expect(existsSync(reusePs!.agentSessionFile!)).toBe(true);
		} finally {
			for (const id of created) await deleteSession(id);
			if (defaultId) {
				await apiFetch(`/api/projects/${defaultId}/config`, {
					method: "PUT",
					body: JSON.stringify({ base_ref: "" }),
				}).catch(() => {});
			}
		}
	});

	test("newWorktree=true rebases cloned runtime cwd metadata off a stale source worktree", async ({ gateway }) => {
		const created: string[] = [];
		let sourceId: string | undefined;
		let forkId: string | undefined;

		const repoBaseRef = await apiFetch(`/api/projects/${projectId}/config`, {
			method: "PUT",
			body: JSON.stringify({ base_ref: "master" }),
		});
		expect(repoBaseRef.status, await repoBaseRef.text()).toBe(200);

		const sresp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: repoPath, worktree: true, projectId }),
		});
		expect(sresp.status, await sresp.clone().text()).toBe(201);
		sourceId = (await sresp.json()).id;
		created.push(sourceId!);

		try {
			const srcRec = await waitUntilReady(sourceId!);
			expect(srcRec.projectId).toBe(projectId);
			expect(srcRec.worktreePath).toBeTruthy();
			expect(srcRec.cwd).toBe(srcRec.worktreePath);
			expect(srcRec.branch).toBe(`session/${sourceId!.slice(0, 8)}`);
			expect(existsSync(srcRec.worktreePath), "source worktree should exist before staling it").toBe(true);
			expect(branchExists(repoPath, srcRec.branch), "source branch should exist before staling it").toBe(true);

			const transcriptMarker = `FORK_STALE_CWD_TRANSCRIPT_${Date.now()}`;
			const sourceJsonl = await seedSessionTranscript(gateway, sourceId!, [
				transcriptMessage(`${transcriptMarker}-user`, `${transcriptMarker} hello from stale fork source`),
			]);
			ensureStaleRuntimeCwdMetadata(sourceJsonl, srcRec.worktreePath, sourceId!);
			const contentMarker = `FORK_STALE_CWD_CONTENT_${Date.now()}`;
			const { userLine, assistantLine } = appendOldCwdMessageContentSentinels(sourceJsonl, srcRec.worktreePath, contentMarker);
			expect(readRuntimeCwdRecords(sourceJsonl), "source transcript should contain stale system cwd metadata before fork").toContainEqual({ type: "system", cwd: srcRec.worktreePath });
			expect(readRuntimeCwdRecords(sourceJsonl), "source transcript should contain stale Pi-style session cwd metadata before fork").toContainEqual({ type: "session", cwd: srcRec.worktreePath });

			const forkResp = await apiFetch(`/api/sessions/${sourceId}/fork`, {
				method: "POST",
				body: JSON.stringify({ newWorktree: true }),
			});
			expect(forkResp.status, await forkResp.clone().text()).toBe(201);
			forkId = (await forkResp.json()).id;
			created.push(forkId!);

			const forkRec = await waitUntilReady(forkId!);
			expect(forkRec.projectId).toBe(projectId);
			expect(forkRec.archived).toBeFalsy();
			expect(forkRec.branch).toBe(`session/${forkId!.slice(0, 8)}`);
			expect(forkRec.branch).not.toBe(srcRec.branch);
			expect(forkRec.worktreePath).toBeTruthy();
			expect(forkRec.worktreePath).not.toBe(srcRec.worktreePath);
			expect(forkRec.cwd).toBe(forkRec.worktreePath);
			expect(existsSync(forkRec.worktreePath), "fork worktree should exist").toBe(true);
			expect(branchExists(repoPath, forkRec.branch), "fork branch should exist").toBe(true);

			await deleteSession(sourceId!);
			removeWorktreeIfPresent(repoPath, srcRec.worktreePath);
			deleteBranchIfPresent(repoPath, srcRec.branch);
			expect(existsSync(srcRec.worktreePath), "source worktree must be deleted before inspecting fork clone").toBe(false);
			expect(branchExists(repoPath, srcRec.branch), "source branch must be deleted before inspecting fork clone").toBe(false);

			const sessionsDir = globalAgentSessionsDir();
			const sourceSlugDir = join(sessionsDir, `--${slugifyCwd(srcRec.worktreePath)}--`);
			const forkWtSlugDir = join(sessionsDir, `--${slugifyCwd(forkRec.worktreePath)}--`);
			const clonedAtSource = findClonedJsonl(sourceSlugDir, forkId!);
			const clonedAtForkWt = findClonedJsonl(forkWtSlugDir, forkId!);

			expect(clonedAtSource, "fork cloned .jsonl must not live under the deleted source worktree slug").toBeNull();
			expect(clonedAtForkWt, "fork cloned .jsonl must live under the fork worktree-cwd slug").toBeTruthy();
			expect(readFileSync(clonedAtForkWt!, "utf8"), "fork cloned transcript should include the source prompt marker").toContain(transcriptMarker);
			const clonedText = readFileSync(clonedAtForkWt!, "utf8");
			expect(clonedText, "ordinary user message content mentioning the old cwd must remain byte-identical").toContain(userLine);
			expect(clonedText, "ordinary assistant message content mentioning the old cwd must remain byte-identical").toContain(assistantLine);

			const clonedRuntimeCwdRecords = readRuntimeCwdRecords(clonedAtForkWt!);
			expect(readRuntimeCwds(clonedAtForkWt!), "fork runtime cwd metadata should be rebased off the deleted source worktree").not.toContain(srcRec.worktreePath);
			expect(clonedRuntimeCwdRecords, "fork system cwd metadata should reference the fresh fork worktree cwd").toContainEqual({ type: "system", cwd: forkRec.worktreePath });
			expect(clonedRuntimeCwdRecords, "fork Pi-style session cwd metadata should reference the fresh fork worktree cwd").toContainEqual({ type: "session", cwd: forkRec.worktreePath });
		} finally {
			for (const id of created.reverse()) await deleteSession(id);
		}
	});
});
