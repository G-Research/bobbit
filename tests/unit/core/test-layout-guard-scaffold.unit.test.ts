import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	collectLayoutDiagnostics,
	formatLayoutDiagnostics,
	listRepositoryFiles,
	parseGitFileList,
} from "../../../scripts/testing/check-layout.mjs";
import {
	createTestFile,
	scaffoldTestPath,
	scaffoldTestSource,
} from "../../../scripts/testing/create-test.mjs";
import { TEST_LAYOUT, validateTestPath } from "../../../scripts/testing/layout-policy.mjs";

type Convention = { semantic: string; directory: string; suffix: string };
type Diagnostic = { code: string };

const temporaryRoots: string[] = [];
afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("test layout repository guard", () => {
	it("parses NUL-delimited names without splitting spaces or newlines", () => {
		expect(parseGitFileList(Buffer.from("tests/dom/a b.dom.test.ts\0tests/dom/line\nb.dom.test.ts\0"))).toEqual([
			"tests/dom/a b.dom.test.ts",
			"tests/dom/line\nb.dom.test.ts",
		]);
	});

	it("asks Git for cached, staged, and untracked files in one NUL-safe inventory", () => {
		const execFile = vi.fn(() => Buffer.from("tracked\0staged\0untracked\0")) as unknown as typeof execFileSync;
		expect(listRepositoryFiles("repo-root", execFile)).toEqual(["tracked", "staged", "untracked"]);
		expect(execFile).toHaveBeenCalledWith(
			"git",
			["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
			expect.objectContaining({ cwd: "repo-root", encoding: "buffer" }),
		);
	});

	it("rejects a tracked, staged, or untracked executable placed directly under tests", () => {
		const diagnostics = collectLayoutDiagnostics({
			root: "synthetic-root",
			listFiles: () => parseGitFileList(Buffer.from("tests/code-review-e2e.ts\0")),
			fileExists: () => true,
			readSource: () => 'import { WebSocket } from "ws";',
		});
		expect(diagnostics).toEqual([
			expect.objectContaining({
				code: "direct-tests-root-executable",
				path: "tests/code-review-e2e.ts",
			}),
		]);
		expect(formatLayoutDiagnostics(diagnostics)).toContain("tests/manual/**/*.manual.spec.ts");
		expect(formatLayoutDiagnostics(diagnostics)).toContain("tests/e2e/node/**/*.node-e2e.test.ts");
	});

	it("validates untracked sources and inventory collisions", () => {
		const files = [
			"tests/dom/good.dom.test.ts",
			"tests/dom/wrong.test.ts",
			"tests/dom/Good.dom.test.ts",
		];
		const diagnostics = collectLayoutDiagnostics({
			root: "synthetic-root",
			listFiles: () => files,
			fileExists: () => true,
			readSource: () => 'import { it } from "vitest";',
		});
		expect(diagnostics.map(({ code }: Diagnostic) => code)).toEqual(expect.arrayContaining(["wrong-suffix", "case-collision"]));
		expect(formatLayoutDiagnostics(diagnostics)).toContain("tests/dom/**/*.dom.test.ts");
	});

	it("rejects API-lane browser bypasses from the repository source scan", () => {
		const sources = [
			'import { test } from "@playwright/test"; test("bad", async function ({ page }) { await page.goto("/"); });',
			'import { test } from "@playwright/test"; test("bad", async ({ context }: Fixtures) => context.close());',
			'import * as playwright from "@playwright/test"; playwright.chromium.launch();',
		] as const;
		for (const source of sources) {
			const diagnostics = collectLayoutDiagnostics({
				root: "synthetic-root",
				listFiles: () => ["tests/e2e/api/browser-bypass.api-e2e.spec.ts"],
				fileExists: () => true,
				readSource: () => source,
			});
			expect(diagnostics.map(({ code }: Diagnostic) => code)).toContainEqual(expect.stringMatching(/^api-browser-(?:fixture|import)$/));
			expect(formatLayoutDiagnostics(diagnostics)).toContain("tests/e2e/browser/**/*.browser-e2e.spec.ts");
		}
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

	it("rejects unknown semantics and unsafe names", () => {
		expect(() => scaffoldTestPath("unknown", "name")).toThrow(/Choose one of/);
		expect(() => scaffoldTestPath("dom", "../escape")).toThrow(/Unsafe test name/);
	});

	it("creates exclusively without a registry side effect", () => {
		const root = mkdtempSync(join(tmpdir(), "bobbit-test-layout-"));
		temporaryRoots.push(root);
		const relativePath = createTestFile("dom", "panel-layout", { root });
		expect(relativePath).toBe("tests/dom/panel-layout.dom.test.ts");
		const source = readFileSync(join(root, ...relativePath.split("/")), "utf8");
		expect(source).toContain('from "vitest"');
		expect(validateTestPath(relativePath, source)).toEqual([]);
		expect(() => createTestFile("dom", "panel-layout", { root })).toThrow(/Refusing to overwrite/);
	});
});
