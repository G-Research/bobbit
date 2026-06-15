import test from "node:test";
import assert from "node:assert/strict";

const routesModule = await import("../market-packs/pr-walkthrough/lib/routes.mjs");
const { resolveCurrentBranchTarget } = routesModule.__test;

test("PR walkthrough launch uses GitHub's PR baseRefOid instead of the current base branch tip", async () => {
	const gitCalls: string[][] = [];
	const result = await resolveCurrentBranchTarget("/repo", {
		gh: async (_cwd: string, args: string[]) => {
			if (args[0] === "pr" && args[1] === "view") {
				assert.ok(args.includes("number,url,headRefOid,baseRefOid,baseRefName,headRefName"));
				return JSON.stringify({
					number: 766,
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
			return "current-origin-master-tip";
		},
	});

	assert.equal(result.ok, true);
	assert.equal(result.target.baseSha, "base-at-pr-comparison");
	assert.equal(result.target.headSha, "head-pr-branch");
	assert.equal(result.target.prNumber, 766);
	assert.equal(result.target.owner, "SuuBro");
	assert.equal(result.target.repo, "bobbit");
	assert.deepEqual(gitCalls, [], "current origin/master must not replace GitHub's PR comparison base");
});
