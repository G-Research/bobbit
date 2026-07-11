import { describe, expect, it } from "vitest";
import {
	baseRefMissingInReposError,
	baseRefSkippedRepoWarning,
	baseRefTagError,
	normalizeBaseRefValue,
	validateBaseRefShape,
} from "../../src/server/base-ref-validation.ts";

function errorFor(value: unknown, sandbox = "none") {
	return validateBaseRefShape({ value, sandbox });
}

describe("validateBaseRefShape", () => {
	it("accepts unset and branch-shaped values", () => {
		for (const value of [undefined, null, 42, "", "   ", "master", "develop", "origin/main", "origin/feature/foo", "feature/foo", "release/2026.07", "abc123"]) {
			expect(errorFor(value), String(value)).toBeNull();
		}
	});

	it("trims string values before validation", () => {
		expect(normalizeBaseRefValue("  origin/develop\n")).toBe("origin/develop");
		expect(errorFor("  origin/develop\n")).toBeNull();
	});

	it("rejects commit SHA shapes with the exact error string", () => {
		for (const value of ["abc123d", "abc123def", "0123456789abcdef0123456789abcdef01234567"]) {
			expect(errorFor(value)).toEqual({
				field: "base_ref",
				error: `base_ref must be a branch ref, not a commit SHA. Got: ${value}`,
			});
		}
	});

	it("rejects invalid branch grammar with the exact error string", () => {
		for (const value of ["feature foo", "feature..foo", "feature@{foo", "feature~foo", "feature^foo", "feature?foo", "feature*foo", "-feature", "feature."]) {
			expect(errorFor(value), value).toEqual({
				field: "base_ref",
				error: `base_ref must be a valid branch name. Got: ${value}`,
			});
		}
	});

	it("rejects known non-origin remote prefixes with the exact error string", () => {
		for (const prefix of ["upstream", "fork", "mirror", "github", "gitlab", "bitbucket", "remote"]) {
			const value = `${prefix}/main`;
			expect(errorFor(value), value).toEqual({
				field: "base_ref",
				error: `base_ref only supports the 'origin' remote today. Got: ${value}. If you need a different primary remote, configure it as 'origin' in your local clone.`,
			});
		}
	});

	it("rejects local refs for docker sandbox projects with the exact error string", () => {
		expect(errorFor("master", "docker")).toEqual({
			field: "base_ref",
			error: "base_ref must be a remote ref (origin/...) for sandboxed projects. The container has separate ref visibility from the host. Got: master",
		});
		expect(errorFor("feature/foo", "docker")).toEqual({
			field: "base_ref",
			error: "base_ref must be a remote ref (origin/...) for sandboxed projects. The container has separate ref visibility from the host. Got: feature/foo",
		});
		expect(errorFor("origin/master", "docker")).toBeNull();
	});
});

describe("base_ref repo validation error formatters", () => {
	it("formats tag, missing-ref details, and skipped-repo warnings", () => {
		expect(baseRefTagError("v1.2.3")).toEqual({
			field: "base_ref",
			error: "base_ref must be a branch ref, not a tag. Tags can't be used as git upstreams. Got: v1.2.3",
		});
		expect(baseRefMissingInReposError("origin/develop", [{ component: "web", message: "ref not found" }], 3)).toEqual({
			field: "base_ref",
			error: "base_ref 'origin/develop' is not present in 1 of 3 component repos",
			details: [{ component: "web", message: "ref not found" }],
		});
		expect(baseRefSkippedRepoWarning("docs", "/tmp/docs")).toBe("base_ref validation skipped for component 'docs': not a git repo at /tmp/docs");
	});
});
