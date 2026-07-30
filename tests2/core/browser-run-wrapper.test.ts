import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

		expect(first.root).not.toBe(second.root);
		expect(first.root.startsWith(temp)).toBe(true);
		expect(second.root.startsWith(temp)).toBe(true);
		expect(first.report).toBe(join(first.root, "playwright-v2", "playwright-report.json"));
		expect(second.report).toBe(join(second.root, "playwright-v2", "playwright-report.json"));
		expect(existsSync(first.root)).toBe(true);
	});

	it("forwards retry and other npm-supplied Playwright arguments unchanged", () => {
		const args = playwrightCommandArgs(["--retry=0", "--grep", "sidebar"]);
		expect(args.slice(-3)).toEqual(["--retry=0", "--grep", "sidebar"]);
		expect(args).toContain("--project");
		expect(args).toContain("browser-v2");
		const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
		expect(scripts["test:v2:browser"]).toBe("node scripts/testing-v2/run-browser-v2.mjs");
		expect(scripts["test:browser"]).toBe("npm run test:v2:browser --");
	});
});
