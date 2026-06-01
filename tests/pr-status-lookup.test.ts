import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	__getCachedPrStatusForTests,
	__resetPrStatusCachesForTests,
	__setGhExecFileForPrStatusTests,
	buildGhPrViewArgs,
} from "../src/server/server.ts";

const PR_FIELDS = "state,url,number,title,mergeable,headRefName,reviewDecision";

describe("PR status GitHub CLI lookup", () => {
	afterEach(() => {
		__setGhExecFileForPrStatusTests(undefined);
		__resetPrStatusCachesForTests();
	});

	it("builds gh pr view as argv so malicious branch text stays one argument", () => {
		const branch = "feature/sidebar-actions && node -e \"throw new Error('shell executed')\"";
		assert.deepEqual(buildGhPrViewArgs(branch), ["pr", "view", branch, "--json", PR_FIELDS]);
		assert.deepEqual(buildGhPrViewArgs(), ["pr", "view", "--json", PR_FIELDS]);
	});

	it("looks up PR status through execFile argv without shell interpolation", async () => {
		const branch = "feature/sidebar-actions && node -e \"throw new Error('shell executed')\"";
		const calls: Array<{ args: string[]; cwd: string; timeout: number }> = [];

		__setGhExecFileForPrStatusTests(async (args, opts) => {
			calls.push({ args: [...args], cwd: opts.cwd, timeout: opts.timeout });
			if (args[0] === "pr" && args[1] === "view") {
				return JSON.stringify({
					state: "OPEN",
					url: "https://github.com/acme/widget/pull/7",
					number: 7,
					title: "Sidebar actions",
					mergeable: "MERGEABLE",
					headRefName: branch,
					reviewDecision: "APPROVED",
				});
			}
			if (args[0] === "repo" && args[1] === "view") {
				return JSON.stringify({ viewerPermission: "ADMIN" });
			}
			throw new Error(`unexpected gh args: ${args.join(" ")}`);
		});

		const status = await __getCachedPrStatusForTests("/repo/worktree", branch, "/repo/main");

		assert.deepEqual(status, {
			number: 7,
			url: "https://github.com/acme/widget/pull/7",
			title: "Sidebar actions",
			state: "OPEN",
			mergeable: "MERGEABLE",
			headRefName: branch,
			reviewDecision: "APPROVED",
			viewerIsAdmin: true,
		});
		assert.deepEqual(calls.map((call) => call.args), [
			["pr", "view", branch, "--json", PR_FIELDS],
			["repo", "view", "--json", "viewerPermission"],
		]);
		assert.equal(calls[0].args[2], branch);
	});
});
