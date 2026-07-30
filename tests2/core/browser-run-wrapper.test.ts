import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserRunPaths, playwrightCommandArgs } from "../../scripts/testing-v2/run-browser-v2.mjs";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("v2 browser coordinator", () => {
	it("allocates distinct owned roots and report paths outside the checkout", () => {
		const temp = mkdtempSync(join(tmpdir(), "browser-wrapper-test-"));
		roots.push(temp);
		const first = createBrowserRunPaths(temp);
		const second = createBrowserRunPaths(temp);
		roots.push(first.root, second.root);

		const canonicalTemp = realpathSync(temp);
		expect(first.root).not.toBe(second.root);
		expect(relative(canonicalTemp, first.root)).toMatch(/^bobbit-v2-run-/);
		expect(relative(canonicalTemp, second.root)).toMatch(/^bobbit-v2-run-/);
		expect(first.report).toBe(join(first.root, "playwright-v2", "playwright-report.json"));
		expect(second.report).toBe(join(second.root, "playwright-v2", "playwright-report.json"));
		expect(existsSync(first.root)).toBe(true);
	});

	it("forwards retry and other npm-supplied Playwright arguments unchanged", () => {
		const args = playwrightCommandArgs(["--retries=0", "--grep", "sidebar"]);
		expect(args.slice(-3)).toEqual(["--retries=0", "--grep", "sidebar"]);
		expect(args).toContain("--project");
		expect(args).toContain("browser-v2");
		const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
		expect(scripts["test:v2:browser"]).toBe("node scripts/testing-v2/run-browser-v2.mjs");
		expect(scripts["test:browser"]).toBe("npm run test:v2:browser --");
	});

	it("captures the global ledger before config-level temp isolation and supports retry-free qualification", () => {
		const config = readFileSync("playwright-v2.config.ts", "utf8");
		const capture = config.indexOf("captureMachineGlobalLedgerDirectory");
		const isolate = config.indexOf("getRunRoot();");
		expect(capture).toBeGreaterThanOrEqual(0);
		expect(capture).toBeLessThan(isolate);
		expect(config).toContain('retries: process.env.BOBBIT_V2_RETRY_FREE === "1" ? 0 : 3');
	});
});
