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
import { fileURLToPath, pathToFileURL } from "node:url";
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

	it("treats an scp-style origin as a true remote", () => {
		const result = resolveSandboxCloneSource({
			originUrl: "git@github.com:foo/bar.git",
			repoPath: "/some/path",
		});
		assert.deepEqual(result, { kind: "remote", cloneUrl: "git@github.com:foo/bar.git" });
	});

	it("treats an ssh:// origin as a true remote", () => {
		const result = resolveSandboxCloneSource({
			originUrl: "ssh://git@host/foo.git",
			repoPath: "/some/path",
		});
		assert.equal(result.kind, "remote");
		// stripTokenFromGitUrl removes the `git@` userinfo; the scheme stays ssh://.
		assert.ok(/^ssh:\/\//.test(result.cloneUrl));
	});

	it("classifies a file:// origin as a mounted source with a decoded host path", () => {
		// Build the file:// origin from an OS-appropriate absolute path so the test
		// is cross-platform (a drive-less `file:///tmp/...` throws on Windows).
		const hostDir = process.platform === "win32" ? "C:/tmp/foo.git" : "/tmp/foo.git";
		const origin = pathToFileURL(hostDir).href;
		const result = resolveSandboxCloneSource({ originUrl: origin, repoPath: "/unused" });
		assert.equal(result.kind, "mounted");
		assert.equal(result.cloneUrl, "file:///workspace-src");
		// Cross-platform: compare against fileURLToPath rather than a hardcoded path.
		assert.equal((result as { hostPath: string }).hostPath, fileURLToPath(origin));
		// Must never be a file:// URL — it has to be a real filesystem path to bind-mount.
		assert.ok(!/^file:\/\//i.test((result as { hostPath: string }).hostPath));
	});

	it("classifies a local absolute POSIX path origin as mounted", () => {
		const result = resolveSandboxCloneSource({
			originUrl: "/srv/repos/foo.git",
			repoPath: "/unused",
		});
		assert.equal(result.kind, "mounted");
		assert.equal((result as { hostPath: string }).hostPath, "/srv/repos/foo.git");
		assert.equal(result.cloneUrl, "file:///workspace-src");
	});

	it("classifies a Windows drive-letter origin as mounted, NOT a remote", () => {
		const result = resolveSandboxCloneSource({
			originUrl: "C:/Users/jsubr/foo.git",
			repoPath: "/unused",
		});
		assert.equal(result.kind, "mounted");
		assert.equal((result as { hostPath: string }).hostPath, "C:/Users/jsubr/foo.git");
		// cloneUrl must never be a drive-letter path (the scp misparse bug).
		assert.ok(
			!/^[A-Za-z]:/.test(result.cloneUrl),
			`cloneUrl must not be a Windows drive-letter path, got: ${result.cloneUrl}`,
		);
		assert.equal(result.cloneUrl, "file:///workspace-src");
	});

	it("honours a per-repo mountPath for multi-repo callers", () => {
		const result = resolveSandboxCloneSource({
			originUrl: undefined,
			repoPath: "/host/web",
			mountPath: "/workspace-src/web",
		});
		assert.equal(result.kind, "mounted");
		assert.equal((result as { mountPath: string }).mountPath, "/workspace-src/web");
		assert.equal(result.cloneUrl, "file:///workspace-src/web");
		assert.equal((result as { hostPath: string }).hostPath, "/host/web");
	});
});
