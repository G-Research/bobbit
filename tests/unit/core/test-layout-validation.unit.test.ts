import { describe, expect, it } from "vitest";
import { TEST_LAYOUT, validateTestPath } from "../../../scripts/testing/layout-policy.mjs";

type Convention = { semantic: string; suffix: string; pattern: string };
type Diagnostic = { code: string };

const misplaced = (TEST_LAYOUT as readonly Convention[]).map((entry) => ({
	semantic: entry.semantic,
	filePath: `tests/wrong/example${entry.suffix}`,
	expectedPattern: entry.pattern,
}));

describe("test layout diagnostics", () => {
	for (const { semantic, filePath, expectedPattern } of misplaced) {
		it(`names the canonical destination for ${semantic}`, () => {
			const diagnostics = validateTestPath(filePath);
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]).toMatchObject({ code: "wrong-directory", expectedPattern });
			expect(diagnostics[0].message).toContain(expectedPattern);
		});
	}

	it("rejects generic suffixes, suffix-directory disagreement, support tests, and tests outside the root", () => {
		expect(validateTestPath("tests/dom/panel.test.ts")[0]).toMatchObject({
			code: "wrong-suffix",
			expectedPattern: "tests/dom/**/*.dom.test.ts",
		});
		expect(validateTestPath("tests/dom/panel.unit.test.ts")[0]).toMatchObject({
			code: "wrong-directory",
			expectedPattern: "tests/unit/core/**/*.unit.test.ts",
		});
		expect(validateTestPath("tests/support/helpers/unit/helper.unit.test.ts")[0]?.code).toBe("runnable-support-file");
		expect(validateTestPath("tests/dom/_helpers/parser.dom.test.ts")[0]?.code).toBe("runnable-support-file");
		expect(validateTestPath("src/panel.dom.test.ts")[0]).toMatchObject({
			code: "wrong-directory",
			expectedPattern: "tests/dom/**/*.dom.test.ts",
		});
		expect(validateTestPath("tests/unknown/panel.test.ts")[0]?.code).toBe("unclassified-test");
	});

	it("rejects incompatible runner imports", () => {
		const cases = [
			["tests/unit/core/a.unit.test.ts", 'import { test } from "node:test";', "runner-import-mismatch"],
			["tests/e2e/node/a.node-e2e.test.ts", 'import { it } from "vitest";', "runner-import-mismatch"],
			["tests/browser/journeys/a.journey.spec.ts", 'import { it } from "vitest";', "runner-import-mismatch"],
		] as const;
		for (const [filePath, source, code] of cases) {
			expect(validateTestPath(filePath, source)[0]?.code).toBe(code);
		}
	});

	it("keeps examples and comments from masquerading as imports", () => {
		const source = [
			'import { it } from "vitest";',
			'const example = \'import { test } from "node:test";\';',
			'// import { test } from "@playwright/test";',
		].join("\n");
		expect(validateTestPath("tests/unit/core/examples.unit.test.ts", source)).toEqual([]);
	});

	it("keeps browser fixtures out of API/process E2E test callbacks", () => {
		const fixtureCases = [
			'test("arrow", async ({ request, page }) => request.get(String(page)));',
			'test("function", function ({ browser }) { return browser.version(); });',
			'test("async function", async function ({ page }) { await page.goto("/"); });',
			'test("typed", async ({ context }: { context: BrowserContext }) => context.close());',
			'async function misuse({ page }: Fixtures) { await page.goto("/"); }\ntest("named", misuse);',
		] as const;
		for (const callback of fixtureCases) {
			const source = `import { test } from "@playwright/test";\n${callback}`;
			expect(validateTestPath("tests/e2e/api/restart.api-e2e.spec.ts", source).map(({ code }: Diagnostic) => code)).toContain("api-browser-fixture");
		}

		const helperFixture = 'import { test as apiTest } from "../_helpers/gateway-harness.js";\napiTest("bad", async ({ page }) => page.close());';
		expect(validateTestPath("tests/e2e/api/helper.api-e2e.spec.ts", helperFixture).map(({ code }: Diagnostic) => code)).toContain("api-browser-fixture");
	});

	it("rejects direct, namespace, default, and require access to Playwright browser primitives", () => {
		const primitiveCases = [
			'import { test, chromium as engine } from "@playwright/test";',
			'import * as playwright from "@playwright/test"; playwright.chromium.launch();',
			'import * as playwright from "@playwright/test"; const { firefox: engine } = playwright;',
			'import playwright from "@playwright/test"; playwright["firefox"].launch();',
			'const playwright = require("@playwright/test"); playwright.webkit.launch();',
		] as const;
		for (const source of primitiveCases) {
			expect(validateTestPath("tests/e2e/api/browser.api-e2e.spec.ts", source).map(({ code }: Diagnostic) => code)).toContain("api-browser-import");
		}
	});

	it("allows API request fixtures and ignores browser examples in comments and strings", () => {
		const source = [
			'import * as playwright from "@playwright/test";',
			'playwright.test("api", async ({ request }) => request.get("/health"));',
			'// playwright.test("example", async function ({ page }) { await page.goto("/"); });',
			'const example = `playwright.chromium.launch(); async ({ browser }) => browser.close()`;',
		].join("\n");
		expect(validateTestPath("tests/e2e/api/request.api-e2e.spec.ts", source)).toEqual([]);
	});

	it("keeps browser-only helper imports out of API/process E2E tests", () => {
		const boundarySource = 'import { test } from "../../support/harnesses/shared/e2e/browser/fixture.js";';
		expect(validateTestPath("tests/e2e/api/helper.api-e2e.spec.ts", boundarySource).map(({ code }: Diagnostic) => code)).toContain("api-browser-boundary");
	});
});
