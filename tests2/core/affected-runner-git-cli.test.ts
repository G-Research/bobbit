import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanupFixtures,
	commit,
	git,
	invocations,
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

	it("plans auditable bounded JSON for exact registered input deletes across Git collection modes", async () => {
		const unitFiles = ["tests2/core/a.test.ts", "tests2/core/b.test.ts"];

		const committedFixture = await makeFixture();
		rmSync(path.join(committedFixture.root, "defaults", "roles", "coder.yaml"));
		await commit(committedFixture, "delete registered exact input");
		const committed = await run(committedFixture, ["--base", committedFixture.base, "--dry"]);
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

		const stagedFixture = await makeFixture();
		rmSync(path.join(stagedFixture.root, "defaults", "roles", "coder.yaml"));
		await git(stagedFixture, ["add", "defaults/roles/coder.yaml"]);
		const staged = await run(stagedFixture, ["--base", "HEAD", "--dry"]);
		expect(staged.status).toBe(0);
		expect(staged.json.changed).toEqual([{ path: "defaults/roles/coder.yaml", status: "D" }]);
		expect(staged.json.summary).toBe("BOUNDED selected=1, cache-hit=0, run=1");

		const unstagedFixture = await makeFixture();
		rmSync(path.join(unstagedFixture.root, "defaults", "roles", "coder.yaml"));
		const unstaged = await run(unstagedFixture, ["--base", "HEAD", "--dry"]);
		expect(unstaged.status).toBe(0);
		expect(unstaged.json.changed).toEqual([{ path: "defaults/roles/coder.yaml", status: "D" }]);
		expect(unstaged.json.kind).toBe("bounded");

		const explicitFixture = await makeFixture();
		const warm = await run(explicitFixture, ["--all"]);
		expect(warm.status).toBe(0);
		rmSync(path.join(explicitFixture.root, "defaults", "roles", "coder.yaml"));
		const explicit = await run(explicitFixture, ["--changed", "defaults\\roles\\coder.yaml", "--base", explicitFixture.base]);
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
		expect(invocations(explicitFixture)).toEqual([unitFiles, ["tests2/core/a.test.ts"]]);
	});

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
