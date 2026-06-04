/**
 * API E2E for GET /api/file-mentions (BLOCKER-B): a session-bound enumeration
 * must target the session's HOST worktree (here, the session cwd), NOT the
 * project root. A file that exists only under the session tree must be found
 * when `sessionId` is supplied, and must NOT be found when enumerating an
 * unrelated cwd without a session.
 */
import { test, expect } from "./in-process-harness.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSession, deleteSession, apiFetch } from "./e2e-setup.js";

function freshDir(label: string): string {
	const dir = path.join(
		os.tmpdir(),
		`bobbit-file-mentions-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

test.setTimeout(30_000);

test.describe.serial("GET /api/file-mentions", () => {
	let sessionId = "";
	let sessionCwd: string;
	let otherCwd: string;

	test.beforeAll(() => {
		sessionCwd = freshDir("session");
		// A file that exists ONLY under the session tree (not the project root).
		fs.writeFileSync(path.join(sessionCwd, "only-in-worktree.txt"), "hello", "utf-8");
		// Also write a gitignored-style file to prove untracked files are listed.
		fs.writeFileSync(path.join(sessionCwd, "untracked.secret.env"), "X=1", "utf-8");
		otherCwd = freshDir("other"); // empty — used to prove the contrast
	});

	test.beforeEach(async () => {
		sessionId = await createSession({ cwd: sessionCwd });
	});
	test.afterEach(async () => {
		if (sessionId) { await deleteSession(sessionId); sessionId = ""; }
	});

	test("sessionId binds enumeration to the session tree (finds worktree-only file)", async () => {
		const resp = await apiFetch(`/api/file-mentions?sessionId=${sessionId}&q=only-in-worktree`);
		expect(resp.ok).toBe(true);
		const data = await resp.json() as { files: Array<{ path: string }> };
		const paths = data.files.map((f) => f.path);
		expect(paths).toContain("only-in-worktree.txt");
	});

	test("untracked/gitignored files are included", async () => {
		const resp = await apiFetch(`/api/file-mentions?sessionId=${sessionId}&q=untracked`);
		const data = await resp.json() as { files: Array<{ path: string }> };
		expect(data.files.map((f) => f.path)).toContain("untracked.secret.env");
	});

	test("without sessionId, an unrelated cwd does NOT see the session file", async () => {
		const resp = await apiFetch(`/api/file-mentions?cwd=${encodeURIComponent(otherCwd)}&q=only-in-worktree`);
		expect(resp.ok).toBe(true);
		const data = await resp.json() as { files: Array<{ path: string }> };
		expect(data.files.map((f) => f.path)).not.toContain("only-in-worktree.txt");
	});
});
