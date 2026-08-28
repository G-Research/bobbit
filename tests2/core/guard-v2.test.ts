// Convention-based Test Suite v2 inventory guard.
import { describe, expect, it } from "vitest";
import {
	discoverTests,
	validateIntroducedTestPaths,
} from "../../scripts/testing-v2/test-discovery.mjs";
import { collectIntroducedPaths } from "../../scripts/testing-v2/unit-inventory-git.mjs";

const GUARD_PATH = "tests2/core/guard-v2.test.ts";

describe("guard-v2: convention inventory", () => {
	it("discovers every active test exactly once and covers itself", () => {
		const discovery = discoverTests();
		const leaves = [
			discovery.core,
			discovery.dom,
			discovery.integration,
			discovery.isolated,
			discovery.vitestE2E,
			discovery.browser,
			discovery.browserE2E,
			discovery.e2eGroups.A,
			discovery.e2eGroups.B,
			discovery.manual,
		];
		const assigned = leaves.flat().sort();

		expect(discovery.core).toContain(GUARD_PATH);
		expect(assigned).toEqual(discovery.all);
		expect(new Set(assigned).size).toBe(assigned.length);
	});

	it("uses NUL-safe add-only Git path admission so rename destinations cannot hide", () => {
		const calls: string[][] = [];
		const introduced = collectIntroducedPaths((args: string[]) => {
			calls.push(args);
			if (args[0] === "diff") {
				return Buffer.from("tests/legacy/renamed.test.ts\0tests2/core/name\nwith-newline.test.ts\0");
			}
			return Buffer.from("tests2/core/untracked.test.ts\0");
		}, { mergeBase: "0123456789abcdef0123456789abcdef01234567" });

		expect(calls).toEqual([
			["diff", "--no-renames", "--diff-filter=A", "--name-only", "-z", "0123456789abcdef0123456789abcdef01234567", "--"],
			["ls-files", "--others", "--exclude-standard", "-z"],
		]);
		expect(introduced).toContain("tests/legacy/renamed.test.ts");
		expect(introduced).toContain("tests2/core/name\nwith-newline.test.ts");
		expect(introduced).not.toContain("tests2/core/example.test.ts");
		expect(() => validateIntroducedTestPaths(introduced)).toThrow("tests/legacy/renamed.test.ts");
	});

	it("admits canonical semantic rename destinations without changing execution discovery", () => {
		const before = discoverTests();
		const introduced = collectIntroducedPaths((args: string[]) => Buffer.from(
			args[0] === "diff" ? "tests/unit/isolated/example.isolated.test.ts\0" : "",
		), { mergeBase: "0123456789abcdef0123456789abcdef01234567" });

		expect(() => validateIntroducedTestPaths(introduced)).not.toThrow();
		expect(discoverTests()).toEqual(before);
	});
});
