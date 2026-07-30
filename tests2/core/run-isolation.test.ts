import { existsSync, readFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	capturePlaywrightBrowserRegistry,
	cleanupOwnedRunRoot,
	CREDENTIAL_ENV_EXACT_NAMES,
	CREDENTIAL_ENV_PATTERN,
	CREDENTIAL_ENV_PREFIXES,
	createRunChild,
	getRunRoot,
	installRunIsolation,
	isCredentialEnvKey,
	isOwnedRunChild,
	isOwnedRunPath,
	isRunRootOwner,
	PLAYWRIGHT_BROWSERS_PATH_ENV,
	removeOwnedRunChild,
	resolvePlaywrightBrowserRegistry,
	isolateCredentialEnv,
	RUN_ROOT_ENV,
	RUN_ROOT_OWNER_ENV,
} from "../harness/run-isolation.js";

const baselineEnv = { ...process.env };

afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (!(key in baselineEnv)) delete process.env[key];
	}
	Object.assign(process.env, baselineEnv);
});

describe("workflow run isolation", () => {
	it("owns canonical, unique children and removes test-created children", () => {
		const root = getRunRoot();
		const child = createRunChild("core-isolation");
		expect(existsSync(root)).toBe(true);
		expect(isOwnedRunPath(child)).toBe(true);
		expect(child.startsWith(root)).toBe(true);

		removeOwnedRunChild(child);
		expect(existsSync(child)).toBe(false);
	});

	it("neutralizes every credential family consumed by host discovery", () => {
		const seeded = {
			ANTHROPIC_OAUTH_TOKEN: "fake-anthropic-oauth",
			CLAUDE_CODE_OAUTH_TOKEN: "fake-claude-code",
			OPENAI_CODEX_AUTH: "fake-codex",
			GOOGLE_APPLICATION_CREDENTIALS: "fake-google-application",
			GOOGLE_CLOUD_ACCESS_TOKEN: "fake-google-access",
			AWS_SESSION_TOKEN: "fake-aws-session",
			OPENROUTER_API_KEY: "fake-openrouter",
			NPM_TOKEN: "fake-npm",
			AIGW_OPENCODE_TOKEN: "fake-aigw",
			OPENCODE_AUTH: "fake-opencode",
			GITHUB_TOKEN: "fake-github",
			GH_TOKEN: "fake-gh",
		};
		Object.assign(process.env, seeded);
		installRunIsolation();

		for (const key of Object.keys(seeded)) expect(process.env[key]).toBeUndefined();
		for (const key of Object.keys(seeded)) expect(isCredentialEnvKey(key)).toBe(true);
		expect(CREDENTIAL_ENV_EXACT_NAMES.has("OPENAI_CODEX_AUTH")).toBe(true);
		expect(CREDENTIAL_ENV_PREFIXES).toContain("CLAUDE_CODE_");
		expect(CREDENTIAL_ENV_PATTERN.test("GOOGLE_CLOUD_ACCESS_TOKEN")).toBe(true);
		expect(isCredentialEnvKey("PATH")).toBe(false);
	});

	it("redirects every host configuration root to the run root", () => {
		const root = installRunIsolation();
		for (const key of [
			"HOME", "USERPROFILE", "BOBBIT_DIR", "BOBBIT_PI_DIR", "BOBBIT_AGENT_DIR", "PI_CODING_AGENT_DIR",
			"BOBBIT_SECRETS_DIR", "APPDATA", "LOCALAPPDATA", "XDG_STATE_HOME", "XDG_CONFIG_HOME",
		]) {
			const value = process.env[key];
			expect(value, key).toBeTruthy();
			expect(isOwnedRunPath(value!)).toBe(true);
			expect(value).toContain(root);
			expect(existsSync(value!)).toBe(true);
		}
	});

	it("restores focused credential snapshots exactly", () => {
		process.env.ANTHROPIC_API_KEY = "fake";
		process.env.OPENAI_CODEX_AUTH = "fake-codex";
		const restore = isolateCredentialEnv();
		expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(process.env.OPENAI_CODEX_AUTH).toBeUndefined();
		restore();
		expect(process.env.ANTHROPIC_API_KEY).toBe("fake");
		expect(process.env.OPENAI_CODEX_AUTH).toBe("fake-codex");
	});

	it("rejects same-root, parent, sibling, Windows cross-drive, and UNC paths", () => {
		const root = getRunRoot();
		const child = createRunChild("containment");
		const sibling = join(dirname(root), "bobbit-v2-sibling");
		try {
			expect(isOwnedRunChild(root, child)).toBe(true);
			expect(isOwnedRunChild(root, root)).toBe(false);
			expect(isOwnedRunChild(root, dirname(root))).toBe(false);
			expect(isOwnedRunChild(root, sibling)).toBe(false);
			expect(() => removeOwnedRunChild(root)).toThrow(/non-owned/);
			expect(() => removeOwnedRunChild(dirname(root))).toThrow(/non-owned/);
			expect(() => removeOwnedRunChild(sibling)).toThrow(/non-owned/);

			expect(isOwnedRunChild("C:\\bobbit\\run", "C:\\bobbit\\run\\child", win32)).toBe(true);
			expect(isOwnedRunChild("C:\\bobbit\\run", "D:\\victim", win32)).toBe(false);
			expect(isOwnedRunChild("\\\\server-a\\share\\run", "\\\\server-b\\share\\victim", win32)).toBe(false);
		} finally {
			removeOwnedRunChild(child);
		}
	});

	it("leaves coordinator cleanup exclusively to the coordinator process", () => {
		const root = getRunRoot();
		expect(process.env[RUN_ROOT_ENV]).toBe(root);
		expect(process.env[RUN_ROOT_OWNER_ENV]).toBeTruthy();
		// Vitest forks inherit the coordinator root. This worker must not delete a
		// root that sibling workers can still be using; the config process owns its
		// exit hook and removes it only after all workers have completed.
		expect(isRunRootOwner()).toBe(false);
		expect(cleanupOwnedRunRoot()).toBe(false);
		expect(existsSync(root)).toBe(true);
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

	it("captures the Playwright registry before the E2E harness isolates HOME", () => {
		const source = readFileSync("playwright-e2e.config.ts", "utf8");
		expect(source).toContain('import { capturePlaywrightBrowserRegistry } from "./tests2/harness/run-isolation.js"');
		expect(source.indexOf("capturePlaywrightBrowserRegistry();")).toBeLessThan(source.indexOf("prepareE2ERuntimeCaches();"));
	});

	it("preserves PATH for Git discovery while isolating config and credentials", () => {
		const executablePath = process.env.PATH ?? process.env.Path;
		expect(executablePath).toBeTruthy();
		installRunIsolation();
		expect(process.env.PATH ?? process.env.Path).toBe(executablePath);
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
