/**
 * Regression test for the Docker sandbox clone-fallback bug.
 *
 * When a project has no `origin` remote, the old code fell back to using the
 * raw HOST directory path as the `git clone` source inside the Linux
 * container. On Windows the drive-letter path (`C:/Users/...`) is misparsed by
 * git as scp/SSH syntax; on any OS the host path is unreachable from inside the
 * container.
 *
 * The fix introduces a pure `resolveSandboxCloneSource()` that NEVER emits a
 * raw host path as the clone URL — the remote-less case becomes a read-only
 * bind-mount cloned via `file:///workspace-src`.
 *
 * This test pins that contract. It fails (red) on the current branch because
 * the module/function does not exist yet.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSandboxCloneSource } from "../src/server/agent/sandbox-clone-source.js";

describe("resolveSandboxCloneSource", () => {
	it("returns a remote source when origin is present", () => {
		const result = resolveSandboxCloneSource({
			originUrl: "https://github.com/foo/bar.git",
			repoPath: "/some/path",
		});
		assert.deepEqual(result, {
			kind: "remote",
			cloneUrl: "https://github.com/foo/bar.git",
		});
	});

	it("returns a mounted source when origin is absent (Windows host path)", () => {
		const result = resolveSandboxCloneSource({
			originUrl: undefined,
			repoPath: "C:/Users/jsubr/proj",
		});
		assert.equal(result.kind, "mounted");
		assert.equal(result.cloneUrl, "file:///workspace-src");
		assert.equal((result as { mountPath: string }).mountPath, "/workspace-src");
		assert.equal((result as { hostPath: string }).hostPath, "C:/Users/jsubr/proj");
	});

	it("NEVER emits the raw host path as the clone URL (the heart of the bug)", () => {
		const repoPath = "C:/Users/jsubr/proj";
		const result = resolveSandboxCloneSource({ originUrl: undefined, repoPath });

		// Must not be the raw host path.
		assert.notEqual(result.cloneUrl, repoPath);
		// Must not look like a Windows drive-letter path (which git misparses as
		// scp/SSH syntax → `cannot run ssh` / `unable to fork`).
		assert.ok(
			!/^[A-Za-z]:/.test(result.cloneUrl),
			`cloneUrl must not be a Windows drive-letter path, got: ${result.cloneUrl}`,
		);
	});

	it("never emits an scp-style remote for a POSIX host path either", () => {
		const repoPath = "/home/dev/project-without-origin";
		const result = resolveSandboxCloneSource({ originUrl: null, repoPath });
		assert.equal(result.kind, "mounted");
		assert.equal(result.cloneUrl, "file:///workspace-src");
		assert.notEqual(result.cloneUrl, repoPath);
	});

	it("treats an empty-string origin as absent", () => {
		const result = resolveSandboxCloneSource({ originUrl: "", repoPath: "/x" });
		assert.equal(result.kind, "mounted");
		assert.equal(result.cloneUrl, "file:///workspace-src");
	});
});
