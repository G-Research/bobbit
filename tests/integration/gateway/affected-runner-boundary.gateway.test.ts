import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	commit,
	createAffectedRunnerFixture,
	git,
	removeAffectedRunnerFixture,
	runAffectedCli,
	type AffectedRunnerFixture,
	writeFixture,
} from "./_helpers/_affected-runner-boundary-fixture.js";

describe.sequential("affected runner CLI and real-Git boundary", () => {
	let fixture: AffectedRunnerFixture | undefined;

	beforeAll(async () => {
		fixture = await createAffectedRunnerFixture();
	});

	afterAll(() => {
		removeAffectedRunnerFixture(fixture);
	});

	it("accepts CLI arguments and emits machine-readable JSON with a successful exit", async () => {
		const result = await runAffectedCli(fixture!, [
			"--changed", "docs/readme.md",
			"--base", fixture!.base,
			"--dry",
			"--no-cache",
		]);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout.trim().split(/\r?\n/u)).toHaveLength(1);
		expect(result.json).toMatchObject({
			kind: "skip-all",
			cachePolicy: "eligible",
			changed: [{ path: "docs/readme.md", status: "M" }],
			affected: [],
			toRun: [],
			outcome: "skip-all",
			counts: { total: 1, selected: 0, cacheHit: 0, run: 0 },
		});
	});

	it("collects committed, staged, unstaged, untracked, rename, and delete records and fails closed for an invalid base", async () => {
		writeFixture(fixture!, "src/committed.ts", "export const committed = 2;\n");
		await commit(fixture!, "committed source change");

		writeFixture(fixture!, "src/staged.ts", "export const staged = 2;\n");
		await git(fixture!, ["add", "src/staged.ts"]);
		writeFixture(fixture!, "src/unstaged.ts", "export const unstaged = 2;\n");
		writeFixture(fixture!, "src/untracked.ts", "export const untracked = true;\n");
		await git(fixture!, ["mv", "src/rename-old.ts", "docs/rename-new.md"]);
		rmSync(path.join(fixture!.root, "src", "deleted.ts"));

		const changed = await runAffectedCli(fixture!, [
			"--base", fixture!.base,
			"--dry",
			"--no-cache",
		]);

		expect(changed.status).toBe(0);
		expect(changed.stderr).toBe("");
		expect(changed.json.changed).toHaveLength(6);
		expect(changed.json.changed).toEqual(expect.arrayContaining([
			{ path: "src/committed.ts", status: "M" },
			{ path: "src/staged.ts", status: "M" },
			{ path: "src/unstaged.ts", status: "M" },
			{ path: "src/untracked.ts", status: "A" },
			{ path: "docs/rename-new.md", oldPath: "src/rename-old.ts", status: "R" },
			{ path: "src/deleted.ts", status: "D" },
		]));
		expect(changed.json).toMatchObject({
			kind: "bounded",
			cachePolicy: "eligible",
			affected: ["tests2/core/fixture.test.ts"],
			toRun: ["tests2/core/fixture.test.ts"],
			outcome: "dry",
			counts: { total: 1, selected: 1, cacheHit: 0, run: 1 },
		});
		expect(changed.json.reasons).toEqual(expect.arrayContaining([
			"source:src/rename-old.ts",
			"source:src/deleted.ts",
		]));

		const invalidBase = await runAffectedCli(fixture!, [
			"--base", "definitely-not-a-ref",
			"--dry",
			"--no-cache",
		]);
		expect(invalidBase.status).toBe(2);
		expect(invalidBase.json).toMatchObject({ outcome: "error" });
		expect(invalidBase.json.error).toMatch(/merge-base/i);
	});
});
