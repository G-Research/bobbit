/**
 * Contract test for the Docker sandbox clone-source resolver.
 *
 * `resolveSandboxCloneSource()` decides what `git clone` uses *inside* the
 * Linux sandbox container. It must NEVER emit a raw host path as the clone URL
 * (a Windows drive-letter path like `C:/Users/...` is misparsed by git as
 * scp/SSH syntax → `cannot run ssh` / `unable to fork`; any host path is
 * unreachable from inside the container).
 *
 * Two security/quality invariants this test pins:
 *
 *  - Classification mirrors git's heuristic: a URL scheme OR scp-style
 *    `[user@]host:path` (host not a single drive letter) is a network remote;
 *    everything else is local.
 *  - A LOCAL origin is only bind-mounted when it resolves INSIDE the project
 *    root. A local origin pointing outside the root throws — bind-mounting an
 *    arbitrary host path into the sandbox is a data-exposure risk.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSandboxCloneSource } from "../src/server/agent/sandbox-clone-source.js";

// An absolute repo root for the running platform (drive-rooted on Windows).
const REPO_ROOT = path.resolve(process.platform === "win32" ? "C:/proj/app" : "/proj/app");

describe("resolveSandboxCloneSource — network remotes", () => {
	it("classifies an https:// origin as a remote (token stripped)", () => {
		const result = resolveSandboxCloneSource({
			originUrl: "https://github.com/foo/bar.git",
			repoPath: REPO_ROOT,
		});
		assert.deepEqual(result, { kind: "remote", cloneUrl: "https://github.com/foo/bar.git" });
	});

	it("classifies an scp-style origin with user (git@host:path) as a remote", () => {
		const result = resolveSandboxCloneSource({
			originUrl: "git@github.com:foo/bar.git",
			repoPath: REPO_ROOT,
		});
		assert.equal(result.kind, "remote");
		// stripTokenFromGitUrl leaves scp-style host:path remotes intact here.
		assert.equal(result.cloneUrl, "git@github.com:foo/bar.git");
	});

	it("classifies an scp-style origin WITHOUT user (host:path) as a remote", () => {
		// This is the Finding-1 regression: a host-without-user scp remote was
		// previously misclassified as a local/mounted source.
		const result = resolveSandboxCloneSource({
			originUrl: "github.example.com:team/repo.git",
			repoPath: REPO_ROOT,
		});
		assert.equal(result.kind, "remote");
		assert.equal(result.cloneUrl, "github.example.com:team/repo.git");
	});

	it("classifies an ssh:// origin as a remote", () => {
		const result = resolveSandboxCloneSource({
			originUrl: "ssh://git@host/foo.git",
			repoPath: REPO_ROOT,
		});
		assert.equal(result.kind, "remote");
		assert.ok(/^ssh:\/\//.test(result.cloneUrl));
	});
});

describe("resolveSandboxCloneSource — absent origin (mount the declared repo)", () => {
	for (const [label, originUrl] of [
		["undefined", undefined],
		["null", null],
		["empty string", ""],
	] as const) {
		it(`mounts the project repo when origin is ${label}`, () => {
			const result = resolveSandboxCloneSource({ originUrl, repoPath: REPO_ROOT });
			assert.equal(result.kind, "mounted");
			assert.equal((result as { hostPath: string }).hostPath, REPO_ROOT);
			assert.equal((result as { mountPath: string }).mountPath, "/workspace-src");
			assert.equal(result.cloneUrl, "file:///workspace-src");
		});
	}

	it("NEVER emits a raw host path or drive-letter as the clone URL", () => {
		const repoPath = process.platform === "win32" ? "C:/Users/jsubr/proj" : "/home/dev/proj";
		const result = resolveSandboxCloneSource({ originUrl: undefined, repoPath });
		assert.notEqual(result.cloneUrl, repoPath);
		assert.ok(
			!/^[A-Za-z]:/.test(result.cloneUrl),
			`cloneUrl must not be a Windows drive-letter path, got: ${result.cloneUrl}`,
		);
		assert.equal(result.cloneUrl, "file:///workspace-src");
	});
});

describe("resolveSandboxCloneSource — local origins inside the project root", () => {
	it("mounts a file:// origin that points inside repoPath", () => {
		const inside = path.join(REPO_ROOT, "sub");
		const origin = pathToFileURL(inside).href;
		const result = resolveSandboxCloneSource({ originUrl: origin, repoPath: REPO_ROOT });
		assert.equal(result.kind, "mounted");
		assert.equal((result as { hostPath: string }).hostPath, fileURLToPath(origin));
		assert.equal(result.cloneUrl, "file:///workspace-src");
		// hostPath must be a real filesystem path, never a file:// URL.
		assert.ok(!/^file:\/\//i.test((result as { hostPath: string }).hostPath));
	});

	it("mounts a relative origin resolved against repoPath", () => {
		const result = resolveSandboxCloneSource({ originUrl: "./vendored", repoPath: REPO_ROOT });
		assert.equal(result.kind, "mounted");
		assert.equal((result as { hostPath: string }).hostPath, path.resolve(REPO_ROOT, "./vendored"));
		assert.equal(result.cloneUrl, "file:///workspace-src");
	});
});

describe("resolveSandboxCloneSource — local origins OUTSIDE the project root throw", () => {
	it("throws for a file:// origin outside repoPath (security)", () => {
		const outside = process.platform === "win32" ? "C:/some/other/private/repo" : "/some/other/private/repo";
		const origin = pathToFileURL(outside).href;
		assert.throws(
			() => resolveSandboxCloneSource({ originUrl: origin, repoPath: REPO_ROOT }),
			/outside the project root/,
		);
	});

	it("throws for an absolute path origin outside repoPath", () => {
		const outside = process.platform === "win32" ? "C:/srv/repos/foo.git" : "/srv/repos/foo.git";
		assert.throws(
			() => resolveSandboxCloneSource({ originUrl: outside, repoPath: REPO_ROOT }),
			/outside the project root/,
		);
	});

	it("throws (NOT classified as remote) for a Windows drive path not under repoPath", () => {
		// A bare drive-letter path must be treated as a local path, never as an
		// scp `host:path` remote (single-letter host). Outside the root → throw.
		const repoPath = process.platform === "win32" ? "C:/totally/unrelated/root" : "/totally/unrelated/root";
		assert.throws(
			() => resolveSandboxCloneSource({ originUrl: "C:/Users/jsubr/foo.git", repoPath }),
			/outside the project root/,
		);
	});
});

describe("resolveSandboxCloneSource — per-repo mountPath", () => {
	it("honours a custom mountPath for multi-repo callers", () => {
		const result = resolveSandboxCloneSource({
			originUrl: undefined,
			repoPath: REPO_ROOT,
			mountPath: "/workspace-src/web",
		});
		assert.equal(result.kind, "mounted");
		assert.equal((result as { mountPath: string }).mountPath, "/workspace-src/web");
		assert.equal(result.cloneUrl, "file:///workspace-src/web");
		assert.equal((result as { hostPath: string }).hostPath, REPO_ROOT);
	});
});
