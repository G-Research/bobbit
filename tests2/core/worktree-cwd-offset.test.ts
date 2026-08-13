import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";

import {
	offsetWorktreeCwd,
	relativeSandboxCwdOffset,
} from "../../src/server/agent/session-setup.js";

const hostRoot = path.parse(path.resolve(".")).root;
const syntheticRoot = path.join(hostRoot, "bobbit-cwd-offset-fixture");
const shortRepo = path.join(syntheticRoot, "RUNNER~1", "repo");
const longRepo = path.join(syntheticRoot, "runneradmin", "repo");
const canonicalRepo = path.join(syntheticRoot, "canonical", "repo");
const worktree = path.join(syntheticRoot, "worktree");

function mockNativeRealpaths(entries: ReadonlyMap<string, string | Error>): void {
	vi.spyOn(fs.realpathSync, "native").mockImplementation(((input: fs.PathLike) => {
		const result = entries.get(path.resolve(String(input)));
		if (result instanceof Error) throw result;
		if (result !== undefined) return result;
		throw Object.assign(new Error(`Unexpected realpath: ${String(input)}`), { code: "ENOENT" });
	}) as typeof fs.realpathSync.native);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("worktree cwd offsets", () => {
	it("maps equivalent native root aliases to the exact worktree root", () => {
		mockNativeRealpaths(new Map([
			[path.resolve(shortRepo), canonicalRepo],
			[path.resolve(longRepo), canonicalRepo],
		]));

		assert.equal(relativeSandboxCwdOffset(shortRepo, longRepo), undefined);
		assert.equal(offsetWorktreeCwd({ repoPath: shortRepo, cwd: longRepo }, worktree), worktree);
	});

	it("preserves an ordinary nested offset across a native root alias", () => {
		const nestedCwd = path.join(canonicalRepo, "packages", "web");
		mockNativeRealpaths(new Map([
			[path.resolve(shortRepo), canonicalRepo],
			[path.resolve(nestedCwd), nestedCwd],
		]));

		assert.equal(relativeSandboxCwdOffset(shortRepo, nestedCwd), "packages/web");
		assert.equal(
			offsetWorktreeCwd({ repoPath: shortRepo, cwd: nestedCwd }, worktree),
			path.join(worktree, "packages", "web"),
		);
	});

	it("falls back atomically when either native realpath fails", () => {
		const nestedCwd = path.join(longRepo, "packages", "web");
		mockNativeRealpaths(new Map<string, string | Error>([
			[path.resolve(longRepo), canonicalRepo],
			[path.resolve(nestedCwd), Object.assign(new Error("missing cwd"), { code: "ENOENT" })],
		]));

		assert.equal(relativeSandboxCwdOffset(longRepo, nestedCwd), "packages/web");
		assert.equal(
			offsetWorktreeCwd({ repoPath: longRepo, cwd: nestedCwd }, worktree),
			path.join(worktree, "packages", "web"),
		);
	});

	it("never appends an outside-root or parent-traversing offset", () => {
		const outsideCwd = path.join(syntheticRoot, "outside");
		mockNativeRealpaths(new Map([
			[path.resolve(shortRepo), canonicalRepo],
			[path.resolve(outsideCwd), outsideCwd],
		]));

		assert.equal(relativeSandboxCwdOffset(shortRepo, outsideCwd), undefined);
		assert.equal(offsetWorktreeCwd({ repoPath: shortRepo, cwd: outsideCwd }, worktree), worktree);
	});
});
