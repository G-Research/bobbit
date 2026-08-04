import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanupFixtures,
	git,
	makeFixture,
	run,
} from "./affected-runner-git-cli.fixture.js";

afterEach(cleanupFixtures);

describe("affected runner Git rename and delete CLI", () => {
	it("preserves rename/delete attribution and fails on an invalid explicit base", async () => {
		const fixture = await makeFixture();
		await git(fixture, ["mv", "semantic.json", "semantic-renamed.json"]);
		rmSync(path.join(fixture.root, "src", "a.ts"));
		const changed = await run(fixture, ["--base", "HEAD", "--dry", "--no-cache"]);
		expect(changed.status).toBe(0);
		expect(changed.json.changed).toEqual(expect.arrayContaining([
			{ path: "semantic-renamed.json", oldPath: "semantic.json", status: "R" },
			{ path: "src/a.ts", status: "D" },
		]));
		expect(changed.json.affected).toContain("tests2/core/a.test.ts");

		const invalid = await run(fixture, ["--base", "definitely-not-a-ref", "--dry"]);
		expect(invalid.status).toBe(2);
		expect(invalid.json).toMatchObject({ outcome: "error" });
		expect(invalid.json.error).toContain("merge-base");
	});
});
