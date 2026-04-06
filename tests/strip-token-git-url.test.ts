/**
 * Unit tests for stripTokenFromGitUrl() — ensures embedded credentials
 * are stripped from git remote URLs before passing them to sandbox containers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripTokenFromGitUrl } from "../dist/server/skills/git.js";

describe("stripTokenFromGitUrl", () => {
	it("strips token from https URL with username", () => {
		const url = "https://ghp_abc123@github.com/user/repo.git";
		assert.equal(stripTokenFromGitUrl(url), "https://github.com/user/repo.git");
	});

	it("strips token from https URL with x-access-token username and password", () => {
		const url = "https://x-access-token:ghp_abc123@github.com/user/repo.git";
		assert.equal(stripTokenFromGitUrl(url), "https://github.com/user/repo.git");
	});

	it("strips oauth2 token from URL", () => {
		const url = "https://oauth2:gho_xxxx@github.com/org/repo.git";
		assert.equal(stripTokenFromGitUrl(url), "https://github.com/org/repo.git");
	});

	it("leaves clean https URL unchanged", () => {
		const url = "https://github.com/user/repo.git";
		assert.equal(stripTokenFromGitUrl(url), "https://github.com/user/repo.git");
	});

	it("leaves SSH URL unchanged", () => {
		const url = "git@github.com:user/repo.git";
		assert.equal(stripTokenFromGitUrl(url), "git@github.com:user/repo.git");
	});

	it("leaves local path unchanged", () => {
		const url = "/home/user/project";
		assert.equal(stripTokenFromGitUrl(url), "/home/user/project");
	});

	it("leaves Windows local path unchanged", () => {
		const url = "C:\\Users\\dev\\project";
		assert.equal(stripTokenFromGitUrl(url), "C:\\Users\\dev\\project");
	});

	it("handles empty string", () => {
		assert.equal(stripTokenFromGitUrl(""), "");
	});
});
