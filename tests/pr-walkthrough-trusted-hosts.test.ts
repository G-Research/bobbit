/**
 * Server-side tests for the UI-managed trusted-host allowlist:
 *   - canonicalizeTarget produces a host-qualified key for enterprise hosts and
 *     keeps github.com unchanged (back-compat).
 *   - The synchronous launch trust-check throws `untrusted_github_host` (carrying
 *     the offending host) BEFORE any job/child is created, and adding the host to
 *     the preferences store lets the immediate launch proceed.
 *   - classifyDiffResolutionError preserves the `untrusted_github_host` code + host
 *     (backstop for the async path), and GithubPrAdapterError carries the host.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { WalkthroughAgentStore } = await import("../src/server/pr-walkthrough/walkthrough-agent-store.ts");
const { WalkthroughAgentManager, canonicalizeTarget, classifyDiffResolutionError, changesetIdForTargetForTesting } = await import("../src/server/pr-walkthrough/walkthrough-agent-manager.ts");
const { GithubPrAdapterError, parseGithubPrReference, resolveGithubPr, changesetIdForGithubForTesting } = await import("../src/server/pr-walkthrough/github-adapter.ts");
const { parseGithubRefForTesting } = await import("../src/server/pr-walkthrough/routes.ts");

let tempDir = "";

function makeSessionManager() {
	const sessions = new Map<string, any>();
	const prompts: string[] = [];
	sessions.set("parent", { id: "parent", cwd: tempDir, status: "idle", projectId: "project-1", sandboxed: false });
	return {
		sessions,
		prompts,
		async createSession(cwd: string, _a?: unknown, _b?: unknown, _c?: unknown, opts?: Record<string, unknown>) {
			const id = String(opts?.sessionId ?? "child");
			const session = {
				id,
				cwd,
				status: "idle",
				env: opts?.env,
				allowedTools: opts?.allowedTools,
				rpcClient: {
					prompt: async (text: string) => { prompts.push(text); return { success: true }; },
					onEvent: () => () => undefined,
				},
			};
			sessions.set(id, session);
			return session;
		},
		getSession(id: string) { return sessions.get(id); },
		getPersistedSession(id: string) { return sessions.get(id); },
		updateSessionMeta(id: string, updates: Record<string, unknown>) { Object.assign(sessions.get(id), updates); return true; },
		setTitle(id: string, title: string) { Object.assign(sessions.get(id), { title }); },
		enqueuePrompt(_id: string, text: string) { prompts.push(text); return { status: "queued" }; },
	};
}

function createGitDiffFixture(): { baseSha: string; headSha: string } {
	execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd: tempDir });
	execFileSync("git", ["config", "user.name", "Tests"], { cwd: tempDir });
	execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: tempDir });
	const filePath = "demo.ts";
	fs.writeFileSync(path.join(tempDir, filePath), "export const value = 1;\n", "utf-8");
	execFileSync("git", ["add", filePath], { cwd: tempDir });
	execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
	const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempDir, encoding: "utf-8" }).trim();
	fs.writeFileSync(path.join(tempDir, filePath), "export const value = 2;\n", "utf-8");
	execFileSync("git", ["add", filePath], { cwd: tempDir });
	execFileSync("git", ["commit", "-m", "change"], { cwd: tempDir, stdio: "ignore" });
	const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempDir, encoding: "utf-8" }).trim();
	return { baseSha, headSha };
}

describe("canonicalizeTarget host-qualified identity", () => {
	it("keeps the historical key shape for github.com", () => {
		const target = canonicalizeTarget({ prUrl: "https://github.com/acme/widgets/pull/42" });
		assert.equal(target.canonicalKey, "github:acme/widgets#42");
		assert.equal(target.prUrl, "https://github.com/acme/widgets/pull/42");
	});

	it("normalizes www.github.com to the github.com key", () => {
		const target = canonicalizeTarget({ prUrl: "https://www.github.com/acme/widgets/pull/42" });
		assert.equal(target.canonicalKey, "github:acme/widgets#42");
	});

	it("includes the host in identity for enterprise hosts", () => {
		const target = canonicalizeTarget({ prUrl: "https://github.example.com/acme/widgets/pull/42" });
		assert.equal(target.canonicalKey, "github:github.example.com/acme/widgets#42");
		assert.equal(target.owner, "acme");
		assert.equal(target.repo, "widgets");
		assert.equal(target.number, 42);
		assert.equal(target.prUrl, "https://github.example.com/acme/widgets/pull/42");
	});

	it("does not collide two enterprise hosts sharing owner/repo/number", () => {
		const a = canonicalizeTarget({ prUrl: "https://ghe-a.corp/acme/widgets/pull/42" });
		const b = canonicalizeTarget({ prUrl: "https://ghe-b.corp/acme/widgets/pull/42" });
		assert.notEqual(a.canonicalKey, b.canonicalKey);
	});

	it("populates the normalized host on the target", () => {
		assert.equal(canonicalizeTarget({ prUrl: "https://github.com/acme/widgets/pull/42" }).host, "github.com");
		assert.equal(canonicalizeTarget({ prUrl: "https://www.github.com/acme/widgets/pull/42" }).host, "github.com");
		assert.equal(canonicalizeTarget({ prUrl: "https://GitHub.Example.Com./acme/widgets/pull/42" }).host, "github.example.com");
	});
});

describe("changesetIdForTarget host-qualified ids", () => {
	it("keeps the legacy un-prefixed id for github.com and www.github.com", () => {
		const gh = canonicalizeTarget({ prUrl: "https://github.com/acme/widgets/pull/42" });
		assert.equal(changesetIdForTargetForTesting(gh), "github:acme/widgets#42");
		const www = canonicalizeTarget({ prUrl: "https://www.github.com/acme/widgets/pull/42" });
		assert.equal(changesetIdForTargetForTesting(www), "github:acme/widgets#42");
	});

	it("host-qualifies the id for an enterprise host", () => {
		const ent = canonicalizeTarget({ prUrl: "https://github.example.com/acme/widgets/pull/42" });
		assert.equal(changesetIdForTargetForTesting(ent), "github:github.example.com/acme/widgets#42");
	});

	it("yields DIFFERENT changeset ids for two enterprise hosts sharing owner/repo/number", () => {
		const a = canonicalizeTarget({ prUrl: "https://ghe-a.corp/acme/widgets/pull/42" });
		const b = canonicalizeTarget({ prUrl: "https://ghe-b.corp/acme/widgets/pull/42" });
		assert.notEqual(changesetIdForTargetForTesting(a), changesetIdForTargetForTesting(b));
		assert.equal(changesetIdForTargetForTesting(a), "github:ghe-a.corp/acme/widgets#42");
		assert.equal(changesetIdForTargetForTesting(b), "github:ghe-b.corp/acme/widgets#42");
	});
});

describe("changesetIdForGithub host-qualified ids", () => {
	const HEAD = "fedcba9876543210fedcba9876543210fedcba98";

	it("keeps the legacy un-prefixed id for github.com and www.github.com", () => {
		assert.equal(changesetIdForGithubForTesting("github.com", "acme", "widgets", 42, HEAD), "github:acme/widgets#42:fedcba9");
		assert.equal(changesetIdForGithubForTesting("www.github.com", "acme", "widgets", 42, HEAD), "github:acme/widgets#42:fedcba9");
	});

	it("host-qualifies the id for an enterprise host", () => {
		assert.equal(changesetIdForGithubForTesting("github.example.com", "acme", "widgets", 42, HEAD), "github:github.example.com/acme/widgets#42:fedcba9");
	});

	it("yields DIFFERENT changeset ids for two enterprise hosts sharing owner/repo/number", () => {
		const a = changesetIdForGithubForTesting("ghe-a.corp", "acme", "widgets", 42, HEAD);
		const b = changesetIdForGithubForTesting("ghe-b.corp", "acme", "widgets", 42, HEAD);
		assert.notEqual(a, b);
	});
});

describe("classifyDiffResolutionError backstop", () => {
	it("preserves untrusted_github_host code and host", () => {
		const typed = classifyDiffResolutionError(new GithubPrAdapterError("Untrusted GitHub PR host: ent.corp", { status: 400, code: "untrusted_github_host", host: "ent.corp" }));
		assert.equal(typed.code, "untrusted_github_host");
		assert.equal(typed.host, "ent.corp");
		assert.equal(typed.retryable, false);
	});
});

describe("github-adapter trust threading", () => {
	it("GithubPrAdapterError carries the offending host from parseGithubPrReference", () => {
		assert.throws(
			() => parseGithubPrReference({ prUrl: "https://github.example.com/acme/widgets/pull/42" }),
			(error: unknown) => error instanceof GithubPrAdapterError && error.code === "untrusted_github_host" && error.host === "github.example.com",
		);
	});

	it("trusts an enterprise host passed via trustedHosts", () => {
		const parsed = parseGithubPrReference({ prUrl: "https://github.example.com/acme/widgets/pull/42" }, ["github.example.com"]);
		assert.equal(parsed.owner, "acme");
		assert.equal(parsed.repo, "widgets");
		assert.equal(parsed.number, 42);
		assert.equal(parsed.host, "github.example.com");
	});

	it("resolveGithubPr rejects an untrusted host with code+host before any fetch", async () => {
		await assert.rejects(
			() => resolveGithubPr({ prUrl: "https://github.example.com/acme/widgets/pull/42" }),
			(error: unknown) => error instanceof GithubPrAdapterError && error.code === "untrusted_github_host" && error.host === "github.example.com",
		);
	});

	it("trusts www.github.com (a DEFAULT baseline host) without any managed hosts", () => {
		const parsed = parseGithubPrReference({ prUrl: "https://www.github.com/acme/widgets/pull/7" });
		assert.equal(parsed.host, "www.github.com");
		assert.equal(parsed.owner, "acme");
		assert.equal(parsed.repo, "widgets");
		assert.equal(parsed.number, 7);
	});
});

function jsonResponse(body: unknown, status = 200): any {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: "OK",
		headers: { get: () => null },
		json: async () => body,
		text: async () => JSON.stringify(body),
	};
}

function makeCapturingFetch(host: string): { fetch: any; urls: string[]; auth: Array<string | undefined> } {
	const urls: string[] = [];
	const auth: Array<string | undefined> = [];
	const fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
		urls.push(url);
		auth.push(init?.headers?.Authorization);
		if (/\/files\?/.test(url)) return jsonResponse([]);
		return jsonResponse({
			number: 1,
			title: "Title",
			html_url: `https://${host}/acme/widgets/pull/1`,
			base: { sha: "a".repeat(40) },
			head: { sha: "b".repeat(40) },
		});
	};
	return { fetch, urls, auth };
}

describe("parseGithubRef enterprise resolve path", () => {
	it("returns full owner/repo/number/url for a trusted enterprise host", () => {
		const ref = parseGithubRefForTesting("https://github.example.com/acme/widgets/pull/42", undefined, "/tmp", ["github.example.com"]);
		assert.ok(ref);
		assert.equal(ref.owner, "acme");
		assert.equal(ref.repo, "widgets");
		assert.equal(ref.number, "42");
		assert.equal(ref.url, "https://github.example.com/acme/widgets/pull/42");
	});

	it("still parses github.com and rejects untrusted enterprise hosts", () => {
		const gh = parseGithubRefForTesting("https://github.com/acme/widgets/pull/3", undefined, "/tmp", []);
		assert.equal(gh?.owner, "acme");
		assert.equal(gh?.number, "3");
		assert.equal(parseGithubRefForTesting("https://github.example.com/acme/widgets/pull/3", undefined, "/tmp", []), undefined);
	});
});

describe("resolveGithubPr host routing and token scoping", () => {
	let savedGithubToken: string | undefined;
	let savedGhToken: string | undefined;
	let savedGhCommand: string | undefined;

	beforeEach(() => {
		savedGithubToken = process.env.GITHUB_TOKEN;
		savedGhToken = process.env.GH_TOKEN;
		savedGhCommand = process.env.BOBBIT_GH_COMMAND;
		// Force the gh CLI fallback to fail deterministically so host-scoped token
		// resolution returns undefined unless an env/explicit token applies.
		process.env.BOBBIT_GH_COMMAND = "bobbit-nonexistent-gh-binary-xyz";
	});
	afterEach(() => {
		if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = savedGithubToken;
		if (savedGhToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedGhToken;
		if (savedGhCommand === undefined) delete process.env.BOBBIT_GH_COMMAND; else process.env.BOBBIT_GH_COMMAND = savedGhCommand;
	});

	it("routes www.github.com to the public api.github.com base URL", async () => {
		delete process.env.GITHUB_TOKEN;
		delete process.env.GH_TOKEN;
		const { fetch, urls } = makeCapturingFetch("www.github.com");
		await resolveGithubPr({ prUrl: "https://www.github.com/acme/widgets/pull/1", fetch });
		assert.ok(urls[0].startsWith("https://api.github.com/repos/acme/widgets/pulls/1"), urls[0]);
	});

	it("forwards the env token only for github.com", async () => {
		process.env.GITHUB_TOKEN = "env-token";
		delete process.env.GH_TOKEN;
		const { fetch, urls, auth } = makeCapturingFetch("github.com");
		await resolveGithubPr({ prUrl: "https://github.com/acme/widgets/pull/1", fetch });
		assert.ok(urls[0].startsWith("https://api.github.com/"), urls[0]);
		assert.ok(auth.some(h => h === "Bearer env-token"));
	});

	it("does NOT forward the env token to an enterprise host", async () => {
		process.env.GITHUB_TOKEN = "env-token";
		delete process.env.GH_TOKEN;
		const { fetch, urls, auth } = makeCapturingFetch("github.example.com");
		await resolveGithubPr({
			prUrl: "https://github.example.com/acme/widgets/pull/1",
			trustedHosts: ["github.example.com"],
			fetch,
		});
		assert.ok(urls[0].startsWith("https://github.example.com/api/v3/"), urls[0]);
		assert.ok(auth.every(h => h === undefined), `enterprise host must not receive github.com env token: ${JSON.stringify(auth)}`);
	});

	it("honors an explicit options.token for any host", async () => {
		delete process.env.GITHUB_TOKEN;
		delete process.env.GH_TOKEN;
		const { fetch, auth } = makeCapturingFetch("github.example.com");
		await resolveGithubPr({
			prUrl: "https://github.example.com/acme/widgets/pull/1",
			trustedHosts: ["github.example.com"],
			token: "explicit-token",
			fetch,
		});
		assert.ok(auth.some(h => h === "Bearer explicit-token"));
	});
});

describe("synchronous launch trust-check", () => {
	beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-prw-trust-")); });
	afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });

	it("aborts an untrusted enterprise launch with code+host and creates no job/child", async () => {
		const sessionManager = makeSessionManager();
		const store = new WalkthroughAgentStore(tempDir);
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store });

		await assert.rejects(
			() => manager.launch({ sessionId: "parent", prUrl: "https://github.example.com/acme/widgets/pull/42" }),
			(error: any) => error?.extra?.code === "untrusted_github_host" && error?.extra?.host === "github.example.com" && error?.status === 400,
		);
		assert.equal(store.list().length, 0, "no walkthrough job/tab should be created for an untrusted host");
		assert.equal(sessionManager.sessions.size, 1, "no child session should be created");
		assert.equal(sessionManager.prompts.length, 0);
	});

	it("proceeds when the host is present in the managed preferences allowlist", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const store = new WalkthroughAgentStore(tempDir);
		const manager = new WalkthroughAgentManager({
			defaultCwd: tempDir,
			stateDir: tempDir,
			sessionManager,
			store,
			preferencesStore: { get: (key: string) => (key === "githubTrustedHosts" ? ["github.example.com"] : undefined) },
		});

		const launch = await manager.launch({
			sessionId: "parent",
			prUrl: "https://github.example.com/acme/widgets/pull/42",
			baseSha: fixture.baseSha,
			headSha: fixture.headSha,
		});
		assert.equal(launch.status, "waiting_for_yaml");
		assert.equal(launch.job.target.canonicalKey, "github:github.example.com/acme/widgets#42");
		assert.equal(store.list().length, 1);
	});

	it("github.com launches remain trusted without any managed hosts", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const store = new WalkthroughAgentStore(tempDir);
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store });

		const launch = await manager.launch({
			sessionId: "parent",
			prUrl: "https://github.com/acme/widgets/pull/42",
			baseSha: fixture.baseSha,
			headSha: fixture.headSha,
		});
		assert.equal(launch.status, "waiting_for_yaml");
		assert.equal(launch.job.target.canonicalKey, "github:acme/widgets#42");
	});
});
