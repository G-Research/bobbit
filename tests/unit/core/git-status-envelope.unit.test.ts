import { describe, expect, it, vi } from "vitest";
import {
	aggregateGitStatusProbes,
	collectGitStatusEnvelope,
	type GitStatusProbe,
	type GitStatusResult,
} from "../../../src/server/skills/git-status-envelope.ts";

function status(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
	return {
		branch: "goal/test",
		primaryBranch: "master",
		primaryRef: "origin/master",
		isOnPrimary: false,
		status: [],
		hasUpstream: true,
		ahead: 0,
		behind: 0,
		aheadOfPrimary: 0,
		behindPrimary: 0,
		mergedIntoPrimary: false,
		insertionsVsPrimary: 0,
		deletionsVsPrimary: 0,
		clean: true,
		summary: "clean",
		unpushed: false,
		partial: false,
		untrackedIncluded: true,
		...overrides,
	};
}

const notRepo = (diagnostic = "fatal: not a git repository"): GitStatusProbe => ({ kind: "not-repository", diagnostic });
const failed = (diagnostic = "temporary failure"): GitStatusProbe => ({ kind: "error", error: new Error(diagnostic), diagnostic });
const ok = (result: GitStatusResult): GitStatusProbe => ({ kind: "success", result });

describe("aggregateGitStatusProbes", () => {
	it("uses components authoritatively and synthesizes all aggregate fields", () => {
		const root = status({ branch: "wrong-root", ahead: 99, clean: true });
		const api = status({ branch: "component-branch", ahead: 2, behind: 1, aheadOfPrimary: 3, insertionsVsPrimary: 8, clean: true, unpushed: false });
		const web = status({ branch: "component-branch", ahead: 4, behind: 5, behindPrimary: 7, deletionsVsPrimary: 9, clean: false, unpushed: true });
		const collected = aggregateGitStatusProbes(ok(root), [
			{ target: { repo: "api", worktreePath: "/api" }, probe: ok(api) },
			{ target: { repo: "web", worktreePath: "/web" }, probe: ok(web) },
		]);

		expect(collected.kind).toBe("success");
		if (collected.kind !== "success") return;
		expect(collected.envelope.aggregate).toMatchObject({
			branch: "component-branch",
			ahead: 6,
			behind: 6,
			aheadOfPrimary: 3,
			behindPrimary: 7,
			insertionsVsPrimary: 8,
			deletionsVsPrimary: 9,
			clean: false,
			unpushed: true,
			partial: false,
			untrackedIncluded: true,
		});
		expect(Object.keys(collected.envelope.repos)).toEqual(["api", "web"]);
	});

	it("reports merged when every successful component has a complete merged comparison", () => {
		const collected = aggregateGitStatusProbes(notRepo(), [
			{ target: { repo: "api", worktreePath: "/api" }, probe: ok(status({ mergedIntoPrimary: true })) },
			{ target: { repo: "web", worktreePath: "/web" }, probe: ok(status({ mergedIntoPrimary: true })) },
		]);
		expect(collected.kind).toBe("success");
		if (collected.kind !== "success") return;
		expect(collected.envelope.aggregate.mergedIntoPrimary).toBe(true);
	});

	it("does not copy merged state from an untouched first component when a later component is ahead", () => {
		const collected = aggregateGitStatusProbes(notRepo(), [
			{ target: { repo: "api", worktreePath: "/api" }, probe: ok(status({ mergedIntoPrimary: true })) },
			{ target: { repo: "web", worktreePath: "/web" }, probe: ok(status({ aheadOfPrimary: 1, mergedIntoPrimary: false })) },
		]);
		expect(collected.kind).toBe("success");
		if (collected.kind !== "success") return;
		expect(collected.envelope.aggregate.aheadOfPrimary).toBe(1);
		expect(collected.envelope.aggregate.mergedIntoPrimary).toBe(false);
	});

	it("does not report merged when a successful component comparison is partial", () => {
		const collected = aggregateGitStatusProbes(notRepo(), [
			{ target: { repo: "api", worktreePath: "/api" }, probe: ok(status({ mergedIntoPrimary: true })) },
			{ target: { repo: "web", worktreePath: "/web" }, probe: ok(status({ mergedIntoPrimary: true, partial: true })) },
		]);
		expect(collected.kind).toBe("success");
		if (collected.kind !== "success") return;
		expect(collected.envelope.aggregate.partial).toBe(true);
		expect(collected.envelope.aggregate.mergedIntoPrimary).toBe(false);
	});

	it("keeps valid siblings and marks a failed configured component partial", () => {
		const collected = aggregateGitStatusProbes(notRepo(), [
			{ target: { repo: "api", worktreePath: "/api" }, probe: ok(status({ mergedIntoPrimary: true })) },
			{ target: { repo: "missing", worktreePath: "/missing" }, probe: failed("missing") },
		]);
		expect(collected.kind).toBe("success");
		if (collected.kind !== "success") return;
		expect(Object.keys(collected.envelope.repos)).toEqual(["api"]);
		expect(collected.envelope.aggregate.partial).toBe(true);
		expect(collected.envelope.aggregate.mergedIntoPrimary).toBe(false);
		expect(collected.envelope.aggregate.untrackedIncluded).toBe(false);
	});

	it("supports one named component while preserving sole-dot flat compatibility", () => {
		const namedResult = status({ status: [{ file: "a.ts", status: "M" }], clean: false });
		const named = aggregateGitStatusProbes(notRepo(), [
			{ target: { repo: "api", worktreePath: "/api" }, probe: ok(namedResult) },
		]);
		expect(named.kind).toBe("success");
		if (named.kind !== "success") return;
		expect(Object.keys(named.envelope.repos)).toEqual(["api"]);
		expect(named.envelope.aggregate.status).toEqual([]);

		const dot = aggregateGitStatusProbes(ok(namedResult), [
			{ target: { repo: ".", worktreePath: "/root" }, probe: ok(namedResult) },
		]);
		expect(dot.kind).toBe("success");
		if (dot.kind !== "success") return;
		expect(dot.envelope.aggregate).toBe(namedResult);
		expect(dot.envelope.status).toEqual(namedResult.status);
	});

	it("falls back to root, but returns terminal only when all probes are definitively non-Git", () => {
		const root = status({ branch: "root" });
		const fallback = aggregateGitStatusProbes(ok(root), [
			{ target: { repo: "missing", worktreePath: "/missing" }, probe: failed() },
		]);
		expect(fallback.kind).toBe("success");
		if (fallback.kind === "success") {
			expect(fallback.envelope.branch).toBe("root");
			expect(fallback.envelope.partial).toBe(true);
			expect(Object.keys(fallback.envelope.repos)).toEqual(["."]);
		}

		expect(aggregateGitStatusProbes(notRepo(), [
			{ target: { repo: "api", worktreePath: "/api" }, probe: notRepo() },
		]).kind).toBe("not-repository");
		expect(aggregateGitStatusProbes(notRepo(), [
			{ target: { repo: "api", worktreePath: "/missing" }, probe: failed("missing") },
		]).kind).toBe("error");
	});
});

describe("collectGitStatusEnvelope", () => {
	it("classifies missing host component paths as retryable while preserving valid repos", async () => {
		const probes = new Map<string, GitStatusProbe>([
			["/root", notRepo()],
			["/api", ok(status())],
		]);
		const collected = await collectGitStatusEnvelope({
			rootPath: "/root",
			components: [
				{ repo: "api", worktreePath: "/api" },
				{ repo: "gone", worktreePath: "/gone" },
			],
			pathExists: path => path !== "/gone",
			probe: async path => probes.get(path) ?? failed("unexpected"),
		});
		expect(collected.kind).toBe("success");
		if (collected.kind === "success") {
			expect(Object.keys(collected.envelope.repos)).toEqual(["api"]);
			expect(collected.envelope.partial).toBe(true);
		}
	});

	it("returns retryable error when every configured path is missing", async () => {
		const collected = await collectGitStatusEnvelope({
			rootPath: "/root",
			components: [{ repo: "api", worktreePath: "/api" }],
			pathExists: () => false,
			probe: async () => notRepo(),
		});
		expect(collected.kind).toBe("error");
		if (collected.kind === "error") expect(collected.diagnostic).toMatch(/not found/i);
	});

	it("fetches and invalidates every deduplicated target despite individual failures", async () => {
		const fetched: string[] = [];
		const invalidated: string[] = [];
		const probe = vi.fn(async (path: string) => path === "/root" ? notRepo() : ok(status()));
		const collected = await collectGitStatusEnvelope({
			rootPath: "/root",
			components: [
				{ repo: "api", worktreePath: "/api" },
				{ repo: "api-alias", worktreePath: "/api" },
			],
			pathExists: () => true,
			fetchTarget: async path => {
				fetched.push(path);
				if (path === "/root") throw new Error("fetch failed");
			},
			invalidateTarget: path => invalidated.push(path),
			probe,
		});
		expect(collected.kind).toBe("success");
		expect(fetched).toEqual(["/root", "/api"]);
		expect(invalidated).toEqual(["/root", "/api"]);
		expect(probe).toHaveBeenCalledTimes(2);
	});
});
