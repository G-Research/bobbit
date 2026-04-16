import { defineConfig } from "@playwright/test";

export default defineConfig({
  timeout: 15_000,
  retries: 1,
  fullyParallel: true,
  grep: /@smoke/,
  globalSetup: "./tests/e2e/e2e-global-setup.ts",
  globalTeardown: "./tests/e2e/e2e-teardown.ts",
  projects: [
    {
      name: "api",
      testDir: "./tests/e2e",
      testIgnore: [
        "**/ui/**",
        "**/session-lifecycle-ui*",
        "**/mcp-tool-permission*",
        "**/mcp-integration*",
        "**/per-project-config-dirs*",
        "**/port-auto-increment*",
        "**/localhost-auth*",
        "**/sandbox-recovery-docker*",
      ],
      workers: 3,
    },
    {
      name: "browser",
      testDir: "./tests/e2e",
      testMatch: [
        "**/ui/*.spec.ts",
        "**/session-lifecycle-ui*.spec.ts",
        "**/mcp-tool-permission*.spec.ts",
        "**/mcp-integration*.spec.ts",
        "**/per-project-config-dirs*.spec.ts",
        "**/port-auto-increment*.spec.ts",
        "**/localhost-auth*.spec.ts",
      ],
      testIgnore: ["**/sandbox-recovery-docker*"],
      workers: 3,
    },
  ],
});
