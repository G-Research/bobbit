import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	collectLayoutDiagnostics,
	countLayoutState,
	formatLayoutDiagnostics,
	listRepositoryFiles,
} from "../../../scripts/testing/check-layout.mjs";
import {
	createTestFile,
	scaffoldTestPath,
	scaffoldTestSource,
} from "../../../scripts/testing/create-test.mjs";
import { TEST_LAYOUT, validateTestPath } from "../../../scripts/testing/layout-policy.mjs";
import { collectIntroducedPaths } from "../../../scripts/testing-v2/unit-inventory-git.mjs";

type Convention = { semantic: string; directory: string; suffix: string };
type Diagnostic = { code: string };

const temporaryRoots: string[] = [];
afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("transitional test layout guard", () => {
	it("uses NUL-safe Git output for tracked and untracked repository files", () => {
		const execFile = vi.fn(() => Buffer.from("tests/dom/a b.dom.test.ts\0tests/dom/line\nb.dom.test.ts\0")) as unknown as typeof execFileSync;
		expect(listRepositoryFiles("repo-root", execFile)).toEqual([
			"tests/dom/a b.dom.test.ts",
			"tests/dom/line\nb.dom.test.ts",
		]);
		expect(execFile).toHaveBeenCalledWith(
			["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
			"repo-root",
		);
	});

	it("admits add, copy, and rename destinations plus untracked paths without newline splitting", () => {
		const calls: string[][] = [];
		const introduced = collectIntroducedPaths((args: string[]) => {
			calls.push(args);
			return Buffer.from(args[0] === "diff"
				? "tests/dom/copied.dom.test.ts\0tests/dom/line\nrenamed.dom.test.ts\0"
				: "tests/dom/untracked.dom.test.ts\0");
		}, { mergeBase: "0123456789abcdef0123456789abcdef01234567" });
		expect(calls[0]).toEqual(["diff", "--no-renames", "--diff-filter=A", "--name-only", "-z", expect.any(String), "--"]);
		expect(introduced).toEqual([
			"tests/dom/copied.dom.test.ts",
			"tests/dom/line\nrenamed.dom.test.ts",
			"tests/dom/untracked.dom.test.ts",
		]);
	});

	it("reports legacy paths without failing them, while rejecting newly introduced paths", () => {
		const allPaths = [
			"tests2/core/existing.test.ts",
			"tests/legacy.test.ts",
			"tests/dom/good.dom.test.ts",
		];
		expect(countLayoutState(allPaths)).toEqual({ canonical: 1, transitional: 1, unowned: 1, runnable: 3 });
		expect(collectLayoutDiagnostics({
			root: "synthetic-root",
			allPaths,
			introducedPaths: [],
			fileExists: () => true,
			readSource: () => 'import { it } from "vitest";',
		})).toEqual([]);

		const diagnostics = collectLayoutDiagnostics({
			root: "synthetic-root",
			allPaths,
			introducedPaths: ["tests2/core/new.test.ts", "tests/wrong/panel.dom.test.ts"],
			fileExists: () => true,
			readSource: () => 'import { it } from "vitest";',
		});
		expect(diagnostics.map(({ code }: Diagnostic) => code)).toEqual(["wrong-directory", "unclassified-test"]);
		expect(formatLayoutDiagnostics(diagnostics)).toContain("tests/dom/**/*.dom.test.ts");
	});

	it("rejects a canonical admission that dynamically loads the wrong runner", () => {
		const filePath = "tests/unit/core/dynamic-runner.unit.test.ts";
		const diagnostics = collectLayoutDiagnostics({
			root: "synthetic-root",
			allPaths: [filePath],
			introducedPaths: [filePath],
			fileExists: () => true,
			readSource: () => 'const runner = await import("node:test");',
		});
		expect(diagnostics.map(({ code }: Diagnostic) => code)).toContain("runner-import-mismatch");
	});

	it("wires the layout guard ahead of typechecking", () => {
		const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
		expect(manifest.scripts["test:layout"]).toBe("node scripts/testing/check-layout.mjs");
		expect(manifest.scripts["test:new"]).toBe("node scripts/testing/create-test.mjs");
		expect(manifest.scripts.check.startsWith("npm run test:layout && ")).toBe(true);
	});
});

describe("canonical test scaffold", () => {
	for (const convention of TEST_LAYOUT as readonly Convention[]) {
		it(`builds a valid ${convention.semantic} path and runner template`, () => {
			const filePath = scaffoldTestPath(convention.semantic, "Nested/My New Test");
			expect(filePath).toBe(`${convention.directory}/nested/my-new-test${convention.suffix}`);
			expect(validateTestPath(filePath, scaffoldTestSource(convention.semantic, "my-new-test"))).toEqual([]);
		});
	}

	it("rejects unknown semantics, traversal, absolute names, and empty segments", () => {
		expect(() => scaffoldTestPath("unknown", "name")).toThrow(/Choose one of/);
		expect(() => scaffoldTestPath("dom", "../escape")).toThrow(/Unsafe test name/);
		expect(() => scaffoldTestPath("dom", "C:\\escape")).toThrow(/Unsafe test name/);
		expect(() => scaffoldTestPath("dom", "bad\0name")).toThrow(/NUL bytes/);
		expect(() => scaffoldTestPath("dom", "nested/???")).toThrow(/each segment/);
	});

	it("creates exclusively through real canonical directories without a registry side effect", () => {
		const root = mkdtempSync(join(tmpdir(), "bobbit-test-layout-"));
		temporaryRoots.push(root);
		mkdirSync(join(root, "tests", "dom"), { recursive: true });
		const relativePath = createTestFile("dom", "nested/panel-layout", { root });
		expect(relativePath).toBe("tests/dom/nested/panel-layout.dom.test.ts");
		const source = readFileSync(join(root, ...relativePath.split("/")), "utf8");
		expect(source).toContain('from "vitest"');
		expect(validateTestPath(relativePath, source)).toEqual([]);
		expect(() => createTestFile("dom", "nested/panel-layout", { root })).toThrow(/Refusing to overwrite/);
	});

	it("rejects a symlink or junction parent without writing to its external target", () => {
		const container = mkdtempSync(join(tmpdir(), "bobbit-test-layout-link-"));
		temporaryRoots.push(container);
		const root = join(container, "repository");
		const external = join(container, "external");
		mkdirSync(join(root, "tests", "unit"), { recursive: true });
		mkdirSync(external);
		symlinkSync(external, join(root, "tests", "unit", "core"), process.platform === "win32" ? "junction" : "dir");

		expect(() => createTestFile("unit-core", "proof", { root })).toThrow(/symbolic links or junctions/);
		expect(existsSync(join(external, "proof.unit.test.ts"))).toBe(false);
	});
});
