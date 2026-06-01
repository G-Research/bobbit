/**
 * Unit tests for `parseBaseRef` / `resolveBaseRef` / `resolveBaseRefWithExec`.
 *
 * These are the pure-parser + host/sandbox resolver helpers that thread the
 * project's configured `base_ref` into every worktree-creation call site.
 * See docs/design/base-ref.md.
 *
 * Run via `node --test --test-force-exit` (npm run test:unit).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	parseBaseRef,
	parseLsRemoteSymref,
	refExistsInRepo,
	resolveBaseRef,
	resolveBaseRefWithExec,
} from "../src/server/skills/git.ts";

function rmDir(p: string): void {
	try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", windowsHide: true }).trim();
}

function makeTempRepo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-base-ref-"));
	git(root, "init", "-q");
	git(root, "config", "user.email", "test@example.com");
	git(root, "config", "user.name", "Test");
	git(root, "config", "commit.gpgsign", "false");
	git(root, "checkout", "-q", "-b", "master");
	fs.writeFileSync(path.join(root, "README.md"), "init\n");
	git(root, "add", "README.md");
	git(root, "commit", "-q", "-m", "init");
	return root;
}

describe("parseBaseRef", () => {
	it("empty string → sentinel unset", () => {
		assert.deepEqual(parseBaseRef(""), { ref: "", branch: "", isRemote: false });
	});

	it("whitespace-only → sentinel unset (trimmed)", () => {
		assert.deepEqual(parseBaseRef("   "), { ref: "", branch: "", isRemote: false });
		assert.deepEqual(parseBaseRef("\t\n "), { ref: "", branch: "", isRemote: false });
	});

	it("local branch name → isRemote false", () => {
		assert.deepEqual(parseBaseRef("master"), { ref: "master", branch: "master", isRemote: false });
		assert.deepEqual(parseBaseRef("develop"), { ref: "develop", branch: "develop", isRemote: false });
	});

	it("origin/<branch> → strips prefix on .branch, keeps .ref intact, isRemote true", () => {
		assert.deepEqual(parseBaseRef("origin/develop"), { ref: "origin/develop", branch: "develop", isRemote: true });
		assert.deepEqual(parseBaseRef("origin/main"), { ref: "origin/main", branch: "main", isRemote: true });
	});

	it("origin/feature/foo nested slash → branch keeps inner slash", () => {
		assert.deepEqual(parseBaseRef("origin/feature/foo"), {
			ref: "origin/feature/foo",
			branch: "feature/foo",
			isRemote: true,
		});
	});

	it("trims surrounding whitespace before parsing", () => {
		assert.deepEqual(parseBaseRef("  master  "), { ref: "master", branch: "master", isRemote: false });
		assert.deepEqual(parseBaseRef("\torigin/develop\n"), {
			ref: "origin/develop",
			branch: "develop",
			isRemote: true,
		});
	});

	it("non-origin remote prefix is NOT special-cased at parse layer", () => {
		// The pure parser doesn't reject non-origin remotes — that's the REST
		// validator's job at save time. By the time `parseBaseRef` runs, the
		// value is assumed well-formed. We verify the parser treats the value
		// as a local-style branch (no `origin/` to strip).
		const result = parseBaseRef("upstream/main");
		assert.equal(result.ref, "upstream/main");
		assert.equal(result.branch, "upstream/main");
		assert.equal(result.isRemote, false);
	});
});

describe("parseLsRemoteSymref", () => {
	it("master symref on first line → 'master'", () => {
		assert.equal(parseLsRemoteSymref("ref: refs/heads/master\tHEAD"), "master");
	});

	it("nested-slash branch keeps inner slashes", () => {
		assert.equal(parseLsRemoteSymref("ref: refs/heads/feature/x\tHEAD"), "feature/x");
	});

	it("multi-line (symref line + sha line) parses the symref", () => {
		const out = "ref: refs/heads/main\tHEAD\n0123456789abcdef0123456789abcdef01234567\tHEAD";
		assert.equal(parseLsRemoteSymref(out), "main");
	});

	it("space-separated columns are tolerated", () => {
		assert.equal(parseLsRemoteSymref("ref: refs/heads/develop   HEAD"), "develop");
	});

	it("CRLF line endings are tolerated", () => {
		const out = "ref: refs/heads/master\tHEAD\r\n0123abc\tHEAD\r\n";
		assert.equal(parseLsRemoteSymref(out), "master");
	});

	it("symref line not first is still found", () => {
		const out = "# comment\nref: refs/heads/release/2026.05\tHEAD";
		assert.equal(parseLsRemoteSymref(out), "release/2026.05");
	});

	it("missing ref line → null", () => {
		assert.equal(parseLsRemoteSymref("0123456789abcdef\tHEAD"), null);
	});

	it("empty string → null", () => {
		assert.equal(parseLsRemoteSymref(""), null);
	});

	it("non-heads symref (e.g. tags) → null", () => {
		assert.equal(parseLsRemoteSymref("ref: refs/tags/v1.0\tHEAD"), null);
	});
});

describe("refExistsInRepo", () => {
	const cleanup: string[] = [];
	after(() => { for (const d of cleanup) rmDir(d); });

	it("returns true for an existing local branch ref", async () => {
		const repo = makeTempRepo();
		cleanup.push(repo);
		assert.equal(await refExistsInRepo(repo, "master"), true);
	});

	it("returns false for a missing ref", async () => {
		const repo = makeTempRepo();
		cleanup.push(repo);
		assert.equal(await refExistsInRepo(repo, "origin/develop"), false);
	});

	it("returns false (never throws) for a non-existent repo path", async () => {
		assert.equal(await refExistsInRepo("/nonexistent/path", "master"), false);
	});
});

describe("resolveBaseRef (host)", () => {
	const cleanup: string[] = [];
	after(() => { for (const d of cleanup) rmDir(d); });

	it("configured non-empty short-circuits parseBaseRef (no exec)", async () => {
		// We pass a non-existent repo path. If the host resolver tried to
		// consult git on disk, `git symbolic-ref` would fail; since the
		// configured value is non-empty, the fallback is never invoked.
		const result = await resolveBaseRef("/nonexistent/path", "origin/develop");
		assert.deepEqual(result, { ref: "origin/develop", branch: "develop", isRemote: true });
	});

	it("configured = '' in a temp repo with no remote → falls back to HEAD sentinel", async () => {
		const repo = makeTempRepo();
		cleanup.push(repo);
		const result = await resolveBaseRef(repo, "");
		// No `origin` remote → `symbolic-ref refs/remotes/origin/HEAD` fails →
		// `resolveRemotePrimary` returns the literal "HEAD" sentinel.
		assert.equal(result.ref, "HEAD");
		assert.equal(result.branch, "HEAD");
		assert.equal(result.isRemote, false);
	});

	it("configured = undefined behaves identically to ''", async () => {
		const repo = makeTempRepo();
		cleanup.push(repo);
		const result = await resolveBaseRef(repo, undefined);
		assert.equal(result.ref, "HEAD");
	});

	it("local configured value returns the local branch without consulting git", async () => {
		const result = await resolveBaseRef("/nonexistent/path", "master");
		assert.deepEqual(result, { ref: "master", branch: "master", isRemote: false });
	});
});

describe("resolveBaseRefWithExec (sandbox)", () => {
	it("configured non-empty → exec is NOT called", async () => {
		let execCalls = 0;
		const exec = async (_args: string[]): Promise<string> => {
			execCalls++;
			return "";
		};
		const result = await resolveBaseRefWithExec(exec, "origin/develop");
		assert.equal(execCalls, 0, "exec must not be called when configured is non-empty");
		assert.deepEqual(result, { ref: "origin/develop", branch: "develop", isRemote: true });
	});

	it("configured empty → exec invoked once with symbolic-ref refs/remotes/origin/HEAD", async () => {
		const calls: string[][] = [];
		const exec = async (args: string[]): Promise<string> => {
			calls.push(args);
			return "refs/remotes/origin/main\n";
		};
		const result = await resolveBaseRefWithExec(exec, "");
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0], ["symbolic-ref", "refs/remotes/origin/HEAD"]);
		assert.deepEqual(result, { ref: "origin/main", branch: "main", isRemote: true });
	});

	it("configured empty + exec rejects → HEAD sentinel fallback", async () => {
		const exec = async (_args: string[]): Promise<string> => {
			throw new Error("symbolic-ref failed (no origin/HEAD set)");
		};
		const result = await resolveBaseRefWithExec(exec, "");
		assert.deepEqual(result, { ref: "HEAD", branch: "HEAD", isRemote: false });
	});

	it("configured undefined behaves identically to ''", async () => {
		const calls: string[][] = [];
		const exec = async (args: string[]): Promise<string> => {
			calls.push(args);
			return "refs/remotes/origin/develop\n";
		};
		const result = await resolveBaseRefWithExec(exec, undefined);
		assert.equal(calls.length, 1);
		assert.equal(result.ref, "origin/develop");
		assert.equal(result.branch, "develop");
		assert.equal(result.isRemote, true);
	});

	it("configured local value short-circuits the exec roundtrip", async () => {
		let execCalls = 0;
		const exec = async (_args: string[]): Promise<string> => {
			execCalls++;
			return "";
		};
		const result = await resolveBaseRefWithExec(exec, "master");
		assert.equal(execCalls, 0);
		assert.deepEqual(result, { ref: "master", branch: "master", isRemote: false });
	});
});
