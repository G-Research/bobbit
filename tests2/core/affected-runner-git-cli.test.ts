import { afterEach, describe, expect, it } from "vitest";
import {
	cleanupFixtures,
	commit,
	git,
	makeFixture,
	run,
	write,
} from "./affected-runner-git-cli.fixture.js";

afterEach(cleanupFixtures);

describe("affected runner Git change collection CLI", () => {
	it("collects committed, staged, unstaged, untracked, and explicit change records", async () => {
		const fixture = await makeFixture();
		write(fixture.root, "semantic.json", "committed-semantic-value\n");
		await commit(fixture, "committed semantic change");

		const committed = await run(fixture, ["--base", fixture.base, "--dry", "--no-cache"]);
		expect(committed.status).toBe(0);
		expect(committed.json.changed).toEqual([{ path: "semantic.json", status: "M" }]);
		expect(committed.json.reasons[0]).toBe("semantic:baseline-semantic-value->committed-semantic-value");

		write(fixture.root, "semantic.json", "staged-semantic-value\n");
		await git(fixture, ["add", "semantic.json"]);
		write(fixture.root, "src/a.ts", "export const a = 2;\n");
		write(fixture.root, "docs/untracked.md", "fixture docs\n");
		const overlays = await run(fixture, ["--base", "HEAD", "--dry", "--no-cache"]);
		expect(overlays.status).toBe(0);
		expect(overlays.json.changed).toEqual(expect.arrayContaining([
			{ path: "semantic.json", status: "M" },
			{ path: "src/a.ts", status: "M" },
			{ path: "docs/untracked.md", status: "A" },
		]));
		expect(overlays.json.reasons[0]).toBe("semantic:committed-semantic-value->staged-semantic-value");
		expect(overlays.json.summary).toBe("BOUNDED selected=1, cache-hit=0, run=1");

		const docsOnly = await run(fixture, ["--changed", "docs/untracked.md", "--dry"]);
		expect(docsOnly.json.summary).toBe("SKIP-ALL reason=docs only, selected=0, run=0");

		const explicit = await run(fixture, ["--changed", "semantic.json", "--base", "HEAD", "--dry", "--no-cache"]);
		expect(explicit.status).toBe(0);
		expect(explicit.json.changed).toEqual([{ path: "semantic.json", status: "M" }]);
		expect(explicit.json.kind).toBe("bounded");
	});
});
