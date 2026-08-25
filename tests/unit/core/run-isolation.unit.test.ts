import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureMachineLedgerDirectory,
  cleanupOwnedRunRoot,
  CREDENTIAL_ENV_EXACT_NAMES,
  CREDENTIAL_ENV_PATTERN,
  CREDENTIAL_ENV_PREFIXES,
  createRunChild,
  createRunChildEnvironment,
  getRunRoot,
  installRunIsolation,
  isAmbientBobbitRuntimeEnvKey,
  isCredentialEnvKey,
  isOwnedRunChild,
  isOwnedRunPath,
  isRunRootOwner,
  removeOwnedRunChild,
  RUN_ROOT_ENV,
  RUN_ROOT_OWNER_ENV,
} from "../../support/harnesses/shared/run-isolation.js";
import { withEnv } from "../../support/harnesses/shared/with-env.js";
import {
  createE2ERunPaths,
  createIsolatedE2EEnvironment,
  isE2EAmbientRuntimeEnvKey,
} from "../../../scripts/run-playwright-e2e.mjs";
import {
  createBrowserRunEnvironment,
  createBrowserRunPaths,
} from "../../../scripts/testing-v2/run-browser-v2.mjs";
import {
  composeE2EChildEnvironment,
  createE2EV2CoordinatorEnvironment,
  createNestedE2EEnvironment,
  groupDVitestArgs,
  resolveE2ERetryCount,
} from "../../../scripts/testing-v2/run-e2e-v2.mjs";

const baselineEnv = { ...process.env };

function restoreBaselineEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in baselineEnv)) delete process.env[key];
  }
  Object.assign(process.env, baselineEnv);
}

afterEach(restoreBaselineEnv);

describe("unit run isolation", () => {
  it("owns one canonical root and only removes children beneath it", () => {
    const root = getRunRoot();
    const child = createRunChild("core-isolation");
    try {
      expect(existsSync(root)).toBe(true);
      expect(isOwnedRunPath(root)).toBe(true);
      expect(isOwnedRunPath(child)).toBe(true);
      expect(isOwnedRunChild(root, child)).toBe(true);
      expect(child.startsWith(root)).toBe(true);
      expect(isOwnedRunChild(root, root)).toBe(false);
      expect(isOwnedRunChild(root, dirname(root))).toBe(false);
      expect(
        isOwnedRunChild(root, join(dirname(root), "bobbit-v2-sibling")),
      ).toBe(false);
      expect(
        isOwnedRunChild("C:\\bobbit\\run", "C:\\bobbit\\run\\child", win32),
      ).toBe(true);
      expect(isOwnedRunChild("C:\\bobbit\\run", "D:\\victim", win32)).toBe(
        false,
      );
    } finally {
      removeOwnedRunChild(child);
    }
  });

  it("rejects child prefixes that could escape or create nested run paths", () => {
    const root = getRunRoot();
    const entriesBefore = readdirSync(root).sort();
    const invalidPrefixes = [
      "",
      ".",
      "..",
      "../outside",
      join(root, "absolute-child"),
      "nested/child",
      "nested\\child",
    ];

    for (const prefix of invalidPrefixes)
      expect(() => createRunChild(prefix)).toThrow("invalid run child prefix");
    expect(readdirSync(root).sort()).toEqual(entriesBefore);
  });

  it("keeps Vitest cache and coverage roots beneath the canonical run root", async () => {
    const config = await import("../../../vitest.config.ts");
    const root = getRunRoot();
    const coverage = (
      config.default as { test?: { coverage?: { reportsDirectory?: string } } }
    ).test?.coverage;

    expect(isOwnedRunChild(root, config.VITEST_MODULE_CACHE_ROOT)).toBe(true);
    expect(isOwnedRunChild(root, config.VITEST_COVERAGE_ROOT)).toBe(true);
    expect(isOwnedRunChild(root, config.resolveVitestModuleCachePath())).toBe(true);
    expect(isOwnedRunChild(root, config.resolveVitestCoveragePath())).toBe(true);
    expect(coverage?.reportsDirectory).toBe(config.resolveVitestCoveragePath());
  });

  it("redirects every discovery root to the canonical run root", () => {
    const root = installRunIsolation();
    for (const key of [
      "TMPDIR",
      "TEMP",
      "TMP",
      "HOME",
      "USERPROFILE",
      "BOBBIT_DIR",
      "BOBBIT_PI_DIR",
      "BOBBIT_AGENT_DIR",
      "PI_CODING_AGENT_DIR",
      "BOBBIT_SECRETS_DIR",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_STATE_HOME",
      "XDG_CONFIG_HOME",
    ]) {
      const value = process.env[key];
      expect(value, key).toBeTruthy();
      expect(isOwnedRunPath(value!), key).toBe(true);
      expect(value, key).toContain(root);
      expect(existsSync(value!), key).toBe(true);
    }
  });

  it("neutralizes provider credentials and named host runtime discovery inputs", () => {
    const inherited = {
      ANTHROPIC_OAUTH_TOKEN: "host-anthropic-oauth",
      CLAUDE_CODE_OAUTH_TOKEN: "host-claude-code",
      OPENAI_CODEX_AUTH: "host-codex",
      GOOGLE_APPLICATION_CREDENTIALS: "host-google-application",
      AWS_SESSION_TOKEN: "host-aws-session",
      OPENROUTER_API_KEY: "host-openrouter",
      NPM_TOKEN: "host-npm",
      GITHUB_TOKEN: "host-github",
      BOBBIT_TOKEN: "host-bobbit-token",
      BOBBIT_BUILTIN_PACKS_DIR: "/host/builtin-packs",
      BOBBIT_BUILTIN_TOOLS: "/host/builtin-tools",
      BOBBIT_GATEWAY_URL: "https://host-gateway.invalid",
      BOBBIT_SESSION_ID: "host-session",
      BOBBIT_SESSION_SECRET: "host-session-secret",
      BOBBIT_GH_COMMAND: "/host/bin/gh",
      BOBBIT_PR_WALKTHROUGH_SYNTHESIS_ADAPTER: "/host/adapter.mjs",
    };
    Object.assign(process.env, inherited);

    installRunIsolation();

    for (const key of Object.keys(inherited))
      expect(process.env[key], key).toBeUndefined();
    for (const key of [
      "ANTHROPIC_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENAI_CODEX_AUTH",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "AWS_SESSION_TOKEN",
      "OPENROUTER_API_KEY",
      "NPM_TOKEN",
      "GITHUB_TOKEN",
      "BOBBIT_TOKEN",
    ])
      expect(isCredentialEnvKey(key), key).toBe(true);
    expect(CREDENTIAL_ENV_EXACT_NAMES.has("OPENAI_CODEX_AUTH")).toBe(true);
    expect(CREDENTIAL_ENV_PREFIXES).toContain("CLAUDE_CODE_");
    expect(CREDENTIAL_ENV_PATTERN.test("GOOGLE_APPLICATION_CREDENTIALS")).toBe(
      true,
    );
    expect(isCredentialEnvKey("PATH")).toBe(false);
  });

  it("matches credentials and Bobbit runtime inputs case-insensitively under Windows semantics", () => {
    expect(isCredentialEnvKey("anthropic_api_key", "win32")).toBe(true);
    expect(isCredentialEnvKey("anthropic_api_key", "linux")).toBe(false);
    expect(isCredentialEnvKey("BOBBIT_TEST_FIXTURE_TOKEN", "win32")).toBe(false);
    expect(isAmbientBobbitRuntimeEnvKey("BOBBIT_V2_COMMAND_OVERRIDE", "win32")).toBe(false);
    expect(isAmbientBobbitRuntimeEnvKey("bobbit_gateway_url", "win32")).toBe(
      true,
    );
    expect(isAmbientBobbitRuntimeEnvKey("bobbit_gateway_url", "linux")).toBe(
      false,
    );
  });

  it("preserves suite controls, the captured browser registry, and the machine-global ledger", () => {
    const ledger = captureMachineLedgerDirectory();
    const root = getRunRoot();
    withEnv(
      {
        BOBBIT_TEST_NO_EXTERNAL: "1",
        BOBBIT_V2_RETRY_FREE: "1",
        PLAYWRIGHT_BROWSERS_PATH: "/machine/playwright-browsers",
      },
      () => {
        installRunIsolation();
        expect(process.env.BOBBIT_TEST_NO_EXTERNAL).toBe("1");
        expect(process.env.BOBBIT_V2_RETRY_FREE).toBe("1");
        expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBe(
          "/machine/playwright-browsers",
        );
        expect(process.env.BOBBIT_V2_LEDGER_DIR).toBe(ledger);
        expect(isOwnedRunChild(root, ledger)).toBe(false);
        expect(existsSync(ledger)).toBe(true);
      },
    );
  });

  it("inherits the coordinator-owned root into workers without granting them cleanup", () => {
    const root = getRunRoot();
    expect(process.env[RUN_ROOT_ENV]).toBe(root);
    expect(process.env[RUN_ROOT_OWNER_ENV]).toBeTruthy();
    // The config process allocated this root before Vitest forked this worker.
    expect(isRunRootOwner()).toBe(false);
    expect(cleanupOwnedRunRoot()).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it("passes a sanitized environment to unit-owned children while retaining explicit fixture overrides", () => {
    installRunIsolation();
    const fixturePacks = join(getRunRoot(), "fixture-packs");
    const fixtureCommand = join(getRunRoot(), "fixture-gh");
    const hostEnvironment = {
      ...process.env,
      BOBBIT_BUILTIN_PACKS_DIR: "/host/builtin-packs",
      BOBBIT_GATEWAY_URL: "https://host-gateway.invalid",
      BOBBIT_SESSION_ID: "host-session",
      BOBBIT_GH_COMMAND: "/host/bin/gh",
    };

    const child = createRunChildEnvironment({}, hostEnvironment);
    expect(child.BOBBIT_BUILTIN_PACKS_DIR).toBeUndefined();
    expect(child.BOBBIT_GATEWAY_URL).toBeUndefined();
    expect(child.BOBBIT_SESSION_ID).toBeUndefined();
    expect(child.BOBBIT_GH_COMMAND).toBeUndefined();
    expect(child[RUN_ROOT_ENV]).toBe(getRunRoot());
    expect(isOwnedRunPath(child.HOME!)).toBe(true);

    const fixtureChild = createRunChildEnvironment(
      {
        BOBBIT_BUILTIN_PACKS_DIR: fixturePacks,
        BOBBIT_GH_COMMAND: fixtureCommand,
      },
      hostEnvironment,
    );
    expect(fixtureChild.BOBBIT_BUILTIN_PACKS_DIR).toBe(fixturePacks);
    expect(fixtureChild.BOBBIT_GH_COMMAND).toBe(fixtureCommand);
    expect(hostEnvironment.BOBBIT_BUILTIN_PACKS_DIR).toBe(
      "/host/builtin-packs",
    );
    expect(hostEnvironment.BOBBIT_GH_COMMAND).toBe("/host/bin/gh");

    withEnv({ BOBBIT_BUILTIN_PACKS_DIR: fixturePacks }, () => {
      expect(process.env.BOBBIT_BUILTIN_PACKS_DIR).toBe(fixturePacks);
    });
    expect(process.env.BOBBIT_BUILTIN_PACKS_DIR).toBeUndefined();
  });

  it("keeps browser and E2E coordinators scrubbed, rooted, and overrideable", () => {
    const temp = mkdtempSync(join(tmpdir(), "coordinator-isolation-"));
    try {
      const paths = createE2ERunPaths(temp);
      const hostEnvironment = {
        HOME: join(temp, "host-home"),
        USERPROFILE: join(temp, "host-profile"),
        TMPDIR: join(temp, "host-tmp"),
        PLAYWRIGHT_BROWSERS_PATH: join(temp, "browser-registry"),
        ANTHROPIC_API_KEY: "host-key",
        BOBBIT_BUILTIN_PACKS_DIR: "/host/packs",
        BOBBIT_GATEWAY_URL: "https://host.invalid",
        BOBBIT_SESSION_ID: "host-session",
        BOBBIT_GH_COMMAND: "/host/gh",
        BOBBIT_TEST_NO_EXTERNAL: "1",
        BOBBIT_V2_RETRY_FREE: "1",
      };
      const fixturePacks = join(paths.root, "fixture-packs");
      const isolated = createIsolatedE2EEnvironment(
        paths,
        hostEnvironment,
        "linux",
        { BOBBIT_BUILTIN_PACKS_DIR: fixturePacks },
      );
      const browser = createBrowserRunEnvironment(paths, hostEnvironment);
      const e2e = createE2EV2CoordinatorEnvironment(paths, hostEnvironment);

      expect(isolated.BOBBIT_BUILTIN_PACKS_DIR).toBe(fixturePacks);
      expect(isolated.BOBBIT_GATEWAY_URL).toBeUndefined();
      for (const environment of [browser, e2e]) {
        expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
        expect(environment.BOBBIT_BUILTIN_PACKS_DIR).toBeUndefined();
        expect(environment.BOBBIT_GATEWAY_URL).toBeUndefined();
        expect(environment.BOBBIT_SESSION_ID).toBeUndefined();
        expect(environment.BOBBIT_GH_COMMAND).toBeUndefined();
        expect(environment.BOBBIT_TEST_NO_EXTERNAL).toBe("1");
        expect(environment.BOBBIT_V2_RETRY_FREE).toBe("1");
        expect(isOwnedRunChild(paths.root, environment.HOME!)).toBe(true);
        expect(isOwnedRunChild(paths.root, environment.TMPDIR!)).toBe(true);
      }
      expect(isE2EAmbientRuntimeEnvKey("BOBBIT_PR_WALKTHROUGH_SYNTHESIS_ADAPTER")).toBe(true);
      expect(isE2EAmbientRuntimeEnvKey("BOBBIT_TEST_NO_EXTERNAL")).toBe(false);
      expect(createBrowserRunPaths(temp).root).not.toBe(paths.root);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("preserves suite controls while canonicalizing Windows-owned environment keys", () => {
    const temp = mkdtempSync(join(tmpdir(), "windows-environment-policy-"));
    try {
      const paths = createE2ERunPaths(temp);
      const fixturePacks = join(paths.root, "fixture-packs");
      const inherited = {
        HOME: join(temp, "host-home"),
        USERPROFILE: join(temp, "host-profile"),
        tMpDiR: join(temp, "host-tmpdir"),
        Temp: join(temp, "host-temp"),
        tMp: join(temp, "host-tmp"),
        bObBiT_tEsT_fIxTuRe_Token: "preserve-test-token",
        BoBbIt_V2_Command_Override: "preserve-v2-command",
        bobbit_gateway_url: "https://host.invalid",
        openai_api_key: "host-key",
        bobbit_v2_run_root: "stale-run-root",
        bObBiT_v2_RuN_rOoT_oWnEr_pId: "stale-owner",
        BoBbIt_E2e_TmP_rOoT: "stale-temp-root",
        bobbit_e2e_pwtest_cache_root: "stale-cache-root",
        BoBbIt_E2e_PwTeSt_RuN_CaChE_RoOt: "stale-run-cache-root",
        pwtest_cache_dir: "stale-pwtest-cache-dir",
        BoBbIt_E2e_PwTeSt_CaChE_Dir: "stale-cache-dir",
        bObBiT_E2E_v8CaChE_rOoT: "stale-v8-cache-root",
      };
      const isolated = createIsolatedE2EEnvironment(
        paths,
        inherited,
        "win32",
        { BOBBIT_BUILTIN_PACKS_DIR: fixturePacks },
      );
      const browser = createBrowserRunEnvironment(paths, inherited, "win32");
      const e2e = createE2EV2CoordinatorEnvironment(paths, inherited, "win32");
      const nested = createNestedE2EEnvironment({
        bObBiT_E2E_PwTeSt_CaChE_Root: "stale-cache-root",
        BoBbIt_E2E_V8cAcHe_RoOt: "stale-v8-cache",
      }, "win32");
      const child = composeE2EChildEnvironment({
        bobbit_v2_run_root: "stale-run-root",
      }, { BOBBIT_V2_RUN_ROOT: paths.root }, "win32");
      const matching = (environment: NodeJS.ProcessEnv, name: string) =>
        Object.keys(environment).filter((key) => key.toUpperCase() === name);

      expect(isolated.BOBBIT_BUILTIN_PACKS_DIR).toBe(fixturePacks);
      for (const environment of [isolated, browser, e2e]) {
        expect(environment.bobbit_gateway_url).toBeUndefined();
        expect(environment.openai_api_key).toBeUndefined();
        expect(environment.bObBiT_tEsT_fIxTuRe_Token).toBe("preserve-test-token");
        expect(environment.BoBbIt_V2_Command_Override).toBe("preserve-v2-command");
      }
      for (const environment of [browser, e2e]) {
        for (const [name, value] of [
          ["BOBBIT_V2_RUN_ROOT", paths.root],
          ["BOBBIT_V2_RUN_ROOT_OWNER_PID", String(process.pid)],
          ["BOBBIT_E2E_TMP_ROOT", paths.legacyTempParent],
          ["BOBBIT_E2E_PWTEST_CACHE_ROOT", paths.cacheRoot],
          ["BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT", paths.cacheRoot],
          ["PWTEST_CACHE_DIR", paths.cacheRoot],
          ["BOBBIT_E2E_PWTEST_CACHE_DIR", paths.cacheRoot],
          ["BOBBIT_E2E_V8CACHE_ROOT", paths.v8CacheRoot],
          ["TMPDIR", paths.tempDir],
          ["TEMP", paths.tempDir],
          ["TMP", paths.tempDir],
        ]) {
          expect(matching(environment, name), name).toEqual([name]);
          expect(environment[name], name).toBe(value);
        }
      }
      expect(matching(child, "BOBBIT_V2_RUN_ROOT")).toEqual(["BOBBIT_V2_RUN_ROOT"]);
      expect(child.BOBBIT_V2_RUN_ROOT).toBe(paths.root);
      expect(Object.keys(nested).map((key) => key.toUpperCase())).not.toContain("BOBBIT_E2E_PWTEST_CACHE_ROOT");
      expect(Object.keys(nested).map((key) => key.toUpperCase())).not.toContain("BOBBIT_E2E_V8CACHE_ROOT");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("keeps Group A naturally retryless through its fixture teardowns", () => {
    const source = readFileSync(
      "scripts/testing-v2/run-e2e-v2.mjs",
      "utf8",
    );
    const groupA = source.match(
      /async function runGroupA[\s\S]*?(?=\nexport function resolveE2ERetryCount)/,
    )?.[0];
    expect(groupA).toBeDefined();
    expect(groupA).not.toContain("--test-force-exit");
    expect(groupA).toContain('const args = ["--test", `--test-concurrency=${nodeConc}`, ...specs];');
    expect(groupA).not.toMatch(/--retr(?:y|ies)(?:=|\b)/);
  });

  it("uses the retry-free control for E2E Groups B/C/D and both Playwright configs", () => {
    const runner = readFileSync("scripts/testing-v2/run-e2e-v2.mjs", "utf8");
    const groupB = runner.match(/async function runGroupB[\s\S]*?(?=\nasync function runGroupC)/)?.[0];
    const groupC = runner.match(/async function runGroupC[\s\S]*?(?=\nexport function groupDVitestArgs)/)?.[0];
    const playwrightRetryPolicy = 'retries: process.env.BOBBIT_V2_RETRY_FREE === "1" ? 0 : 3,';

    expect(resolveE2ERetryCount({})).toBe(3);
    expect(resolveE2ERetryCount({ BOBBIT_V2_RETRY_FREE: "1" })).toBe(0);
    expect(groupB).toContain("const retries = resolveE2ERetryCount(coordinatorEnv);");
    expect(groupB).toContain("`--retries=${retries}`");
    expect(groupC).toContain('const retryArgs = isRetryFreeQualification(coordinatorEnv) ? ["--retries=0"] : [];');
    expect(groupDVitestArgs({})).not.toContain("--retry=0");
    expect(groupDVitestArgs({ BOBBIT_V2_RETRY_FREE: "1" })).toContain("--retry=0");
    for (const config of ["playwright-e2e.config.ts", "playwright-v2.config.ts"])
      expect(readFileSync(config, "utf8"), config).toContain(playwrightRetryPolicy);
  });

  it("owns E2E Playwright artifacts beneath each coordinator root", async () => {
    const configSource = readFileSync("playwright-e2e.config.ts", "utf8");
    const config = await import("../../../playwright-e2e.config.ts");
    const root = getRunRoot();
    const temp = mkdtempSync(join(tmpdir(), "e2e-output-isolation-"));
    try {
      const firstRoot = createE2ERunPaths(temp).root;
      const secondRoot = createE2ERunPaths(temp).root;
      const firstOutput = config.resolveE2EOutputDir(firstRoot);
      const secondOutput = config.resolveE2EOutputDir(secondRoot);
      const outputDir = (config.default as { outputDir?: string }).outputDir;

      expect(configSource).toContain("outputDir: resolveE2EOutputDir(),");
      expect(outputDir).toBe(config.resolveE2EOutputDir(root));
      expect(isOwnedRunChild(root, outputDir!)).toBe(true);
      expect(outputDir).not.toBe(join(process.cwd(), "test-results"));
      expect(isOwnedRunChild(firstRoot, firstOutput)).toBe(true);
      expect(isOwnedRunChild(secondRoot, secondOutput)).toBe(true);
      expect(firstOutput).not.toBe(secondOutput);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("keeps the gateway fixtures beneath the inherited run root", () => {
    const source = readFileSync("tests/support/harnesses/shared/gateway.ts", "utf8");
    expect(source).toContain('from "./run-isolation.js"');
    expect(source).toContain("createRunChild");
    expect(source).toContain("getRunRoot");

    const basePathSource = readFileSync(
      "tests/integration/gateway/_helpers/base-path-gateway-fixture.ts",
      "utf8",
    );
    expect(basePathSource).toContain('from "../../../support/harnesses/shared/run-isolation.js"');
    expect(basePathSource).toContain('createRunChild("base-path-gateway")');
    expect(basePathSource.match(/removeOwnedRunChild\(root\)/g)).toHaveLength(2);
    expect(basePathSource).toMatch(
      /catch \(error\) \{\s*try \{ await gateway!\.shutdown\(\); \} catch \{[^}]*\}\s*restoreProcessState\(processState\);\s*removeOwnedRunChild\(root\);/,
    );
    expect(basePathSource).toMatch(
      /async shutdown\(\) \{\s*try \{ await gateway\.shutdown\(\); \}\s*finally \{[\s\S]*?restoreProcessState\(processState\);\s*removeOwnedRunChild\(root\);/,
    );
    expect(basePathSource).not.toContain("tmpdir");
    expect(basePathSource).not.toContain("mkdtempSync");
    expect(basePathSource).not.toContain("rmSync");
  });
});
