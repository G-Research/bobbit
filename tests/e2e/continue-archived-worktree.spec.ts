/**
 * Continue-Archived from a worktree-backed source — repro for the
 * "new session is read-only / no editor" bug.
 *
 * Symptom (real agent CLI): after clicking Continue from a worktree-backed
 * archived session, the new session id appears in the URL and sidebar but
 * the editor is hidden because the new session is archived/read-only.
 *
 * Root cause (suspected): server.ts L5508 pre-computes `destJsonl` via
 *
 *     formatAgentSessionFilePath(projCwd, ...)
 *
 * where `projCwd = proj.rootPath` — the **project root** cwd. For a
 * worktree-backed session the agent CLI runs with `cwd = offsetCwd`
 * (the worktree path), so the cloned `.jsonl` ends up at
 *
 *     <agentDir>/sessions/--<slugify(projCwd)>--/<ts>_<newId>.jsonl
 *
 * but the agent CLI expects its session file to live under
 *
 *     <agentDir>/sessions/--<slugify(worktreeCwd)>--/...
 *
 * The agent CLI's `switch_session` rejects (or silently rotates away from)
 * a path whose slug doesn't match its own cwd. `executeWorktreeAsync`
 * throws → `handleSetupFailure` → the new session is archived.
 *
 * This spec asserts the slug invariant on the cloned `.jsonl` at the
 * destination path the server actually used. After the fix, the cloned
 * file should live under the **worktree** slug, not the project-root slug.
 */

import { test, expect } from "./in-process-harness.js";
import { apiFetch, connectWs, agentEndPredicate } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
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

test.describe("Continue-Archived from worktree-backed source", () => {
	let repoPath: string;
	let projectId: string;

	test.beforeAll(async () => {
		const base = join(tmpdir(), `bobbit-e2e-cont-wt-${process.pid}-${Date.now()}`);
		repoPath = join(base, "repo");
		mkdirSync(repoPath, { recursive: true });
		execFileSync("git", ["init", "--initial-branch=master"], { cwd: repoPath });
		execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoPath });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: repoPath });
		execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoPath });

		const reg = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `cont-wt-project-${Date.now()}`, rootPath: repoPath }),
		});
		expect(reg.status).toBe(201);
		projectId = (await reg.json()).id;
	});

	test("cloned .jsonl is placed under the worktree slug, not the project-root slug (api)", async () => {
		// 1. Create worktree-backed source session.
		const sresp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: repoPath, worktree: true, projectId }),
		});
		expect(sresp.status).toBe(201);
		const srcId = (await sresp.json()).id;

		const srcRec = await pollUntil(async () => {
			const r = await apiFetch(`/api/sessions/${srcId}`);
			if (!r.ok) return null;
			const j = await r.json();
			return j.status === "idle" || j.status === "streaming" ? j : null;
		}, { timeoutMs: 30_000, intervalMs: 200, label: "source session reached idle" });
		expect(srcRec.worktreePath).toBeTruthy();
		expect(srcRec.cwd).toBe(srcRec.worktreePath);

		// 2. Drive a non-trivial transcript.
		await sendPromptAndWait(srcId, "WORKTREE_SOURCE_MARKER hello from worktree");

		// 3. Archive.
		const del = await apiFetch(`/api/sessions/${srcId}`, { method: "DELETE" });
		expect(del.ok).toBe(true);

		// 4. Continue.
		const cont = await apiFetch(`/api/sessions/${srcId}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(cont.status).toBe(201);
		const data = await cont.json();
		const newId: string = data.id;
		expect(newId).not.toBe(srcId);

		// 5. Wait for the worktree pipeline to resolve.
		const newRec = await pollUntil(async () => {
			const r = await apiFetch(`/api/sessions/${newId}?include=archived`);
			if (!r.ok) return null;
			const j = await r.json();
			return j.status !== "preparing" && j.status !== "starting" ? j : null;
		}, { timeoutMs: 30_000, intervalMs: 200, label: "new session left preparing" });

		// (a) Status reached idle/streaming, NOT archived.
		expect(["idle", "streaming"]).toContain(newRec.status);
		expect(newRec.archived).toBeFalsy();

		// (b) Worktree allocated.
		expect(newRec.worktreePath).toBeTruthy();
		expect(newRec.cwd).toBe(newRec.worktreePath);

		// (c) PRIMARY ASSERTION — the cloned `.jsonl` (named
		// `<ts>_${newId}.jsonl` by `formatAgentSessionFilePath`) must NOT
		// live under the project-root slug, and MUST live under the
		// worktree-cwd slug. Today the server pre-computes destJsonl from
		// `projCwd` (= proj.rootPath), so the file ends up under the
		// project-root slug — that's the bug.
		const sessionsDir = globalAgentSessionsDir();
		const projSlugDir = join(sessionsDir, `--${slugifyCwd(repoPath)}--`);
		const wtSlugDir = join(sessionsDir, `--${slugifyCwd(newRec.worktreePath)}--`);

		const clonedAtProj = findClonedJsonl(projSlugDir, newId);
		const clonedAtWt = findClonedJsonl(wtSlugDir, newId);

		// FAILS today: server clones to projSlugDir.
		expect(clonedAtProj, "cloned .jsonl must NOT live under the project-root slug").toBeNull();

		// FAILS today: nothing exists at wtSlugDir for the cloned file.
		expect(clonedAtWt, "cloned .jsonl must live under the worktree-cwd slug").toBeTruthy();
		expect(existsSync(clonedAtWt!)).toBe(true);
	});
});
