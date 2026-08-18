// Current-branch PR resolution and local origin-host trust preflight.

import { test } from "vitest";
import assert from "node:assert/strict";

const routesModule = await import("../../market-packs/pr-walkthrough/lib/routes.mjs");
const { resolveCurrentBranchTarget } = routesModule.__test;

test("PR walkthrough launch uses GitHub's PR baseRefOid instead of the current base branch tip", async () => {
	const gitCalls: string[][] = [];
	const result = await resolveCurrentBranchTarget("/repo", {
		gh: async (_cwd: string, args: string[]) => {
			if (args[0] === "pr" && args[1] === "view") {
				assert.ok(args.includes("number,title,body,url,headRefOid,baseRefOid,baseRefName,headRefName"));
				return JSON.stringify({
					number: 766,
					title: "Improve PR walkthrough header",
					body: "## Summary\nPreserve the launch-time PR description.",
					url: "https://github.com/SuuBro/bobbit/pull/766",
					headRefOid: "head-pr-branch",
					baseRefOid: "base-at-pr-comparison",
					baseRefName: "master",
					headRefName: "session/aab88279",
				});
			}
			if (args[0] === "repo" && args[1] === "view") {
				return JSON.stringify({ owner: { login: "SuuBro" }, name: "bobbit" });
			}
			throw new Error(`unexpected gh args: ${args.join(" ")}`);
		},
		git: async (_cwd: string, args: string[]) => {
			gitCalls.push(args);
			if (args.join(" ") === "remote get-url origin") return "git@github.com:SuuBro/bobbit.git";
			return "current-origin-master-tip";
		},
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
	assert.deepEqual(gitCalls, [["remote", "get-url", "origin"]], "only the local trust preflight should read git when PR OIDs are complete");
});

test("unknown enterprise origin returns HOST_NOT_TRUSTED before any gh call", async () => {
	const ghCalls: string[][] = [];
	const result = await resolveCurrentBranchTarget("/repo", {
		gh: async (_cwd: string, args: string[]) => { ghCalls.push(args); throw new Error("must not run"); },
		git: async () => "git@ghe.example.com:acme/widgets.git",
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, "HOST_NOT_TRUSTED");
	assert.equal(result.host, "ghe.example.com");
	assert.equal(result.retryable, true);
	assert.deepEqual(ghCalls, [], "trust must be decided before gh pr/repo resolution");
});

test("an exact enterprise origin ack allows gh resolution", async () => {
	const ghCalls: string[][] = [];
	const result = await resolveCurrentBranchTarget("/repo", {
		gh: async (_cwd: string, args: string[]) => {
			ghCalls.push(args);
			if (args[0] === "pr") return JSON.stringify({
				number: 7,
				url: "https://ghe.example.com/acme/widgets/pull/7",
				headRefOid: "head",
				baseRefOid: "base",
			});
			return JSON.stringify({ owner: { login: "acme" }, name: "widgets" });
		},
		git: async () => "https://ghe.example.com/acme/widgets.git",
	}, "ghe.example.com");

	assert.equal(result.ok, true);
	assert.equal(result.target.prUrl, "https://ghe.example.com/acme/widgets/pull/7");
	assert.deepEqual(ghCalls.map((args) => args.slice(0, 2)), [["pr", "view"], ["repo", "view"]]);
});

test("a mismatched enterprise origin ack still performs no gh call", async () => {
	let ghCalls = 0;
	const result = await resolveCurrentBranchTarget("/repo", {
		gh: async () => { ghCalls++; throw new Error("must not run"); },
		git: async () => "ssh://git@ghe.example.com/acme/widgets.git",
	}, "other.example.com");

	assert.equal(result.code, "HOST_NOT_TRUSTED");
	assert.equal(result.host, "ghe.example.com");
	assert.equal(ghCalls, 0);
});

test("an origin whose host cannot be safely derived fails closed before gh", async () => {
	let ghCalls = 0;
	const result = await resolveCurrentBranchTarget("/repo", {
		gh: async () => { ghCalls++; throw new Error("must not run"); },
		git: async () => "../local/repo",
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, "REMOTE_UNRESOLVED");
	assert.equal(ghCalls, 0);
});
