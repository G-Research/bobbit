// Current-branch PR resolution, local remote selection, and trust preflight.

import { test } from "vitest";
import assert from "node:assert/strict";

const routesModule = await import("../../../market-packs/pr-walkthrough/lib/routes.mjs");
const { resolveCurrentBranchTarget } = routesModule.__test;

type GitFixture = {
	remotes?: string[];
	branch?: string;
	config?: Record<string, string>;
	urls?: Record<string, string>;
	fallback?: (args: string[]) => string | Promise<string>;
};

function fixtureGit(fixture: GitFixture, calls: string[][] = []) {
	return async (_cwd: string, args: string[]) => {
		calls.push(args);
		if (args.length === 1 && args[0] === "remote") return (fixture.remotes ?? ["origin"]).join("\n");
		if (args.join(" ") === "symbolic-ref --quiet --short HEAD") {
			if (!fixture.branch) throw new Error("detached");
			return fixture.branch;
		}
		if (args[0] === "config" && args[1] === "--get") {
			const value = fixture.config?.[args[2]];
			if (!value) throw new Error("unset");
			return value;
		}
		if (args[0] === "remote" && args[1] === "get-url") {
			const value = fixture.urls?.[args[2]];
			if (!value) throw new Error("missing remote");
			return value;
		}
		if (fixture.fallback) return fixture.fallback(args);
		throw new Error(`unexpected git args: ${args.join(" ")}`);
	};
}

function githubPr(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		number: 766,
		title: "Improve PR walkthrough header",
		body: "## Summary\nPreserve the launch-time PR description.",
		url: "https://github.com/SuuBro/bobbit/pull/766",
		headRefOid: "head-pr-branch",
		baseRefOid: "base-at-pr-comparison",
		baseRefName: "main",
		headRefName: "session/aab88279",
		...overrides,
	});
}

test("PR walkthrough launch uses GitHub's PR baseRefOid and binds gh to the selected repository", async () => {
	const gitCalls: string[][] = [];
	const ghCalls: string[][] = [];
	const result = await resolveCurrentBranchTarget("/repo", {
		gh: async (_cwd: string, args: string[]) => { ghCalls.push(args); return githubPr(); },
		git: fixtureGit({
			remotes: ["origin"],
			branch: "session/aab88279",
			urls: { origin: "git@github.com:SuuBro/bobbit.git" },
		}, gitCalls),
	});

	assert.equal(result.ok, true);
	assert.equal(result.target.baseSha, "base-at-pr-comparison");
	assert.equal(result.target.headSha, "head-pr-branch");
	assert.equal(result.target.prNumber, 766);
	assert.equal(result.target.prTitle, "Improve PR walkthrough header");
	assert.equal(result.target.prBody, "## Summary\nPreserve the launch-time PR description.");
	assert.equal(result.target.prBodySource, "gh_cli");
	assert.match(result.target.prBodyFetchedAt, /^\d{4}-\d{2}-\d{2}T/);
	assert.equal(result.target.owner, "SuuBro");
	assert.equal(result.target.repo, "bobbit");
	assert.deepEqual(ghCalls, [[
		"pr", "view", "--repo", "github.com/SuuBro/bobbit", "--json",
		"number,title,body,url,headRefOid,baseRefOid,baseRefName,headRefName",
	]]);
	assert.ok(gitCalls.some((args) => args.join(" ") === "remote get-url origin"));
});

test("unknown enterprise remote returns HOST_NOT_TRUSTED before any gh call", async () => {
	const ghCalls: string[][] = [];
	let trustChecks = 0;
	const result = await resolveCurrentBranchTarget("/repo", {
		gh: async (_cwd: string, args: string[]) => { ghCalls.push(args); throw new Error("must not run"); },
		git: fixtureGit({ remotes: ["origin"], branch: "feature", urls: { origin: "git@ghe.example.com:acme/widgets.git" } }),
		isTrustedHost: async () => { trustChecks++; return true; },
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, "HOST_NOT_TRUSTED");
	assert.equal(result.host, "ghe.example.com");
	assert.equal(result.retryable, true);
	assert.deepEqual(ghCalls, []);
	assert.equal(trustChecks, 0, "the first response must preserve the client prompt/check flow");
});

test("a forged exact ack is not authority and performs no gh call when the server rejects it", async () => {
	let ghCalls = 0;
	const checked: string[] = [];
	const result = await resolveCurrentBranchTarget("/repo", {
		gh: async () => { ghCalls++; throw new Error("must not run"); },
		git: fixtureGit({ remotes: ["origin"], branch: "feature", urls: { origin: "ssh://git@ghe.example.com/acme/widgets.git" } }),
		isTrustedHost: async (host: string) => { checked.push(host); return false; },
	}, "ghe.example.com");

	assert.equal(result.code, "HOST_NOT_TRUSTED");
	assert.deepEqual(checked, ["ghe.example.com"]);
	assert.equal(ghCalls, 0);
});

test("a valid ack plus server trust uses the selected upstream and a host-qualified --repo", async () => {
	const ghCalls: string[][] = [];
	const gitCalls: string[][] = [];
	const result = await resolveCurrentBranchTarget("/repo", {
		gh: async (_cwd: string, args: string[]) => {
			ghCalls.push(args);
			return githubPr({
				number: 7,
				url: "https://ghe.example.com/acme/widgets/pull/7",
				headRefOid: "head",
				baseRefOid: "base",
			});
		},
		git: fixtureGit({
			remotes: ["origin", "upstream"],
			branch: "feature",
			config: { "branch.feature.remote": "upstream" },
			urls: {
				origin: "git@github.com:someone/fork.git",
				upstream: "https://ghe.example.com/acme/widgets.git",
			},
		}, gitCalls),
		isTrustedHost: async (host: string) => host === "ghe.example.com",
	}, "ghe.example.com");

	assert.equal(result.ok, true);
	assert.equal(result.target.prUrl, "https://ghe.example.com/acme/widgets/pull/7");
	assert.ok(gitCalls.some((args) => args.join(" ") === "remote get-url upstream"));
	assert.ok(!gitCalls.some((args) => args.join(" ") === "remote get-url origin"));
	assert.deepEqual(ghCalls[0].slice(0, 5), ["pr", "view", "--repo", "ghe.example.com/acme/widgets", "--json"]);
});

test("current branch pushRemote wins over remote.pushDefault, branch remote, and origin", async () => {
	const gitCalls: string[][] = [];
	const ghCalls: string[][] = [];
	const result = await resolveCurrentBranchTarget("/repo", {
		gh: async (_cwd: string, args: string[]) => { ghCalls.push(args); return githubPr(); },
		git: fixtureGit({
			remotes: ["origin", "default-push", "upstream", "fork"],
			branch: "feature",
			config: {
				"branch.feature.pushRemote": "fork",
				"remote.pushDefault": "default-push",
				"branch.feature.remote": "upstream",
			},
			urls: {
				origin: "git@github.com:wrong/origin.git",
				"default-push": "git@github.com:wrong/default.git",
				upstream: "git@github.com:wrong/upstream.git",
				fork: "git@github.com:SuuBro/bobbit.git",
			},
		}, gitCalls),
	});

	assert.equal(result.ok, true);
	assert.ok(gitCalls.some((args) => args.join(" ") === "remote get-url fork"));
	assert.ok(!gitCalls.some((args) => args.join(" ") === "remote get-url origin"));
	assert.ok(ghCalls[0].includes("github.com/SuuBro/bobbit"));
});

test("ssh.github.com transport alias is canonicalized to github.com without a prompt", async () => {
	let trustChecks = 0;
	const ghCalls: string[][] = [];
	const result = await resolveCurrentBranchTarget("/repo", {
		gh: async (_cwd: string, args: string[]) => { ghCalls.push(args); return githubPr(); },
		git: fixtureGit({ remotes: ["origin"], branch: "feature", urls: { origin: "ssh://git@ssh.github.com:443/SuuBro/bobbit.git" } }),
		isTrustedHost: async () => { trustChecks++; return false; },
	});

	assert.equal(result.ok, true);
	assert.equal(trustChecks, 0);
	assert.ok(ghCalls[0].includes("github.com/SuuBro/bobbit"));
});

test("https://ssh.github.com is not treated as GitHub's SSH transport alias", async () => {
	let ghCalls = 0;
	const result = await resolveCurrentBranchTarget("/repo", {
		gh: async () => { ghCalls++; throw new Error("must not run"); },
		git: fixtureGit({ remotes: ["origin"], branch: "feature", urls: { origin: "https://ssh.github.com/SuuBro/bobbit.git" } }),
	});

	assert.equal(result.code, "HOST_NOT_TRUSTED");
	assert.equal(result.host, "ssh.github.com");
	assert.equal(ghCalls, 0);
});

test("an unknown selected remote fails closed before gh", async () => {
	let ghCalls = 0;
	const result = await resolveCurrentBranchTarget("/repo", {
		gh: async () => { ghCalls++; throw new Error("must not run"); },
		git: fixtureGit({ remotes: ["upstream"], branch: "feature", urls: { upstream: "../local/repo" } }),
	});

	assert.equal(result.code, "REMOTE_UNRESOLVED");
	assert.equal(ghCalls, 0);
});

test("multiple unselected remotes without origin fail closed before gh", async () => {
	let ghCalls = 0;
	const gitCalls: string[][] = [];
	const result = await resolveCurrentBranchTarget("/repo", {
		gh: async () => { ghCalls++; throw new Error("must not run"); },
		git: fixtureGit({
			remotes: ["fork", "upstream"],
			branch: "feature",
			urls: {
				fork: "git@github.com:me/widgets.git",
				upstream: "git@github.com:acme/widgets.git",
			},
		}, gitCalls),
	});

	assert.equal(result.code, "REMOTE_UNRESOLVED");
	assert.equal(ghCalls, 0);
	assert.ok(!gitCalls.some((args) => args[0] === "remote" && args[1] === "get-url"));
});

test("strict whole-remote parsing rejects extra path components before gh", async () => {
	let ghCalls = 0;
	const result = await resolveCurrentBranchTarget("/repo", {
		gh: async () => { ghCalls++; throw new Error("must not run"); },
		git: fixtureGit({ remotes: ["origin"], branch: "feature", urls: { origin: "https://github.com/acme/widgets/extra" } }),
	});

	assert.equal(result.code, "REMOTE_UNRESOLVED");
	assert.equal(ghCalls, 0);
});
