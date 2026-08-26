import { describe, expect, it, vi } from "vitest";
import {
	resolveCodeReviewBaseBranch,
	type GitInvoker,
} from "../../manual/_helpers/resolve-primary-branch.js";

describe("manual workflow primary branch resolution", () => {
	it("keeps CODE_REVIEW_BASE authoritative without invoking Git", () => {
		const runGit = vi.fn(() => "origin/ignored\n") as unknown as GitInvoker;
		expect(resolveCodeReviewBaseBranch("repo-root", "explicit/base", runGit)).toBe("explicit/base");
		expect(runGit).not.toHaveBeenCalled();
	});

	it("resolves and strips origin/HEAD through an argument-array Git call", () => {
		const runGit = vi.fn(() => "origin/release/next\n") as unknown as GitInvoker;

		expect(resolveCodeReviewBaseBranch("repo-root", undefined, runGit)).toBe("release/next");
		expect(runGit).toHaveBeenCalledWith(
			"git",
			["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
			{ cwd: "repo-root", encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
	});

	it("falls back to main when symbolic-ref resolution is unavailable or malformed", () => {
		const unavailable = (() => { throw new Error("git unavailable"); }) as GitInvoker;
		expect(resolveCodeReviewBaseBranch("repo-root", undefined, unavailable)).toBe("main");
		expect(resolveCodeReviewBaseBranch("repo-root", undefined, () => "refs/heads/topic\n")).toBe("main");
	});
});
