/**
 * API E2E — session git-status multi-repo envelope (Gap 1).
 *
 * Asserts the session git-status handler reaches parity with the goal handler:
 *   - A multi-repo session (repoWorktrees.length > 1) returns
 *     `{ ...aggregate, aggregate, repos }` with one entry per sub-repo.
 *   - A single-repo session returns the unchanged flat shape PLUS
 *     `repos: { ".": result }` for back-compat.
 *   - A per-repo git failure is non-fatal (skip the entry, never 500).
 *
 * Determinism: like `git-status-caching.spec.ts`, we install
 * `__setGitStatusFake` so per-repo statusing returns a programmed result
 * keyed by cwd instead of spawning Git Bash (flaky under CI load). The
 * multi-repo session itself is provisioned via the real worktree pool.
 *
 * See docs/design/multi-repo-components.md and the Polyrepo Git Status design.
 */
import { test, expect } from "./in-process-harness.js";

// Pool prebuild must run so a multi-repo session can claim per-repo worktrees.
test.use({ enableWorktreePool: true });

import { apiFetch, deleteSession, defaultProjectId } from "./e2e-setup.js";
import { waitForPool, pollSessionUntil } from "./test-utils/pool-polling.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let serverModule: any;

function gitInit(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--initial-branch=master"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@bobbit.local"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
	execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
}

function okResult(overrides: Record<string, unknown> = {}) {
	return {
		branch: "session/abcd1234",
		primaryBranch: "master",
		primaryRef: "origin/master",
		isOnPrimary: false,
		hasPrimary: true,
		ahead: 0,
		behind: 0,
		aheadOfPrimary: 0,
		behindPrimary: 0,
		mergedIntoPrimary: false,
		insertionsVsPrimary: 0,
		deletionsVsPrimary: 0,
		hasUpstream: false,
		upstream: null,
		status: [],
		clean: true,
		summary: "",
		unpushed: false,
		partial: false,
		untrackedIncluded: false,
		...overrides,
	};
}

test.describe.serial("session git-status multi-repo envelope", () => {
	let root: string;
	let projectId: string;
	let sessionId: string;
	let branch: string;
	let container: string;
	let apiWt: string;
	let webWt: string;

	test.beforeAll(async () => {
		serverModule = await import("../../dist/server/server.js");
		expect(typeof serverModule.__setGitStatusFake).toBe("function");

		root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-sess-mr-"));
		gitInit(path.join(root, "api"));
		gitInit(path.join(root, "web"));

		const reg = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({
				name: `sess-mr-${Date.now()}`,
				rootPath: root,
				components: [
					{ name: "api", repo: "api" },
					{ name: "web", repo: "web" },
				],
			}),
		});
		expect(reg.status).toBe(201);
		projectId = (await reg.json()).id;

		const ready = await waitForPool(projectId, 1);
		expect(ready).toBeGreaterThan(0);

		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: path.join(root, "api"),
				projectId,
				worktree: true,
			}),
		});
		expect(sessResp.status).toBe(201);
		sessionId = (await sessResp.json()).id;

		const settled = await pollSessionUntil(
			sessionId,
			(row: any) => typeof row.branch === "string" && row.branch.startsWith("session/"),
			15_000,
		);
		branch = settled.branch;
		expect(branch).toMatch(/^session\//);
		const branchSlug = branch.replace(/\//g, "-");
		container = path.join(`${root}-wt`, branchSlug);
		apiWt = path.join(container, "api");
		webWt = path.join(container, "web");
		expect(fs.existsSync(apiWt)).toBe(true);
		expect(fs.existsSync(webWt)).toBe(true);
	});

	test.afterAll(async () => {
		serverModule?.__clearGitStatusFake();
		if (sessionId) await deleteSession(sessionId).catch(() => {});
		await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	function invalidateAll() {
		for (const p of [apiWt, webWt]) serverModule.invalidateGitStatusCache(p);
	}

	test("multi-repo session returns { repos, aggregate } with one entry per sub-repo", async () => {
		serverModule.__setGitStatusFake(async (cwd: string) => {
			const isWeb = cwd === webWt;
			return okResult({
				branch,
				status: isWeb
					? [{ file: "index.html", status: "M" }]
					: [{ file: "src/a.ts", status: "M" }, { file: "src/b.ts", status: "M" }],
				clean: false,
				aheadOfPrimary: isWeb ? 1 : 2,
				insertionsVsPrimary: isWeb ? 5 : 10,
			});
		});
		invalidateAll();

		const r = await apiFetch(`/api/sessions/${sessionId}/git-status?fetch=true`);
		expect(r.status).toBe(200);
		const b = await r.json();

		// Flat fields preserved at top level (back-compat).
		expect(typeof b.branch).toBe("string");
		expect(Array.isArray(b.status)).toBe(true);

		// Envelope present.
		expect(b.aggregate).toBeTruthy();
		expect(b.repos).toBeTruthy();
		expect(Object.keys(b.repos).sort()).toEqual(["api", "web"]);
		expect(b.repos.api.aheadOfPrimary).toBe(2);
		expect(b.repos.web.aheadOfPrimary).toBe(1);
		expect(b.repos.api.status.length).toBe(2);
		expect(b.repos.web.status.length).toBe(1);
		// No single-repo "." sentinel in multi-repo mode.
		expect(b.repos["."]).toBeUndefined();
	});

	test("true polyrepo (non-git container cwd) still emits { repos, aggregate } with synthesized summed stats", async () => {
		// In a TRUE polyrepo the session's cwd IS the branch container dir,
		// which is NOT itself a git repo (no `repo: "."` component) — so
		// `batchGitStatus(container)` returns null. Provision a session whose
		// cwd is the project root (offset "") so session.cwd === container.
		// Ensure the pool replenished a warm worktree after the first claim —
		// a cold-claim fallback would NOT populate repoWorktrees (multi-repo
		// claims are pool-only), so wait for a ready entry first.
		await waitForPool(projectId, 1);
		const polyResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: root, projectId, worktree: true }),
		});
		expect(polyResp.status).toBe(201);
		const polyId = (await polyResp.json()).id;
		try {
			const settled = await pollSessionUntil(
				polyId,
				(row: any) => typeof row.branch === "string" && row.branch.startsWith("session/") && typeof row.cwd === "string",
				15_000,
			);
			const polyBranch: string = settled.branch;
			const polyContainer = path.join(`${root}-wt`, polyBranch.replace(/\//g, "-"));
			const polyApiWt = path.join(polyContainer, "api");
			const polyWebWt = path.join(polyContainer, "web");
			// session.cwd must be the container itself (non-git), not a sub-repo.
			expect(settled.cwd).toBe(polyContainer);

			serverModule.__setGitStatusFake(async (cwd: string) => {
				if (cwd === polyApiWt) {
					return okResult({
						branch: polyBranch,
						status: [{ file: "src/a.ts", status: "M" }, { file: "src/b.ts", status: "M" }],
						clean: false,
						aheadOfPrimary: 2,
						insertionsVsPrimary: 10,
						deletionsVsPrimary: 3,
					});
				}
				if (cwd === polyWebWt) {
					return okResult({
						branch: polyBranch,
						status: [{ file: "index.html", status: "M" }],
						clean: false,
						aheadOfPrimary: 1,
						insertionsVsPrimary: 5,
						deletionsVsPrimary: 1,
					});
				}
				// Container cwd (and anything else): not a git repo.
				return null;
			});
			for (const p of [polyContainer, polyApiWt, polyWebWt]) serverModule.invalidateGitStatusCache(p);

			const r = await apiFetch(`/api/sessions/${polyId}/git-status?fetch=true`);
			expect(r.status).toBe(200);
			const b = await r.json();

			// Envelope present with both per-repo entries — no 400/500.
			expect(b.repos).toBeTruthy();
			expect(Object.keys(b.repos).sort()).toEqual(["api", "web"]);
			expect(b.repos["."]).toBeUndefined();

			// Synthesized aggregate sums numeric fields across repos.
			expect(b.aggregate).toBeTruthy();
			expect(b.aggregate.aheadOfPrimary).toBe(3);
			expect(b.aggregate.insertionsVsPrimary).toBe(15);
			expect(b.aggregate.deletionsVsPrimary).toBe(4);
			expect(b.aggregate.clean).toBe(false);
			expect(Array.isArray(b.aggregate.status)).toBe(true);
			expect(b.aggregate.status.length).toBe(0);
			// Flat fields mirror the aggregate.
			expect(b.aheadOfPrimary).toBe(3);
			expect(b.insertionsVsPrimary).toBe(15);
		} finally {
			await deleteSession(polyId).catch(() => {});
		}
	});

	test("per-repo git failure is non-fatal — no 500, broken sub-repo skipped", async () => {
		serverModule.__setGitStatusFake(async (cwd: string) => {
			if (cwd === webWt) throw new Error("fake web git failure");
			return okResult({ branch, status: [{ file: "src/a.ts", status: "M" }], clean: false });
		});
		invalidateAll();

		const r = await apiFetch(`/api/sessions/${sessionId}/git-status?fetch=true`);
		expect(r.status).toBe(200);
		const b = await r.json();
		expect(b.aggregate).toBeTruthy();
		expect(b.repos.api).toBeTruthy();
		// Broken sub-repo is skipped, not fatal.
		expect(b.repos.web).toBeUndefined();
	});

	test("single-repo session returns flat shape + repos:{'.':result}", async () => {
		// A session with no multi-repo worktrees (arbitrary cwd) must keep the
		// back-compat flat envelope.
		const cwd = path.join(os.tmpdir(), `bobbit-sess-single-${process.pid}-${Date.now()}`);
		fs.mkdirSync(cwd, { recursive: true });
		const pid = await defaultProjectId();
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd, projectId: pid }),
		});
		expect(resp.status).toBe(201);
		const singleId = (await resp.json()).id;
		const realCwd = (await (await apiFetch(`/api/sessions/${singleId}`)).json()).cwd;
		try { fs.mkdirSync(realCwd, { recursive: true }); } catch { /* exists */ }

		serverModule.__setGitStatusFake(async () => okResult({ branch: "master", isOnPrimary: true, clean: true }));
		serverModule.invalidateGitStatusCache(realCwd);

		try {
			const r = await apiFetch(`/api/sessions/${singleId}/git-status?fetch=true`);
			expect(r.status).toBe(200);
			const b = await r.json();
			// Flat fields present.
			expect(b.branch).toBe("master");
			// Back-compat envelope.
			expect(b.aggregate).toBeTruthy();
			expect(b.repos).toBeTruthy();
			expect(Object.keys(b.repos)).toEqual(["."]);
			expect(b.repos["."].branch).toBe("master");
		} finally {
			await deleteSession(singleId).catch(() => {});
		}
	});
});
