import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "**/*.spec.ts",
	// `tests/lsp/**/*.spec.ts` are node:test-style integration tests (they
	// import `node:test`, spawn real language servers, and some `process.chdir`
	// into fixture dirs — chdir leaks into other Playwright workers in the
	// same process and silently breaks fixture specs that resolve relative
	// paths). They are executed by the node `--test` runner in `test:unit`.
	testIgnore: ["e2e/**", "fullstack/**", "manual-integration/**", "lsp/**", "compaction.spec.ts"],
	timeout: 15_000,
	fullyParallel: true,
	workers: process.env.CI ? 2 : "50%",
});
