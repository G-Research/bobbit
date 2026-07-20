import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBobbitAppInfo } from "../../src/server/app-info.js";

const tempRoots: string[] = [];

function packageRoot(version = "0.14.1"): string {
	const root = mkdtempSync(path.join(tmpdir(), "bobbit-app-info-"));
	tempRoots.push(root);
	writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "bobbit", version }), "utf-8");
	return root;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Bobbit app info", () => {
	it("reports an installed package with only its package version", () => {
		const root = packageRoot();
		let commitRead = false;

		expect(resolveBobbitAppInfo(root, () => {
			commitRead = true;
			return "e3563ba";
		})).toEqual({ version: "0.14.1", buildType: "installed" });
		expect(commitRead).toBe(false);
	});

	it("reports a source checkout with a normalized short commit SHA", () => {
		const root = packageRoot();
		mkdirSync(path.join(root, ".git"));

		expect(resolveBobbitAppInfo(root, () => "E3563BA91A2")).toEqual({
			version: "0.14.1",
			buildType: "source",
			commitSha: "e3563ba",
		});
	});

	it("reads the source commit directly from Git metadata", () => {
		const root = packageRoot();
		const gitDir = path.join(root, ".git");
		mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
		writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/master\n", "utf-8");
		writeFileSync(path.join(gitDir, "refs", "heads", "master"), "e3563ba91a234567890123456789012345678901\n", "utf-8");

		expect(resolveBobbitAppInfo(root)).toEqual({
			version: "0.14.1",
			buildType: "source",
			commitSha: "e3563ba",
		});
	});
});
