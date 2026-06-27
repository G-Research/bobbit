import { test, expect } from "./in-process-harness.js";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	agentEndPredicate,
	apiFetch,
	connectWs,
	createGoal,
	createSession,
	defaultProjectId,
	deleteGoal,
	deleteSession,
	gitCwd,
	nonGitCwd,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

async function json(resp: Response): Promise<any> {
	return resp.json().catch(() => ({}));
}

// Fork clones the source transcript, so the source needs a non-empty `.jsonl`
// before forking. Driving one prompt to completion populates `agentSessionFile`.
async function sendPromptAndWait(id: string, text: string): Promise<void> {
	const ws = await connectWs(id);
	try {
		ws.send({ type: "prompt", text });
		await ws.waitFor(agentEndPredicate(), 10_000);
	} finally {
		ws.close();
	}
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

// Fork's worktree-choice test allocates a real worktree; disable the warm pool
// file-wide for deterministic branch/path assertions. Must be top-level —
// Playwright forbids `test.use({ enableWorktreePool })` inside a describe.
test.use({ enableWorktreePool: false });

test.describe.configure({ mode: "serial" });

test.describe("sidebar actions server endpoints", () => {
	test("POST /api/sessions/:id/fork clones the source transcript, preserves metadata, and rejects unsupported sources", async ({ gateway }) => {
		const sourceId = await createSession();
		let forkId: string | undefined;
		try {
			await apiFetch(`/api/sessions/${sourceId}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "Source session" }),
			});
			gateway.sessionManager.persistSessionModel(sourceId, "openai", "gpt-4.1");
			await sendPromptAndWait(sourceId, "FORK_SOURCE_MARKER hello from the original session");

			const resp = await apiFetch(`/api/sessions/${sourceId}/fork`, {
				method: "POST",
				body: JSON.stringify({ newWorktree: false }),
			});
			expect(resp.status).toBe(201);
			const body = await resp.json();
			forkId = body.id;
			expect(body.id).toBeTruthy();
			expect(body.id).not.toBe(sourceId);
			expect(body.cwd).toBeTruthy();
			// Finding 1: a non-worktree source forked with newWorktree=false keeps its
			// own cwd instead of landing in the project root.
			const srcPs = gateway.sessionManager.getPersistedSession(sourceId);
			expect(srcPs?.worktreePath).toBeFalsy();
			expect(srcPs?.cwd).toBeTruthy();
			expect(body.cwd).toBe(srcPs!.cwd);
			expect(body.status).toBeTruthy();
			expect(body.projectId).toBe(await defaultProjectId());
			expect(body.title).toBe("Fork: Source session");

			const dup = await waitUntilReady(forkId!);
			expect(dup.title).toBe("Fork: Source session");
			expect(dup.modelProvider).toBe("openai");
			expect(dup.modelId).toBe("gpt-4.1");
			// The fork rehydrates from the cloned transcript: reaching a non-preparing
			// status above means `switch_session` adopted the clone, and the session
			// now owns a real `.jsonl` on disk.
			const forkPs = gateway.sessionManager.getPersistedSession(forkId!);
			expect(forkPs?.agentSessionFile).toBeTruthy();
			expect(existsSync(forkPs!.agentSessionFile!)).toBe(true);

			const childId = await createSession();
			try {
				await apiFetch(`/api/sessions/${childId}`, {
					method: "PATCH",
					body: JSON.stringify({ delegateOf: sourceId }),
				});
				const rejected = await apiFetch(`/api/sessions/${childId}/fork`, { method: "POST", body: "{}" });
				expect(rejected.status).toBe(422);
				expect((await json(rejected)).error).toContain("delegate");
			} finally {
				await deleteSession(childId);
			}

			const archivedId = await createSession();
			await deleteSession(archivedId);
			const archivedRejected = await apiFetch(`/api/sessions/${archivedId}/fork`, { method: "POST", body: "{}" });
			expect(archivedRejected.status).toBe(422);
			expect((await json(archivedRejected)).error).toContain("archived");

			// Finding 2: non-interactive sources are rejected, matching the client
			// `canForkSidebarSession` guard that hides Fork for `session.nonInteractive`.
			const nonInteractiveId = await createSession();
			try {
				gateway.sessionManager.getSessionStore(await defaultProjectId()).update(nonInteractiveId, { nonInteractive: true });
				const niRejected = await apiFetch(`/api/sessions/${nonInteractiveId}/fork`, { method: "POST", body: "{}" });
				expect(niRejected.status).toBe(422);
				expect((await json(niRejected)).error).toContain("non-interactive");
			} finally {
				await deleteSession(nonInteractiveId);
			}
		} finally {
			if (forkId) await deleteSession(forkId);
			await deleteSession(sourceId);
		}
	});

	test("POST /api/sessions/:id/fork preserves persisted goal/task context", async ({ gateway }) => {
		const goal = await createGoal({ title: `sidebar task fork ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		let sourceId: string | undefined;
		let forkId: string | undefined;
		try {
			const taskResp = await apiFetch(`/api/goals/${goal.id}/tasks`, {
				method: "POST",
				body: JSON.stringify({ title: "Fork task context", type: "implementation" }),
			});
			expect(taskResp.status).toBe(201);
			const task = await taskResp.json();

			sourceId = await createSession({ goalId: goal.id, projectId: goal.projectId as string });
			const assignResp = await apiFetch(`/api/tasks/${task.id}/assign`, {
				method: "POST",
				body: JSON.stringify({ sessionId: sourceId }),
			});
			expect(assignResp.status).toBe(200);

			gateway.sessionManager.getSessionStore(goal.projectId as string).update(sourceId, { taskId: task.id });
			expect(gateway.sessionManager.getPersistedSession(sourceId)?.taskId).toBe(task.id);
			await sendPromptAndWait(sourceId, "FORK_GOAL_MARKER acknowledge please");

			const resp = await apiFetch(`/api/sessions/${sourceId}/fork`, {
				method: "POST",
				body: JSON.stringify({ newWorktree: false }),
			});
			expect(resp.status).toBe(201);
			const respBody = await resp.json();
			forkId = respBody.id;
			expect(respBody.goalId).toBe(goal.id);

			const dup = await waitUntilReady(forkId!);
			expect(dup.goalId).toBe(goal.id);
			expect(dup.taskId).toBe(task.id);
			const forkPs = gateway.sessionManager.getPersistedSession(forkId!);
			expect(forkPs?.taskId).toBe(task.id);
			expect(forkPs?.agentSessionFile).toBeTruthy();
			expect(existsSync(forkPs!.agentSessionFile!)).toBe(true);
		} finally {
			if (forkId) await deleteSession(forkId);
			if (sourceId) await deleteSession(sourceId);
			await deleteGoal(goal.id);
		}
	});

	test("GET /api/goals/:id/github-link returns PR, branch fallback, and unavailable states", async ({ gateway }) => {
		const prGoal = await createGoal({ title: `sidebar pr ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		const noBranchGoal = await createGoal({ title: `sidebar no branch ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		const branchGoal = await createGoal({ title: `sidebar branch ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		try {
			gateway.sessionManager.prStatusStore.set(prGoal.id, { state: "OPEN", url: "https://github.com/acme/widget/pull/123" });
			const prResp = await apiFetch(`/api/goals/${prGoal.id}/github-link`);
			expect(prResp.status).toBe(200);
			expect(await prResp.json()).toMatchObject({ available: true, kind: "pr", url: "https://github.com/acme/widget/pull/123" });

			const noBranchResp = await apiFetch(`/api/goals/${noBranchGoal.id}/github-link`);
			expect(noBranchResp.status).toBe(200);
			expect(await noBranchResp.json()).toMatchObject({ available: false, reason: "no-branch" });

			const missingResp = await apiFetch(`/api/goals/does-not-exist/github-link`);
			expect(missingResp.status).toBe(200);
			expect(await missingResp.json()).toMatchObject({ available: false, reason: "goal-not-found" });

			const repo = gitCwd();
			try { execFileSync("git", ["remote", "remove", "origin"], { cwd: repo, stdio: "ignore" }); } catch { /* ignore */ }
			execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widget.git"], { cwd: repo, stdio: "pipe" });
			const branch = "feature/sidebar-actions";
			gateway.sessionManager.getGoalStoreForProject(branchGoal.projectId).update(branchGoal.id, { branch, repoPath: repo, cwd: repo });
			const branchResp = await apiFetch(`/api/goals/${branchGoal.id}/github-link`);
			expect(branchResp.status).toBe(200);
			expect(await branchResp.json()).toMatchObject({
				available: true,
				kind: "branch",
				url: "https://github.com/acme/widget/tree/feature%2Fsidebar-actions",
			});
		} finally {
			await deleteGoal(prGoal.id);
			await deleteGoal(noBranchGoal.id);
			await deleteGoal(branchGoal.id);
		}
	});
});

// Fork's worktree choice needs a real git-repo-backed project so newWorktree=true
// can allocate a distinct worktree/branch and newWorktree=false can reuse the
// source session's worktree path.
test.describe("fork worktree choice", () => {
	let baseDir: string;
	let repoPath: string;
	let projectId: string;

	test.beforeAll(async () => {
		baseDir = realpathSync(tmpdir()) + `/bobbit-e2e-fork-wt-${process.pid}-${Date.now()}`;
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
		if (projectId) {
			await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		}
		if (baseDir) {
			rmSync(baseDir, { recursive: true, force: true });
		}
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
			// Deliberately omit projectId: the E2E injector must select the project
			// containing cwd, not leak the default project's stale base_ref into this repo.
			// The repo project has a valid base_ref=master; the default project has a
			// deliberately stale base_ref, so successful worktree setup proves the
			// repo project's config was used.
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
			await sendPromptAndWait(sourceId, "FORK_WT_MARKER hello from worktree");

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
			await sendPromptAndWait(sourceId!, `${transcriptMarker} hello from stale fork source`);

			const sourceJsonl = await pollUntil<string>(() => {
				const file = gateway.sessionManager.getPersistedSession(sourceId!)?.agentSessionFile;
				return file && existsSync(file) ? file : "";
			}, {
				timeoutMs: 10_000,
				intervalMs: 100,
				label: "source session jsonl exists",
			});
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
