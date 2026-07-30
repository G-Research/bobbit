import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	capturePlaywrightBrowserRegistry,
	cleanupOwnedRunRoot,
	CREDENTIAL_ENV_EXACT_NAMES,
	CREDENTIAL_ENV_PATTERN,
	CREDENTIAL_ENV_PREFIXES,
	createRunArtifactDirectory,
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
import {
	createE2ERunPaths,
	createIsolatedE2EEnvironment,
	isE2ECredentialEnvKey,
	resolveChildTmpdir,
} from "../../scripts/run-playwright-e2e.mjs";
import { currentRunId, ownedE2EVolumeNames } from "../../tests/e2e/e2e-teardown.js";
import { packedConsumerTempPrefix } from "../../scripts/release-packed-consumer-audit.mjs";

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

	it("contains deterministic Playwright artifact directories in the coordinator run root", () => {
		const root = getRunRoot();
		const artifacts = createRunArtifactDirectory("playwright-v2");
		expect(artifacts).toBe(join(root, "playwright-v2"));
		expect(existsSync(artifacts)).toBe(true);
		expect(isOwnedRunPath(artifacts)).toBe(true);
		for (const invalid of ["", ".", "..", "nested/child", "nested\\child"]) {
			expect(() => createRunArtifactDirectory(invalid)).toThrow(/invalid|non-owned/);
		}
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
			"TMPDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "BOBBIT_DIR", "BOBBIT_PI_DIR", "BOBBIT_AGENT_DIR", "PI_CODING_AGENT_DIR",
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

	it("matches credential keys case-insensitively only under Windows semantics", () => {
		for (const matchesCredential of [isCredentialEnvKey, isE2ECredentialEnvKey]) {
			expect(matchesCredential("anthropic_api_key", "win32")).toBe(true);
			expect(matchesCredential("bobbit_host_token", "win32")).toBe(true);
			expect(matchesCredential("anthropic_api_key", "linux")).toBe(false);
		}
	});

	it("allocates a canonical legacy E2E coordinator root and confines its packed-consumer child", () => {
		const temp = mkdtempSync(join(tmpdir(), "legacy-e2e-isolation-"));
		try {
			const first = createE2ERunPaths(temp);
			const second = createE2ERunPaths(temp);
			const canonicalTemp = realpathSync(temp);
			expect(first.root).not.toBe(second.root);
			expect(relative(canonicalTemp, first.root)).toMatch(/^bobbit-v2-run-/);
			expect(first.runId).toBe(first.root.split(/[\\/]/).pop());
			expect(first.cacheRoot).toBe(join(first.root, "pwtest-transform-cache"));
			expect(packedConsumerTempPrefix({ BOBBIT_V2_RUN_ROOT: first.root })).toBe(
				join(first.root, "bobbit-release-packed-audit-"),
			);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("isolates legacy E2E host roots and credentials while preserving its browser registry", () => {
		const temp = mkdtempSync(join(tmpdir(), "legacy-e2e-environment-"));
		try {
			const paths = createE2ERunPaths(temp);
			const browserRegistry = join(temp, "host-browser-registry");
			const env = createIsolatedE2EEnvironment(paths, {
				HOME: join(temp, "host-home"),
				USERPROFILE: join(temp, "host-profile"),
				TMPDIR: join(temp, "host-tmpdir"),
				TEMP: join(temp, "host-temp"),
				TMP: join(temp, "host-tmp"),
				tmpdir: join(temp, "host-tmpdir-lowercase"),
				temp: join(temp, "host-temp-lowercase"),
				tmp: join(temp, "host-tmp-lowercase"),
				BOBBIT_DIR: join(temp, "host-bobbit"),
				BOBBIT_SECRETS_DIR: join(temp, "host-secrets"),
				APPDATA: join(temp, "host-appdata"),
				XDG_CONFIG_HOME: join(temp, "host-xdg-config"),
				playwright_browsers_path: browserRegistry,
				anthropic_api_key: "fake-anthropic-lowercase",
				openai_codex_auth: "fake-codex-lowercase",
				ANTHROPIC_API_KEY: "fake-anthropic",
				OPENAI_CODEX_AUTH: "fake-codex",
				GOOGLE_APPLICATION_CREDENTIALS: "fake-google",
				BOBBIT_TOKEN: "fake-bobbit-token",
				PATH: "/safe/path",
			}, "win32");

			for (const key of [
				"TMPDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "BOBBIT_DIR", "BOBBIT_PI_DIR", "BOBBIT_AGENT_DIR", "PI_CODING_AGENT_DIR",
				"BOBBIT_SECRETS_DIR", "APPDATA", "LOCALAPPDATA", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
			]) {
				expect(env[key], key).toBeTruthy();
				expect(isOwnedRunChild(paths.root, env[key]!)).toBe(true);
				expect(existsSync(env[key]!)).toBe(true);
			}
			expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(browserRegistry);
			expect(env.HOME).not.toBe(join(temp, "host-home"));
			expect(env.TMPDIR).toBe(paths.tempDir);
			expect(env.TEMP).toBe(paths.tempDir);
			expect(env.TMP).toBe(paths.tempDir);
			expect(env.tmpdir).toBeUndefined();
			expect(env.temp).toBeUndefined();
			expect(env.tmp).toBeUndefined();
			// This pure seam mirrors Node's os.tmpdir() selection for the child
			// environment, avoiding a subprocess after tier-1's spawn guard closes.
			for (const platform of ["linux", "darwin", "win32"] as const) {
				const childTmpdir = resolveChildTmpdir(env, platform);
				expect(childTmpdir).toBe(paths.tempDir);
				expect(isOwnedRunChild(paths.root, childTmpdir)).toBe(true);
			}
			expect(env.ANTHROPIC_API_KEY).toBeUndefined();
			expect(env.OPENAI_CODEX_AUTH).toBeUndefined();
			expect(env.anthropic_api_key).toBeUndefined();
			expect(env.openai_codex_auth).toBeUndefined();
			expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
			expect(env.BOBBIT_TOKEN).toBeUndefined();
			expect(env.PATH).toBe("/safe/path");
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("limits legacy E2E teardown to validated run-namespaced volume names", () => {
		const projectId = "project-123";
		const runId = "legacy-run_123";
		expect(currentRunId(runId)).toBe(runId);
		expect(currentRunId("invalid/run")).toBeUndefined();
		expect(ownedE2EVolumeNames(projectId, runId)).toEqual([
			`bobbit-workspace-${projectId}-e2e-${runId}`,
			`bobbit-worktrees-${projectId}-e2e-${runId}`,
		]);
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

	it("keeps v2 Playwright results and reports in the owned run root", () => {
		const source = readFileSync("playwright-v2.config.ts", "utf8");
		expect(source).toContain("createRunArtifactDirectory");
		expect(source.indexOf("getRunRoot();")).toBeLessThan(source.indexOf("createRunArtifactDirectory(\"playwright-v2\")"));
		expect(source).toContain('outputDir: playwrightResultsDir');
		expect(source).toContain('outputFile: playwrightBudgetReport');
		expect(source).toContain("BOBBIT_V2_PLAYWRIGHT_REPORT_PATH");
		expect(source).toContain("isOwnedRunPath(report)");
		expect(source).not.toContain(".profiles/testing-v2/budgets/playwright-report.json");
		expect(source).not.toContain("test-results-v2-${playwrightRunId}");
		expect(source).not.toContain("playwright-report-${playwrightRunId}.json");
	});

	it("preserves PATH for Git discovery while isolating config and credentials", () => {
		const executablePath = process.env.PATH ?? process.env.Path;
		expect(executablePath).toBeTruthy();
		installRunIsolation();
		expect(process.env.PATH ?? process.env.Path).toBe(executablePath);
	});

	it("keeps workflow harnesses free of fixed ports, timestamp-only roots, and unowned cleanup", () => {
		for (const file of ["tests2/harness/gateway.ts", "tests/e2e/in-process-harness.ts", "tests/e2e/gateway-harness.ts", "tests/e2e/in-process-harness-realpush.ts"]) {
			const source = readFileSync(file, "utf8");
			expect(source, file).not.toMatch(/port:\s*(?!0\b)\d+/);
			expect(source, file).not.toMatch(/join\([^\n]*Date\.now\(\)/);
		}
		for (const file of ["tests/e2e/in-process-harness.ts", "tests/e2e/gateway-harness.ts", "tests/e2e/in-process-harness-realpush.ts"]) {
			const source = readFileSync(file, "utf8");
			expect(source, file).not.toContain('join(tmpdir(), "bobbit-e2e")');
		}
	});

	it("routes legacy E2E teardown and Docker cleanup by coordinator run identity", () => {
		const runner = readFileSync("scripts/run-playwright-e2e.mjs", "utf8");
		const realpush = readFileSync("tests/e2e/in-process-harness-realpush.ts", "utf8");
		const teardown = readFileSync("tests/e2e/e2e-teardown.ts", "utf8");
		const sandbox = readFileSync("src/server/agent/project-sandbox.ts", "utf8");
		const audit = readFileSync("scripts/release-packed-consumer-audit.mjs", "utf8");
		expect(runner).toContain("createE2ERunPaths");
		expect(runner).toContain("BOBBIT_V2_RUN_ROOT");
		expect(runner).toContain("BOBBIT_E2E_RUN_ID");
		expect(realpush).toContain("installRunIsolation()");
		expect(realpush).toContain("createRunChild(`e2e-realpush-");
		expect(teardown).toContain("label=bobbit-e2e-run=${runId}");
		expect(teardown).toContain("ownedE2EVolumeNames(projectId, runId)");
		expect(teardown).toContain("-e2e-${runId}");
		expect(teardown).not.toContain("readdirSync");
		expect(sandbox).toContain('"bobbit-e2e-run": e2eRunId');
		expect(sandbox).toContain("_findContainerByLabel(label, e2eRunId)");
		expect(audit).toContain("packedConsumerTempPrefix");
	});
});
