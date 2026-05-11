/**
 * Unit tests for runPreflight() — see docs/design/robust-add-project.md.
 * Uses file:// fixtures via tmp dirs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runPreflight, type PreflightContext } from "../src/server/agent/project-preflight.js";

function mkTmp(prefix = "bobbit-preflight-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function emptyCtx(overrides: Partial<PreflightContext> = {}): PreflightContext {
	return {
		registeredProjects: [],
		gatewayProjectRoot: path.join(os.tmpdir(), "fake-gateway-root-" + Math.random()),
		...overrides,
	};
}

function find(report: ReturnType<typeof runPreflight>, id: string) {
	const c = report.checks.find(c => c.id === id);
	if (!c) throw new Error(`check ${id} not in report`);
	return c;
}

test("path.absolute fails on relative path", () => {
	const report = runPreflight("relative/path", emptyCtx());
	assert.equal(find(report, "path.absolute").level, "fail");
	assert.ok(report.hasFail);
});

test("path.exists fails on missing directory", () => {
	const tmp = mkTmp();
	try {
		const missing = path.join(tmp, "does-not-exist");
		const report = runPreflight(missing, emptyCtx());
		assert.equal(find(report, "path.exists").level, "fail");
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("path.exists fails when path is a file, not a directory", () => {
	const tmp = mkTmp();
	try {
		const file = path.join(tmp, "a.txt");
		fs.writeFileSync(file, "x");
		const report = runPreflight(file, emptyCtx());
		assert.equal(find(report, "path.exists").level, "fail");
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("happy path: empty tmp dir → no failures", () => {
	const tmp = mkTmp();
	try {
		const report = runPreflight(tmp, emptyCtx());
		assert.equal(report.hasFail, false, JSON.stringify(report.checks.filter(c => c.level === "fail"), null, 2));
		assert.equal(find(report, "path.exists").level, "pass");
		assert.equal(find(report, "path.readable").level, "pass");
		assert.equal(find(report, "path.writable").level, "pass");
		assert.equal(find(report, "bobbit.existing").level, "pass");
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("path.symlink warns when path resolves through a symlink", (t) => {
	const tmp = mkTmp();
	try {
		const target = path.join(tmp, "canonical");
		const link = path.join(tmp, "via-link");
		fs.mkdirSync(target);
		try { fs.symlinkSync(target, link, "dir"); }
		catch { t.skip("symlink creation not permitted"); return; }
		const report = runPreflight(link, emptyCtx());
		assert.equal(find(report, "path.symlink").level, "warn");
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("path.nested-in-project fails when inside another registered project", () => {
	const tmp = mkTmp();
	try {
		const parent = path.join(tmp, "parent");
		const child = path.join(parent, "nested");
		fs.mkdirSync(child, { recursive: true });
		const report = runPreflight(child, emptyCtx({
			registeredProjects: [{
				id: "p1", name: "Parent", rootPath: parent, hidden: false,
			} as any],
		}));
		const c = find(report, "path.nested-in-project");
		assert.equal(c.level, "fail");
		assert.match(c.detail, /Parent/);
		assert.ok(report.hasFail);
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("path.nested-in-project: exact-same path is NOT 'nested'", () => {
	const tmp = mkTmp();
	try {
		const report = runPreflight(tmp, emptyCtx({
			registeredProjects: [{
				id: "p1", name: "Same", rootPath: tmp, hidden: false,
			} as any],
		}));
		assert.equal(find(report, "path.nested-in-project").level, "pass");
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("path.nested-in-project fails when inside another project's worktree root", () => {
	const tmp = mkTmp();
	try {
		const proj = path.join(tmp, "proj");
		const wtRoot = path.join(tmp, "proj-wt");
		const inside = path.join(wtRoot, "branch", "x");
		fs.mkdirSync(proj, { recursive: true });
		fs.mkdirSync(inside, { recursive: true });
		const report = runPreflight(inside, emptyCtx({
			registeredProjects: [{ id: "p1", name: "Proj", rootPath: proj, hidden: false } as any],
		}));
		const c = find(report, "path.nested-in-project");
		assert.equal(c.level, "fail");
		assert.match(c.detail, /worktree/);
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("path.contains-project warns when path is ancestor of existing project", () => {
	const tmp = mkTmp();
	try {
		const inner = path.join(tmp, "inner");
		fs.mkdirSync(inner, { recursive: true });
		const report = runPreflight(tmp, emptyCtx({
			registeredProjects: [{ id: "p1", name: "Inner", rootPath: inner, hidden: false } as any],
		}));
		assert.equal(find(report, "path.contains-project").level, "warn");
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("path.is-worktree fails when .git is a file pointing into another repo's worktrees/", () => {
	const tmp = mkTmp();
	try {
		const dir = path.join(tmp, "wt");
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/branchx\n");
		const report = runPreflight(dir, emptyCtx());
		assert.equal(find(report, "path.is-worktree").level, "fail");
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("path.is-worktree passes when .git is a normal directory", () => {
	const tmp = mkTmp();
	try {
		const dir = path.join(tmp, "repo");
		fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
		const report = runPreflight(dir, emptyCtx());
		assert.equal(find(report, "path.is-worktree").level, "pass");
		assert.equal(find(report, "git.repo").level, "pass");
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("bobbit.existing warns with summary when .bobbit/state/sessions.json exists with entries", () => {
	const tmp = mkTmp();
	try {
		const state = path.join(tmp, ".bobbit", "state");
		fs.mkdirSync(state, { recursive: true });
		fs.writeFileSync(
			path.join(state, "sessions.json"),
			JSON.stringify([{ id: "a" }, { id: "b" }, { id: "c" }]),
		);
		const report = runPreflight(tmp, emptyCtx());
		const c = find(report, "bobbit.existing");
		assert.equal(c.level, "warn");
		assert.match(c.detail, /3 sessions/);
		assert.equal(c.remediation?.kind, "archive-bobbit");
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("bobbit.gateway-owned warns when path === gatewayProjectRoot", () => {
	const tmp = mkTmp();
	try {
		const report = runPreflight(tmp, emptyCtx({ gatewayProjectRoot: tmp }));
		assert.equal(find(report, "bobbit.gateway-owned").level, "warn");
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("bobbit.gateway-owned warns when .bobbit/state/gateway-url is present", () => {
	const tmp = mkTmp();
	try {
		const stateDir = path.join(tmp, ".bobbit", "state");
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "gateway-url"), "https://x");
		const report = runPreflight(tmp, emptyCtx());
		assert.equal(find(report, "bobbit.gateway-owned").level, "warn");
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("path.unc-or-network warns on a UNC path", () => {
	// We don't actually create one; the check is text-only.
	const report = runPreflight("\\\\server\\share\\proj", emptyCtx());
	assert.equal(find(report, "path.unc-or-network").level, "warn");
});

test("path.long warns on Windows for path > 200 chars", { skip: process.platform !== "win32" }, () => {
	const tmp = mkTmp();
	try {
		// Build a long path inside tmp
		let p = tmp;
		while (p.length < 230) p = path.join(p, "abcdefghij");
		fs.mkdirSync(p, { recursive: true });
		const report = runPreflight(p, emptyCtx());
		assert.equal(find(report, "path.long").level, "warn");
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("relative path short-circuits downstream checks gracefully", () => {
	const report = runPreflight("not/absolute", emptyCtx());
	// hasFail is true
	assert.ok(report.hasFail);
	// downstream checks degrade to warn rather than throwing
	const symlink = find(report, "path.symlink");
	assert.ok(symlink.level === "warn" || symlink.level === "pass");
});
