/**
 * Server-side tests for the UI-managed trusted-host allowlist:
 *   - canonicalizeTarget produces a host-qualified key for enterprise hosts and
 *     keeps github.com unchanged (back-compat).
 *   - classifyDiffResolutionError preserves the `untrusted_github_host` code + host
 *     (backstop for the async path), and GithubPrAdapterError carries the host.
 *
 * The legacy `WalkthroughAgentManager.launch` trust-check tests were removed with
 * the launcher (host.agents reviewer migration, design Decision F Phase 3); the
 * launch trust enforcement now lives in the github-adapter + the pack `run` route
 * and is covered by `tests/e2e/pr-walkthrough-host-agents.spec.ts`. These remaining
 * tests pin the surviving PURE target/error helpers.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const { canonicalizeTarget, classifyDiffResolutionError, changesetIdForTargetForTesting, numberOnlyTargetFromInferred } = await import("../src/server/pr-walkthrough/walkthrough-agent-manager.ts");
const { GithubPrAdapterError, parseGithubPrReference, resolveGithubPr, changesetIdForGithubForTesting } = await import("../src/server/pr-walkthrough/github-adapter.ts");
const { parseGithubRefForTesting } = await import("../src/server/pr-walkthrough/routes.ts");

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

describe("numberOnlyTargetFromInferred host-qualified identity", () => {
	const numberOnlyTarget = (number) => ({ provider: "github", number, host: "github.com", canonicalKey: `github:unknown/unknown#${number}` });

	it("keeps the legacy key/id for an inferred github.com origin", () => {
		const t = numberOnlyTargetFromInferred(numberOnlyTarget(42), { owner: "acme", repo: "widgets", host: "github.com" });
		assert.equal(t.canonicalKey, "github:acme/widgets#42");
		assert.equal(t.host, "github.com");
		assert.equal(changesetIdForTargetForTesting(t), "github:acme/widgets#42");
		assert.equal(t.prUrl, "https://github.com/acme/widgets/pull/42");
	});

	it("host-qualifies identity for an inferred enterprise origin", () => {
		const t = numberOnlyTargetFromInferred(numberOnlyTarget(42), { owner: "acme", repo: "widgets", host: "GHE.Corp." });
		assert.equal(t.host, "ghe.corp");
		assert.equal(t.canonicalKey, "github:ghe.corp/acme/widgets#42");
		assert.equal(changesetIdForTargetForTesting(t), "github:ghe.corp/acme/widgets#42");
		assert.equal(t.prUrl, "https://ghe.corp/acme/widgets/pull/42");
	});

	it("does not collide two enterprise origins sharing owner/repo/number", () => {
		const a = numberOnlyTargetFromInferred(numberOnlyTarget(42), { owner: "acme", repo: "widgets", host: "ghe-a.corp" });
		const b = numberOnlyTargetFromInferred(numberOnlyTarget(42), { owner: "acme", repo: "widgets", host: "ghe-b.corp" });
		assert.notEqual(a.canonicalKey, b.canonicalKey);
		assert.notEqual(changesetIdForTargetForTesting(a), changesetIdForTargetForTesting(b));
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
