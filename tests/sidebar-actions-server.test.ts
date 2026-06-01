import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGithubBranchUrl, parseGithubRemoteUrl } from "../src/server/sidebar-actions.ts";

describe("sidebar actions server GitHub remote helpers", () => {
	it("parses sanitized HTTPS and SSH GitHub remotes", () => {
		assert.deepEqual(parseGithubRemoteUrl("https://github.com/Owner/repo.git"), {
			host: "github.com",
			owner: "Owner",
			repo: "repo",
		});
		assert.deepEqual(parseGithubRemoteUrl("git@github.com:owner/repo.git"), {
			host: "github.com",
			owner: "owner",
			repo: "repo",
		});
		assert.deepEqual(parseGithubRemoteUrl("ssh://git@github.com/owner/repo.git"), {
			host: "github.com",
			owner: "owner",
			repo: "repo",
		});
	});

	it("builds encoded branch URLs without leaking credentials", () => {
		assert.equal(
			buildGithubBranchUrl("https://token@github.com/owner/repo.git", "feature/sidebar actions"),
			"https://github.com/owner/repo/tree/feature%2Fsidebar%20actions",
		);
	});

	it("rejects non-GitHub and unsafe remotes", () => {
		assert.equal(buildGithubBranchUrl("https://gitlab.com/owner/repo.git", "feature/x"), null);
		assert.equal(buildGithubBranchUrl("git@github.com:../repo.git", "feature/x"), null);
		assert.equal(buildGithubBranchUrl("file:///tmp/repo", "feature/x"), null);
	});
});
