import { describe, expect, it } from "vitest";
import { readOptionalGitPath } from "../../scripts/testing-v2/unit-inventory-git.mjs";

const revision = "0123456789abcdef";
const historicalPath = "scripts/testing-v2/integration-e2e-files.mjs";

function gitFailure(stderr: string, status = 128): Error & { status: number; stderr: Buffer } {
	return Object.assign(new Error("Git failed"), {
		status,
		stderr: Buffer.from(stderr, "utf-8"),
	});
}

describe("optional historical inventory Git source", () => {
	it("returns empty text only when the requested path is absent at the revision", () => {
		const calls: string[][] = [];
		const source = readOptionalGitPath((args: string[]) => {
			calls.push(args);
			throw gitFailure(`fatal: path '${historicalPath}' does not exist in '${revision}'\n`);
		}, { path: historicalPath, revision });

		expect(source).toBe("");
		expect(calls).toEqual([["show", `${revision}:${historicalPath}`]]);
	});

	it("keeps unrelated Git failures fatal", () => {
		const failure = gitFailure("fatal: not a git repository (or any of the parent directories): .git\n");
		let caught: unknown;
		try {
			readOptionalGitPath(() => { throw failure; }, { path: historicalPath, revision });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(failure);
	});
});
