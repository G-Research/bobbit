import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanupFixtures,
	commit,
	git,
	invocations,
	makeFixture,
	run,
} from "./affected-runner-git-cli.fixture.js";

afterEach(cleanupFixtures);

describe("affected runner exact-input delete CLI", () => {
	it("plans auditable bounded JSON for exact registered input deletes across Git collection modes", async () => {
		const unitFiles = ["tests2/core/a.test.ts", "tests2/core/b.test.ts"];

		const fixture = await makeFixture();
		rmSync(path.join(fixture.root, "defaults", "roles", "coder.yaml"));
		await commit(fixture, "delete registered exact input");
		const committed = await run(fixture, ["--base", fixture.base, "--dry"]);
		expect(committed.status).toBe(0);
		expect(committed.json).toMatchObject({
			kind: "bounded",
			cachePolicy: "eligible",
			changed: [{ path: "defaults/roles/coder.yaml", status: "D" }],
			affected: ["tests2/core/a.test.ts"],
			cacheHits: [],
			toRun: ["tests2/core/a.test.ts"],
			outcome: "dry",
		});
		expect(committed.json.outcome).not.toBe("error");

		await git(fixture, ["reset", "--hard", fixture.base]);
		rmSync(path.join(fixture.root, "defaults", "roles", "coder.yaml"));
		await git(fixture, ["add", "defaults/roles/coder.yaml"]);
		const staged = await run(fixture, ["--base", "HEAD", "--dry"]);
		expect(staged.status).toBe(0);
		expect(staged.json.changed).toEqual([{ path: "defaults/roles/coder.yaml", status: "D" }]);
		expect(staged.json.summary).toBe("BOUNDED selected=1, cache-hit=0, run=1");

		await git(fixture, ["reset", "--hard", "HEAD"]);
		rmSync(path.join(fixture.root, "defaults", "roles", "coder.yaml"));
		const unstaged = await run(fixture, ["--base", "HEAD", "--dry"]);
		expect(unstaged.status).toBe(0);
		expect(unstaged.json.changed).toEqual([{ path: "defaults/roles/coder.yaml", status: "D" }]);
		expect(unstaged.json.kind).toBe("bounded");

		await git(fixture, ["reset", "--hard", "HEAD"]);
		const warm = await run(fixture, ["--all"]);
		expect(warm.status).toBe(0);
		rmSync(path.join(fixture.root, "defaults", "roles", "coder.yaml"));
		const explicit = await run(fixture, ["--changed", "defaults\\roles\\coder.yaml", "--base", fixture.base]);
		expect(explicit.status).toBe(0);
		expect(explicit.json).toMatchObject({
			kind: "bounded",
			cachePolicy: "eligible",
			changed: [{ path: "defaults/roles/coder.yaml", status: "D" }],
			cacheHits: [],
			toRun: ["tests2/core/a.test.ts"],
			outcome: "pass",
			counts: { total: 2, selected: 1, cacheHit: 0, run: 1 },
		});
		expect(invocations(fixture)).toEqual([unitFiles, ["tests2/core/a.test.ts"]]);
	});
});
