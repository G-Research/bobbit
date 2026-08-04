import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanupFixtures,
	git,
	makeFixture,
	run,
} from "./affected-runner-git-cli.fixture.js";

afterEach(cleanupFixtures);

describe("affected runner graph-owned Markdown CLI", () => {
	it("keeps graph-owned Markdown deletes and rename-outs out of SKIP-ALL", async () => {
		const fixture = await makeFixture();
		rmSync(path.join(fixture.root, "market-packs", "example", "README.md"));
		const deleted = await run(fixture, ["--base", "HEAD", "--dry", "--no-cache"]);
		expect(deleted.status).toBe(0);
		expect(deleted.json).toMatchObject({
			kind: "bounded",
			cachePolicy: "eligible",
			changed: [{ path: "market-packs/example/README.md", status: "D" }],
		});
		expect(deleted.json.summary).not.toContain("SKIP-ALL");

		const renameFixture = await makeFixture();
		mkdirSync(path.join(renameFixture.root, "docs"), { recursive: true });
		await git(renameFixture, ["mv", "market-packs/example/README.md", "docs/example-pack.md"]);
		const renamedOut = await run(renameFixture, ["--base", "HEAD", "--dry", "--no-cache"]);
		expect(renamedOut.status).toBe(0);
		expect(renamedOut.json.changed).toEqual([{
			path: "docs/example-pack.md",
			oldPath: "market-packs/example/README.md",
			status: "R",
		}]);
		expect(renamedOut.json.kind).toBe("bounded");
		expect(renamedOut.json.summary).not.toContain("SKIP-ALL");
	});
});
