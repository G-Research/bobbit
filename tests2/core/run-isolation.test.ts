import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	capturePlaywrightBrowserRegistry,
	CREDENTIAL_ENV_PATTERN,
	createRunChild,
	getRunRoot,
	installRunIsolation,
	isOwnedRunPath,
	PLAYWRIGHT_BROWSERS_PATH_ENV,
	resolvePlaywrightBrowserRegistry,
	isolateCredentialEnv,
} from "../harness/run-isolation.js";

const savedEnv = new Map<string, string | undefined>();
for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "HOME", "USERPROFILE", "BOBBIT_DIR", "XDG_CACHE_HOME", "LOCALAPPDATA", PLAYWRIGHT_BROWSERS_PATH_ENV]) savedEnv.set(key, process.env[key]);
afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("workflow run isolation", () => {
	it("owns canonical, unique children under an inherited run root", () => {
		const root = getRunRoot();
		const child = createRunChild("core-isolation");
		expect(existsSync(root)).toBe(true);
		expect(isOwnedRunPath(child)).toBe(true);
		expect(child.startsWith(root)).toBe(true);
	});

	it("removes inherited provider credentials before initialization", () => {
		process.env.ANTHROPIC_API_KEY = "fake-anthropic";
		process.env.OPENAI_API_KEY = "fake-openai";
		process.env.GITHUB_TOKEN = "fake-github";
		installRunIsolation();
		expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(process.env.OPENAI_API_KEY).toBeUndefined();
		expect(process.env.GITHUB_TOKEN).toBeUndefined();
		expect(process.env.HOME).toContain(getRunRoot());
	});

	it("restores focused credential snapshots exactly", () => {
		process.env.ANTHROPIC_API_KEY = "fake";
		const restore = isolateCredentialEnv();
		expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
		restore();
		expect(process.env.ANTHROPIC_API_KEY).toBe("fake");
		expect(CREDENTIAL_ENV_PATTERN.test("GOOGLE_API_KEY")).toBe(true);
	});

	it("keeps Playwright's browser registry outside the isolated home", () => {
		delete process.env[PLAYWRIGHT_BROWSERS_PATH_ENV];
		const hostHome = join(getRunRoot(), "playwright-host-home");
		process.env.HOME = hostHome;
		process.env.USERPROFILE = hostHome;
		const expected = resolvePlaywrightBrowserRegistry();
		expect(capturePlaywrightBrowserRegistry()).toBe(expected);
		installRunIsolation();
		expect(process.env[PLAYWRIGHT_BROWSERS_PATH_ENV]).toBe(expected);
		expect(process.env.HOME).not.toBe(hostHome);
		expect(expected).not.toContain(process.env.HOME!);
	});

	it("keeps workflow harnesses free of fixed ports, timestamp-only roots, and unowned cleanup", () => {
		for (const file of ["tests2/harness/gateway.ts", "tests/e2e/in-process-harness.ts", "tests/e2e/gateway-harness.ts"]) {
			const source = readFileSync(file, "utf8");
			expect(source, file).not.toMatch(/port:\s*(?!0\b)\d+/);
			expect(source, file).not.toMatch(/join\([^\n]*Date\.now\(\)/);
		}
		for (const file of ["tests/e2e/in-process-harness.ts", "tests/e2e/gateway-harness.ts"]) {
			const source = readFileSync(file, "utf8");
			expect(source, file).not.toContain('join(tmpdir(), "bobbit-e2e")');
		}
	});
});
